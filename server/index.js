import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  Engine, DIVISIONS, MODES, MAX_OBJECTS, TEMPO_MULTS, STOP_MODES, DISABLE_MODES, RANGE_SHAPES, PATH_ORDERS, PATH_CURVES,
  TEMPO_MODES, defaultObject, sanitizeObject, toBool, num, now, deepMerge,
} from './engine.js';
import {
  SYSTEMS, MAX_TARGETS, defaultOutputConfig, defaultTarget, sanitizeOutput, sanitizeTarget, newTargetId, applyTransform,
  describeSystems, targetWarnings, pickScale, lerpScale, SCALE_KEYS, OFFSET_KEYS, SCALE_RANGE, OFFSET_RANGE,
} from './adapters.js';
import { OscOutput, OscInput, HostResolver, encodeMessage, encodeBundles } from './osc.js';
import { PresetStore, safeName, SLOT_COUNT, PALETTE, validSlot, validColor } from './presets.js';
import { writeFileAtomic, writeFileAtomicAsync, flushWrites, stripBom, isPlainObject } from './fsutil.js';
import {
  CueEngine, InternalClock, CUE_ACTIONS, TC_INPUTS, TC_RATE_SETTINGS, LOSS_MODES, MAX_CUES, TC_TRIGGERS, CUE_CURVES,
  STAGGER_ORDERS, GLOBALS_MODES, validateCue, defaultCue, sanitizeCueList, sanitizeTcSettings, parseOscTc, cleanText, strictInt,
} from './timecode.js';
import { parseTc, formatTc, normalizeRate, tcToSeconds, secondsToTc, isDf } from '../public/tc-core.js';
import { L, LocalizedError, errMsg, wire, en } from './i18n.js';
import { SessionStore, SESSION_VERSION, MAX_SESSION_BYTES, migrateSession } from './sessions.js';
import { AssetStore, MAX_ASSET_BYTES, ASSET_MIME } from './assets.js';
import { defaultStage, sanitizeStage, parseLayout, fitScale, MAX_SPEAKERS } from './layouts.js';
import { ClipRunner, CLIP_KINDS, CLIP_THEN } from './clips.js';
import { OscLog } from './osclog.js';
import { LibraryStore, libPatch } from './library.js';
import {
  AutoRunner, AUTO_MODES, AUTO_GLOBAL, AUTO_CURVES, MAX_LANES, MAX_POINTS, validateLane, validateLanes, sanitizePoints, paramRange, laneKey,
} from './automation.js';
import { AUTO_PARAMS, MASTER_AUTO_PARAMS } from './engine.js';

process.on('uncaughtException', (err) => console.error('[objitter] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[objitter] unhandled rejection:', err));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PRESET_DIR = path.resolve(process.env.PRESET_DIR || path.join(ROOT, 'presets'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const LIBRARY_DIR = path.resolve(process.env.LIBRARY_DIR || path.join(ROOT, 'library'));
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? ''; } catch { return ''; }
})();
const envPort = (name) => {
  const v = process.env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(`[objitter] ${name}="${v}" is not a valid port (1–65535) — ignored`);
  return null;
};
const HTTP_PORT = envPort('PORT') ?? 8080;
const HOST = process.env.HOST?.trim() || undefined;
const CONTROL_PORT_ENV = envPort('CONTROL_PORT');
const MAX_BUFFERED = 256 * 1024;
const MAX_BUFFERED_KILL = 4 * 1024 * 1024;
const MAX_SHOW_BYTES = 2 * 1024 * 1024;
const MAX_MSG_BYTES = 256 * 1024;
const LARGE_TYPES = new Set(['tc.show.import', 'tc.show.preview', 'preset.import', 'session.import', 'stage.layout', 'stage.layout.parse', 'auto.points']);
const CLAIM_BUSY_S = 2;
const MAX_GROUPS = 16;

const engine = new Engine();
const presets = new PresetStore(PRESET_DIR);
const sessions = new SessionStore(SESSION_DIR);
const assets = new AssetStore(path.join(DATA_DIR, 'assets'));
const library = new LibraryStore(LIBRARY_DIR);
try { library.load(); } catch (err) { console.warn('[library]', err.message); }
const cues = new CueEngine();
const clock = new InternalClock();
/** The one browser client whose decoded MTC/LTC is accepted: { ws, cid, clientId, label, kind, lastFrameAt }. */
let tcSource = null;
let output = defaultOutputConfig();
let control = { enabled: true, port: 9000, allow: '' };
let showLock = false;
let groups = [];
let stage = defaultStage();
let startupWarning = null;
let lastPreset = null; // { name, modified }
/** Current session: name + content signature at the last save/load (dirty = signature differs). */
let currentSession = null; // { name, sig }

// ---------------- persistence ----------------
function sanitizeControl(c, prev) {
  const src = isPlainObject(c) ? c : {};
  let allow = prev.allow ?? '';
  if (typeof src.allow === 'string') {
    const list = src.allow.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (list.every((ip) => net.isIP(ip))) allow = list.slice(0, 32).join(', ');
  }
  return {
    enabled: toBool(src.enabled, prev.enabled),
    port: Math.round(num(src.port, 1, 65535, prev.port)),
    allow,
  };
}

function sanitizeGroups(list) {
  const out = [];
  for (const g of (Array.isArray(list) ? list : []).filter(isPlainObject)) {
    const name = typeof g.name === 'string' ? cleanText(g.name, 24).replace(/[@,]/g, '').trim() : '';
    if (!name || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const ids = validIds(g.ids);
    if (!ids.length) continue;
    out.push({ name, ids: ids.sort((a, b) => a - b), color: validColor(g.color) });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

function loadState() {
  let text;
  try {
    text = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[state] cannot read ${STATE_FILE}: ${err.message}`);
    return;
  }
  let s;
  try {
    s = JSON.parse(stripBom(text));
    if (!isPlainObject(s)) throw new Error('top-level value is not an object');
  } catch (err) {
    const bad = `${STATE_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, bad); } catch { /* ignore */ }
    startupWarning = L('srv.stateCorrupt', { file: path.basename(bad) });
    console.warn(`[state] state.json parse failed (${err.message}) → kept as ${bad}, starting with defaults`);
    return;
  }
  try {
    if (s.scene) engine.loadScene(s.scene, { fade: 0, globals: 'preset' });
    if (s.master) engine.applyMaster({ ...s.master, running: undefined, frozen: undefined });
  } catch (err) {
    console.warn('[state] scene restore failed:', err.message);
  }
  output = sanitizeOutput(s.output, defaultOutputConfig());
  control = sanitizeControl(s.control, control);
  showLock = s.showLock === true;
  groups = sanitizeGroups(s.groups);
  stage = sanitizeStage(s.stage, defaultStage());
  if (isPlainObject(s.automation)) autoRunner.setLanes(validateLanes(s.automation.lanes).lanes.map((l) => ({ ...l, armed: false })));
  if (isPlainObject(s.lastPreset) && typeof s.lastPreset.name === 'string') {
    lastPreset = { name: s.lastPreset.name, modified: !!s.lastPreset.modified };
  }
  if (isPlainObject(s.session) && typeof s.session.name === 'string' && safeName(s.session.name)) {
    currentSession = { name: safeName(s.session.name), sig: typeof s.session.sig === 'string' ? s.session.sig : '' };
  }
  if (isPlainObject(s.timecode)) {
    const ts = isPlainObject(s.timecode.settings) ? { ...s.timecode.settings } : {};
    // Settings saved before v3 carry the old 2 s / 1 s defaults, which let shuttles fire cues.
    if (!Object.hasOwn(ts, 'chaseFade')) {
      ts.locateThreshold = Math.min(Number(ts.locateThreshold) || 0.5, 0.5);
      ts.freewheel = Math.min(Number(ts.freewheel) || 0.5, 0.5);
    }
    cues.setSettings(ts);
    cues.setCues(sanitizeCueList(s.timecode.cues).map(fillCuePreset));
  }
}

function stateSnapshot() {
  return {
    scene: engine.getScene(), master: engine.settings(), output, control, lastPreset, showLock, groups, stage,
    timecode: { settings: cues.settings, cues: cues.cues }, automation: { lanes: autoRunner.lanes }, session: currentSession,
  };
}

let saveTimer = null;
let firstDirty = 0;
function saveStateSoon(immediate = false) {
  const t = Date.now();
  if (!firstDirty) firstDirty = t;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, immediate ? 50 : Math.max(0, Math.min(800, firstDirty + 3000 - t)));
}

function saveStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  firstDirty = 0;
  writeFileAtomicAsync(STATE_FILE, JSON.stringify(stateSnapshot(), null, 2))
    .catch((err) => console.error('[state] save failed:', err.message));
}

// ---------------- undo ----------------
const undoStack = [];
let lastUndoPush = 0;
/** Edits within 1 s share one undo step; a forced push (preset load) always stands alone. */
function pushUndo(force = false) {
  const t = Date.now();
  if (!force && t - lastUndoPush < 1000) {
    lastUndoPush = t;
    return;
  }
  undoStack.push(JSON.stringify(engine.getScene()));
  if (undoStack.length > 20) undoStack.shift();
  lastUndoPush = force ? 0 : t;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) {
    toast(L('srv.undo.none'), 'warn');
    return false;
  }
  engine.loadScene(JSON.parse(snap), { fade: engine.master.transition, globals: 'preset' });
  cues.invalidate('scene');
  lastUndoPush = 0;
  toast(L('srv.undo.done'));
  return true;
}

function markModified() {
  if (lastPreset && !lastPreset.modified) lastPreset = { ...lastPreset, modified: true };
}

// ---------------- groups / targets ----------------
const allIds = () => engine.objects.map((o) => o.id);

function validIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.slice(0, 256).map(strictInt).filter((id) => id !== null && id >= 1 && id <= MAX_OBJECTS))];
}

/** "1-8,12,@front" → { ids } (null = all) or { ids: [], error }. */
function resolveTargets(str) {
  const s = String(str ?? '').trim();
  if (!s || s === '*' || s.toLowerCase() === 'all') return { ids: null };
  const set = new Set();
  for (const raw of s.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('@')) {
      const name = part.slice(1).trim().toLowerCase();
      const g = groups.find((x) => x.name.toLowerCase() === name);
      if (!g) return { ids: [], error: L('srv.targets.noGroup', { name: part.slice(1).trim() }) };
      for (const id of g.ids) set.add(id);
      continue;
    }
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return { ids: [], error: L('srv.targets.bad', { part: part.slice(0, 16) }) };
    let a = Number(m[1]);
    let b = Number(m[2] ?? m[1]);
    if (a > b) [a, b] = [b, a];
    for (let id = Math.max(1, a); id <= Math.min(MAX_OBJECTS, b); id++) set.add(id);
  }
  return { ids: [...set].sort((a, b) => a - b) };
}

// ---------------- OSC ----------------
const oscOut = new OscOutput();
const oscIn = new OscInput({ host: HOST });
oscOut.on('error', (err) => console.warn('[osc-out]', err.code || err.message));
oscIn.on('status', (s) => {
  if (s.state === 'listening') console.log(`[osc-in] listening for control on UDP ${s.port}`);
  if (s.state === 'error') {
    console.error(`[osc-in] ${s.message}`);
    toast(L('srv.ctl.error', { msg: ctlErr(s) }), 'error');
  }
  stateChanged(false);
});

function ctlErr(s) {
  if (s.code === 'EADDRINUSE') return L('ctl.err.inUse', { port: s.port });
  if (s.code === 'EACCES') return L('ctl.err.access', { port: s.port });
  return s.message;
}
let lastMalformedToast = 0;
oscIn.on('malformed', (err, rinfo) => {
  const t = Date.now();
  if (t - lastMalformedToast < 1000) return;
  lastMalformedToast = t;
  toast(L('srv.osc.malformed', { addr: rinfo.address, msg: err.message }), 'warn');
});
let lastDeniedToast = 0;
oscIn.on('message', (m, rinfo) => {
  if (oscLog.active) oscLog.add(controlAllowed(rinfo?.address) ? 'in' : 'deny', `${rinfo?.address}:${rinfo?.port}`, m.address, m.args);
  if (!controlAllowed(rinfo?.address)) {
    const t = Date.now();
    if (t - lastDeniedToast > 5000) {
      lastDeniedToast = t;
      toast(L('srv.osc.denied', { addr: rinfo?.address }), 'warn');
    }
    return;
  }
  try {
    handleControlMessage(m);
  } catch (err) {
    console.error('[osc-in]', err);
  }
});

function controlAllowed(addr) {
  if (!control.allow) return true;
  const a = String(addr || '').replace(/^::ffff:/, '');
  return control.allow.split(/,\s*/).includes(a);
}

const controlPort = () => CONTROL_PORT_ENV ?? control.port;

function applyControlInput() {
  oscIn.listen(control.enabled ? controlPort() : null).catch((err) => console.error('[osc-in]', err));
}

const oscNum = (v) => num(v, -Infinity, Infinity, null);
const oscBool = (v) => (v === undefined ? true : toBool(typeof v === 'string' ? v.toLowerCase() : v, Number(v) > 0));

function oscSetPatch(p, value) {
  if (typeof p !== 'string' || !/^[A-Za-z]+(\.[A-Za-z]+)?$/.test(p)) return null;
  const [k, sub] = p.split('.');
  const def = defaultObject(1);
  // pathPts is a nested list; a flat OSC argument list would silently erase the drawn path.
  if (k === 'id' || k === 'pathPts' || !Object.hasOwn(def, k)) return null;
  if (sub !== undefined && !(isPlainObject(def[k]) && Object.hasOwn(def[k], sub))) return null;
  if (sub === undefined && isPlainObject(def[k])) return null;
  return sub === undefined ? { [k]: value } : { [k]: { [sub]: value } };
}

let lastLockToast = 0;
function lockedToast(ws = null) {
  if (ws) {
    replyToast(ws, L('srv.locked'), 'warn');
    return;
  }
  const t = Date.now();
  if (t - lastLockToast < 2000) return;
  lastLockToast = t;
  toast(L('srv.lockedOsc'), 'warn');
}

function handleControlMessage({ address, args }) {
  const a = address.split('/').filter(Boolean);
  if (a[0] !== 'objitter') return;
  const arg0 = args[0];
  const tr = engine.master.transition;
  switch (a[1]) {
    case 'tc': handleOscTc(a[2], args); return;
    case 'go': runTcActions(cues.go(now())); pushTcStatus(true); return;
    case 'back': if (cues.back()) pushTcStatus(true); return;
    case 'standby': {
      const n = strictInt(arg0 ?? a[2]);
      if (n !== null && cues.standbyTo(n)) pushTcStatus(true);
      return;
    }
    case 'start': engine.setRunning(true); cues.invalidate('run'); break;
    case 'stop': engine.setRunning(false); cues.invalidate('run'); clipRunner.stopAll(); autoRunner.stopRuns(now()); break;
    case 'toggle':
      engine.setRunning(!engine.master.running);
      cues.invalidate('run');
      if (!engine.master.running) {
        clipRunner.stopAll();
        autoRunner.stopRuns(now());
      }
      break;
    case 'run': {
      const v = oscBool(arg0);
      if (v === null) return;
      engine.setRunning(v);
      cues.invalidate('run');
      break;
    }
    case 'tap': if (oscBool(arg0)) engine.tap(); break;
    case 'bpm': if (!engine.setBpm(oscNum(arg0))) return; break;
    case 'resync': engine.resync(); break;
    case 'speed': if (!engine.setSpeed(oscNum(arg0), oscNum(args[1]) ?? 0)) return; autoTouch(['master'], ['speed']); break;
    case 'tempomult': if (!engine.setTempoMult(oscNum(arg0))) return; break;
    case 'transition': {
      const n = oscNum(arg0);
      if (n === null) return;
      engine.applyMaster({ transition: n });
      break;
    }
    case 'freeze': if (!engine.setFrozen(oscBool(arg0))) return; cues.invalidate('freeze'); break;
    case 'home': engine.home(allIds(), oscNum(arg0) ?? tr); cues.invalidate('scene'); clipRunner.release(null); break;
    case 'undo':
      if (showLock) { lockedToast(); return; }
      if (!undo()) return;
      break;
    case 'preset': {
      let name;
      let fade;
      if (a[2]) {
        try { name = decodeURIComponent(a.slice(2).join('/')); } catch { return; }
        fade = oscNum(arg0);
      } else {
        if (typeof arg0 !== 'string') return;
        name = arg0;
        fade = oscNum(args[1]);
      }
      if (!loadPreset(name, null, fade)) return;
      cues.invalidate('scene');
      break;
    }
    case 'slot': {
      const n = validSlot(a[2] ?? arg0);
      const fade = oscNum(a[2] ? arg0 : args[1]);
      if (!loadSlot(n, null, fade)) return;
      cues.invalidate('scene');
      break;
    }
    case 'session': {
      const name = typeof arg0 === 'string' ? arg0 : null;
      if (a[2] === 'load') {
        if (showLock) { lockedToast(); return; }
        if (!name) return;
        loadSession(name, { includeOutput: args[1] === undefined ? false : oscBool(args[1]) === true });
        return;
      }
      if (a[2] === 'save') {
        const target = name ?? currentSession?.name;
        if (!target) {
          toast(L('srv.session.noCurrent'), 'warn');
          return;
        }
        saveSession(target, { overwrite: true });
      }
      return;
    }
    case 'obj': {
      const cmd = a[3];
      const transport = cmd === 'play' || cmd === 'pause' || cmd === 'run';
      if (showLock && !transport) { lockedToast(); return; }
      const sel = a[2] === '*' ? 'all' : (() => { try { return decodeURIComponent(a[2] ?? ''); } catch { return ''; } })();
      if (!sel.trim()) return;
      const { ids: r } = resolveTargets(sel);
      const ids = r ?? allIds();
      if (!ids.length) return;
      if (transport) {
        const play = cmd === 'run' ? oscBool(arg0) : cmd === 'play';
        if (!engine.setObjectsRunning(ids, play).length) return;
        kick();
        break;
      }
      let apply;
      if (cmd === 'enable') apply = () => engine.updateObjects(ids, { enabled: oscBool(arg0) });
      else if (cmd === 'mode' && MODES.includes(String(arg0))) apply = () => engine.updateObjects(ids, { mode: String(arg0) });
      else if (cmd === 'center') {
        const x = oscNum(args[0]);
        const y = oscNum(args[1]);
        if (x === null || y === null) return;
        const z = oscNum(args[2]);
        apply = () => {
          autoTouch(ids, ['center.x', 'center.y', 'center.z']);
          for (const id of ids) engine.updateObject(id, { center: { x, y, z: z ?? engine.objects[id - 1].center.z } });
        };
      } else if (cmd === 'set') {
        const value = args.length > 2 ? args.slice(1) : args[1];
        if (value === undefined) return;
        const patch = oscSetPatch(String(arg0), value);
        if (!patch) return;
        apply = () => {
          autoTouch(ids, autoParamsOf(patch));
          engine.updateObjects(ids, patch);
        };
      } else if (cmd === 'home') {
        apply = () => engine.home(ids, oscNum(arg0) ?? tr);
      } else return;
      pushUndo();
      apply();
      cues.invalidate('scene', ids);
      markModified();
      break;
    }
    default: return;
  }
  stateChanged();
}

let lastTcWarn = 0;
function handleOscTc(sub, args) {
  if (sub === 'enable') {
    if (showLock) { lockedToast(); return; }
    cues.setSettings({ enabled: oscBool(args[0]) });
    tcChanged();
    return;
  }
  if (sub === 'play' || sub === 'pause' || sub === 'locate' || sub === 'rewind') {
    internalTransport(sub, args[0], null);
    return;
  }
  if (cues.settings.input !== 'osc') {
    const t = Date.now();
    if (t - lastTcWarn > 5000) {
      lastTcWarn = t;
      toast(L('srv.tc.oscIgnored'), 'warn');
    }
    return;
  }
  if (sub === 'stop') {
    runTcActions(cues.stop());
    return;
  }
  if (sub !== undefined) return;
  const p = parseOscTc(args);
  if (!p) return;
  runTcActions(cues.input({ tc: p.tc, rate: p.rate, src: { kind: 'osc' }, kind: 'osc' }, now()));
  pushTcStatus();
}

// ---------------- timecode cues ----------------
/** Name is the primary reference; the slot is a shortcut / fallback for cues without a known name. */
function resolveCuePreset(cue) {
  const byName = cue.preset ? presets.meta(cue.preset) : null;
  if (byName) return { name: byName.name, via: 'name', meta: byName };
  const bySlot = cue.slot ? presets.bySlot(cue.slot) : null;
  if (bySlot) return { name: bySlot.name, via: 'slot', meta: bySlot };
  return { name: null, via: null, meta: null };
}

/** Effective object ids a cue touches (targets ∩ preset objects); null = not object-scoped. */
function cueIds(cue) {
  const tg = cue.targets ? resolveTargets(cue.targets) : { ids: null };
  if (tg.error) return [];
  if (cue.action === 'slot') {
    const r = resolveCuePreset(cue);
    if (!r.meta) return [];
    return tg.ids ? r.meta.ids.filter((id) => tg.ids.includes(id)) : [...r.meta.ids];
  }
  if (cue.action === 'home' || cue.action === 'library') return tg.ids ?? allIds();
  if (cue.action === 'clips') return clipCueIds(cue);
  return null;
}
cues.resolveIds = cueIds;

const clipRunner = new ClipRunner({
  resolve: (spec) => {
    if (!spec) return allIds();
    const tg = resolveTargets(spec);
    return tg.error ? [] : tg.ids ?? allIds();
  },
  object: (id) => engine.objects[id - 1],
  apply: (ids, objects, { fade, ease }) => {
    engine.loadScene({ objects }, { onlyIds: ids, fade: fade ?? engine.master.transition, ease, globals: 'keep' });
    forceFrame = true;
    stateChanged();
  },
  home: (ids, fade, ease) => {
    engine.home(ids, fade ?? engine.master.transition, now(), { ease });
    forceFrame = true;
  },
  preset: (name, ids, fade, ease) => {
    const meta = presets.meta(name);
    if (!meta) {
      toast(L('srv.cue.presetMissing', { name }), 'warn');
      return false;
    }
    const list = meta.ids.filter((id) => ids.includes(id));
    return list.length ? recallPreset(meta.name, { ids: list, fade, quiet: true, ease }) : false;
  },
  library: (p, ids, fade, ease) => applyLibrary(p, ids, { fade, ease, quiet: true }),
  run: (ids, play) => {
    if (!engine.setObjectsRunning(ids, play).length) return;
    forceFrame = true;
    stateChanged(false);
  },
  onClip: (info) => broadcastLive({ type: 'clip', ...info }),
});

const autoRunner = new AutoRunner({
  apply: (target, param, value) => {
    if (target === 'master') engine.setMasterAutomation(param, value);
    else engine.setAutomation(target, param, value);
  },
  sample: (target, param) => {
    if (target === 'master') return param === 'speed' ? engine.master.speedTarget : null;
    const i = target - 1;
    if (param === 'pos') {
      const p = engine.rt[i].pos;
      return [p.x, p.y, p.z];
    }
    const dot = param.indexOf('.');
    const o = engine.objects[i];
    return dot > 0 ? o[param.slice(0, dot)][param.slice(dot + 1)] : o[param];
  },
  locked: () => showLock,
  running: () => engine.master.running,
  cueTime: (id) => cueTime(id),
  onRecorded: (ids) => {
    const names = ids.map((id) => autoRunner.lane(id)).filter(Boolean).map(laneName);
    toast(L('srv.auto.recorded', { list: names.slice(0, 4).join(', ') }));
    autoChanged();
  },
});

const laneName = (l) => `${l.target === 'master' ? 'Master' : engine.objects[l.target - 1]?.name ?? l.target} · ${l.param}`;

/** Automatable params present in an object patch (recording source for Touch / Latch). */
function autoParamsOf(patch) {
  if (!isPlainObject(patch)) return [];
  const out = [];
  for (const k of Object.keys(AUTO_PARAMS)) {
    const dot = k.indexOf('.');
    if (dot > 0 ? isPlainObject(patch[k.slice(0, dot)]) && Object.hasOwn(patch[k.slice(0, dot)], k.slice(dot + 1)) : Object.hasOwn(patch, k)) out.push(k);
  }
  return out;
}

function autoTouch(ids, params) {
  if (!params.length || !autoRunner.lanes.length) return;
  const t = now();
  for (const id of ids) autoRunner.touch(id, params, t);
}

let autoTimer = null;
function autoChanged() {
  saveStateSoon();
  if (currentSession) stateChanged(false);
  if (autoTimer) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    broadcast({ type: 'auto', lanes: autoRunner.lanes, global: autoRunner.global });
  }, 30);
}

let lastAutoPush = 0;
let lastAutoKey = '';
function pushAutoStatus(force = false) {
  const t = now();
  const st = autoRunner.status();
  const key = JSON.stringify(st);
  if (!force && (key === lastAutoKey || t - lastAutoPush < 1 / 15)) return;
  lastAutoPush = t;
  lastAutoKey = key;
  broadcastLive({ type: 'autos', ...st });
}

/** Cue time (s) on the TC circle for a cue id, or null when it is not on the timeline. */
const cueTime = (id) => cues.timeline().find((x) => x.cue.id === id)?.t ?? null;
const tcClock = (t) => ({ pos: cues.position(t), rolling: cues.rolling, day: cues.day() });

/** Clips are part of the cue: ids = union of clip targets. */
function clipCueIds(cue) {
  const set = new Set();
  for (const c of cue.clips ?? []) for (const id of clipRunner.api.resolve(c.targets)) set.add(id);
  return [...set].sort((a, b) => a - b);
}

function fillCuePreset(cue) {
  if (cue.action !== 'slot') return cue;
  if (!cue.preset && cue.slot) return { ...cue, preset: presets.bySlot(cue.slot)?.name ?? '' };
  if (cue.preset && cue.slot === null) {
    const m = presets.meta(cue.preset);
    return { ...cue, preset: m?.name ?? cue.preset, slot: m?.slot ?? null };
  }
  return cue;
}

let forceFrame = false;

function applyCue({ cue, type: how, ids, elapsed = 0 }) {
  const t = now();
  const base = cue.fade ?? engine.master.transition;
  const fade = how === 'chase' ? Math.max(base - elapsed, cues.settings.chaseFade) : base;
  const tg = cue.targets ? resolveTargets(cue.targets) : { ids: null };
  let ok = true;
  let level = 'info';
  let what = L(`cue.action.${cue.action}`);
  switch (cue.action) {
    case 'slot': {
      const r = resolveCuePreset(cue);
      if (!r.name) {
        ok = false;
        what = L('srv.cue.presetMissing', { name: cue.preset || L('common.slotN', { n: cue.slot }) });
        break;
      }
      what = r.meta.slot ? L('srv.cue.presetWithSlot', { name: r.name, slot: r.meta.slot }) : r.name;
      if (r.via === 'slot' && cue.preset) {
        what = L('srv.cue.fallback', { preset: cue.preset, slot: cue.slot, name: r.name });
        level = 'warn';
      }
      if (tg.error) {
        ok = false;
        what = tg.error;
        break;
      }
      const list = ids ?? cueIds(cue);
      clipRunner.release(list);
      ok = recallPreset(r.name, {
        ids: list, fade, quiet: true, ease: cue.curve, stagger: cue.stagger, order: cue.staggerOrder,
        seedOffset: cue.seedOffset, globals: cue.globals,
      });
      break;
    }
    case 'clips': {
      const n = cue.clips?.length ?? 0;
      what = L('srv.cue.clips', { n });
      if (!n) {
        ok = false;
        break;
      }
      const tcRun = how === 'fire' || how === 'chase';
      clipRunner.chaseFade = cues.settings.chaseFade;
      clipRunner.start(cue, {
        ids: ids ?? null, elapsed, clock: tcRun ? 'tc' : 'wall', cueT: tcRun ? cueTime(cue.id) : null, now: t, chase: how === 'chase',
      });
      break;
    }
    case 'library': {
      what = cue.lib;
      if (tg.error) {
        ok = false;
        what = tg.error;
        break;
      }
      if (!library.get(cue.lib)) {
        ok = false;
        what = L('srv.cue.libMissing', { name: cue.lib });
        break;
      }
      const list = ids ?? cueIds(cue);
      clipRunner.release(list);
      ok = applyLibrary(cue.lib, list, { fade, ease: cue.curve, quiet: true, stagger: cue.stagger, order: cue.staggerOrder });
      break;
    }
    case 'home': {
      if (tg.error) {
        ok = false;
        what = tg.error;
        break;
      }
      const list = ids ?? cueIds(cue);
      clipRunner.release(list);
      engine.home(list, fade, t, { ease: cue.curve, delays: engine.staggerDelays(list.filter((id) => engine.objects[id - 1].enabled), cue.stagger, cue.staggerOrder) });
      break;
    }
    case 'start': engine.setRunning(true, t); break;
    case 'stop': engine.setRunning(false, t); break;
    case 'freeze': engine.setFrozen(true, t); break;
    case 'unfreeze': engine.setFrozen(false, t); break;
    default: return;
  }
  if (ok) {
    const tcRun = how === 'fire' || how === 'chase';
    autoRunner.cueStarted(cue, { clock: tcRun ? 'tc' : 'wall', cueT: tcRun ? cueTime(cue.id) : null, now: t, elapsed });
  }
  if (ok && cue.bpm !== null && cue.bpm !== undefined) engine.setBpm(cue.bpm, t);
  if (ok && cue.anchorBeat) engine.resync(t);
  if (!ok) level = 'warn';
  forceFrame = true;
  broadcast({ type: 'cue', id: cue.id, how, ok });
  const label = cue.label || cue.tc;
  const prefix = L(`srv.cue.prefix.${['chase', 'go', 'manual'].includes(how) ? how : 'fire'}`);
  toast(L('srv.cue.fired', { prefix, label, what }), level);
  stateChanged();
}

function runTcActions(actions) {
  for (const a of actions) {
    try {
      if (a.type === 'fire' || a.type === 'chase' || a.type === 'go' || a.type === 'manual') {
        applyCue(a);
      } else if (a.type === 'rolling') {
        const s = cues.settings;
        if (s.enabled && s.autoStart && !engine.master.running) {
          const runCue = cues.cues.find((c) => c.id === cues.applied.run);
          if (runCue?.action === 'stop') {
            toast(L('srv.tc.noAutoStart'), 'warn');
          } else {
            engine.setRunning(true);
            forceFrame = true;
            toast(L('srv.tc.autoStart'));
            stateChanged();
          }
        }
      } else if (a.type === 'lost' && cues.settings.enabled) {
        const stop = cues.settings.onLoss === 'stop' && engine.master.running;
        if (stop) {
          engine.setRunning(false);
          stateChanged();
        }
        toast(L(stop ? 'srv.tc.lostStop' : 'srv.tc.lost'), 'warn');
      }
    } catch (err) {
      console.error('[tc]', err);
    }
  }
  if (actions.length) {
    pushTcStatus(true);
    kick();
  }
}

function internalStatus(t) {
  if (cues.settings.input !== 'internal') return null;
  const r = cues.rate();
  return { playing: clock.playing, tc: formatTc(secondsToTc(clock.position(t), r), { df: isDf(r) }) };
}

function tcStatus(t = now()) {
  return { ...cues.status(t), internal: internalStatus(t), clips: clipRunner.status(t, tcClock(t)) };
}

let lastTcPush = 0;
let lastTcKey = '';
function pushTcStatus(force = false) {
  const t = now();
  const st = tcStatus(t);
  const key = `${st.state}|${st.next?.id ?? ''}|${st.src}|${st.enabled}|${st.trigger}|${st.standby?.id ?? ''}|${st.internal?.playing ?? ''}|${st.chasePending}|${st.clips.map((r) => r.cue).join(',')}`;
  if (!force && key === lastTcKey && t - lastTcPush < 1 / 15) return;
  lastTcPush = t;
  lastTcKey = key;
  broadcastLive({ type: 'tcs', ...st });
}

let lastInternalFeed = 0;
function feedInternal(t) {
  if (cues.settings.input !== 'internal') return;
  if (t - lastInternalFeed < (clock.playing ? 0.01 : 0.1)) return;
  lastInternalFeed = t;
  runTcActions(cues.feed(clock.position(t), { src: { kind: 'internal' }, kind: 'internal' }, t));
}

function internalTransport(op, arg, ws) {
  const say = (msg, level = 'warn') => (ws ? replyToast(ws, msg, level) : toast(msg, level));
  if (cues.settings.input !== 'internal') {
    say(L('srv.int.notSelected'));
    return false;
  }
  const t = now();
  const rate = cues.rate();
  if (op === 'play') clock.play(t);
  else if (op === 'pause') clock.pause(t);
  else if (op === 'toggle') (clock.playing ? clock.pause(t) : clock.play(t));
  else if (op === 'locate' || op === 'rewind') {
    let sec;
    if (op === 'rewind') {
      const first = cues.timeline()[0];
      sec = first ? Math.max(0, first.t - cues.settings.preroll) : 0;
    } else {
      const tc = typeof arg === 'string' ? parseTc(arg) : null;
      if (!tc || tc.neg) {
        say(L('srv.int.badLocate', { v: String(arg ?? '').slice(0, 16) }));
        return false;
      }
      sec = tcToSeconds(tc, rate);
    }
    clock.locate(sec, t);
  } else return false;
  lastInternalFeed = 0;
  feedInternal(t);
  pushTcStatus(true);
  return true;
}

// ---------------- timecode state broadcast (coalesced deltas) ----------------
function tcState() {
  return {
    settings: cues.settings,
    cues: cues.cues,
    source: tcSource ? { cid: tcSource.cid, label: tcSource.label, kind: tcSource.kind } : null,
  };
}

const tcSent = { settings: '', source: '', cues: new Map(), order: '' };
let tcTimer = null;
function tcChanged() {
  if (clipRunner.runs.length) clipRunner.refresh(new Map(cues.cues.map((c) => [c.id, c])));
  saveStateSoon(true);
  if (!tcTimer) tcTimer = setTimeout(flushTc, 40);
  if (currentSession) stateChanged(false);
}

function snapshotTcSent(st) {
  tcSent.settings = JSON.stringify(st.settings);
  tcSent.source = JSON.stringify(st.source);
  tcSent.cues = new Map(st.cues.map((c) => [c.id, JSON.stringify(c)]));
  tcSent.order = st.cues.map((c) => c.id).join(',');
}

function flushTc() {
  tcTimer = null;
  const st = tcState();
  const msg = { type: 'tc.delta' };
  const sj = JSON.stringify(st.settings);
  if (sj !== tcSent.settings) msg.settings = st.settings;
  const so = JSON.stringify(st.source);
  if (so !== tcSent.source) msg.source = st.source;
  const upsert = st.cues.filter((c) => tcSent.cues.get(c.id) !== JSON.stringify(c));
  const ids = new Set(st.cues.map((c) => c.id));
  const remove = [...tcSent.cues.keys()].filter((id) => !ids.has(id));
  const order = st.cues.map((c) => c.id).join(',');
  if (upsert.length) msg.upsert = upsert;
  if (remove.length) msg.remove = remove;
  if (order !== tcSent.order) msg.order = st.cues.map((c) => c.id);
  snapshotTcSent(st);
  if (Object.keys(msg).length > 1) broadcast(msg);
  pushTcStatus(true);
}

// ---------------- show files ----------------
function showFile() {
  const { enabled, input, ...settings } = cues.settings;
  return {
    app: 'objitter',
    kind: 'show',
    version: 3,
    savedAt: new Date().toISOString(),
    timecode: { settings, cues: cues.cues },
    automation: { lanes: autoRunner.lanes.map((l) => ({ ...l, armed: false })) },
    groups,
    slots: presets.list().filter((p) => p.slot).map((p) => ({ slot: p.slot, preset: p.name })),
  };
}

/** Strict check of a show file; nothing is changed. */
function previewShow(data) {
  const errors = [];
  if (!isPlainObject(data) || !isPlainObject(data.timecode) || !Array.isArray(data.timecode.cues)) {
    return { ok: false, cues: 0, errors: [{ index: 0, message: L('srv.show.notShow') }], missing: [], slots: 0, settings: null };
  }
  if (data.app !== undefined && data.app !== 'objitter') errors.push({ index: 0, message: L('srv.show.badApp', { v: String(data.app).slice(0, 20) }) });
  if (data.kind !== undefined && data.kind !== 'show') errors.push({ index: 0, message: L('srv.show.badKind', { v: String(data.kind).slice(0, 20) }) });
  const settings = sanitizeTcSettings(isPlainObject(data.timecode.settings) ? data.timecode.settings : {}, cues.settings);
  const rate = settings.rate === 'auto' ? cues.rate() : settings.rate;
  const list = data.timecode.cues;
  if (list.length > MAX_CUES) errors.push({ index: 0, message: L('srv.show.tooMany', { n: list.length, max: MAX_CUES }) });
  const valid = [];
  const seen = new Set();
  list.slice(0, MAX_CUES).forEach((c, i) => {
    const id = isPlainObject(c) && typeof c.id === 'string' && /^[a-z0-9]{1,16}$/i.test(c.id) && !seen.has(c.id) ? c.id : undefined;
    const { cue, errors: e } = validateCue(c, id ? { ...defaultCue(), id } : defaultCue(), { rate });
    if (!cue) {
      errors.push({ index: i + 1, message: e });
      return;
    }
    seen.add(cue.id);
    valid.push(cue);
  });
  let lanes = [];
  if (data.automation !== undefined) {
    if (!isPlainObject(data.automation)) errors.push({ index: 0, message: L('auto.err.notList') });
    else {
      const v = validateLanes(data.automation.lanes);
      lanes = v.lanes;
      for (const e of v.errors) errors.push({ index: 0, message: L('srv.show.laneErr', { n: e.index, msg: e.message }) });
    }
  }
  const showGroups = sanitizeGroups(data.groups);
  const slotsIn = Array.isArray(data.slots) ? data.slots.filter(isPlainObject) : [];
  const slotNames = new Map(slotsIn.map((s) => [validSlot(s.slot), safeName(s.preset)]).filter(([s, n]) => s && n));
  const missing = new Set();
  for (const c of valid) {
    if (c.action !== 'slot') continue;
    const name = c.preset || slotNames.get(c.slot) || '';
    if (name ? !presets.meta(name) : !presets.bySlot(c.slot)) missing.add(name || `#${c.slot}`);
    if (c.targets) {
      const names = [...c.targets.matchAll(/@([^,]+)/g)].map((m) => m[1].trim().toLowerCase());
      for (const n of names) {
        if (!showGroups.some((g) => g.name.toLowerCase() === n) && !groups.some((g) => g.name.toLowerCase() === n)) {
          errors.push({ index: list.indexOf(c) + 1 || 0, message: L('srv.show.noGroup', { name: n }) });
        }
      }
    }
  }
  return {
    ok: errors.length === 0, name: typeof data.name === 'string' ? cleanText(data.name, 64) : '', cues: valid.length,
    errors: errors.slice(0, 50), errorCount: errors.length, missing: [...missing].slice(0, 50), slots: slotNames.size, settings,
    groups: showGroups.length, lanes: lanes.length, _valid: valid, _groups: showGroups, _slots: slotNames, _lanes: lanes,
  };
}

function publicPreview(p) {
  const { _valid, _groups, _slots, _lanes, ...rest } = p;
  return rest;
}

function importShow(data, applySlots) {
  const p = previewShow(data);
  if (!p.ok) throw new LocalizedError('srv.show.invalid', { n: p.errorCount });
  const settings = { ...p.settings };
  delete settings.enabled;
  delete settings.input;
  if (p._groups.length) groups = p._groups;
  let slots = 0;
  const jobs = [];
  if (applySlots) {
    for (const [slot, name] of p._slots) {
      if (!presets.meta(name)) continue;
      try {
        jobs.push(presets.setSlot(name, slot));
        slots++;
      } catch { /* missing preset */ }
    }
    Promise.all(jobs).catch((err) => toast(L('srv.slot.saveFailed', { msg: errMsg(err) }), 'error'));
    presetsChanged();
  }
  cues.setSettings(settings);
  cues.setCues(p._valid.map((c) => (c.action === 'slot' && !c.preset && p._slots.get(c.slot) ? { ...c, preset: p._slots.get(c.slot) } : c)).map(fillCuePreset));
  clipRunner.stopAll();
  autoRunner.stopAll(now());
  autoRunner.setLanes(p._lanes);
  autoChanged();
  cues.invalidate('scene');
  cues.invalidate('run');
  cues.invalidate('freeze');
  return { cues: p.cues, slots, missing: p.missing };
}

// ---------------- sessions ----------------
const slotMap = () => presets.list().filter((p) => p.slot).map((p) => ({ slot: p.slot, preset: p.name })).sort((a, b) => a.slot - b.slot);

/** Everything a session restores. TC `enabled` stays a per-machine switch (never toggled by a load). */
function sessionContent() {
  const { enabled, ...settings } = cues.settings;
  return {
    scene: engine.getScene(), master: engine.settings(), output, control, groups, slots: slotMap(),
    timecode: { settings, cues: cues.cues }, stage, automation: { lanes: autoRunner.lanes.map((l) => ({ ...l, armed: false })) },
  };
}

function sessionSig() {
  return crypto.createHash('sha1').update(JSON.stringify(sessionContent())).digest('hex');
}

/** Session file contents; presets used by slots or cues are embedded so the file is self-contained. */
function sessionFile(name, { embed = true, embedAssets = true } = {}) {
  const c = sessionContent();
  const embedded = {};
  const files = {};
  const bg = c.stage.background.asset;
  if (embedAssets && bg && assets.has(bg)) {
    try { files[bg] = assets.read(bg).toString('base64'); } catch { /* left as a reference */ }
  }
  if (embed) {
    const wanted = new Set([
      ...c.slots.map((s) => s.preset.toLowerCase()),
      ...cues.cues.filter((q) => q.action === 'slot' && q.preset).map((q) => q.preset.toLowerCase()),
    ]);
    for (const p of presets.list()) {
      if (!wanted.has(p.name.toLowerCase())) continue;
      try {
        const { slot, app, version, name: n, savedAt, ...d } = presets.load(p.name);
        embedded[p.name] = d;
      } catch { /* unreadable preset is simply not embedded */ }
    }
  }
  return {
    app: 'objitter', kind: 'session', version: SESSION_VERSION, appVersion: APP_VERSION, name,
    savedAt: new Date().toISOString(), ...c, presets: embedded, assets: files,
  };
}

/** Strict check of a session file (nothing is changed). Throws LocalizedError. */
function validateSession(raw) {
  const d = migrateSession(raw);
  const fail = (what) => { throw new LocalizedError('srv.session.badPart', { part: what }); };
  if (!isPlainObject(d.scene)) fail('scene');
  let scene;
  try { scene = sanitizeImport(d.scene); } catch { fail('scene'); }
  for (const k of ['master', 'output', 'control']) if (d[k] !== undefined && !isPlainObject(d[k])) fail(k);
  if (d.groups !== undefined && !Array.isArray(d.groups)) fail('groups');
  if (d.slots !== undefined && !Array.isArray(d.slots)) fail('slots');
  if (d.presets !== undefined && !isPlainObject(d.presets)) fail('presets');
  if (d.stage !== undefined && !isPlainObject(d.stage)) fail('stage');
  if (d.assets !== undefined && !isPlainObject(d.assets)) fail('assets');
  if (d.automation !== undefined && !isPlainObject(d.automation)) fail('automation');
  const auto = validateLanes(d.automation?.lanes ?? []);
  if (auto.errors.length) fail('automation');
  const files = Object.entries(d.assets ?? {}).filter(([id, b64]) => assets.file(id) && typeof b64 === 'string');
  const embedded = new Map();
  for (const [name, p] of Object.entries(d.presets ?? {})) {
    const n = safeName(name);
    if (!n) fail('presets');
    try { embedded.set(n, sanitizeImport(p)); } catch { fail(`presets/${n}`); }
  }
  let tc = null;
  if (d.timecode !== undefined) {
    if (!isPlainObject(d.timecode) || !Array.isArray(d.timecode.cues)) fail('timecode');
    const pv = previewShow({ timecode: d.timecode, groups: d.groups ?? [], slots: d.slots ?? [] });
    if (!pv.ok) throw new LocalizedError('srv.session.badCues', { n: pv.errorCount });
    tc = pv;
  }
  const slots = new Map();
  for (const s of (d.slots ?? []).filter(isPlainObject)) {
    const slot = validSlot(s.slot);
    const preset = safeName(s.preset);
    if (slot && preset) slots.set(slot, preset);
  }
  return {
    name: safeName(d.name), scene: { ...d.scene, objects: scene.objects }, master: d.master ?? {}, output: d.output ?? null,
    control: d.control ?? null, groups: sanitizeGroups(d.groups ?? []), slots, embedded, tc, raw: d,
    stage: d.stage !== undefined ? sanitizeStage(d.stage, defaultStage()) : null, files, lanes: auto.lanes,
  };
}

const MASTER_SESSION_KEYS = ['transition', 'tempoMult', 'stopMode', 'disableMode', 'maxVelocity', 'vmaxExceptJumps', 'reseedOnStart', 'livePreview'];

/**
 * Loads a stored session. The scene crossfades over the current transition time, transport is
 * left alone (never auto-START), and one undo step is pushed first. Output targets/control are
 * kept unless includeOutput is true.
 */
async function loadSession(name, { ws = null, includeOutput = false } = {}) {
  const say = (msg, level) => (ws ? replyToast(ws, msg, level) : toast(msg, level));
  let s;
  try {
    s = validateSession(sessions.load(name));
  } catch (err) {
    say(L('srv.session.loadFailed', { msg: errMsg(err) }), 'error');
    return false;
  }
  const stored = sessions.meta(name)?.name ?? safeName(name);
  pushUndo(true);
  const restored = [];
  for (const [pname, scene] of s.embedded) {
    if (presets.meta(pname)) continue;
    try {
      await presets.save(pname, scene);
      restored.push(pname);
    } catch (err) {
      console.warn('[session] preset restore failed:', pname, err.message);
    }
  }
  const t = now();
  const fade = engine.master.transition;
  const master = Object.fromEntries(MASTER_SESSION_KEYS.filter((k) => k in s.master).map((k) => [k, s.master[k]]));
  engine.applyMaster(master, t);
  engine.loadScene(s.scene, { fade: num(master.transition, 0, 30, fade), t, globals: 'preset' });
  if (includeOutput) {
    if (s.output) {
      output = sanitizeOutput(s.output, output);
      onOutputChanged();
    }
    if (s.control) {
      control = sanitizeControl({ ...control, ...s.control }, control);
      applyControlInput();
    }
  }
  groups = s.groups;
  if (s.stage) {
    for (const [id, b64] of s.files) {
      try { await assets.restore(id, b64); } catch (err) { console.warn('[session] asset restore failed:', id, err.message); }
    }
    stage = s.stage;
    if (stage.background.asset && !assets.has(stage.background.asset)) say(L('srv.stage.assetMissing'), 'warn');
    stageChanged(false);
  }
  const want = new Map([...s.slots].map(([slot, preset]) => [preset.toLowerCase(), slot]));
  const jobs = [];
  for (const p of presets.list()) {
    const slot = want.get(p.name.toLowerCase()) ?? null;
    if (p.slot !== slot && p.slot !== null) jobs.push(presets.setSlot(p.name, null));
  }
  for (const [slot, preset] of s.slots) {
    const meta = presets.meta(preset);
    if (meta && meta.slot !== slot) jobs.push(presets.setSlot(meta.name, slot));
  }
  Promise.all(jobs).catch((err) => toast(L('srv.slot.saveFailed', { msg: errMsg(err) }), 'error'));
  if (s.tc) {
    const { enabled, ...settings } = s.tc.settings;
    const before = cues.settings.input;
    cues.setSettings(settings);
    if (tcSource && tcSource.kind !== cues.settings.input) {
      reply(tcSource.ws, { type: 'tc.source.lost', reason: L('srv.tc.inputChanged', { input: cues.settings.input.toUpperCase() }) });
      toast(L('srv.tc.inputChangedToast', { from: before.toUpperCase(), to: cues.settings.input.toUpperCase(), who: tcSource.label }), 'warn');
      tcSource = null;
    }
    if (cues.settings.input !== 'internal' && clock.playing) clock.pause(now());
    cues.setCues(s.tc._valid.map((c) => (c.action === 'slot' && !c.preset && s.slots.get(c.slot) ? { ...c, preset: s.slots.get(c.slot) } : c)).map(fillCuePreset));
  }
  clipRunner.stopAll();
  autoRunner.stopAll(now());
  autoRunner.setLanes(s.lanes);
  autoChanged();
  cues.invalidate('scene');
  cues.invalidate('run');
  cues.invalidate('freeze');
  lastPreset = null;
  forceFrame = true;
  currentSession = { name: stored, sig: sessionSig() };
  const missing = [...s.slots.values()].filter((p) => !presets.meta(p));
  toast(L(missing.length ? 'srv.session.loadedMissing' : 'srv.session.loaded', {
    name: stored, list: missing.slice(0, 5).join(', '),
  }), missing.length ? 'warn' : 'info');
  if (restored.length) toast(L('srv.session.presetsRestored', { n: restored.length, list: restored.slice(0, 5).join(', ') }));
  presetsChanged();
  tcChanged();
  stateChanged();
  kick();
  return true;
}

async function saveSession(name, { ws = null } = {}) {
  const say = (msg, level) => (ws ? replyToast(ws, msg, level) : toast(msg, level));
  try {
    const fits = (d) => Buffer.byteLength(JSON.stringify(d, null, 2)) <= MAX_SESSION_BYTES;
    let data = sessionFile(name);
    let dropped = false;
    let assetDropped = false;
    if (!fits(data) && Object.keys(data.assets).length) {
      data = sessionFile(name, { embedAssets: false });
      assetDropped = true;
    }
    if (!fits(data)) {
      data = sessionFile(name, { embed: false, embedAssets: false });
      dropped = true;
    }
    const sig = sessionSig();
    const stored = await sessions.save(name, data);
    currentSession = { name: stored, sig };
    toast(L('srv.session.saved', { name: stored }));
    if (dropped) say(L('srv.session.presetsDropped'), 'warn');
    if (assetDropped) say(L('srv.session.assetDropped'), 'warn');
    sessionsChanged();
    stateChanged();
    return true;
  } catch (err) {
    say(L('srv.saveFailed', { msg: errMsg(err) }), 'error');
    return false;
  }
}

function sessionsChanged() {
  broadcast({ type: 'sessions', sessions: sessions.list() });
  stateChanged(false);
}

// ---------------- macOS: keep the Mac awake while serving ----------------
let caffeinateActive = false;
function startCaffeinate() {
  if (process.platform !== 'darwin' || process.env.OBJITTER_CAFFEINATE === '0') return;
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', (err) => {
      caffeinateActive = false;
      console.warn('[mac] caffeinate unavailable:', err.message);
    });
    child.on('exit', () => { caffeinateActive = false; });
    child.unref();
    caffeinateActive = true;
    console.log('  > macOS: idle sleep prevented while running (caffeinate -i; OBJITTER_CAFFEINATE=0 disables)\n');
  } catch (err) {
    console.warn('[mac] caffeinate failed:', err.message);
  }
}

// ---------------- output targets ----------------
const targetRt = new Map();
const prevEnabled = new Array(MAX_OBJECTS).fill(false);
let statT = now();
let uiNextMs = performance.now();
let wakeMs = 0;
let frameMs = 0;

function makeTargetRt(t) {
  const resolver = new HostResolver();
  resolver.on('change', () => stateChanged(false));
  resolver.set(t.host);
  return {
    resolver, host: t.host, lastSent: new Map(), st: Array.from({ length: MAX_OBJECTS }, () => ({})),
    nextFrameMs: performance.now(), lastKeepalive: 0, frames: 0, sent: 0, lastFrameMs: 0, iv: [], sample: '',
    error: null, errorAt: 0, sig: '', statFrom: now(),
    sclFrom: pickScale(t.transform), sclTo: pickScale(t.transform), sclT0: 0,
  };
}

/** Scale/offset changes glide over this time instead of jumping (live-show safety). */
const SCALE_RAMP_S = 0.5;
const rampedScale = (rt, t) => lerpScale(rt.sclFrom, rt.sclTo, (t - rt.sclT0) / SCALE_RAMP_S);

function onOutputChanged() {
  const ids = new Set(output.targets.map((t) => t.id));
  for (const [id, rt] of targetRt) {
    if (!ids.has(id)) {
      rt.resolver.close();
      targetRt.delete(id);
    }
  }
  let maxRate = 1;
  for (const t of output.targets) {
    let rt = targetRt.get(t.id);
    if (!rt) {
      rt = makeTargetRt(t);
      targetRt.set(t.id, rt);
    }
    if (rt.host !== t.host) {
      rt.host = t.host;
      rt.resolver.set(t.host);
    }
    const to = pickScale(t.transform);
    if (JSON.stringify(to) !== JSON.stringify(rt.sclTo)) {
      const t0 = now();
      rt.sclFrom = rampedScale(rt, t0);
      rt.sclTo = to;
      rt.sclT0 = t0;
    }
    const sig = JSON.stringify(t);
    if (sig !== rt.sig) {
      rt.sig = sig;
      rt.lastSent.clear();
      rt.nextFrameMs = performance.now();
    }
    if (t.enabled) maxRate = Math.max(maxRate, t.rate);
  }
  engine.minPeriod = Math.max(0.1, 4 / maxRate);
  wakeMs = 0;
}

const fmtArg = (x) => (typeof x.value === 'number' ? x.value.toFixed(3) : x.value);

function sendTarget(tg, rt, batch) {
  const ip = rt.resolver.ip;
  const onErr = (err) => {
    rt.error = err.code || err.message;
    rt.errorAt = now();
  };
  if (SYSTEMS[tg.system].bundleable && tg.cfg.bundle) {
    for (const buf of encodeBundles(batch)) oscOut.sendBuffer(buf, tg.port, ip, onErr);
  } else {
    for (const m of batch) oscOut.sendBuffer(encodeMessage(m.address, m.args), tg.port, ip, onErr);
  }
  rt.sent += batch.length;
  if (oscLog.active) {
    const peer = `${tg.host}:${tg.port}`;
    for (const x of batch) oscLog.add('out', peer, x.address, x.args);
  }
  const m = batch[batch.length - 1];
  rt.sample = `${m.address} ${m.args.map(fmtArg).join(' ')}`;
}

/** due: target ids whose frame is due now; other targets only get event-driven (jump) updates. */
function tick(due) {
  const t = now();
  engine.update(t);
  const released = !engine.master.running && engine.master.stopMode === 'release';
  const active = [];
  for (let i = 0; i < MAX_OBJECTS; i++) {
    const o = engine.objects[i];
    if (o.enabled && !prevEnabled[i]) for (const rt of targetRt.values()) rt.lastSent.delete(i);
    prevEnabled[i] = o.enabled;
    active.push(engine.isOutputActive(i, t) && (!released || engine.isObjectRunning(i) || engine.isLiveTouched(i, t)));
  }
  const ms = performance.now();
  for (const tg of output.targets) {
    if (!tg.enabled) continue;
    const rt = targetRt.get(tg.id);
    if (!rt) continue;
    const isFrame = due.has(tg.id);
    if (isFrame) {
      rt.frames++;
      if (rt.lastFrameMs) rt.iv.push(ms - rt.lastFrameMs);
      if (rt.iv.length > 240) rt.iv.splice(0, rt.iv.length - 240);
      rt.lastFrameMs = ms;
    }
    if (!rt.resolver.ip) continue;
    const keepalive = isFrame && t - rt.lastKeepalive >= 1;
    if (keepalive) rt.lastKeepalive = t;
    const adapter = SYSTEMS[tg.system];
    const scl = rampedScale(rt, t);
    const batch = [];
    for (let i = 0; i < MAX_OBJECTS; i++) {
      if (!active[i]) continue;
      const r = engine.rt[i];
      if (!isFrame && !r.evt) continue;
      const p = applyTransform(r.pos, tg.transform, scl);
      const prev = rt.lastSent.get(i);
      if (!keepalive && prev && Math.abs(prev.x - p.x) < 1e-5 && Math.abs(prev.y - p.y) < 1e-5 && Math.abs(prev.z - p.z) < 1e-5) continue;
      const sid = engine.objects[i].sourceId + tg.idOffset;
      if (sid < 1) continue;
      rt.lastSent.set(i, p);
      batch.push(...adapter.messages(sid, p, tg.cfg, rt.st[i]));
    }
    if (batch.length) sendTarget(tg, rt, batch);
  }
  engine.clearEvents();
}

function p95(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 10) / 10;
}

function sendStats(t) {
  statT = t;
  const sourceIds = engine.objects.filter((o) => o.enabled).map((o) => o.sourceId);
  let worst = null;
  let worstPeriod = null;
  let jitterWarn = false;
  const targets = output.targets.map((tg) => {
    const rt = targetRt.get(tg.id);
    const periodMs = 1000 / tg.rate;
    const p = rt ? p95(rt.iv) : null;
    const span = rt ? Math.max(0.05, t - rt.statFrom) : 1;
    if (tg.enabled && p !== null) {
      if (worst === null || p - periodMs > worst - worstPeriod) {
        worst = p;
        worstPeriod = periodMs;
      }
      if (!output.precise && p > 1.5 * periodMs && p - periodMs > 4) jitterWarn = true;
    }
    const st = {
      id: tg.id, name: tg.name, system: tg.system, enabled: tg.enabled, target: `${tg.host}:${tg.port}`,
      ip: rt?.resolver.ip ?? null, resolve: rt?.resolver.status ?? 'idle',
      frameHz: rt ? Math.round((rt.frames / span) * 10) / 10 : 0, msgRate: rt ? Math.round(rt.sent / span) : 0,
      sample: rt?.sample ?? '', error: rt && t - rt.errorAt < 3 ? rt.error : null, p95Ms: p, periodMs: Math.round(periodMs * 10) / 10,
      feedback: 'off', warn: targetWarnings(tg, sourceIds).map(wire),
    };
    if (rt) {
      rt.frames = 0;
      rt.sent = 0;
      rt.iv = [];
      rt.statFrom = t;
    }
    return st;
  });
  broadcastLive({
    type: 'stats', targets, intervalP95Ms: worst, periodMs: worstPeriod === null ? null : Math.round(worstPeriod * 10) / 10,
    jitterWarn, precise: output.precise, platform: process.platform,
  });
}

let loopHandle = null;
let loopImmediate = false;

/**
 * Precise mode busy-waits once the next output frame is < 16 ms away (Windows timer granularity is
 * ~15.6 ms, so any timer that close could oversleep the frame); other wakes use plain timers.
 */
function schedule(delay, untilFrame = Infinity) {
  if (loopHandle) (loopImmediate ? clearImmediate : clearTimeout)(loopHandle);
  if (output.precise && untilFrame < 16) {
    loopImmediate = true;
    loopHandle = setImmediate(loop);
    return;
  }
  const d = output.precise ? Math.min(delay, untilFrame - 15) : delay;
  loopImmediate = d <= 0;
  loopHandle = loopImmediate ? setImmediate(loop) : setTimeout(loop, d);
}

/** Run the loop now (new TC input, cue fired, etc.) instead of waiting for the next scheduled wake. */
function kick() {
  wakeMs = 0;
  schedule(0);
}

function loop() {
  loopHandle = null;
  const nowMs = performance.now();
  if (nowMs >= wakeMs - 0.25 || forceFrame) {
    try {
      const t = nowMs / 1000;
      feedInternal(t);
      runTcActions(cues.tick(t));
      if (clipRunner.runs.length) clipRunner.tick(t, tcClock(t));
      if (autoRunner.lanes.length) autoRunner.tick(t, tcClock(t));
      const due = new Set();
      for (const tg of output.targets) {
        if (!tg.enabled) continue;
        const rt = targetRt.get(tg.id);
        if (!rt) continue;
        if (forceFrame || nowMs >= rt.nextFrameMs - 0.25) {
          due.add(tg.id);
          if (nowMs >= rt.nextFrameMs - 0.25) {
            const P = 1000 / tg.rate;
            rt.nextFrameMs += P;
            if (nowMs - rt.nextFrameMs > 2 * P) rt.nextFrameMs = nowMs + P;
          }
        }
      }
      forceFrame = false;
      tick(due);
      if (nowMs >= uiNextMs - 0.5) {
        uiNextMs += 1000 / 30;
        if (nowMs - uiNextMs > 100) uiNextMs = nowMs + 1000 / 30;
        broadcastLive({ type: 'pos', p: engine.positions(), j: engine.takeJumps(), beat: engine.beatAt(t), running: engine.master.running, rm: engine.runMask(), speed: engine.autoMaster.speed ?? engine.master.speed });
        if (cues.state === 'locked' || cues.state === 'freewheel' || clock.playing || clipRunner.runs.length) pushTcStatus();
        if (autoRunner.lanes.length) pushAutoStatus();
      }
      if (t - statT >= 1) sendStats(t);
    } catch (err) {
      console.error('[loop]', err);
    }
    frameMs = Infinity;
    for (const tg of output.targets) {
      const rt = targetRt.get(tg.id);
      if (tg.enabled && rt && rt.nextFrameMs < frameMs) frameMs = rt.nextFrameMs;
    }
    wakeMs = Math.min(uiNextMs, frameMs);
    const cand = [engine.nextEventTime(), cues.nextWake(nowMs / 1000), clipRunner.nextWake(nowMs / 1000)];
    for (const c of cand) {
      if (c === null) continue;
      const cMs = c * 1000;
      if (cMs > nowMs && cMs < wakeMs - 1) wakeMs = cMs;
    }
  }
  const ms = performance.now();
  schedule(wakeMs - ms, frameMs - ms);
}

// ---------------- presets ----------------
/**
 * quiet: cue recalls — no undo step and no toast (the cue toast reports it).
 * globals: 'preset' also applies the preset's bpm / speed (ramped over the fade) / tempo multiplier.
 */
function recallPreset(name, { ids = null, fade = null, quiet = false, ease = 'inOut', stagger = 0, order = 'id', seedOffset = 0, globals = 'keep' } = {}) {
  if (typeof name !== 'string' || !safeName(name)) {
    toast(L('srv.preset.badName'), 'error');
    return false;
  }
  try {
    const scene = presets.load(name);
    if (!quiet) pushUndo(true);
    const t = now();
    const n = engine.loadScene(scene, { onlyIds: ids, fade, t, ease, stagger, order, seedOffset, globals: 'keep' });
    if (globals === 'preset') {
      const dur = num(fade, 0, 60, engine.master.transition);
      if (scene.bpm !== undefined) engine.setBpm(scene.bpm, t);
      if (scene.speed !== undefined) engine.setSpeed(scene.speed, dur);
      if (scene.tempoMult !== undefined) engine.setTempoMult(scene.tempoMult);
    }
    const meta = presets.meta(name);
    lastPreset = { name: meta?.name ?? safeName(name), modified: false };
    if (!quiet) toast(L(engine.master.frozen ? 'srv.preset.loadedFrozen' : 'srv.preset.loaded', { name: lastPreset.name, n }));
    forceFrame = true;
    return true;
  } catch (err) {
    toast(L('srv.preset.loadFailed', { msg: err.code === 'ENOENT' ? L('srv.preset.noFile', { name: safeName(name) }) : errMsg(err) }), 'error');
    return false;
  }
}

function loadPreset(name, onlyIds = null, fade = null, globals = 'keep') {
  const ok = recallPreset(name, { ids: onlyIds, fade, globals });
  if (ok) clipRunner.release(onlyIds ?? presets.meta(name)?.ids ?? null);
  return ok;
}

function loadSlot(slot, onlyIds = null, fade = null, globals = 'keep') {
  const s = validSlot(slot);
  if (s === null) return false;
  const p = presets.bySlot(s);
  if (!p) {
    toast(L('srv.slot.empty', { slot: s }), 'warn');
    return false;
  }
  const ok = recallPreset(p.name, { ids: onlyIds, fade, globals });
  if (ok) clipRunner.release(onlyIds ?? p.ids);
  return ok;
}

function sanitizeImport(data) {
  if (!isPlainObject(data) || !Array.isArray(data.objects)) throw new LocalizedError('srv.preset.invalidFile');
  const used = new Set();
  const objects = [];
  for (const [i, o] of data.objects.filter(isPlainObject).slice(0, MAX_OBJECTS).entries()) {
    let id = strictInt(o.id);
    if (id === null || id < 1 || id > MAX_OBJECTS || used.has(id)) id = i + 1;
    if (used.has(id)) continue;
    used.add(id);
    objects.push(sanitizeObject({ ...o, id }, id));
  }
  if (!objects.length) throw new LocalizedError('srv.preset.noObjects');
  const scene = { objects };
  const bpm = num(data.bpm, 20, 300, null);
  const speed = num(data.speed, 0, 4, null);
  if (bpm !== null) scene.bpm = bpm;
  if (speed !== null) scene.speed = speed;
  if (TEMPO_MULTS.includes(Number(data.tempoMult))) scene.tempoMult = Number(data.tempoMult);
  if (validColor(data.color)) scene.color = data.color;
  if (typeof data.note === 'string') scene.note = cleanText(data.note, 120);
  return scene;
}

/** Cue numbers (1-based) that recall this preset by name, or by slot when they have no name. */
function cuesUsing(name) {
  const m = presets.meta(name);
  const key = (m?.name ?? safeName(name)).toLowerCase();
  const out = [];
  cues.cues.forEach((c, i) => {
    if (c.action !== 'slot') return;
    if (c.preset ? c.preset.toLowerCase() === key : m?.slot && c.slot === m.slot) out.push(i + 1);
  });
  return out;
}

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
/** Code/markup must never be stale after an update; images rarely change. */
const CACHEABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']);

function httpError(res, code, text) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

/** DNS-rebinding guard: only Host names this machine actually answers to. */
const extraHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
let hostCache = { at: 0, set: new Set() };
function allowedHosts() {
  const t = Date.now();
  if (t - hostCache.at < 30000) return hostCache.set;
  const set = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts]);
  const hn = os.hostname().toLowerCase();
  set.add(hn);
  set.add(`${hn}.local`);
  if (HOST) set.add(HOST.toLowerCase());
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) set.add(String(ni.address).toLowerCase().replace(/%.*$/, ''));
  }
  hostCache = { at: t, set };
  return set;
}

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  else if (h.split(':').length === 2) h = h.split(':')[0];
  if (h.endsWith('.')) h = h.slice(0, -1);
  return allowedHosts().has(h) || (h.endsWith('.localhost'));
}

/**
 * POST /api/assets — raw image bytes in the body. Same-origin only (Origin must match Host and the
 * X-Objitter header forces a CORS preflight, so a foreign page can't post here). Refused under Show Lock.
 */
function handleAssetUpload(req, res) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  if (!originAllowed(req.headers.origin, req.headers.host) || req.headers['x-objitter'] !== '1') {
    json(403, { error: 'forbidden' });
    req.resume();
    return;
  }
  if (showLock) {
    json(423, { error: 'locked', ...wire(L('srv.locked')) });
    req.resume();
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    json(413, { error: 'size', max: MAX_ASSET_BYTES });
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > MAX_ASSET_BYTES) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (over) { json(413, { error: 'size', max: MAX_ASSET_BYTES }); return; }
    try {
      const r = await assets.save(Buffer.concat(chunks));
      json(200, r);
    } catch (err) {
      if (err.code === 'type') json(415, { error: 'type' });
      else if (err.code === 'size') json(413, { error: 'size', max: MAX_ASSET_BYTES });
      else {
        console.error('[assets]', err);
        json(500, { error: 'write' });
      }
    }
  });
  req.on('error', () => { try { json(400, { error: 'read' }); } catch { /* closed */ } });
}

const MAX_LAYOUT_BYTES = 64 * 1024 * 1024;
const LAYOUT_TTL_MS = 10 * 60 * 1000;
const parsedLayouts = new Map();

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Parsed speaker layout: rooms with speakers, or an L() error. */
function parseLayoutText(text, filename) {
  let parsed;
  try {
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty file');
    parsed = parseLayout(text, filename);
  } catch (err) {
    return { error: L('srv.stage.parseFailed', { msg: String(err.message || err).slice(0, 160) }) };
  }
  const rooms = parsed.rooms.filter((r) => r.speakers.length);
  if (!rooms.length) return { error: L('srv.stage.noSpeakers') };
  return { format: parsed.format, rooms };
}

const layoutSummary = (p, filename) => ({
  format: p.format, filename: filename.slice(0, 120),
  rooms: p.rooms.map((r) => ({ index: r.index, name: r.name, count: r.speakers.length, subs: r.speakers.filter((s) => s.kind === 'sub').length, speakers: r.speakers })),
});

/** POST /api/layout?filename= — raw layout file (SPAT / L-ISA / CSV), too big for a WS message. */
function handleLayoutUpload(req, res) {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  if (!originAllowed(req.headers.origin, req.headers.host) || req.headers['x-objitter'] !== '1') {
    json(403, { error: 'forbidden' });
    req.resume();
    return;
  }
  if (showLock) {
    json(423, { error: 'locked', ...wire(L('srv.locked')) });
    req.resume();
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_LAYOUT_BYTES) {
    json(413, { error: 'size', max: MAX_LAYOUT_BYTES });
    req.resume();
    return;
  }
  let filename = '';
  try { filename = String(new URL(req.url, 'http://x').searchParams.get('filename') ?? '').normalize('NFC').slice(0, 200); } catch { /* bad url */ }
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > MAX_LAYOUT_BYTES) { over = true; chunks.length = 0; return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) { json(413, { error: 'size', max: MAX_LAYOUT_BYTES }); return; }
    const p = parseLayoutText(decodeText(Buffer.concat(chunks)), filename);
    if (p.error) { json(422, { error: 'parse', ...wire(p.error) }); return; }
    const now = Date.now();
    for (const [k, v] of parsedLayouts) if (now - v.at > LAYOUT_TTL_MS) parsedLayouts.delete(k);
    while (parsedLayouts.size >= 8) parsedLayouts.delete(parsedLayouts.keys().next().value);
    const token = crypto.randomBytes(9).toString('base64url');
    parsedLayouts.set(token, { at: now, filename, ...p });
    json(200, { token, ...layoutSummary(p, filename) });
  });
  req.on('error', () => { try { json(400, { error: 'read' }); } catch { /* closed */ } });
}

const server = http.createServer((req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) {
      httpError(res, 403, 'Forbidden host (allow it with the ALLOWED_HOSTS environment variable)');
      return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/assets') {
      handleAssetUpload(req, res);
      return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/layout') {
      handleLayoutUpload(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      httpError(res, 405, 'Method not allowed');
      return;
    }
    if (req.url.startsWith('/assets/') && !req.url.startsWith('/assets/icons/')) {
      const id = req.url.slice('/assets/'.length).split('?')[0];
      const f = assets.file(id);
      if (f) {
        fs.readFile(f, (err, data) => {
          if (err) { httpError(res, 404, 'Not found'); return; }
          res.writeHead(200, {
            'Content-Type': ASSET_MIME[id.split('.').pop()],
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
        return;
      }
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      httpError(res, 400, 'Bad request');
      return;
    }
    // ':' would allow NTFS alternate data streams (index.html::$DATA) and drive-relative paths.
    if (rel.includes('\0') || rel.includes(':')) {
      httpError(res, 400, 'Bad request');
      return;
    }
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel);
    const within = path.relative(PUBLIC_DIR, file);
    if (!within || within.split(/[\\/]/)[0] === '..' || path.isAbsolute(within)) {
      httpError(res, 403, 'Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      try {
        if (err) {
          httpError(res, 404, 'Not found');
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': CACHEABLE.has(ext) ? 'public, max-age=86400' : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch (e) {
        console.error('[http]', e);
      }
    });
  } catch (err) {
    console.error('[http]', err);
    try { httpError(res, 500, 'Internal error'); } catch { /* ignore */ }
  }
});

// ---------------- WebSocket ----------------
function originAllowed(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: MAX_SHOW_BYTES + 128 * 1024,
  verifyClient: ({ origin, req }) => hostAllowed(req.headers.host) && originAllowed(origin, req.headers.host),
});

function lanUrls() {
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') return [`http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${HTTP_PORT}`];
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${HTTP_PORT}`);
    }
  }
  return urls;
}

function staticInfo() {
  return {
    systems: describeSystems(),
    constants: {
      divisions: DIVISIONS, modes: MODES, maxObjects: MAX_OBJECTS, tempoMults: TEMPO_MULTS, stopModes: STOP_MODES,
      disableModes: DISABLE_MODES, rangeShapes: RANGE_SHAPES, pathOrders: PATH_ORDERS, pathCurves: PATH_CURVES,
      tempoModes: TEMPO_MODES, slots: SLOT_COUNT,
      cueActions: CUE_ACTIONS, clipKinds: CLIP_KINDS, clipThen: CLIP_THEN, tcInputs: TC_INPUTS, tcRates: TC_RATE_SETTINGS, lossModes: LOSS_MODES, maxCues: MAX_CUES,
      cueCurves: CUE_CURVES, staggerOrders: STAGGER_ORDERS, tcTriggers: TC_TRIGGERS, globalsModes: GLOBALS_MODES,
      autoParams: AUTO_PARAMS, masterAutoParams: MASTER_AUTO_PARAMS, autoModes: AUTO_MODES, autoGlobal: AUTO_GLOBAL, autoCurves: AUTO_CURVES,
      maxLanes: MAX_LANES, maxPoints: MAX_POINTS,
      maxTargets: MAX_TARGETS, palette: PALETTE, maxShowBytes: MAX_SHOW_BYTES, maxMsgBytes: MAX_MSG_BYTES,
      maxSessionBytes: MAX_SESSION_BYTES, outScale: SCALE_RANGE, outOffset: OFFSET_RANGE,
    },
    network: { http: HTTP_PORT, host: HOST ?? null, lan: lanUrls(), platform: process.platform, caffeinate: caffeinateActive },
    version: APP_VERSION,
    features: ['control.ws'],
  };
}

function dupSources() {
  const by = new Map();
  for (const o of engine.objects) {
    if (!o.enabled) continue;
    by.set(o.sourceId, [...(by.get(o.sourceId) || []), o.id]);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([sourceId, ids]) => ({ sourceId, ids }));
}

function dynState() {
  return {
    master: { ...engine.master },
    bpm: engine.clock.bpm,
    output,
    control: { ...control, port: controlPort(), portFromEnv: CONTROL_PORT_ENV !== null },
    controlStatus: oscIn.status,
    dupSources: dupSources(),
    lastPreset,
    canUndo: undoStack.length > 0,
    startupWarning,
    showLock,
    groups,
    session: currentSession ? { name: currentSession.name, modified: sessionSig() !== currentSession.sig } : null,
  };
}

/** Clients that stopped reading (buffer > 4 MB) are dropped so they can't grow server memory. */
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (c.bufferedAmount > MAX_BUFFERED_KILL) {
      c.terminate();
      continue;
    }
    c.send(data);
  }
}

/** Live data (positions/stats) is skipped for clients that can't keep up instead of queueing. */
function broadcastLive(msg) {
  let data = null;
  for (const c of wss.clients) {
    if (c.readyState !== 1 || c.bufferedAmount > MAX_BUFFERED) continue;
    data ??= JSON.stringify(msg);
    c.send(data);
  }
}

/** Identical toasts within 1 s are merged into one follow-up "(×n)". */
const toastWindow = new Map();
function toast(msg, level = 'info') {
  const w0 = wire(msg);
  const key = `${level}|${JSON.stringify(w0)}`;
  const w = toastWindow.get(key);
  if (w) {
    w.n++;
    return;
  }
  broadcast({ type: 'toast', ...w0, level });
  const entry = { n: 0 };
  toastWindow.set(key, entry);
  setTimeout(() => {
    toastWindow.delete(key);
    if (entry.n > 0) broadcast({ type: 'toast', ...w0, level, count: entry.n + 1 });
  }, 1000).unref();
}

const lastObjJson = engine.objects.map(() => '');
let lastDupKey = '';
let stateTimer = null;
function stateChanged(persist = true) {
  if (persist) saveStateSoon();
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const changed = [];
    engine.objects.forEach((o, i) => {
      const j = JSON.stringify(o);
      if (j !== lastObjJson[i]) {
        lastObjJson[i] = j;
        changed.push(o);
      }
    });
    const st = dynState();
    const dupKey = JSON.stringify(st.dupSources);
    if (dupKey !== lastDupKey) {
      if (st.dupSources.length) {
        toast(L('srv.dupSources', { list: st.dupSources.map((d) => L('srv.dupItem', { src: d.sourceId, ids: d.ids.join(', ') })) }), 'warn');
      }
      lastDupKey = dupKey;
    }
    broadcast({ type: 'state', state: st, objects: changed });
  }, 25);
}

function stageChanged(persist = true) {
  broadcast({ type: 'stage', stage });
  stateChanged(persist);
}

function presetsChanged() {
  broadcast({ type: 'presets', presets: presets.list() });
  stateChanged(false);
}

function libraryChanged() {
  broadcast({ type: 'library', ...library.list() });
}

const cuesUsingLib = (p) => cues.cues.map((c, i) => [c, i + 1])
  .filter(([c]) => (c.action === 'library' && c.lib.toLowerCase() === p.toLowerCase())
    || (c.clips ?? []).some((x) => x.kind === 'library' && x.params.path.toLowerCase() === p.toLowerCase()))
  .map(([, n]) => n);

/** Applies a library item's motion settings to ids (crossfaded like a preset recall). */
function applyLibrary(p, ids, { fade, ease, quiet = false, stagger = 0, order = 'id' } = {}) {
  const item = library.get(p);
  if (!item) {
    toast(L('srv.cue.libMissing', { name: String(p).slice(0, 80) }), 'warn');
    return false;
  }
  const list = ids.filter((id) => Number.isInteger(id) && id >= 1 && id <= MAX_OBJECTS);
  if (!list.length) return false;
  const patch = libPatch(item);
  if (!quiet) {
    pushUndo(true);
    autoTouch(list, autoParamsOf(patch));
  }
  const objects = list.map((id) => ({ ...deepMerge(engine.objects[id - 1], patch), id }));
  const t = now();
  engine.loadScene({ objects }, { onlyIds: list, fade: fade ?? engine.master.transition, t, ease, stagger, order, globals: 'keep' });
  markModified();
  forceFrame = true;
  stateChanged();
  return true;
}

/** undefined/null → all objects (null result); array → validated ids (may be empty). */
function idsOrAll(ids) {
  return ids === undefined || ids === null ? null : validIds(ids);
}

const reply = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};
const replyToast = (ws, msg, level = 'info') => reply(ws, { type: 'toast', ...wire(msg), level });
const oscLog = new OscLog((ws, msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(JSON.stringify(msg)); });
const replyErr = (ws, msg) => replyToast(ws, msg, 'error');
/** Asks the client to confirm; `msg` is re-sent as-is when the user agrees. */
const replyConfirm = (ws, text, yes, msg) => reply(ws, { type: 'confirm', ...wire(text), yes: wire(yes), msg });

/** Rejected while the show is locked. Transport, recall, GO and the internal clock stay available. */
const LOCKED_TYPES = new Set([
  'updateObjects', 'updateObjectsEach', 'nudgeCenter', 'setOutput', 'output.target.add', 'output.target.update',
  'output.target.remove', 'setControl', 'preset.save', 'preset.delete', 'preset.import', 'preset.setSlot', 'preset.meta',
  'preset.snapshot', 'slot.clear', 'undo', 'groups.save', 'groups.delete', 'tc.settings', 'tc.cue.add', 'tc.cue.update', 'tc.cue.delete',
  'tc.cue.move', 'tc.cues.clear', 'tc.show.import', 'lib.save', 'lib.delete', 'lib.move', 'lib.folder.add', 'lib.folder.delete',
  'session.load', 'session.delete', 'session.rename', 'session.import',
  'stage.set', 'stage.layout', 'stage.clear', 'stage.speaker.add', 'stage.speaker.update', 'stage.speaker.delete',
  'auto.lane.add', 'auto.lane.update', 'auto.lane.delete', 'auto.points', 'auto.arm',
]);
const LOCKED_MASTER_KEYS = ['stopMode', 'disableMode', 'maxVelocity', 'vmaxExceptJumps', 'reseedOnStart'];

function cueErrorText(errors) {
  return L('srv.cue.errors', { list: errors.slice(0, 3), more: errors.length > 3 ? L('srv.cue.more', { n: errors.length - 3 }) : '' });
}

function defaultNewCueTc() {
  const rate = cues.rate();
  const st = cues.status(now());
  if (st.tc) return st.tc.replace(';', ':');
  const last = cues.cues[cues.cues.length - 1];
  const lt = last ? parseTc(last.tc) : null;
  if (!lt) return '00:00:00:00';
  return formatTc(secondsToTc(tcToSeconds(lt, rate) + 10, rate));
}

function handleClientMessage(ws, m) {
  if (!isPlainObject(m) || typeof m.type !== 'string') return;
  if (showLock && LOCKED_TYPES.has(m.type)) {
    lockedToast(ws);
    return;
  }
  switch (m.type) {
    case 'hello':
      if (typeof m.clientId === 'string' && /^[A-Za-z0-9-]{4,64}$/.test(m.clientId)) ws.clientId = m.clientId;
      for (let i = 0; i < MAX_OBJECTS; i++) lastObjJson[i] ||= JSON.stringify(engine.objects[i]);
      reply(ws, {
        type: 'init', static: staticInfo(), state: dynState(), objects: engine.objects, presets: presets.list(),
        sessions: sessions.list(), tc: tcState(), tcs: tcStatus(), you: ws.cid, stage,
        auto: { lanes: autoRunner.lanes, global: autoRunner.global }, autos: autoRunner.status(),
        library: library.list(),
      });
      return;
    case 'lock.set': {
      const v = toBool(m.locked, null);
      if (v === null || v === showLock) return;
      showLock = v;
      toast(L(v ? 'srv.lock.on' : 'srv.lock.off', { who: ws.label }), v ? 'info' : 'warn');
      break;
    }
    case 'control': {
      // Same command set and Show Lock rules as the OSC control input, for clients that can't rely on UDP
      // reaching this instance (e.g. the control port is held by another program). Not subject to control.allow:
      // a WebSocket client already passed the host/origin checks and has full UI access.
      if (typeof m.address !== 'string' || m.address.length > 512 || !Array.isArray(m.args) || m.args.length > 16) return;
      const args = m.args.filter((v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || typeof v === 'boolean');
      if (args.length !== m.args.length) return;
      if (oscLog.active) oscLog.add('in', `ws:${ws.label}`, m.address, args);
      handleControlMessage({ address: m.address, args });
      return;
    }
    case 'tc.frame': {
      if (!tcSource || tcSource.ws !== ws || m.kind !== cues.settings.input || typeof m.tc !== 'string') return;
      const tc = parseTc(m.tc);
      if (!tc || tc.neg) return;
      tcSource.lastFrameAt = now();
      const at = num(m.at, 0, Number.MAX_SAFE_INTEGER, null);
      runTcActions(cues.input({ tc, sub: num(m.sub, -60, 60, 0), rate: normalizeRate(m.rate), src: { kind: m.kind }, kind: m.kind, at }, now()));
      pushTcStatus();
      return;
    }
    case 'tc.claim': {
      if (m.kind !== 'mtc' && m.kind !== 'ltc') return;
      const prev = tcSource;
      const same = prev && (prev.ws === ws || (ws.clientId && prev.clientId === ws.clientId));
      if (m.resume === true && prev && !same) return;
      if (!same && m.force !== true) {
        if (prev && now() - (prev.lastFrameAt ?? -Infinity) < CLAIM_BUSY_S) {
          replyConfirm(ws, L('srv.tc.claimBusy', { who: prev.label }), L('srv.tc.take'), { ...m, force: true, resume: false });
          return;
        }
        if (showLock && (cues.settings.input !== m.kind || prev)) {
          replyConfirm(ws, L('srv.tc.claimLocked'), L('srv.tc.change'), { ...m, force: true, resume: false });
          return;
        }
      }
      if (prev && !same) reply(prev.ws, { type: 'tc.source.lost', reason: L('srv.tc.takenBy', { who: ws.label }) });
      tcSource = { ws, cid: ws.cid, clientId: ws.clientId ?? null, label: ws.label, kind: m.kind, lastFrameAt: same ? prev.lastFrameAt : null };
      if (cues.settings.input !== m.kind) cues.setSettings({ input: m.kind });
      tcChanged();
      return;
    }
    case 'tc.release':
      if (tcSource?.ws !== ws) return;
      tcSource = null;
      runTcActions(cues.stop());
      tcChanged();
      return;
    case 'tc.settings': {
      if (!isPlainObject(m.patch)) return;
      const before = cues.settings.input;
      cues.setSettings(m.patch);
      if (tcSource && tcSource.kind !== cues.settings.input) {
        reply(tcSource.ws, { type: 'tc.source.lost', reason: L('srv.tc.inputChanged', { input: cues.settings.input.toUpperCase() }) });
        toast(L('srv.tc.inputChangedToast', { from: before.toUpperCase(), to: cues.settings.input.toUpperCase(), who: tcSource.label }), 'warn');
        tcSource = null;
      }
      if (cues.settings.input !== 'internal' && clock.playing) clock.pause(now());
      tcChanged();
      return;
    }
    case 'osclog.sub':
      oscLog.subscribe(ws, !!m.on);
      return;
    case 'tc.int.play': case 'tc.int.pause': case 'tc.int.toggle': case 'tc.int.locate': case 'tc.int.rewind':
      internalTransport(m.type.slice(7), m.tc, ws);
      return;
    case 'tc.go':
      runTcActions(cues.go(now()));
      pushTcStatus(true);
      return;
    case 'tc.back':
      if (cues.back()) pushTcStatus(true);
      return;
    case 'tc.standby': {
      const n = strictInt(m.index);
      if (n !== null && cues.standbyTo(n)) pushTcStatus(true);
      return;
    }
    case 'tc.cue.fire': {
      const cue = cues.cues.find((c) => c.id === m.id);
      if (!cue) return;
      runTcActions([cues.fire(cue, 'manual', null, 0)]);
      return;
    }
    case 'tc.cue.playFrom': {
      const cue = cues.cues.find((c) => c.id === m.id);
      if (!cue) return;
      const tc = parseTc(cue.tc);
      const sec = Math.max(0, tcToSeconds(tc, cues.rate()) - cues.settings.preroll);
      if (internalTransport('locate', formatTc(secondsToTc(sec, cues.rate())), ws)) internalTransport('play', null, ws);
      return;
    }
    case 'tc.cue.add': {
      if (cues.cues.length >= MAX_CUES) {
        replyErr(ws, L('srv.cue.max', { max: MAX_CUES }));
        return;
      }
      const src = isPlainObject(m.cue) ? { ...m.cue } : {};
      delete src.id;
      if (!('tc' in src)) {
        if (m.atCurrent && !cues.status(now()).tc) {
          replyErr(ws, L('srv.cue.noTc'));
          return;
        }
        src.tc = defaultNewCueTc();
      }
      if ((src.action ?? 'slot') === 'slot' && !('slot' in src) && !('preset' in src)) {
        const last = [...cues.cues].reverse().find((c) => c.action === 'slot');
        const slot = last?.slot ? (last.slot % SLOT_COUNT) + 1 : 1;
        src.slot = slot;
      }
      const { cue, errors } = validateCue(src, defaultCue(), { rate: cues.rate() });
      const tg = cue?.targets ? resolveTargets(cue.targets) : {};
      if (!cue || tg.error) {
        replyErr(ws, cueErrorText(cue ? [tg.error] : errors));
        return;
      }
      const filled = fillCuePreset(cue);
      cues.setCues([...cues.cues, filled]);
      tcChanged();
      reply(ws, { type: 'tc.cue.added', id: filled.id });
      return;
    }
    case 'tc.cue.update': {
      const cur = cues.cues.find((c) => c.id === m.id);
      if (!cur || !isPlainObject(m.patch)) return;
      const patch = { ...m.patch };
      delete patch.id;
      if ('slot' in patch && !('preset' in patch) && cur.action === 'slot') patch.preset = '';
      if ('preset' in patch && !('slot' in patch)) patch.slot = null;
      const { cue, errors } = validateCue(patch, cur, { rate: cues.rate() });
      const tg = cue?.targets ? resolveTargets(cue.targets) : {};
      if (!cue || tg.error) {
        replyErr(ws, cueErrorText(cue ? [tg.error] : errors));
        tcSent.cues.delete(cur.id);
        tcChanged();
        return;
      }
      cues.setCues(cues.cues.map((c) => (c.id === cur.id ? fillCuePreset(cue) : c)));
      if (JSON.stringify(cue) !== JSON.stringify(cur)) cues.invalidate('scene');
      tcChanged();
      return;
    }
    case 'tc.cue.move': {
      const i = cues.cues.findIndex((c) => c.id === m.id);
      const d = m.delta === -1 || m.delta === 1 ? m.delta : 0;
      const j = i + d;
      if (i < 0 || !d || j < 0 || j >= cues.cues.length || cues.cues[j].tc !== cues.cues[i].tc) {
        replyErr(ws, L('srv.cue.moveSameTc'));
        return;
      }
      const list = [...cues.cues];
      [list[i], list[j]] = [list[j], list[i]];
      cues.setCues(list);
      tcChanged();
      return;
    }
    case 'tc.cue.delete':
      if (!cues.cues.some((c) => c.id === m.id)) return;
      cues.setCues(cues.cues.filter((c) => c.id !== m.id));
      tcChanged();
      return;
    case 'tc.cues.clear':
      cues.setCues([]);
      tcChanged();
      toast(L('srv.cue.cleared'));
      return;
    case 'tc.show.get':
      reply(ws, { type: 'tc.show.data', data: showFile() });
      return;
    case 'tc.show.preview':
      reply(ws, { type: 'tc.show.preview', ...publicPreview(previewShow(m.data)) });
      return;
    case 'tc.show.import':
      try {
        const r = importShow(m.data, m.applySlots === true);
        tcChanged();
        stateChanged();
        toast(L('srv.show.imported', {
          n: r.cues,
          slots: m.applySlots === true ? L('srv.show.importedSlots', { n: r.slots }) : '',
          missing: r.missing.length ? L('srv.show.importedMissing', { list: r.missing.slice(0, 5).join(', ') }) : '',
        }), r.missing.length ? 'warn' : 'info');
      } catch (err) {
        replyErr(ws, L('srv.show.importFailed', { msg: errMsg(err) }));
      }
      return;
    case 'slot.clear': {
      const s = validSlot(m.slot);
      const p = s === null ? null : presets.bySlot(s);
      if (!p) return;
      presets.setSlot(p.name, null).catch((err) => toast(L('srv.slot.clearFailed', { msg: errMsg(err) }), 'error'));
      presetsChanged();
      return;
    }
    case 'updateObjects': {
      const ids = validIds(m.ids);
      if (!ids.length || !isPlainObject(m.patch)) return;
      pushUndo();
      autoTouch(ids, autoParamsOf(m.patch));
      engine.updateObjects(ids, m.patch);
      cues.invalidate('scene', ids);
      markModified();
      if (engine.master.livePreview) kick();
      break;
    }
    case 'updateObjectsEach': {
      if (!Array.isArray(m.items)) return;
      const seen = new Set();
      const items = m.items.slice(0, MAX_OBJECTS * 2).filter((it) => {
        const id = strictInt(it?.id);
        if (id === null || id < 1 || id > MAX_OBJECTS || seen.has(id) || !isPlainObject(it.patch)) return false;
        seen.add(id);
        return true;
      });
      if (!items.length) return;
      pushUndo();
      for (const it of items) {
        autoTouch([strictInt(it.id)], autoParamsOf(it.patch));
        engine.updateObject(strictInt(it.id), it.patch);
      }
      cues.invalidate('scene', [...seen]);
      markModified();
      if (engine.master.livePreview) kick();
      break;
    }
    case 'nudgeCenter': {
      const ids = validIds(m.ids);
      if (!ids.length) return;
      pushUndo();
      autoTouch(ids, ['center.x', 'center.y', 'center.z']);
      engine.nudgeCenters(ids, num(m.dx, -2, 2, 0), num(m.dy, -2, 2, 0), num(m.dz, -2, 2, 0));
      cues.invalidate('scene', ids);
      markModified();
      if (engine.master.livePreview) kick();
      break;
    }
    case 'home':
    case 'recenter': {
      const ids = idsOrAll(m.ids) ?? allIds();
      if (!ids.length) return;
      engine.home(ids, num(m.fade, 0, 60, engine.master.transition));
      cues.invalidate('scene', ids);
      forceFrame = true;
      break;
    }
    case 'obj.run': {
      const ids = validIds(m.ids);
      if (!ids.length || !engine.setObjectsRunning(ids, m.play).length) return;
      kick();
      break;
    }
    case 'master': {
      const patch = { ...m };
      if (showLock && LOCKED_MASTER_KEYS.some((k) => k in patch)) {
        for (const k of LOCKED_MASTER_KEYS) delete patch[k];
        lockedToast(ws);
      }
      const wasRun = engine.master.running;
      const wasFrozen = engine.master.frozen;
      engine.applyMaster(patch);
      if (engine.master.running !== wasRun) cues.invalidate('run');
      if (engine.master.frozen !== wasFrozen) cues.invalidate('freeze');
      if (engine.master.running !== wasRun) forceFrame = true;
      if (wasRun && !engine.master.running) {
        clipRunner.stopAll();
        autoRunner.stopRuns(now());
      }
      if ('speed' in patch) autoTouch(['master'], ['speed']);
      break;
    }
    case 'tap':
      engine.tap();
      break;
    case 'bpm':
      if (!engine.setBpm(m.bpm)) return;
      break;
    case 'resync':
      engine.resync();
      break;
    case 'undo':
      undo();
      break;
    case 'setOutput': {
      if (!isPlainObject(m.patch)) return;
      output = { ...output, precise: toBool(m.patch.precise, output.precise) };
      onOutputChanged();
      break;
    }
    case 'output.target.add': {
      if (output.targets.length >= MAX_TARGETS) {
        replyErr(ws, L('srv.out.max', { max: MAX_TARGETS }));
        return;
      }
      const id = newTargetId(output.targets);
      const src = output.targets.find((t) => t.id === m.copyOf) ?? (m.mirror ? output.targets[0] : null);
      let t;
      if (src) {
        const suffix = typeof m.suffix === 'string' && m.suffix.trim() ? m.suffix : (m.mirror ? 'backup' : 'copy');
        t = { ...structuredClone(src), id, name: cleanText(`${src.name} ${suffix}`, 32) };
      } else {
        const sys = Object.hasOwn(SYSTEMS, m.system) ? m.system : 'spat';
        t = defaultTarget(sys, id);
      }
      output = { ...output, targets: [...output.targets, t] };
      onOutputChanged();
      break;
    }
    case 'output.target.update': {
      const cur = output.targets.find((t) => t.id === m.id);
      if (!cur || !isPlainObject(m.patch)) return;
      const next = sanitizeTarget(m.patch, cur);
      if (m.patch.host !== undefined && next.host !== String(m.patch.host).trim()) {
        replyErr(ws, L('srv.out.badHost', { host: String(m.patch.host).slice(0, 64) }));
      }
      if (isPlainObject(m.patch.transform)) {
        const bad = [...SCALE_KEYS, ...OFFSET_KEYS].filter((k) => m.patch.transform[k] !== undefined
          && Number(m.patch.transform[k]) !== next.transform[k]);
        if (bad.length) {
          replyErr(ws, L('srv.out.badScale', {
            keys: bad.join(', '), smin: SCALE_RANGE.min, smax: SCALE_RANGE.max, omin: OFFSET_RANGE.min, omax: OFFSET_RANGE.max,
          }));
        }
      }
      output = { ...output, targets: output.targets.map((t) => (t.id === cur.id ? next : t)) };
      onOutputChanged();
      break;
    }
    case 'output.target.remove': {
      if (output.targets.length <= 1) {
        replyErr(ws, L('srv.out.lastTarget'));
        return;
      }
      if (!output.targets.some((t) => t.id === m.id)) return;
      output = { ...output, targets: output.targets.filter((t) => t.id !== m.id) };
      onOutputChanged();
      break;
    }
    case 'setControl': {
      if (!isPlainObject(m.patch)) return;
      const next = sanitizeControl({ ...control, ...m.patch }, control);
      if (typeof m.patch.allow === 'string' && m.patch.allow.split(/[\s,]+/).filter(Boolean).join(', ') !== next.allow) {
        replyErr(ws, L('srv.ctl.badAllow'));
      }
      if ('port' in m.patch && CONTROL_PORT_ENV !== null) {
        replyToast(ws, L('srv.ctl.envPort', { port: CONTROL_PORT_ENV }), 'warn');
      }
      control = next;
      applyControlInput();
      break;
    }
    case 'groups.save': {
      const name = typeof m.name === 'string' ? cleanText(m.name, 24).replace(/[@,]/g, '').trim() : '';
      const ids = validIds(m.ids);
      if (!name || !ids.length) {
        replyErr(ws, L('srv.group.needName'));
        return;
      }
      const rest = groups.filter((g) => g.name.toLowerCase() !== name.toLowerCase());
      if (rest.length >= MAX_GROUPS) {
        replyErr(ws, L('srv.group.max', { max: MAX_GROUPS }));
        return;
      }
      const prev = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
      const g = { name, ids: ids.sort((a, b) => a - b), color: 'color' in m ? validColor(m.color) : prev?.color ?? null };
      groups = prev ? groups.map((x) => (x === prev ? g : x)) : [...groups, g];
      cues.invalidate('scene');
      toast(L('srv.group.saved', { name, n: ids.length }));
      break;
    }
    case 'groups.delete': {
      const name = String(m.name ?? '').toLowerCase();
      const used = cues.cues.map((c, i) => (c.targets && c.targets.toLowerCase().split(',').some((p) => p.trim() === `@${name}`) ? i + 1 : 0)).filter(Boolean);
      if (used.length && m.force !== true) {
        replyConfirm(ws, L('srv.group.inUse', { name: String(m.name), cues: used.join('·') }), L('common.delete'), { ...m, force: true });
        return;
      }
      groups = groups.filter((g) => g.name.toLowerCase() !== name);
      break;
    }
    case 'preset.save': {
      const name = safeName(m.name);
      if (!name) {
        replyErr(ws, L('srv.preset.needName'));
        return;
      }
      let ids = idsOrAll(m.ids);
      if (ids && !ids.length) {
        replyErr(ws, L('srv.noSelection'));
        return;
      }
      const existing = presets.meta(name);
      if (m.overwrite !== true && existing) {
        replyConfirm(ws, L('srv.preset.exists', { name: existing.name }), L('common.overwrite'), { ...m, overwrite: true });
        return;
      }
      if (m.keepScope === true && existing?.ids.length) ids = existing.ids;
      const scene = engine.getScene(ids);
      if (m.saveGlobals === false) {
        delete scene.bpm;
        delete scene.speed;
        delete scene.tempoMult;
      }
      presets.save(name, scene).then((saved) => {
        lastPreset = { name: saved, modified: false };
        toast(ids ? L('srv.preset.savedN', { name: saved, n: ids.length }) : L('srv.preset.saved', { name: saved }));
        presetsChanged();
        stateChanged();
      }).catch((err) => toast(L('srv.saveFailed', { msg: errMsg(err) }), 'error'));
      return;
    }
    case 'preset.load': {
      const ids = idsOrAll(m.ids);
      if (ids && !ids.length) {
        replyErr(ws, L('srv.noSelection'));
        return;
      }
      if (!loadPreset(m.name, ids, num(m.fade, 0, 60, null), m.globals === 'preset' ? 'preset' : 'keep')) return;
      cues.invalidate('scene', ids);
      break;
    }
    case 'slot.load': {
      const ids = idsOrAll(m.ids);
      if (ids && !ids.length) return;
      if (!loadSlot(m.slot, ids, num(m.fade, 0, 60, null), m.globals === 'preset' ? 'preset' : 'keep')) return;
      cues.invalidate('scene', ids);
      break;
    }
    case 'lib.save': {
      const id = strictInt(m.id);
      if (id === null || id < 1 || id > MAX_OBJECTS) return;
      const obj = engine.objects[id - 1];
      library.save({ folder: m.folder, name: m.name, obj, includeRegion: m.includeRegion === true, note: m.note, overwrite: m.overwrite === true })
        .then((it) => {
          toast(L('srv.lib.saved', { name: it.path }));
          reply(ws, { type: 'lib.saved', path: it.path });
          libraryChanged();
        })
        .catch((err) => {
          if (err.key === 'srv.lib.exists' && m.overwrite !== true) replyConfirm(ws, L('srv.lib.exists', err.params), L('lib.overwrite'), { ...m, overwrite: true });
          else replyErr(ws, L('srv.lib.failed', { msg: errMsg(err) }));
        });
      return;
    }
    case 'lib.delete': {
      const it = library.get(m.path);
      if (!it) { replyErr(ws, L('srv.lib.missing', { name: String(m.path).slice(0, 80) })); return; }
      const used = cuesUsingLib(it.path);
      if (used.length && m.force !== true) {
        replyConfirm(ws, L('srv.lib.inUse', { name: it.path, cues: used.join('·') }), L('common.delete'), { ...m, force: true });
        return;
      }
      library.remove(it.path)
        .then(() => { toast(L('srv.lib.deleted', { name: it.path })); libraryChanged(); })
        .catch((err) => replyErr(ws, L('srv.lib.failed', { msg: errMsg(err) })));
      return;
    }
    case 'lib.move':
      library.move(m.path, m.folder, m.name)
        .then((it) => { toast(L('srv.lib.moved', { name: it.path })); libraryChanged(); })
        .catch((err) => replyErr(ws, L('srv.lib.failed', { msg: errMsg(err) })));
      return;
    case 'lib.folder.add':
      library.addFolder(m.path)
        .then((p) => { toast(L('srv.lib.folderAdded', { name: p })); reply(ws, { type: 'lib.folder.added', path: p }); libraryChanged(); })
        .catch((err) => replyErr(ws, L('srv.lib.failed', { msg: errMsg(err) })));
      return;
    case 'lib.folder.delete':
      library.removeFolder(m.path)
        .then((p) => { toast(L('srv.lib.folderDeleted', { name: p })); libraryChanged(); })
        .catch((err) => replyErr(ws, L('srv.lib.failed', { msg: errMsg(err) })));
      return;
    case 'lib.apply': {
      const ids = validIds(m.ids);
      const it = library.get(m.path);
      if (!it) { replyErr(ws, L('srv.lib.missing', { name: String(m.path).slice(0, 80) })); return; }
      if (!ids.length) { replyErr(ws, L('srv.noSelection')); return; }
      clipRunner.release(ids);
      if (applyLibrary(it.path, ids, { fade: m.fade === undefined || m.fade === null ? undefined : num(m.fade, 0, 60, engine.master.transition) })) {
        cues.invalidate('scene', ids);
        toast(L('srv.lib.applied', { name: it.name, n: ids.length }));
      }
      return;
    }
    case 'preset.delete': {
      const meta = presets.meta(m.name);
      if (!meta) {
        replyErr(ws, L('srv.preset.deleteMissing', { name: safeName(m.name) }));
        return;
      }
      const used = cuesUsing(meta.name);
      if (used.length && m.force !== true) {
        replyConfirm(ws, L('srv.preset.inUse', { name: meta.name, cues: used.join('·') }), L('common.delete'), { ...m, force: true });
        return;
      }
      try {
        presets.remove(meta.name);
        if (lastPreset?.name === meta.name) lastPreset = null;
        toast(L('srv.preset.deleted', { name: meta.name }));
        presetsChanged();
        tcChanged();
      } catch (err) {
        toast(L('srv.deleteFailed', { msg: errMsg(err) }), 'error');
      }
      break;
    }
    case 'preset.meta': {
      try {
        const patch = {};
        if ('color' in m) patch.color = m.color;
        if ('note' in m) patch.note = m.note;
        presets.setMeta(m.name, patch).catch((err) => toast(L('srv.preset.metaFailed', { msg: errMsg(err) }), 'error'));
        presetsChanged();
      } catch (err) {
        replyErr(ws, errMsg(err));
      }
      return;
    }
    case 'preset.import':
      try {
        const name = safeName(m.name);
        if (!name) throw new LocalizedError('srv.preset.badName');
        const scene = sanitizeImport(m.data);
        if (m.overwrite !== true && presets.meta(name)) {
          replyConfirm(ws, L('srv.preset.importExists', { name }), L('common.overwrite'), { ...m, overwrite: true });
          return;
        }
        presets.save(name, scene).then(() => {
          toast(L('srv.preset.imported', { name, n: scene.objects.length }));
          presetsChanged();
        }).catch((err) => replyErr(ws, L('srv.importFailed', { msg: errMsg(err) })));
      } catch (err) {
        replyErr(ws, L('srv.importFailed', { msg: errMsg(err) }));
      }
      return;
    case 'preset.get':
      try {
        reply(ws, { type: 'preset.data', name: safeName(m.name), data: presets.load(m.name) });
      } catch (err) {
        replyErr(ws, L('srv.exportFailed', { msg: errMsg(err) }));
      }
      return;
    case 'preset.snapshot': {
      const slot = validSlot(m.slot);
      if (slot === null) {
        replyErr(ws, L('srv.slot.range', { max: SLOT_COUNT }));
        return;
      }
      const name = `Slot ${String(slot).padStart(2, '0')}`;
      const holder = presets.bySlot(slot);
      if (holder && m.overwrite !== true) {
        replyConfirm(ws, L('srv.slot.snapshotReplace', { slot, name: holder.name }), L('common.overwrite'), { ...m, overwrite: true });
        return;
      }
      const other = presets.meta(name);
      if (other && other.slot !== null && other.slot !== slot && m.overwrite !== true) {
        replyConfirm(ws, L('srv.slot.snapshotNameUsed', { name: other.name, slot: other.slot }), L('common.overwrite'), { ...m, overwrite: true });
        return;
      }
      presets.save(name, engine.getScene(null))
        .then((saved) => presets.setSlot(saved, slot).then(() => saved))
        .then((saved) => {
          lastPreset = { name: saved, modified: false };
          toast(L('srv.slot.snapshotSaved', { slot, name: saved }));
          presetsChanged();
          tcChanged();
          stateChanged();
        })
        .catch((err) => toast(L('srv.saveFailed', { msg: errMsg(err) }), 'error'));
      return;
    }
    case 'preset.setSlot':
      try {
        const slot = m.slot === null || m.slot === '' || m.slot === undefined ? null : validSlot(m.slot);
        if (slot === null && !(m.slot === null || m.slot === '' || m.slot === undefined)) throw new LocalizedError('srv.slot.range', { max: SLOT_COUNT });
        presets.setSlot(m.name, slot).catch((err) => toast(L('srv.slot.saveFailed', { msg: errMsg(err) }), 'error'));
        presetsChanged();
        tcChanged();
      } catch (err) {
        replyErr(ws, L('srv.slot.assignFailed', { msg: errMsg(err) }));
      }
      return;
    case 'session.list':
      reply(ws, { type: 'sessions', sessions: sessions.list() });
      return;
    case 'session.save': {
      const name = safeName(m.name);
      if (!name) {
        replyErr(ws, L('srv.session.needName'));
        return;
      }
      const existing = sessions.meta(name);
      const isCurrent = existing && currentSession && existing.name.toLowerCase() === currentSession.name.toLowerCase();
      if (existing && m.overwrite !== true && !isCurrent) {
        replyConfirm(ws, L('srv.session.exists', { name: existing.name }), L('common.overwrite'), { ...m, overwrite: true });
        return;
      }
      saveSession(name, { ws, overwrite: true });
      return;
    }
    case 'session.load': {
      const meta = sessions.meta(m.name);
      if (!meta) {
        replyErr(ws, L('srv.session.notFound', { name: safeName(m.name) }));
        return;
      }
      loadSession(meta.name, { ws, includeOutput: m.includeOutput === true });
      return;
    }
    case 'session.delete': {
      const meta = sessions.meta(m.name);
      if (!meta) {
        replyErr(ws, L('srv.session.notFound', { name: safeName(m.name) }));
        return;
      }
      try {
        sessions.remove(meta.name);
        if (currentSession?.name.toLowerCase() === meta.name.toLowerCase()) currentSession = null;
        toast(L('srv.session.deleted', { name: meta.name }));
        sessionsChanged();
      } catch (err) {
        replyErr(ws, L('srv.deleteFailed', { msg: errMsg(err) }));
      }
      return;
    }
    case 'session.rename': {
      sessions.rename(m.name, m.to).then((to) => {
        if (currentSession?.name.toLowerCase() === safeName(m.name).toLowerCase()) currentSession = { ...currentSession, name: to };
        toast(L('srv.session.renamed', { from: safeName(m.name), to }));
        sessionsChanged();
      }).catch((err) => replyErr(ws, L('srv.session.renameFailed', { msg: errMsg(err) })));
      return;
    }
    case 'session.export': {
      try {
        const meta = m.name === undefined || m.name === null ? null : sessions.meta(m.name);
        if (m.name !== undefined && m.name !== null && !meta) throw new LocalizedError('srv.session.notFound', { name: safeName(m.name) });
        const data = meta ? sessions.load(meta.name) : sessionFile(currentSession?.name ?? 'Objitter session');
        reply(ws, { type: 'session.data', name: meta?.name ?? data.name, data });
      } catch (err) {
        replyErr(ws, L('srv.exportFailed', { msg: errMsg(err) }));
      }
      return;
    }
    case 'session.import': {
      try {
        const v = validateSession(m.data);
        const name = safeName(m.name) || v.name;
        if (!name) throw new LocalizedError('srv.session.needName');
        if (m.overwrite !== true && sessions.meta(name)) {
          replyConfirm(ws, L('srv.session.importExists', { name }), L('common.overwrite'), { ...m, overwrite: true });
          return;
        }
        sessions.save(name, { ...v.raw, name }).then((saved) => {
          toast(L('srv.session.imported', { name: saved }));
          sessionsChanged();
        }).catch((err) => replyErr(ws, L('srv.importFailed', { msg: errMsg(err) })));
      } catch (err) {
        replyErr(ws, L('srv.importFailed', { msg: errMsg(err) }));
      }
      return;
    }
    case 'stage.set': {
      const next = sanitizeStage({ ...m.patch, speakers: isPlainObject(m.patch?.speakers) ? { ...m.patch.speakers, items: undefined } : undefined }, stage);
      if (JSON.stringify(next) === JSON.stringify(stage)) return;
      stage = next;
      stageChanged();
      return;
    }
    case 'stage.layout.parse':
    case 'stage.layout': {
      let filename = typeof m.filename === 'string' ? m.filename : '';
      let parsed;
      if (typeof m.token === 'string') {
        const hit = parsedLayouts.get(m.token);
        if (!hit) { replyErr(ws, L('srv.stage.layoutExpired')); return; }
        parsed = hit;
        filename = hit.filename;
      } else {
        parsed = parseLayoutText(m.text, filename);
        if (parsed.error) { replyErr(ws, parsed.error); return; }
      }
      const { rooms } = parsed;
      if (m.type === 'stage.layout.parse') {
        reply(ws, { type: 'stage.layout.parsed', ...layoutSummary(parsed, filename) });
        return;
      }
      if (m.token) parsedLayouts.delete(m.token);
      const room = rooms.find((r) => r.index === m.room) ?? rooms[0];
      const fname = filename.replace(/\.[^.]+$/, '');
      stage = sanitizeStage({
        speakers: {
          name: rooms.length > 1 ? `${fname} — ${room.name}` : fname || room.name,
          source: parsed.format,
          items: room.speakers.slice(0, MAX_SPEAKERS),
          transform: { metersPerUnit: fitScale(room.speakers), offsetX: 0, offsetY: 0, rotation: 0, mirrorX: false },
          visible: true,
        },
      }, stage);
      toast(L('srv.stage.layoutLoaded', { n: stage.speakers.items.length, name: stage.speakers.name }));
      stageChanged();
      return;
    }
    case 'stage.speaker.add':
    case 'stage.speaker.update':
    case 'stage.speaker.delete': {
      const items = stage.speakers.items.map((it) => ({ ...it }));
      const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(1000, Math.max(-1000, Number(v))) : d);
      let idx = null;
      if (m.type !== 'stage.speaker.add') {
        idx = strictInt(m.index);
        if (idx === null || idx < 0 || idx >= items.length) { replyErr(ws, L('srv.stage.spBadIndex')); return; }
      }
      const sp = { ...stage.speakers, items };
      if (m.type === 'stage.speaker.add') {
        if (items.length >= MAX_SPEAKERS) { replyErr(ws, L('srv.stage.spMax', { max: MAX_SPEAKERS })); return; }
        const kind = m.kind === 'sub' ? 'sub' : 'main';
        const n = items.filter((it) => it.kind === kind).length + 1;
        items.push({
          name: typeof m.name === 'string' && m.name.trim() ? m.name : `${kind === 'sub' ? 'SUB' : 'SPK'} ${n}`,
          x: num(m.x, 0), y: num(m.y, 0), z: num(m.z, 0), yaw: null, kind, group: '',
        });
        if (items.length === 1 && !stage.speakers.source) {
          sp.name = sp.name || 'Manual';
          sp.source = 'manual';
          sp.transform = { ...sp.transform, metersPerUnit: 5 };
        }
      } else if (m.type === 'stage.speaker.update') {
        const p = isPlainObject(m.patch) ? m.patch : {};
        const it = items[idx];
        if (typeof p.name === 'string' && p.name.trim()) it.name = p.name;
        for (const k of ['x', 'y', 'z']) if (k in p) it[k] = num(p[k], it[k]);
        if ('yaw' in p) it.yaw = p.yaw === null ? null : num(p.yaw, it.yaw);
        if (p.kind === 'sub' || p.kind === 'main') it.kind = p.kind;
      } else {
        items.splice(idx, 1);
      }
      const next = sanitizeStage({ speakers: sp }, stage);
      if (JSON.stringify(next) === JSON.stringify(stage)) return;
      stage = next;
      stageChanged();
      if (m.type === 'stage.speaker.add') reply(ws, { type: 'stage.speaker.added', index: items.length - 1 });
      return;
    }
    case 'stage.clear': {
      const d = defaultStage();
      if (m.what === 'background') stage = { ...stage, background: d.background };
      else if (m.what === 'speakers') stage = { ...stage, speakers: d.speakers };
      else return;
      stageChanged();
      return;
    }
    case 'auto.lane.add': {
      if (autoRunner.lanes.length >= MAX_LANES) {
        replyErr(ws, L('srv.auto.lanesLimit', { max: MAX_LANES }));
        return;
      }
      const { lane, error } = validateLane({ ...m.lane, id: undefined, armed: false });
      if (error) {
        replyErr(ws, error);
        return;
      }
      if (autoRunner.lanes.some((l) => laneKey(l) === laneKey(lane))) {
        replyErr(ws, L('auto.err.dup'));
        return;
      }
      autoRunner.setLanes([...autoRunner.lanes, lane]);
      reply(ws, { type: 'auto.lane.added', id: lane.id });
      autoChanged();
      kick();
      return;
    }
    case 'auto.lane.update': {
      const cur = autoRunner.lane(m.id);
      if (!cur || !isPlainObject(m.patch)) return;
      const allowed = Object.fromEntries(['mode', 'armed', 'label', 'owner'].filter((k) => k in m.patch).map((k) => [k, m.patch[k]]));
      const { lane, error } = validateLane(allowed, cur);
      if (error) {
        replyErr(ws, error);
        return;
      }
      if (autoRunner.lanes.some((l) => l !== cur && laneKey(l) === laneKey(lane))) {
        replyErr(ws, L('auto.err.dup'));
        return;
      }
      Object.assign(cur, { mode: lane.mode, armed: lane.armed, label: lane.label, owner: lane.owner });
      autoChanged();
      kick();
      return;
    }
    case 'auto.arm': {
      const ids = Array.isArray(m.ids) ? m.ids : [m.id];
      const armed = toBool(m.armed, null);
      if (armed === null) return;
      let n = 0;
      for (const l of autoRunner.lanes) {
        if (!ids.includes(l.id) || l.armed === armed) continue;
        l.armed = armed;
        n++;
      }
      if (n) autoChanged();
      return;
    }
    case 'auto.lane.delete': {
      const ids = new Set(Array.isArray(m.ids) ? m.ids : [m.id]);
      const next = autoRunner.lanes.filter((l) => !ids.has(l.id));
      if (next.length === autoRunner.lanes.length) return;
      autoRunner.setLanes(next);
      autoChanged();
      kick();
      return;
    }
    case 'auto.points': {
      const cur = autoRunner.lane(m.id);
      if (!cur || !Array.isArray(m.points)) return;
      if (m.points.length > MAX_POINTS) {
        replyErr(ws, L('auto.err.tooMany', { max: MAX_POINTS }));
        return;
      }
      cur.points = sanitizePoints(m.points, paramRange(cur.target, cur.param));
      autoChanged();
      kick();
      return;
    }
    case 'auto.global': {
      if (!AUTO_GLOBAL.includes(m.mode)) return;
      if (showLock && m.mode === 'write') {
        replyToast(ws, L('srv.auto.lockedWrite'), 'warn');
        return;
      }
      if (autoRunner.setGlobal(m.mode, now())) {
        autoChanged();
        pushAutoStatus(true);
        kick();
      }
      return;
    }
    default:
      return;
  }
  stateChanged();
  kick();
}

let clientSeq = 0;
function clientLabel(req) {
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Client';
  const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return `${browser} @ ${addr === '::1' ? '127.0.0.1' : addr}`;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.cid = ++clientSeq;
  ws.label = `${clientLabel(req)} #${ws.cid}`;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => console.warn('[ws] client error:', err.message));
  ws.on('close', () => {
    oscLog.drop(ws);
    if (tcSource?.ws !== ws) return;
    tcSource = null;
    tcChanged();
  });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (raw.length > MAX_MSG_BYTES && !LARGE_TYPES.has(m?.type)) {
      replyErr(ws, L('srv.msgTooBig', { kb: Math.round(raw.length / 1024) }));
      return;
    }
    try {
      handleClientMessage(ws, m);
    } catch (err) {
      console.error('[ws]', err);
      replyErr(ws, L('srv.error', { msg: errMsg(err) }));
    }
  });
});

const heartbeat = setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) {
      c.terminate();
      continue;
    }
    c.isAlive = false;
    try { c.ping(); } catch { /* ignore */ }
  }
}, 15000);
heartbeat.unref();

let listenFailed = false;
function onListenError(err) {
  if (listenFailed) return;
  if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
    console.error('[objitter] server error:', err);
    return;
  }
  listenFailed = true;
  const why = err.code === 'EADDRINUSE'
    ? `Port ${HTTP_PORT} is already in use (Objitter may already be running).`
    : `No permission to open port ${HTTP_PORT}.`;
  console.error(`\n[objitter] ${why}\nRun it on another port:\n`
    + '  PowerShell : $env:PORT=8081; npm start\n'
    + '  cmd        : set PORT=8081 && npm start\n'
    + '  macOS/Linux: PORT=8081 npm start\n');
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', onListenError);

loadState();
snapshotTcSent(tcState());

server.listen(HTTP_PORT, HOST, () => {
  onOutputChanged();
  applyControlInput();
  loop();
  console.log('\n  OBJITTER - immersive object motion controller');
  console.log(`  > Local:   http://localhost:${HTTP_PORT}`);
  for (const u of lanUrls()) console.log(`  > Network: ${u}`);
  for (const t of output.targets) {
    console.log(`  > Output:  ${t.enabled ? '' : '(off) '}${t.name} [${SYSTEMS[t.system].label}] -> ${t.host}:${t.port} @ ${t.rate} Hz`);
  }
  console.log(`  > Data:    ${DATA_DIR}`);
  console.log(`  > Presets: ${PRESET_DIR}`);
  console.log(`  > Sessions: ${SESSION_DIR}\n`);
  if (startupWarning) console.warn(`  ! ${en(startupWarning)}\n`);
  startCaffeinate();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(saveTimer);
  await Promise.race([flushWrites(), new Promise((r) => setTimeout(r, 1000))]);
  try { writeFileAtomic(STATE_FILE, JSON.stringify(stateSnapshot(), null, 2)); } catch (err) { console.error('[state] save failed:', err.message); }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, shutdown); } catch { /* signal unsupported on this platform */ }
}
