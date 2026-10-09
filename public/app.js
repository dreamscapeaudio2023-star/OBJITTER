import { createTimecode } from './tc-ui.js';
import {
  t, tm, pick, getLang, setLang, storedLang, storeLang, applyStatic, staticParams, kbd, IS_MAC, LANGS,
} from './i18n.js';

import {
  $, $$, h, clamp, getPath, setPath, mergeLocal, nextId, objColor, store, emit, on, setSocket,
  send, sendRaw, guardEdit, toast, toastThrottled, closeConfirm, askConfirm, disarm, armButton, downloadJson,
  toggleEl, segEl, setSeg,
} from './core.js';
import { createWorkspaces } from './workspace.js';
import { createShow } from './ws-show.js';
import { createAutomation } from './ws-automation.js';
import { createOutput, sysLabel } from './ws-output.js';
import { drawBackground, drawSpeakers, drawSpeakersSide, onImageLoad } from './stage-draw.js';
import { createStageSetup } from './ws-stage.js';
import { createSetup } from './ws-setup.js';
import { createOscLog } from './ws-osclog.js';
import { createLibrary } from './ws-library.js';

const COLORS = Array.from({ length: 33 }, (_, id) => ({
  solid: objColor(id, 0.95),
  dim: objColor(id, 0.4),
  glow: objColor(id, 0.22),
  trail: objColor(id, 0.35),
  region: objColor(id, 0.75),
  regionFill: objColor(id, 0.07),
}));

// ---------------- state ----------------
let ST = null; // static info (systems, constants, network)
let S = null; // dynamic state
let OBJ = [];
let PRESETS = [];
let positions = [];
let beat = 0;
let running = false;
let stats = null;
const selected = store.selected.add(1);
const OBJ_WIN = (() => {
  const v = Number(new URLSearchParams(location.search).get('obj'));
  return Number.isInteger(v) && v >= 1 && v <= 32 ? v : null;
})();
let objWinId = OBJ_WIN;
const MONITOR = new URLSearchParams(location.search).get('ws') === 'monitor';
if (MONITOR) {
  document.body.classList.add('monitor-win');
  selected.clear();
  // view only: no shortcut may change the show from this window
  window.addEventListener('keydown', (e) => { if (!e.target.closest?.('input, select')) e.stopImmediatePropagation(); }, true);
}
let multiMode = false;
let dirty = true;
const trails = Array.from({ length: 32 }, () => []);
const isLocked = () => !!S?.showLock;
const palette = () => ST?.constants?.palette ?? [];
const palHex = (key) => (key ? palette().find((c) => c.key === key)?.hex ?? null : null);
Object.defineProperties(store, {
  ST: { get: () => ST },
  S: { get: () => S },
  OBJ: { get: () => OBJ },
  PRESETS: { get: () => PRESETS },
  positions: { get: () => positions },
  running: { get: () => running },
  stats: { get: () => stats },
});

let reconnects = 0;
/** Per tab, survives reloads: lets a TC source browser reclaim its source after a reconnect. */
const CLIENT_ID = (() => {
  let id = sessionStorage.getItem('objitter.clientId');
  if (!id || !/^[A-Za-z0-9-]{4,64}$/.test(id)) {
    id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem('objitter.clientId', id);
  }
  return id;
})();
let ws = null;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  setSocket(ws);
  ws.onopen = () => {
    reconnects = 0;
    renderConn(true);
    ws.send(JSON.stringify({ type: 'hello', clientId: CLIENT_ID }));
  };
  ws.onclose = (e) => {
    reconnects++;
    renderConn(false);
    if (e.code === 1009) toast(t('ui.tooBig'), 'error');
    tcui.onDisconnect?.();
    setTimeout(connect, Math.min(5000, 500 + reconnects * 300));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.type) {
      case 'init':
        ST = m.static;
        S = m.state;
        OBJ = m.objects;
        PRESETS = m.presets;
        SESSIONS = m.sessions ?? [];
        onInit();
        tcui.init(m.tc, m.tcs, m.you);
        renderPresetUsage();
        renderWarnings();
        break;
      case 'tc':
        tcui.onTc(m.tc);
        renderPresetUsage();
        break;
      case 'tc.delta':
        tcui.onTcDelta?.(m);
        renderPresetUsage();
        break;
      case 'tcs':
        tcui.onTcs(m);
        break;
      case 'cue':
        tcui.onCue(m);
        break;
      case 'tc.cue.added':
        tcui.onCueAdded(m.id);
        break;
      case 'tc.show.data':
        tcui.onShowData(m.data);
        break;
      case 'tc.show.preview':
        tcui.onShowPreview?.(m);
        break;
      case 'tc.source.lost':
        if (tcui.onSourceLost) tcui.onSourceLost(m);
        else toast(m.reason ? tm(m.reason) : t('ui.notSource'), 'warn');
        break;
      case 'state':
        if (!S) return;
        S = m.state;
        for (const o of m.objects) {
          // An echo of an older edit must not snap the point being dragged back.
          if (pathEdit?.id === o.id && (pathDrag || pathSendTimer !== null) && OBJ[o.id - 1]) o.pathPts = OBJ[o.id - 1].pathPts;
          OBJ[o.id - 1] = o;
        }
        onState();
        tcui.onState?.();
        break;
      case 'presets':
        PRESETS = m.presets;
        renderPresets();
        renderSlots();
        tcui.onPresets();
        renderPresetUsage();
        break;
      case 'pos': {
        const prev = positions;
        positions = m.p;
        beat = m.beat;
        if (running !== m.running) {
          running = m.running;
          if (S) S.master.running = running;
          renderTransport();
          renderWarnings();
          outUi.render();
          renderRunState();
        }
        if (typeof m.rm === 'number' && m.rm !== runMask) {
          runMask = m.rm >>> 0;
          renderRunState();
        }
        trackJumps(prev, m.j | 0);
        if (running || runMask) pushTrails();
        dirty = true;
        break;
      }
      case 'stats':
        renderStats(m);
        break;
      case 'toast':
        toast(m.count > 1 ? `${tm(m)} (×${m.count})` : tm(m), m.level);
        break;
      case 'confirm':
        askConfirm(tm(m), m.yes ? tm(m.yes) : t('common.ok'), () => send(m.msg));
        break;
      case 'sessions':
        SESSIONS = m.sessions;
        renderSessions();
        break;
      case 'session.data':
        downloadJson(`${m.name}.objitter-session.json`, m.data);
        break;
      case 'preset.data':
        downloadJson(`${m.name}.objitter.json`, m.data);
        break;
    }
    if (m.type === 'init' || m.type === 'stage') {
      store.stage = m.stage;
      renderStageToggles();
      dirty = true;
    }
    if (m.type === 'init' || m.type === 'tc') store.TC = m.tc;
    if (m.type === 'init') store.TCS = m.tcs;
    if (m.type === 'tcs') store.TCS = m;
    if (m.type === 'init') { store.AUTO = m.auto; store.AUTOS = m.autos; }
    if (m.type === 'auto') store.AUTO = { lanes: m.lanes, global: m.global };
    if (m.type === 'autos') store.AUTOS = m;
    if (m.type === 'init') store.LIB = m.library ?? null;
    if (m.type === 'library') store.LIB = { folders: m.folders, items: m.items };
    if (m.type === 'init' || m.type === 'autos' || m.type === 'auto') {
      const rec = store.AUTO?.lanes?.length && store.AUTOS?.rec && Object.keys(store.AUTOS.rec).length;
      document.body.toggleAttribute('data-rec', !!rec);
    }
    emit(m.type, m);
  };
}

function renderConn(ok) {
  const el = $('#conn');
  el.textContent = ok ? t('top.connected') : t('top.disconnected');
  el.title = `${t('top.conn.title')}: ${el.textContent}`;
  el.dataset.ok = ok ? '1' : '0';
  if (ok) hideSplash();
  el.className = `badge ${ok ? 'ok' : 'err'}`;
  document.body.classList.toggle('offline', !ok);
  const ban = $('#offline');
  ban.hidden = ok;
  if (!ok) {
    ban.textContent = t('ui.offline', { n: reconnects });
    $('#outRate').textContent = '—';
    $('#outRate').classList.remove('active');
    $('#outHz').textContent = '—';
  }
}

/** Esc (without Shift): closes the first layer of open UI. Returns true if anything was closed. */
function closeOverlays() {
  if (closeModal()) return true;
  let closed = closePops();
  if (exitPathEdit()) closed = true;
  if (!$('#slotMenu').hidden) { closeSlotMenu(); closed = true; }
  if (closePalette()) closed = true;
  if (closeConfirm()) closed = true;
  for (const b of $$('button.confirming')) { disarm(b); closed = true; }
  for (const d of $$('details[open].popover, details[open][data-popover]')) { d.open = false; closed = true; }
  return closed;
}

// ---------------- palette popover ----------------
function palRow(cur, onPick) {
  return h('div', { class: 'pal-row', role: 'group', 'aria-label': t('ui.color') },
    h('button', { class: `pal-sw none${cur ? '' : ' on'}`, title: t('ui.noColor'), 'aria-label': t('ui.noColor'), 'aria-pressed': String(!cur), onclick: () => onPick(null) }, '∅'),
    palette().map((c) => h('button', {
      class: `pal-sw${cur === c.key ? ' on' : ''}`, style: `--pc:${c.hex}`, title: pick(c.name), 'aria-label': pick(c.name),
      'aria-pressed': String(cur === c.key), onclick: () => onPick(c.key),
    })));
}

let palPop = null;
let palAnchor = null;
function closePalette() {
  if (!palPop) return false;
  palPop.remove();
  palPop = null;
  const a = palAnchor;
  palAnchor = null;
  if (a?.isConnected) a.focus();
  return true;
}

function openPalette(anchor, cur, onPick) {
  if (palAnchor === anchor) { closePalette(); return; }
  closePalette();
  palPop = h('div', { class: 'pal-pop' }, palRow(cur, (k) => { closePalette(); onPick(k); }));
  palPop.addEventListener('keydown', (e) => { if (e.code !== 'Escape') e.stopPropagation(); });
  document.body.append(palPop);
  palAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  const left = clamp(r.left, 8, window.innerWidth - palPop.offsetWidth - 8);
  const top = r.bottom + 6 + palPop.offsetHeight < window.innerHeight ? r.bottom + 6 : r.top - palPop.offsetHeight - 6;
  palPop.style.left = `${left}px`;
  palPop.style.top = `${Math.max(8, top)}px`;
  ($('.pal-sw.on', palPop) || $('.pal-sw', palPop)).focus();
}

// ---------------- modal dialogs ----------------
/** Opens a modal <dialog>. Returns { dlg, close }. Esc / backdrop close it; global shortcuts are ignored inside. */
function openModal({ title, body = [], actions = [], cls = '', onClose }) {
  closeModal();
  const dlg = h('dialog', { class: `modal ${cls}`.trim(), 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h3', {}, title),
      h('button', { class: 'modal-x', type: 'button', title: t('common.close'), 'aria-label': t('common.close'), onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close: () => dlg.close() };
}

function closeModal() {
  const d = $('dialog.modal[open]');
  if (!d) return false;
  d.close();
  return true;
}

// ---------------- sessions ----------------
let SESSIONS = [];
const fmtDate = (ms) => new Date(ms).toLocaleString(getLang() === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });

function renderSessionBadge() {
  const b = $('#sessionBadge');
  if (!b) return;
  const s = S?.session;
  $('#sessionName').textContent = s ? s.name : t('sess.untitled');
  $('#sessionDirty').hidden = !(s?.modified);
  b.classList.toggle('none', !s);
  b.title = `${s ? t(s.modified ? 'sess.badge.modified' : 'sess.badge.saved', { name: s.name }) : t('sess.badge.none')} · ${t('sess.badge.keys', { save: kbd('mod', 'S'), open: kbd('mod', 'O') })}`;
}

function saveSessionNow() {
  if (!S?.session) { openSaveAs(); return; }
  send({ type: 'session.save', name: S.session.name });
}

function nameDialog({ title, value = '', okLabel, onOk }) {
  const input = h('input', { type: 'text', class: 'modal-name', maxLength: 64, spellcheck: false, value, 'aria-label': t('sess.name'), placeholder: t('sess.name') });
  const ok = () => {
    const n = input.value.trim();
    if (!n) { toast(t('srv.session.needName'), 'error'); input.focus(); return; }
    if (onOk(n) !== false) m.close();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ok(); }
  });
  const m = openModal({
    title,
    body: [input],
    actions: [h('button', { type: 'button', onclick: () => m.close() }, t('common.cancel')), h('button', { type: 'button', class: 'accent', onclick: ok }, okLabel)],
  });
  input.focus();
  input.select();
  return m;
}

function openSaveAs() {
  nameDialog({
    title: t('sess.saveAs'),
    value: S?.session?.name ?? '',
    okLabel: t('common.save'),
    onOk: (name) => send({ type: 'session.save', name }),
  });
}

function confirmLoadSession(name) {
  if (!guardEdit()) return;
  const keep = h('input', { type: 'checkbox', checked: true });
  const dirtyNote = S?.session?.modified ? h('p', { class: 'warn-text' }, t('sess.load.unsaved', { name: S.session.name })) : null;
  const m = openModal({
    title: t('sess.load.title', { name }),
    body: [
      h('p', {}, t('sess.load.body')),
      dirtyNote,
      h('label', { class: 'chk' }, keep, t('sess.load.keepOutput')),
      h('p', { class: 'hint' }, t('sess.load.keepHint')),
    ],
    actions: [
      h('button', { type: 'button', onclick: () => m.close() }, t('common.cancel')),
      h('button', {
        type: 'button', class: 'accent',
        onclick: () => { if (send({ type: 'session.load', name, includeOutput: !keep.checked })) m.close(); },
      }, t('common.load')),
    ],
  });
  m.dlg.querySelector('.modal-foot .accent').focus();
}

let sessionsModal = null;
function openSessions() {
  const list = h('div', { class: 'sess-list', id: 'sessList' });
  const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > (ST?.constants?.maxSessionBytes ?? 2 * 1024 * 1024)) { toast(t('srv.session.tooBig'), 'error'); return; }
    try {
      const data = JSON.parse(await f.text());
      const n = String(data?.name || f.name.replace(/(\.objitter-session)?\.json$/i, '')).trim();
      send({ type: 'session.import', name: n, data });
    } catch {
      toast(t('ui.jsonFailed', { file: f.name }), 'error');
    }
  });
  sessionsModal = openModal({
    title: t('sess.title'),
    cls: 'sessions',
    body: [
      h('div', { class: 'sess-top' },
        h('button', { type: 'button', class: 'accent', onclick: saveSessionNow, title: kbd('mod', 'S') }, t('common.save')),
        h('button', { type: 'button', onclick: openSaveAs, title: kbd('mod', 'shift', 'S') }, t('sess.saveAsBtn')),
        h('button', { type: 'button', onclick: () => { if (guardEdit()) file.click(); } }, t('sess.importBtn')),
        h('button', { type: 'button', onclick: () => send({ type: 'session.export' }) }, t('sess.exportCurrent'))),
      h('p', { class: 'hint' }, t('sess.hint')),
      list, file,
    ],
    onClose: () => { sessionsModal = null; },
  });
  renderSessions();
  (list.querySelector('button.load') ?? sessionsModal.dlg.querySelector('.sess-top button')).focus();
}

function renderSessions() {
  const list = $('#sessList');
  if (!list) return;
  const cur = S?.session?.name?.toLowerCase();
  if (!SESSIONS.length) {
    list.replaceChildren(h('div', { class: 'empty', style: 'padding:16px' }, t('sess.none')));
    return;
  }
  list.replaceChildren(...SESSIONS.map((s) => {
    const isCur = s.name.toLowerCase() === cur;
    return h('div', { class: `sess-row${isCur ? ' current' : ''}` },
      h('div', { class: 'sess-info' },
        h('div', { class: 'sess-name', title: s.name }, s.name, isCur ? h('span', { class: 'badge ok' }, t('sess.current')) : null),
        h('div', { class: 'muted sess-meta' }, `${fmtDate(s.mtime)} · ${Math.max(1, Math.round(s.size / 1024))} KB`)),
      h('div', { class: 'sess-act' },
        h('button', { type: 'button', class: 'load', onclick: () => confirmLoadSession(s.name) }, t('common.load')),
        h('button', {
          type: 'button', title: t('sess.overwrite.title'),
          onclick: () => send({ type: 'session.save', name: s.name }),
        }, t('common.save')),
        h('button', {
          type: 'button',
          onclick: () => {
            if (!guardEdit()) return;
            nameDialog({ title: t('sess.rename.title', { name: s.name }), value: s.name, okLabel: t('common.rename'), onOk: (to) => send({ type: 'session.rename', name: s.name, to }) });
          },
        }, t('common.rename')),
        h('button', { type: 'button', title: t('common.export'), 'aria-label': t('common.export'), onclick: () => send({ type: 'session.export', name: s.name }) }, '⇩'),
        armButton(h('button', { type: 'button', class: 'danger', title: t('common.delete'), 'aria-label': t('common.delete') }, '✕'),
          () => send({ type: 'session.delete', name: s.name }))));
  }));
}

// ---------------- about / splash / language ----------------
function hideSplash() {
  const sp = $('#splash');
  if (!sp || sp.classList.contains('gone')) return;
  sp.classList.add('gone');
  setTimeout(() => sp.remove(), 400);
}

const shortcutRows = () => [
  ['Space', t('help.start')], ['Esc', t('help.esc')], [kbd('shift', 'Esc'), t('help.shiftEsc')],
  ['F', 'FREEZE'], ['H', 'RETURN'], ['T', 'TAP'], ['R', t('top.resync')], ['L', 'LIVE EDIT'], ['P', t('help.objRun')],
  ['1–0', t('help.slots', staticParams)], [IS_MAC ? kbd('mod', 'I') : 'Insert', t('help.addCue')],
  [kbd('mod', 'Z'), t('help.undo')],
  [kbd('mod', 'A'), t('help.selAll')], [kbd('mod', 'shift', 'A'), t('help.selNone')],
  [kbd('mod', 'S'), t('help.save')], [kbd('mod', 'shift', 'S'), t('help.saveAs')], [kbd('mod', 'O'), t('help.open')],
  ['?', t('top.help')],
];
const keysList = () => h('dl', { class: 'keys' }, shortcutRows().flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]));

/** Cheat sheet: ? button, Shift+/ or the ⋯ menu. */
function openShortcuts() {
  closePops();
  if ($('dialog.modal.cheat[open]')) { closeModal(); return; }
  openModal({ title: t('about.shortcuts'), cls: 'cheat', body: [keysList(), h('p', { class: 'hint' }, t('help.cheatHint', staticParams))] });
}

function openAbout() {
  closePops();
  openModal({
    title: t('about.title'),
    cls: 'about',
    body: [
      h('img', { class: 'about-hero', src: 'assets/hero.jpg', alt: '' }),
      h('div', { class: 'about-brand' },
        h('img', { class: 'about-logo', src: 'assets/dreamscape-128.png', alt: 'DREAMSCAPE', width: 48, height: 48 }),
        h('div', {},
          h('p', { class: 'about-ver' }, 'OBJITTER ', h('span', { class: 'mono muted' }, ST?.version ? `v${ST.version}` : '')),
          h('p', { class: 'about-maker' }, t('about.madeBy')),
          h('p', { class: 'about-copy muted' }, t('about.copyright')),
          h('p', { class: 'about-copy muted' }, t('about.license')))),
      h('p', { class: 'hint' }, t('about.desc')),
      h('p', { class: 'hint' }, t('about.company')),
      h('div', { class: 'section' }, t('about.shortcuts')),
      keysList(),
    ],
  });
}

// ---------------- top-bar popovers (Master, ⋯ menu) ----------------
function closePops(except) {
  let closed = false;
  for (const host of $$('.pop-host.open')) {
    if (host === except) continue;
    host.classList.remove('open');
    $('[aria-expanded]', host)?.setAttribute('aria-expanded', 'false');
    closed = true;
  }
  return closed;
}

function setupPop(hostSel) {
  const host = $(hostSel);
  const btn = $('[aria-expanded]', host);
  btn.addEventListener('click', () => {
    const open = !host.classList.contains('open');
    closePops(host);
    host.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  });
}
setupPop('#master');
setupPop('#more');
document.addEventListener('pointerdown', (e) => {
  for (const host of $$('.pop-host.open')) if (!host.contains(e.target)) closePops();
}, true);
$('#btnHelp').addEventListener('click', openShortcuts);
$('#mmKeys').addEventListener('click', openShortcuts);
$('#mmAbout').addEventListener('click', openAbout);
$('#mmSessions').addEventListener('click', () => { closePops(); openSessions(); });

function applyLang(lang) {
  if (!LANGS.includes(lang)) return;
  setLang(lang);
  storeLang(lang);
  applyStatic(document);
  for (const b of $$('#langSeg button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  $('#moreLang').textContent = lang.toUpperCase();
  $('#mmSessKey').textContent = kbd('mod', 'O');
  renderConn(ws?.readyState === 1);
  if (!ST || !S) return;
  presetSig = null;
  warnSig = '';
  closeOverlays();
  onInit();
  tcui.relang?.();
  wsm.relang();
  emit('lang');
  renderPresetUsage();
  renderWarnings();
  renderSessions();
  setSlotHint(slotHintFor);
}

function onInit() {
  running = S.master.running;
  buildTempoMult();
  buildGrid();
  buildEditor();
  buildTools();
  buildPresets();
  buildSlots();
  buildGroups();
  outUi.build();
  prevLock = null;
  onState();
  renderPresets();
}

let prevLock = null;
function onState() {
  running = S.master.running;
  const lk = isLocked();
  if (prevLock !== null && lk !== prevLock) {
    toast(lk ? t('ui.lockOn') : t('ui.lockOff'), lk ? 'warn' : 'info');
    if (lk) closeSlotMenu();
  }
  prevLock = lk;
  checkPathEdit();
  renderTransport();
  renderGrid();
  renderGroups();
  updateEditorValues();
  renderPresetsActive();
  renderSlots();
  outUi.render();
  renderOutStatus();
  renderJitter();
  renderWarnings();
  renderCtlStatus();
  renderSessionBadge();
  updateToolCounts();
  dirty = true;
}

// ---------------- transport ----------------
const XF_MIN = 0.05;
const XF_MAX = 30;
const xfToSlider = (v) => (v <= 0 ? 0 : clamp(Math.round((1000 * Math.log(v / XF_MIN)) / Math.log(XF_MAX / XF_MIN)), 1, 1000));
const sliderToXf = (s) => (s <= 0 ? 0 : Math.round(XF_MIN * (XF_MAX / XF_MIN) ** (s / 1000) * 100) / 100);
const fmtSec = (v) => (v === 0 ? '0s' : v < 10 ? `${v.toFixed(v < 1 ? 2 : 1)}s` : `${Math.round(v)}s`);

function renderTransport() {
  if (!S) return;
  const m = S.master;
  const start = $('#btnStart');
  start.classList.toggle('running', running);
  $('#startLbl').textContent = running ? '▶ RUNNING' : '▶ START';
  start.setAttribute('aria-pressed', String(running));
  $('#btnStop').classList.toggle('idle', !running);
  $('#btnFreeze').setAttribute('aria-pressed', String(!!m.frozen));
  if (document.activeElement !== $('#speed')) $('#speed').value = m.speedTarget;
  $('#speedOut').textContent = `${Number(m.speedTarget).toFixed(2)}×`;
  if (document.activeElement !== $('#xf')) $('#xf').value = xfToSlider(m.transition);
  $('#xfOut').textContent = fmtSec(m.transition);
  renderMasterSummary(m.speedTarget, m.transition);
  if (document.activeElement !== $('#bpm')) $('#bpm').value = Number(S.bpm).toFixed(1);
  for (const b of $$('#tempoMult button')) {
    const on = Math.abs(Number(b.dataset.v) - m.tempoMult) < 1e-6;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const mults = ST?.constants?.tempoMults ?? [];
  $('#multDown').disabled = !mults.length || m.tempoMult <= mults[0] + 1e-6;
  $('#multUp').disabled = !mults.length || m.tempoMult >= mults[mults.length - 1] - 1e-6;
  const lk = isLocked();
  const lb = $('#btnLock');
  $('#lockLbl').textContent = lk ? t('top.locked') : t('top.lock');
  lb.classList.toggle('locked', lk);
  lb.setAttribute('aria-pressed', String(lk));
  document.body.classList.toggle('locked', lk);
  const live = isLive();
  const lv = $('#btnLive');
  lv.classList.toggle('on', live);
  lv.setAttribute('aria-pressed', String(live));
  const vb = $('#vmaxBadge');
  const vmax = Number(m.maxVelocity) || 0;
  vb.hidden = vmax <= 0;
  vb.textContent = `VMAX ${vmax.toFixed(2)}/s`;
}

function renderMasterSummary(speed, xf) {
  const sp = Number(speed);
  $('#masterSum').textContent = `${sp.toFixed(2)}× · ${fmtSec(xf)}`;
  const b = $('#btnMaster');
  b.classList.toggle('changed', Math.abs(sp - 1) > 1e-6);
  b.title = `${t('top.master.title')} — ${t('top.speed')} ${sp.toFixed(2)}× · ${t('top.fade')} ${fmtSec(xf)}`;
}

function buildTempoMult() {
  const labels = { 0.25: '¼', 0.5: '½', 1: '1', 2: '2', 4: '4' };
  $('#tempoMult').replaceChildren(...ST.constants.tempoMults.map((v) => h('button', {
    'data-v': v,
    title: t('top.tempoMult.title', { v: labels[v] }),
    onclick: () => send({ type: 'master', tempoMult: v }),
  }, `×${labels[v]}`)));
}

/** Compact tempo-multiplier stepper (below 1800 px only the current value is shown between − and +). */
function stepTempoMult(dir) {
  const mults = ST?.constants?.tempoMults;
  if (!mults || !S) return;
  const i = mults.findIndex((v) => Math.abs(v - S.master.tempoMult) < 1e-6);
  const n = clamp((i < 0 ? mults.indexOf(1) : i) + dir, 0, mults.length - 1);
  if (n !== i) send({ type: 'master', tempoMult: mults[n] });
}
$('#multDown').addEventListener('click', () => stepTempoMult(-1));
$('#multUp').addEventListener('click', () => stepTempoMult(1));

const start = () => send({ type: 'master', running: true });
const stop = () => send({ type: 'master', running: false });
const toggleFreeze = () => send({ type: 'master', frozen: !S?.master.frozen });
const isLive = () => S?.master?.livePreview !== false;
const toggleLive = () => { if (S) send({ type: 'master', livePreview: !isLive() }); };
const homeAll = () => send({ type: 'home' });

$('#btnStart').addEventListener('click', start);
$('#btnStop').addEventListener('click', stop);
$('#floatStop').addEventListener('click', stop);
$('#btnFreeze').addEventListener('click', toggleFreeze);
$('#btnHome').addEventListener('click', homeAll);
$('#speed').addEventListener('input', (e) => {
  $('#speedOut').textContent = `${Number(e.target.value).toFixed(2)}×`;
  send({ type: 'master', speed: Number(e.target.value) });
});
$('#xf').addEventListener('input', (e) => {
  const v = sliderToXf(Number(e.target.value));
  $('#xfOut').textContent = fmtSec(v);
  send({ type: 'master', transition: v });
});
$('#bpm').addEventListener('change', (e) => send({ type: 'bpm', bpm: Number(e.target.value) }));
$('#btnResync').addEventListener('click', () => send({ type: 'resync' }));
$('#btnResyncPop').addEventListener('click', () => send({ type: 'resync' }));
$('#btnLock').addEventListener('click', () => {
  if (S) send({ type: 'lock.set', locked: !S.showLock });
});
$('#btnLive').addEventListener('click', toggleLive);
$('#vmaxBadge').addEventListener('click', () => {
  wsm.open('output');
  const v = $('#o-vmax');
  if (!v) return;
  v.scrollIntoView({ block: 'center' });
  v.focus();
});
$('#jitterBadge').addEventListener('click', () => {
  const p95 = stats?.intervalP95Ms;
  askConfirm(t('ui.jitterAsk', { p95: p95 != null ? ` (p95 ${Math.round(p95)} ms)` : '' }),
    t('ui.jitterYes'), () => send({ type: 'setOutput', patch: { precise: true } }));
});

function doTap() {
  send({ type: 'tap' });
  const b = $('#btnTap');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 90);
}
$('#btnTap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  doTap();
});
$('#btnTap').addEventListener('keydown', (e) => {
  if (e.code === 'Enter') doTap();
});

const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
const SLOT_KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

/** 1–0 → slots 1–10, Shift+1–0 → 11–20, Alt+1–0/-/= → 21–32 (physical keys, layout/IME independent). */
function slotForKey(e) {
  let code = e.code;
  if (/^Numpad\d$/.test(code)) {
    // Shift+Numpad is reported as navigation keys on Windows, so only plain numpad digits are mapped.
    if (e.shiftKey || e.altKey || !/^\d$/.test(e.key)) return null;
    code = `Digit${code.slice(6)}`;
  }
  const i = SLOT_KEYS.indexOf(code);
  if (i < 0) return null;
  if (e.altKey) return e.shiftKey ? null : 21 + i;
  if (i >= 10) return null;
  return e.shiftKey ? 11 + i : 1 + i;
}

function slotKeyLabel(s) {
  if (s <= 10) return SLOT_KEY_LABELS[s - 1];
  if (s <= 20) return kbd('shift', SLOT_KEY_LABELS[s - 11]);
  return kbd('alt', SLOT_KEY_LABELS[s - 21]);
}

/** Corner label on a slot: ⇧1 / ⌥1 on macOS, ⇧1 / Alt1 elsewhere (⇧ is printed on PC Shift keys too; ⌥ is not). */
function slotKeyShort(s) {
  if (s <= 10) return SLOT_KEY_LABELS[s - 1];
  if (s <= 20) return `⇧${SLOT_KEY_LABELS[s - 11]}`;
  return `${IS_MAC ? '⌥' : 'Alt'}${SLOT_KEY_LABELS[s - 21]}`;
}

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);
function isTextField(t) {
  if (!(t instanceof Element)) return false;
  if (t.closest('textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
  return t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type);
}

// Range/checkbox keep focus after a mouse/touch interaction and would swallow Space/digit shortcuts.
// Keyboard-focused (:focus-visible) controls keep focus so arrow keys still work.
function blurToggleInput(e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || (t.type !== 'range' && t.type !== 'checkbox')) return;
  if (e.type === 'change' && t.matches(':focus-visible')) return;
  t.blur();
}
document.addEventListener('change', blurToggleInput);
document.addEventListener('pointerup', blurToggleInput);

document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt' && !isTextField(e.target)) e.preventDefault();
});

/*
 * Esc policy (live show safety):
 *  Shift+Esc  → STOP, always (even inside inputs and menus).
 *  Esc in a text field / select → blur only.
 *  Esc otherwise → close the first open layer (slot menu, palette, confirm bar, armed buttons, popovers);
 *                  if nothing was open → STOP.
 */
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const t = e.target;
  if (e.code === 'Escape') {
    if (e.shiftKey) {
      e.preventDefault();
      stop();
      return;
    }
    if (isTextField(t)) { t.blur(); return; }
    if (closeOverlays()) return;
    if (wsm.close()) return;
    stop();
    return;
  }
  if (e.key === 'Alt') {
    if (!isTextField(t)) e.preventDefault();
    return;
  }
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const inModal = !!$('dialog.modal[open]');
  if (mod && !e.altKey && (e.code === 'KeyS' || e.code === 'KeyO')) {
    e.preventDefault();
    if (e.repeat || inModal) return;
    if (e.code === 'KeyO') openSessions();
    else if (e.shiftKey || !S?.session) openSaveAs();
    else saveSessionNow();
    return;
  }
  if (inModal) return;
  if (tcui.onKey?.(e)) return;
  if (isTextField(t)) return;
  if (wsm.current()) {
    if (wsm.onKey(e)) return;
    if (mod && !e.altKey && e.code === 'KeyA') return;
  }
  if (mod && !e.altKey && e.code === 'KeyA') {
    e.preventDefault();
    if (e.shiftKey) selectNone();
    else selectAllEnabled();
    return;
  }
  if (pathEdit && pathEdit.sel !== null && (e.code === 'Delete' || e.code === 'Backspace')) {
    e.preventDefault();
    deletePathPoint(pathEdit.sel);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyZ') {
    e.preventDefault();
    send({ type: 'undo' });
    return;
  }
  if (e.ctrlKey || e.metaKey || e.repeat) return;
  const slot = slotForKey(e);
  if (slot) {
    e.preventDefault();
    loadSlot(slot);
    return;
  }
  if (e.altKey) return;
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
    e.preventDefault();
    openShortcuts();
    return;
  }
  switch (e.code) {
    case 'Space': e.preventDefault(); start(); break;
    case 'KeyT': doTap(); break;
    case 'KeyR': send({ type: 'resync' }); break;
    case 'KeyH': homeAll(); break;
    case 'KeyF': toggleFreeze(); break;
    case 'KeyL': toggleLive(); break;
    case 'KeyP': toggleSelectionRun(); break;
    default: return;
  }
});

const statOf = (id) => stats?.targets?.find((x) => x.id === id) ?? null;

function targetErr(st) {
  if (!st || !st.enabled) return null;
  if (st.resolve === 'resolving') return t('out.resolving');
  if (st.resolve && st.resolve !== 'ok' && st.resolve !== 'idle') return t('out.resolveFailed', { code: st.resolve });
  if (st.error) return t('out.sendError', { code: st.error });
  return null;
}

function renderStats(m) {
  stats = m;
  if (!S) return;
  renderOutStatus();
  renderJitter();
  outUi.updateStatus();
}

let lastErr = null;
function renderOutStatus() {
  if (!S || !ST) return;
  const on = (S.output?.targets ?? []).filter((t) => t.enabled);
  const first = on[0];
  const st = first ? statOf(first.id) : null;
  const sysEl = $('#outSystem');
  sysEl.textContent = first ? sysLabel(first.system) : t('out.none');
  sysEl.classList.toggle('none', !first);
  $('#outTarget').textContent = first ? (st?.target ?? `${first.host}:${first.port}`) : '';
  const more = $('#outMore');
  more.hidden = on.length < 2;
  more.textContent = `+${on.length - 1}`;
  more.title = on.slice(1).map((t) => `${t.name} — ${t.host}:${t.port}`).join('\n');
  const dot = $('#outDot');
  const box = $('#outStatus');
  const lines = on.map((tg) => {
    const s2 = statOf(tg.id);
    return `${tg.name || sysLabel(tg.system)} — ${s2?.target ?? `${tg.host}:${tg.port}`}${s2 ? ` · ${s2.frameHz} Hz · ${s2.msgRate} msg/s` : ''}`;
  });
  if (document.body.classList.contains('offline') || !stats) {
    dot.className = 'out-dot';
    box.title = first ? lines.join('\n') : t('out.none');
    return;
  }
  $('#outHz').textContent = st ? `${st.frameHz} Hz` : '— Hz';
  const rate = Math.round((stats.targets ?? []).filter((x) => x.enabled).reduce((a, x) => a + (Number(x.msgRate) || 0), 0));
  const r = $('#outRate');
  r.textContent = `${rate} msg/s`;
  r.classList.toggle('active', rate > 0);
  const errs = (stats.targets ?? []).map((x) => {
    const e = targetErr(x);
    return e && { text: on.length > 1 ? `${x.name}: ${e}` : e, resolving: x.resolve === 'resolving' };
  }).filter(Boolean);
  const err = errs.length ? `${errs[0].text}${errs.length > 1 ? ` (+${errs.length - 1})` : ''}` : null;
  const badge = $('#outErr');
  badge.hidden = !err;
  badge.textContent = err ?? '';
  badge.title = errs.map((x) => x.text).join('\n');
  dot.className = `out-dot ${!first ? 'warn' : err ? (errs.every((x) => x.resolving) ? 'warn' : 'err') : rate > 0 ? 'ok' : ''}`;
  box.title = [first ? lines.join('\n') : t('out.none'), ...errs.map((x) => `⚠ ${x.text}`)].join('\n');
  if (err !== lastErr) {
    if (err && !errs[0].resolving) toast(err, 'error');
    lastErr = err;
  }
}

function renderJitter() {
  const b = $('#jitterBadge');
  const on = !!stats?.jitterWarn && !S?.output?.precise;
  b.hidden = !on;
  if (on) b.textContent = t('top.jitterP95', { ms: Math.round(Number(stats.intervalP95Ms) || 0) });
}

let warnSig = '';
function renderWarnings() {
  if (!S) return;
  const msgs = [...(tcui.warnings?.() ?? [])];
  const enabled = OBJ.filter((o) => o.enabled).length;
  if (running && enabled === 0) msgs.push(t('warn.noActive'));
  if (S.master.frozen) msgs.push(t('warn.frozen'));
  for (const d of S.dupSources) msgs.push(t('warn.dupSource', { id: d.sourceId, ids: d.ids.join(', ') }));
  if (S.controlStatus.state === 'error') msgs.push(t('srv.ctl.error', { msg: ctlErrText(S.controlStatus) }));
  if (S.startupWarning) msgs.push(tm(S.startupWarning));
  const sig = msgs.join('|');
  if (sig === warnSig) return;
  warnSig = sig;
  const bar = $('#warnBar');
  bar.hidden = !msgs.length;
  bar.replaceChildren(...msgs.map((m) => h('p', {}, tm(m))));
}

function ctlErrText(s) {
  if (s.code === 'EADDRINUSE') return t('ctl.err.inUse', { port: s.port });
  if (s.code === 'EACCES') return t('ctl.err.access', { port: s.port });
  return s.message;
}

function renderCtlStatus() {
  const s = S.controlStatus;
  const el = $('#ctlStatus');
  if (s.state === 'listening') {
    el.textContent = t('ctl.badge', { port: s.port });
    el.className = 'badge ok';
    el.title = `${el.textContent} — ${t('ctl.listening', { port: s.port })}`;
  } else if (s.state === 'error') {
    el.textContent = t('ctl.errBadge');
    el.className = 'badge err';
    el.title = `${el.textContent} — ${ctlErrText(s)}`;
  } else {
    el.textContent = t('ctl.badgeOff');
    el.className = 'badge';
    el.title = t('ctl.off');
  }
}

// ---------------- object grid ----------------
let suppressClick = false;

function toggleEnable(id) {
  const o = OBJ[id - 1];
  if (!guardEdit()) return;
  if (send({ type: 'updateObjects', ids: [id], patch: { enabled: !o.enabled } })) {
    o.enabled = !o.enabled;
    renderGrid();
  }
}

function buildGrid() {
  const grid = $('#objGrid');
  grid.replaceChildren();
  for (let id = 1; id <= ST.constants.maxObjects; id++) {
    const btn = h('button', { class: 'obj', 'data-id': id, style: `--c:${COLORS[id].solid}`, 'aria-pressed': 'false' },
      h('span', { class: 'num' }, id),
      h('span', { class: 'tag' }),
      h('span', { class: 'md' }),
      h('span', { class: 'nm' }));
    let lp = null;
    let start = null;
    const cancel = () => { clearTimeout(lp); lp = null; };
    btn.addEventListener('pointerdown', (e) => {
      start = [e.clientX, e.clientY];
      cancel();
      lp = setTimeout(() => {
        lp = null;
        suppressClick = true;
        navigator.vibrate?.(15);
        toggleEnable(id);
      }, 500);
    });
    btn.addEventListener('pointermove', (e) => {
      if (lp && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancel();
    });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancel();
      openObjWindow(id);
    });
    btn.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      selectObject(id, multiMode || e.shiftKey || e.ctrlKey || e.metaKey);
    });
    btn.addEventListener('dblclick', () => toggleEnable(id));
    const run = h('button', { class: 'obj-run', type: 'button', 'data-id': id, tabindex: '-1' }, h('i', { 'aria-hidden': 'true' }));
    run.addEventListener('click', (e) => {
      e.stopPropagation();
      setObjectsRun([id], !isObjMoving(id));
    });
    run.addEventListener('dblclick', (e) => e.stopPropagation());
    grid.append(h('div', { class: 'obj-cell', style: `--c:${COLORS[id].solid}` }, btn, run));
  }
}

let runMask = 0;
const isObjMoving = (id) => ((runMask >>> (id - 1)) & 1) === 1;

function setObjectsRun(ids, play) {
  const list = ids.filter((id) => OBJ[id - 1]?.enabled);
  if (!list.length || !send({ type: 'obj.run', ids: list, play })) return;
  for (const id of list) runMask = play ? (runMask | (1 << (id - 1))) >>> 0 : (runMask & ~(1 << (id - 1))) >>> 0;
  renderRunState();
}

/** P: if any selected object is moving, pause the selection; otherwise play it. */
function toggleSelectionRun() {
  const ids = [...selected].filter((id) => OBJ[id - 1]?.enabled);
  if (!ids.length) return;
  setObjectsRun(ids, !ids.some(isObjMoving));
}

function renderRunState() {
  if (!S) return;
  let moving = 0;
  for (const cell of $$('.obj-cell', $('#objGrid'))) {
    const btn = cell.firstElementChild;
    const run = cell.lastElementChild;
    const id = Number(btn.dataset.id);
    const on = OBJ[id - 1].enabled;
    const mv = on && isObjMoving(id);
    if (mv) moving++;
    btn.classList.toggle('moving', mv);
    btn.classList.toggle('held', on && running && !mv);
    run.hidden = !on;
    run.classList.toggle('playing', mv);
    run.setAttribute('aria-label', t(mv ? 'grid.pause' : 'grid.play', { id }));
    run.title = t(mv ? 'grid.pause.title' : 'grid.play.title');
  }
  const startBtn = $('#btnStart');
  const partial = !running && moving > 0;
  startBtn.classList.toggle('partial', partial);
  startBtn.dataset.partial = partial ? t('top.partial', { n: moving }) : '';
}

function renderGrid() {
  if (!S) return;
  const dup = new Set(S.dupSources.flatMap((d) => d.ids));
  for (const btn of $$('.obj', $('#objGrid'))) {
    const id = Number(btn.dataset.id);
    const o = OBJ[id - 1];
    btn.classList.toggle('on', o.enabled);
    btn.classList.toggle('sel', selected.has(id));
    btn.classList.toggle('dup', dup.has(id));
    btn.setAttribute('aria-pressed', String(selected.has(id)));
    $('.md', btn).textContent = `${modeName(o.mode)}${o.mode !== 'hold' && o.timing.sync === 'tempo' ? ' ♩' : ''}`;
    $('.nm', btn).textContent = o.name;
    $('.tag', btn).textContent = o.sourceId !== id ? `#${o.sourceId}` : '';
    const state = o.enabled ? t('grid.active') : t('grid.inactive');
    btn.title = `${o.name} · ${t('grid.src', { n: o.sourceId })} · ${modeName(o.mode)} · ${state}${dup.has(id) ? ` · ${t('grid.dup')}` : ''}`;
    btn.setAttribute('aria-label', t('grid.aria', { id, name: o.name, mode: modeName(o.mode), state }));
  }
  const n = selected.size;
  $('#selInfo').textContent = t('grid.selInfo', { sel: n ? t('grid.nSel', { n }) : t('grid.noSel'), n: OBJ.filter((o) => o.enabled).length });
  $('#btnMulti').setAttribute('aria-pressed', String(multiMode));
  renderRunState();
  renderObjWinHead();
}

function selectObject(id, additive) {
  if (additive) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  } else {
    selected.clear();
    selected.add(id);
  }
  selectionChanged();
}

/** Ctrl/⌘+A: replaces the selection with the enabled objects only. */
function selectAllEnabled() {
  if (!S) return;
  selected.clear();
  OBJ.forEach((o, i) => { if (o?.enabled) selected.add(i + 1); });
  selectionChanged();
}

function selectNone() {
  selected.clear();
  selectionChanged();
}

// ---------------- object properties window (?obj=N) ----------------
// One named window shows a single object: its motion editor and the library. Right-clicking an
// object in the main window's list retargets it (BroadcastChannel), or opens it if it is closed.
const objChan = typeof BroadcastChannel === 'function' ? new BroadcastChannel('objitter-obj') : null;
let objWinRef = null;

function openObjWindow(id) {
  if (objWinRef && !objWinRef.closed) {
    objChan?.postMessage({ id });
    objWinRef.focus();
    return;
  }
  objWinRef = window.open(`${location.pathname}?obj=${id}`, 'objitter-obj', 'popup=yes,width=1240,height=880');
  if (!objWinRef) {
    toast(t('ws.popBlocked'), 'warn');
    selectObject(id, false);
  }
}

if (OBJ_WIN) {
  document.body.classList.add('obj-win');
  selected.clear();
  selected.add(OBJ_WIN);
  objChan?.addEventListener('message', (e) => {
    const id = Number(e.data?.id);
    if (!Number.isInteger(id) || id < 1 || id > 32) return;
    selected.clear();
    selected.add(id);
    selectionChanged();
    window.focus();
  });
}

function setObjWinTarget(id) {
  objWinId = id;
  history.replaceState(null, '', `?obj=${id}`);
  renderObjWinHead();
}

function renderObjWinHead() {
  if (!objWinId) return;
  let head = $('#objWinHead');
  if (!head) {
    head = h('div', { class: 'objwin-head', id: 'objWinHead' },
      h('i', { class: 'objwin-dot' }), h('span', { class: 'objwin-num mono' }), h('span', { class: 'objwin-name' }), h('span', { class: 'objwin-meta muted' }));
    $('.side-panel').prepend(head);
  }
  const o = OBJ[objWinId - 1];
  head.style.setProperty('--c', COLORS[objWinId].solid);
  $('.objwin-num', head).textContent = `#${objWinId}`;
  $('.objwin-name', head).textContent = o?.name ?? '';
  $('.objwin-meta', head).textContent = o ? `${modeName(o.mode)} · ${o.enabled ? t('grid.active') : t('grid.inactive')}` : '';
  document.title = `#${objWinId}${o?.name ? ` ${o.name}` : ''} — ${t('objwin.title')} — Objitter`;
}

function selectionChanged() {
  if (objWinId) {
    if (selected.size === 1 && !selected.has(objWinId)) setObjWinTarget([...selected][0]);
    else if (selected.size !== 1) {
      selected.clear();
      selected.add(objWinId);
    }
  }
  checkPathEdit();
  renderGrid();
  updateEditorValues();
  updateToolCounts();
  dirty = true;
  emit('selection');
}
on('show.pickObject', ({ id, add }) => selectObject(id, add));

$('.objects').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !S) return;
  const ids = [...selected];
  const needSel = () => {
    if (ids.length) return true;
    toast(t('srv.noSelection'), 'warn');
    return false;
  };
  switch (act) {
    case 'selAll': OBJ.forEach((o) => selected.add(o.id)); break;
    case 'selActive': {
      const act2 = OBJ.filter((o) => o.enabled).map((o) => o.id);
      selected.clear();
      act2.forEach((id) => selected.add(id));
      break;
    }
    case 'selNone': selected.clear(); break;
    case 'multi': multiMode = !multiMode; break;
    case 'undo': send({ type: 'undo' }); return;
    case 'enable':
    case 'disable':
      if (needSel() && send({ type: 'updateObjects', ids, patch: { enabled: act === 'enable' } })) {
        ids.forEach((id) => { OBJ[id - 1].enabled = act === 'enable'; });
      }
      break;
    case 'home': if (needSel()) send({ type: 'home', ids }); return;
  }
  selectionChanged();
});

// ---------------- groups ----------------
function fmtIds(ids) {
  const s = [...ids].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(',');
}

function selectGroup(g, additive) {
  if (!additive) selected.clear();
  for (const id of g.ids) selected.add(id);
  selectionChanged();
}

function buildGroups() {
  const nameIn = h('input', { type: 'text', id: 'groupName', maxLength: 24, spellcheck: false, placeholder: t('grp.name'), 'aria-label': t('grp.newName') });
  const form = h('div', { class: 'group-form', hidden: true });
  const openBtn = h('button', { class: 'group-save', title: t('grp.save.title') }, t('grp.save'));
  const close = () => {
    form.hidden = true;
    openBtn.hidden = false;
    nameIn.value = '';
  };
  const save = () => {
    const n = nameIn.value.trim();
    const groups = S?.groups ?? [];
    if (!n) { toast(t('grp.needName'), 'error'); return; }
    if (/[@,]/.test(n)) { toast(t('grp.badChars'), 'error'); return; }
    if (!selected.size) { toast(t('srv.noSelection'), 'warn'); return; }
    const existing = groups.find((g) => g.name.toLowerCase() === n.toLowerCase());
    if (!existing && groups.length >= 16) { toast(t('srv.group.max', { max: 16 }), 'error'); return; }
    if (send({ type: 'groups.save', name: existing?.name ?? n, ids: [...selected].sort((a, b) => a - b), ...(existing ? { color: existing.color } : {}) })) close();
  };
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); }
    else if (e.code === 'Escape' && !e.shiftKey) close();
  });
  openBtn.addEventListener('click', () => {
    if (!guardEdit()) return;
    if (!selected.size) { toast(t('grp.selectFirst'), 'warn'); return; }
    form.hidden = false;
    openBtn.hidden = true;
    nameIn.focus();
  });
  form.append(nameIn, h('button', { class: 'accent', onclick: save }, t('common.save')), h('button', { onclick: close }, t('common.cancel')));
  groupSig = null;
  $('#groupsBox').replaceChildren(
    h('div', { class: 'groups-head' }, h('span', {}, t('grp.title')), openBtn),
    h('div', { class: 'group-chips', id: 'groupChips' }),
    form,
  );
}

let groupSig = null;
function renderGroups() {
  const box = $('#groupChips');
  if (!box || !S) return;
  const groups = S.groups ?? [];
  const sig = JSON.stringify(groups) + JSON.stringify(palette());
  if (sig === groupSig) return;
  groupSig = sig;
  if (!groups.length) {
    box.replaceChildren(h('span', { class: 'muted' }, t('grp.none')));
    return;
  }
  box.replaceChildren(...groups.map((g) => {
    const hex = palHex(g.color);
    const wrap = h('span', { class: 'gwrap' });
    const chip = h('button', {
      class: 'gchip', style: hex ? `--pc:${hex}` : null,
      title: t('grp.chip.title', { name: g.name, ids: fmtIds(g.ids), shift: kbd('shift') }),
    }, h('i', { class: 'gdot', 'aria-hidden': 'true' }), g.name);
    let lp = null;
    let suppress = false;
    const cancel = () => { clearTimeout(lp); lp = null; };
    chip.addEventListener('click', (e) => {
      if (suppress) { suppress = false; return; }
      selectGroup(g, e.shiftKey || e.ctrlKey || e.metaKey || multiMode);
    });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (guardEdit()) openPalette(chip, g.color, (k) => send({ type: 'groups.save', name: g.name, ids: g.ids, color: k }));
    });
    chip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      lp = setTimeout(() => {
        lp = null;
        suppress = true;
        navigator.vibrate?.(15);
        wrap.classList.toggle('show-del');
      }, 550);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) chip.addEventListener(ev, cancel);
    const del = armButton(h('button', { class: 'gdel', title: t('grp.delete', { name: g.name }), 'aria-label': t('grp.delete', { name: g.name }) }, '✕'),
      () => send({ type: 'groups.delete', name: g.name }));
    wrap.append(chip, del);
    return wrap;
  }));
}

// ---------------- editor ----------------
const MODE_KEYS = ['hold', 'jitter', 'glide', 'path', 'drift', 'orbit'];
const modeName = (m) => t(`mode.${m}`);
const divRows = () => [
  [t('div.straight'), [[0.25, t('div.0.25')], [0.5, t('div.0.5')], [1, t('div.1')], [2, t('div.2')], [4, t('div.4')], [8, t('div.8')], [16, t('div.16')], [32, t('div.32')]]],
  [t('div.triplet'), [[1 / 3, t('div.t0.5')], [2 / 3, t('div.t1')]]],
  [t('div.dotted'), [[0.75, t('div.d0.5')], [1.5, t('div.d1')], [3, t('div.d2')], [6, t('div.d4')], [12, t('div.d8')]]],
];
const sameDiv = (a, b) => Math.abs(a - b) < 1e-4;
const pct = (v) => `${Math.round(v * 100)}%`;
const MOVE = (o) => o.mode === 'glide' || o.mode === 'path';
const STEP = (o) => o.mode === 'jitter' || MOVE(o);
const NOT_HOLD = (o) => o.mode !== 'hold';
const SHAPED = (o) => STEP(o) || o.mode === 'drift';
const FREE = (o) => o.timing.sync === 'free';
const TEMPO = (o) => o.timing.sync === 'tempo';
const isMode = (m) => (o) => o.mode === m;
const DRAWN = (o) => o.mode === 'path' && o.pathSource === 'custom';
const RANDOM_PATH = (o) => o.mode === 'path' && o.pathSource !== 'custom';
const fmtSlew = (v) => (v <= 0 ? t('ed.instant') : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`);

/** Rebuilt on every language change (labels are translated when the editor is built). */
let FIELDS = [];
const makeFields = () => [
  { section: t('ed.sec.basic') },
  { path: 'enabled', label: t('ed.enabled'), type: 'toggle' },
  { path: 'name', label: t('ed.name'), type: 'text', single: true },
  { path: 'sourceId', label: t('ed.sourceId'), type: 'number', min: 1, max: 999, step: 1, title: t('ed.sourceId.title') },
  { path: 'mode', label: t('ed.mode'), type: 'seg', options: MODE_KEYS.map((m) => [m, modeName(m)]) },
  { type: 'modehelp' },
  { section: t('ed.sec.region') },
  { path: 'center.x', label: t('ed.centerX'), type: 'range', min: -1, max: 1, step: 0.01, rel: true, reset: 0 },
  { path: 'center.y', label: t('ed.centerY'), type: 'range', min: -1, max: 1, step: 0.01, rel: true, reset: 0 },
  { path: 'center.z', label: t('ed.centerZ'), type: 'range', min: -1, max: 1, step: 0.01, rel: true, reset: 0 },
  { path: 'range.x', label: t('ed.rangeX'), type: 'range', min: 0, max: 1, step: 0.01, rel: true, applies: NOT_HOLD },
  { path: 'range.y', label: t('ed.rangeY'), type: 'range', min: 0, max: 1, step: 0.01, rel: true, applies: NOT_HOLD },
  { path: 'range.z', label: t('ed.rangeZ'), type: 'range', min: 0, max: 1, step: 0.01, rel: true, applies: NOT_HOLD },
  { path: 'rangeShape', label: t('ed.shape'), type: 'seg', options: [['box', t('ed.shape.box')], ['ellipse', t('ed.shape.ellipse')], ['ring', t('ed.shape.ring')]], applies: SHAPED },
  { path: 'innerRadius', label: t('ed.inner'), type: 'range', min: 0, max: 0.95, step: 0.01, fmt: pct, applies: (o) => SHAPED(o) && o.rangeShape === 'ring' },
  { section: t('ed.sec.timing') },
  { path: 'timing.sync', label: t('ed.sync'), type: 'seg', options: [['free', t('ed.sync.free')], ['tempo', t('ed.sync.tempo')]], applies: NOT_HOLD },
  { path: 'timing.min', label: t('ed.min'), type: 'range', scale: 'log', min: 0.05, max: 60, fmt: fmtSec, applies: (o) => FREE(o) && (STEP(o) || o.mode === 'orbit'), pair: ['timing.max', 1] },
  { path: 'timing.max', label: t('ed.max'), type: 'range', scale: 'log', min: 0.05, max: 60, fmt: fmtSec, applies: (o) => FREE(o) && (STEP(o) || o.mode === 'orbit'), pair: ['timing.min', -1] },
  { path: 'driftRate', label: t('ed.driftRate'), type: 'range', scale: 'log', min: 0.01, max: 10, fmt: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)), applies: (o) => o.mode === 'drift' && FREE(o) },
  { path: 'timing.divisions', label: t('ed.divs'), type: 'divs', applies: (o) => NOT_HOLD(o) && TEMPO(o) },
  { path: 'timing.tempoMode', label: t('ed.tempoMode'), type: 'seg', options: [['grid', t('ed.tempoMode.grid')], ['length', t('ed.tempoMode.length')]], applies: (o) => STEP(o) && TEMPO(o), title: t('ed.tempoMode.title') },
  { type: 'hint', text: t('ed.tempoMode.hint'), applies: (o) => STEP(o) && TEMPO(o) },
  { path: 'timing.phaseOffset', label: t('ed.phase'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: (o) => TEMPO(o) && (STEP(o) || o.mode === 'orbit') },
  { path: 'speedScale', label: t('ed.speedScale'), type: 'range', scale: 'log', min: 0.25, max: 4, fmt: (v) => `${v.toFixed(2)}×`, snap: [0.25, 0.5, 1, 2, 4], applies: NOT_HOLD, title: t('ed.speedScale.title') },
  { section: t('ed.sec.motion') },
  { path: 'glide', label: t('ed.glide'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: MOVE, title: t('ed.glide.title') },
  { path: 'easing', label: t('ed.easing'), type: 'select', options: [['linear', 'Linear'], ['inOut', 'Ease In-Out'], ['in', 'Ease In'], ['out', 'Ease Out'], ['smooth', 'Smooth']], applies: MOVE },
  { path: 'jumpChance', label: t('ed.jumpChance'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: MOVE },
  { path: 'jumpSlew', label: t('ed.jumpSlew'), type: 'range', scale: 'log0', min: 0, logMin: 5, max: 2000, fmt: fmtSlew, applies: STEP, title: t('ed.jumpSlew.title') },
  { path: 'restChance', label: t('ed.rest'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: STEP },
  { path: 'minStep', label: t('ed.minStep'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: (o) => STEP(o) && !DRAWN(o) },
  { path: 'pathSource', label: t('ed.pathSource'), type: 'seg', options: [['random', t('ed.pathSource.random')], ['custom', t('ed.pathSource.custom')]], applies: isMode('path') },
  { path: 'pathPts', type: 'pathtools', applies: DRAWN },
  { type: 'hint', text: t('ed.pathHint.empty'), applies: (o) => DRAWN(o) && o.pathPts.length < 2 },
  { path: 'pathPoints', label: t('ed.pathPoints'), type: 'range', min: 2, max: 16, step: 1, fmt: (v) => String(Math.round(v)), applies: RANDOM_PATH },
  { path: 'pathOrder', label: t('ed.pathOrder'), type: 'seg', options: [['loop', t('ed.pathOrder.loop')], ['pingpong', t('ed.pathOrder.pingpong')], ['shuffle', t('ed.pathOrder.shuffle')]], applies: isMode('path') },
  { path: 'pathCurve', label: t('ed.pathCurve'), type: 'seg', options: [['linear', t('ed.pathCurve.linear')], ['catmull', t('ed.pathCurve.catmull')]], applies: isMode('path') },
  { path: 'pathTiming', label: t('ed.pathTiming'), type: 'seg', options: [['step', t('ed.pathTiming.step')], ['even', t('ed.pathTiming.even')]], applies: DRAWN, title: t('ed.pathTiming.title') },
  { path: 'pathStart', label: t('ed.pathStart'), type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, applies: DRAWN, title: t('ed.pathStart.title') },
  { path: 'pathJitter', label: t('ed.pathJitter'), type: 'range', min: 0, max: 0.3, step: 0.005, applies: DRAWN, title: t('ed.pathJitter.title') },
  { path: 'pathWobble', label: t('ed.pathWobble'), type: 'range', min: 0, max: 0.3, step: 0.005, applies: isMode('path'), title: t('ed.pathWobble.title') },
  { path: 'pathRegen', label: t('ed.pathRegen'), type: 'toggle', applies: RANDOM_PATH },
  { path: 'driftDepth', label: t('ed.driftDepth'), type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, applies: isMode('drift') },
  { path: 'orbitDir', label: t('ed.orbitDir'), type: 'seg', options: [['cw', t('ed.orbitDir.cw')], ['ccw', t('ed.orbitDir.ccw')], ['random', t('ed.orbitDir.random')]], applies: isMode('orbit') },
  { path: 'seed', label: t('ed.seed'), type: 'number', min: 0, max: 999999, step: 1, applies: NOT_HOLD, title: t('ed.seed.title') },
];

const isLog = (f) => f.scale === 'log' || f.scale === 'log0';
function toSlider(f, v) {
  if (f.scale === 'log0') return v <= 0 ? 0 : clamp(1 + (999 * Math.log(v / f.logMin)) / Math.log(f.max / f.logMin), 1, 1000);
  return f.scale === 'log' ? (1000 * Math.log(v / f.min)) / Math.log(f.max / f.min) : v;
}
function fromSlider(f, s) {
  if (!isLog(f)) return Number(s);
  if (f.scale === 'log0') {
    if (Number(s) <= 0) return 0;
    const v = f.logMin * (f.max / f.logMin) ** ((Number(s) - 1) / 999);
    return v < 100 ? Math.round(v) : Math.round(v / 10) * 10;
  }
  let v = f.min * (f.max / f.min) ** (Number(s) / 1000);
  if (f.snap) {
    const near = f.snap.find((x) => Math.abs(v / x - 1) < 0.05);
    if (near) return near;
  }
  return Number(v.toPrecision(3));
}

const selectedObjects = () => [...selected].sort((a, b) => a - b).map((id) => OBJ[id - 1]).filter(Boolean);
const targetsOf = (f) => selectedObjects().filter((o) => !f.applies || f.applies(o));

function fixTiming(o, path) {
  if (path === 'timing.min' && o.timing.min > o.timing.max) o.timing.max = o.timing.min;
  if (path === 'timing.max' && o.timing.max < o.timing.min) o.timing.min = o.timing.max;
}

function afterLocalEdit() {
  updateEditorValues();
  renderGrid();
  dirty = true;
}

function applyEdit(f, value) {
  const targets = targetsOf(f);
  if (!targets.length) return;
  if (f.path === 'pathSource' && value === 'custom' && targets.some((o) => o.pathPts.length < 2)) {
    // Start from a simple shape inside the zone so there is something to see and edit right away.
    if (applyEach(targets.map((o) => ({ id: o.id, patch: o.pathPts.length < 2 ? { pathSource: 'custom', pathPts: defaultPathPts(o) } : { pathSource: 'custom' } })))) {
      startPathEdit(targets[0].id, 'points');
    }
    return;
  }
  const patch = setPath(f.path, value);
  if (!send({ type: 'updateObjects', ids: targets.map((o) => o.id), patch })) { afterLocalEdit(); return; }
  for (const o of targets) {
    mergeLocal(o, structuredClone(patch));
    fixTiming(o, f.path);
  }
  afterLocalEdit();
}

function applyEach(items) {
  if (!items.length) return false;
  if (!send({ type: 'updateObjectsEach', items })) return false;
  for (const it of items) mergeLocal(OBJ[it.id - 1], structuredClone(it.patch));
  afterLocalEdit();
  return true;
}

function buildControl(f) {
  if (f.section) {
    f.el = h('div', { class: 'section' }, f.section);
    return f.el;
  }
  if (f.type === 'modehelp') {
    f.el = h('div', { class: 'mode-help' });
    f.set = (v, { targets, mixed }) => {
      const vmax = S?.master?.maxVelocity || 0;
      const exceptJumps = S?.master?.vmaxExceptJumps !== false;
      const jumps = targets.some((o) => o.mode === 'jitter' || (['glide', 'path'].includes(o.mode) && o.jumpChance > 0));
      f.el.textContent = (mixed ? t('ed.mixedModes') : t(`mode.${targets[0].mode}.help`))
        + (vmax > 0 && jumps && !exceptJumps ? t('ed.vmaxWarn', { v: vmax.toFixed(2) }) : '');
    };
    return f.el;
  }
  if (f.type === 'hint') {
    f.el = h('p', { class: 'hint field-hint' }, f.text);
    f.set = () => {};
    return f.el;
  }
  if (f.type === 'pathtools') return buildPathTools(f);
  const id = nextId('f');
  const ctl = h('div', { class: 'ctl' });
  const labelEl = ['seg', 'divs'].includes(f.type)
    ? h('span', { class: 'lbl', id: `${id}-l` }, f.label)
    : h('label', { for: id }, f.label);
  const row = h('div', { class: 'row', title: f.title || '' }, labelEl, ctl);
  f.el = row;
  const fmt = f.fmt || ((v) => Number(v).toFixed(2));

  switch (f.type) {
    case 'range': {
      const r = h('input', { type: 'range', id, min: isLog(f) ? 0 : f.min, max: isLog(f) ? 1000 : f.max, step: isLog(f) ? 1 : f.step });
      const val = h('span', { class: 'val' });
      let startV = 0;
      r.addEventListener('pointerdown', () => { startV = fromSlider(f, r.value); });
      r.addEventListener('focus', () => { startV = fromSlider(f, r.value); });
      r.addEventListener('input', () => {
        if (!guardEdit()) { updateEditorValues(); return; }
        const v = fromSlider(f, r.value);
        if (f.rel && f.mixed) {
          const delta = v - f.lastV;
          f.lastV = v;
          const items = targetsOf(f).map((o) => ({ id: o.id, patch: setPath(f.path, clamp(getPath(o, f.path) + delta, f.min, f.max)) }));
          applyEach(items);
          const total = v - startV;
          val.textContent = `Δ${total >= 0 ? '+' : ''}${total.toFixed(2)}`;
          return;
        }
        f.lastV = v;
        val.textContent = fmt(v);
        applyEdit(f, v);
      });
      r.addEventListener('dblclick', () => {
        if (f.reset !== undefined) applyEdit(f, f.reset);
      });
      ctl.append(r, val);
      f.set = (v, { mixed }) => {
        f.mixed = mixed;
        if (document.activeElement !== r) {
          r.value = toSlider(f, v);
          f.lastV = v;
        }
        if (document.activeElement !== r || !mixed) val.textContent = mixed ? t('ed.mixed') : fmt(v);
      };
      break;
    }
    case 'number': {
      const n = h('input', { type: 'number', id, min: f.min, max: f.max, step: f.step });
      n.addEventListener('change', () => {
        if (n.value === '') return;
        applyEdit(f, Number(n.value));
      });
      ctl.append(n);
      f.set = (v, { mixed }) => {
        if (document.activeElement === n) return;
        n.value = mixed ? '' : v;
        n.placeholder = mixed ? t('ed.mixed') : '';
      };
      break;
    }
    case 'text': {
      const t = h('input', { type: 'text', id, maxLength: 32 });
      t.addEventListener('change', () => applyEdit(f, t.value));
      ctl.append(t);
      f.set = (v) => { if (document.activeElement !== t) t.value = v; };
      break;
    }
    case 'toggle': {
      const c = h('input', { type: 'checkbox', id, role: 'switch' });
      c.addEventListener('change', () => applyEdit(f, c.checked));
      ctl.append(h('span', { class: 'toggle' }, c, h('span', { 'aria-hidden': 'true' })));
      f.set = (v, { mixed }) => {
        c.indeterminate = mixed;
        c.checked = !mixed && !!v;
      };
      break;
    }
    case 'select': {
      const s = h('select', { id }, h('option', { value: '', disabled: true }, t('ed.mixed')), f.options.map(([v, l]) => h('option', { value: v }, l)));
      s.addEventListener('change', () => applyEdit(f, s.value));
      ctl.append(s);
      f.set = (v, { mixed }) => { s.value = mixed ? '' : v; };
      break;
    }
    case 'seg': {
      const seg = h('div', { class: 'seg', role: 'group', 'aria-labelledby': `${id}-l` });
      for (const [v, l] of f.options) {
        seg.append(h('button', { 'data-v': v, 'aria-pressed': 'false', onclick: () => applyEdit(f, v) }, l));
      }
      ctl.append(seg);
      f.set = (v, { vals }) => $$('button', seg).forEach((b) => {
        const n = vals.filter((x) => String(x) === b.dataset.v).length;
        b.classList.toggle('on', n === vals.length);
        b.classList.toggle('partial', n > 0 && n < vals.length);
        b.setAttribute('aria-pressed', n === vals.length ? 'true' : n > 0 ? 'mixed' : 'false');
      });
      break;
    }
    case 'divs': {
      const box = h('div', { class: 'divs', role: 'group', 'aria-labelledby': `${id}-l` });
      for (const [rowLabel, items] of divRows()) {
        box.append(h('div', { class: 'drow' }, h('span', { class: 'dlab' }, rowLabel), items.map(([d, l]) => h('button', {
          'data-v': d,
          title: t('div.beats', { n: Math.round(d * 1000) / 1000 }),
          onclick: () => {
            if (!guardEdit()) return;
            const targets = targetsOf(f);
            const allHave = targets.every((o) => o.timing.divisions.some((x) => sameDiv(x, d)));
            const items2 = targets.map((o) => {
              let cur = o.timing.divisions.filter((x) => !sameDiv(x, d));
              if (!allHave) cur = [...cur, d];
              if (!cur.length) cur = o.timing.divisions;
              return { id: o.id, patch: { timing: { divisions: cur.sort((a, b) => a - b) } } };
            });
            applyEach(items2);
          },
        }, l))));
      }
      ctl.append(box);
      f.set = (v, { vals }) => $$('button', box).forEach((b) => {
        const d = Number(b.dataset.v);
        const n = vals.filter((arr) => arr.some((x) => sameDiv(x, d))).length;
        b.classList.toggle('on', n === vals.length);
        b.classList.toggle('partial', n > 0 && n < vals.length);
        b.setAttribute('aria-pressed', n === vals.length ? 'true' : n > 0 ? 'mixed' : 'false');
      });
      break;
    }
  }
  return row;
}

function buildEditor() {
  FIELDS = makeFields();
  $('#editor').replaceChildren(
    h('div', { class: 'empty', id: 'editorEmpty' }, t('ed.empty')),
    h('div', { id: 'editorBody' }, FIELDS.map(buildControl)),
  );
}

function updateEditorValues() {
  if (!S || !$('#editorBody')) return;
  const objs = selectedObjects();
  $('#editorEmpty').style.display = objs.length ? 'none' : '';
  $('#editorBody').style.display = objs.length ? '' : 'none';
  if (!objs.length) return;

  let section = null;
  let sectionHas = false;
  const finish = () => { if (section) section.el.style.display = sectionHas ? '' : 'none'; };
  for (const f of FIELDS) {
    if (f.section) {
      finish();
      section = f;
      sectionHas = false;
      continue;
    }
    const targets = f.applies ? objs.filter(f.applies) : objs;
    const show = targets.length > 0 && !(f.single && objs.length > 1);
    f.el.style.display = show ? '' : 'none';
    if (!show || f.type === 'hint') continue;
    sectionHas = true;
    const vals = f.type === 'modehelp' ? targets.map((o) => o.mode) : targets.map((o) => getPath(o, f.path));
    const first = JSON.stringify(vals[0]);
    const mixed = vals.some((v) => JSON.stringify(v) !== first);
    f.set(vals[0], { mixed, targets, vals });
    if (f.type !== 'modehelp') {
      f.el.classList.toggle('mixed', mixed);
      const partial = targets.length < objs.length ? t('ed.partial', { n: targets.length }) : '';
      f.el.title = (mixed ? t(f.rel ? 'ed.mixedRel' : 'ed.mixedTitle') : (f.title || '')) + partial;
    }
  }
  finish();
}

// ---------------- tabs ----------------
function openLibraryTab() {
  activateTab($('#tabbtn-library'));
  if (selected.size === 1 && !isLocked()) libUi.openSave();
}

function activateTab(t) {
  $$('.tab').forEach((x) => {
    const on = x === t;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', String(on));
    x.tabIndex = on ? 0 : -1;
  });
  $$('.tab-body').forEach((b) => b.classList.toggle('active', b.id === `tab-${t.dataset.tab}`));
}
$$('.tab').forEach((t) => {
  t.addEventListener('click', () => activateTab(t));
  t.addEventListener('keydown', (e) => {
    if (e.code !== 'ArrowRight' && e.code !== 'ArrowLeft') return;
    const tabs = $$('.tab');
    const next = tabs[(tabs.indexOf(t) + (e.code === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    activateTab(next);
    next.focus();
  });
});

// ---------------- tools (scatter / humanize) ----------------
const tool = { shape: 'circle', radius: 0.7, angle: 0, offset: 0, spacing: 0.2, amount: 0.3, h: { timing: true, range: true, glide: true, drift: true, phase: true, dir: true } };

function toolRange(label, key, min, max, step, fmt = (v) => v.toFixed(2)) {
  const id = nextId('t');
  const val = h('span', { class: 'val' }, fmt(tool[key]));
  const r = h('input', { type: 'range', id, min, max, step, value: tool[key] });
  r.addEventListener('input', () => { tool[key] = Number(r.value); val.textContent = fmt(tool[key]); });
  return h('div', { class: 'row', 'data-key': key }, h('label', { for: id }, label), h('div', { class: 'ctl' }, r, val));
}

function scatterPositions(n) {
  const { shape, radius: r, angle, offset, spacing } = tool;
  const out = [];
  if (shape === 'circle') {
    for (let i = 0; i < n; i++) {
      const a = (angle * Math.PI) / 180 + (i * 2 * Math.PI) / n;
      out.push([r * Math.sin(a), r * Math.cos(a)]);
    }
  } else if (shape === 'lineX' || shape === 'lineY') {
    for (let i = 0; i < n; i++) {
      const v = n === 1 ? 0 : -r + (2 * r * i) / (n - 1);
      out.push(shape === 'lineX' ? [v, offset] : [offset, -v]);
    }
  } else if (shape === 'grid') {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const rw = Math.floor(i / cols);
      out.push([cols === 1 ? 0 : -r + (2 * r * c) / (cols - 1), rows === 1 ? 0 : r - (2 * r * rw) / (rows - 1)]);
    }
  } else {
    for (let i = 0; i < n; i++) {
      let best = null;
      let bestD = -1;
      for (let k = 0; k < 200; k++) {
        const p = [(Math.random() * 2 - 1) * r, (Math.random() * 2 - 1) * r];
        const d = out.length ? Math.min(...out.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]))) : Infinity;
        if (d >= spacing) { best = p; break; }
        if (d > bestD) { best = p; bestD = d; }
      }
      out.push(best);
    }
  }
  return out.map(([x, y]) => [clamp(Math.round(x * 1000) / 1000, -1, 1), clamp(Math.round(y * 1000) / 1000, -1, 1)]);
}

function runScatter() {
  const objs = selectedObjects();
  if (!objs.length) { toast(t('srv.noSelection'), 'warn'); return; }
  const pts = scatterPositions(objs.length);
  if (applyEach(objs.map((o, i) => ({ id: o.id, patch: { center: { x: pts[i][0], y: pts[i][1] } } })))) {
    toast(t('tools.scattered', { n: objs.length }));
  }
}

function runHumanize() {
  const objs = selectedObjects();
  if (!objs.length) { toast(t('srv.noSelection'), 'warn'); return; }
  const v = tool.amount;
  const vary = (x) => x * (1 + (Math.random() * 2 - 1) * v);
  const r2 = (x) => Math.round(x * 1000) / 1000;
  const items = objs.map((o) => {
    const patch = {};
    if (tool.h.timing) {
      const mn = clamp(vary(o.timing.min), 0.05, 60);
      patch.timing = { min: r2(mn), max: r2(Math.max(mn, clamp(vary(o.timing.max), 0.05, 60))) };
    }
    if (tool.h.phase) patch.timing = { ...(patch.timing || {}), phaseOffset: r2(Math.random() * v) };
    if (tool.h.range) patch.range = { x: r2(clamp(vary(o.range.x), 0, 1)), y: r2(clamp(vary(o.range.y), 0, 1)) };
    if (tool.h.glide) patch.glide = r2(clamp(o.glide + (Math.random() * 2 - 1) * v * 0.5, 0, 1));
    if (tool.h.drift) patch.driftRate = r2(clamp(vary(o.driftRate), 0.01, 10));
    if (tool.h.dir && o.orbitDir !== 'random' && Math.random() < v * 0.5) patch.orbitDir = o.orbitDir === 'cw' ? 'ccw' : 'cw';
    return { id: o.id, patch };
  });
  if (applyEach(items)) toast(t('tools.humanized', { n: objs.length, amount: pct(v) }));
}

function buildTools() {
  const root = $('#tab-tools');
  const shapes = ['circle', 'lineX', 'lineY', 'grid', 'random'].map((k) => [k, t(`tools.shape.${k}`)]);
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('tools.shape') });
  const rows = {
    angle: toolRange(t('tools.angle'), 'angle', 0, 360, 1, (v) => `${Math.round(v)}°`),
    offset: toolRange(t('tools.offset'), 'offset', -1, 1, 0.01),
    spacing: toolRange(t('tools.spacing'), 'spacing', 0, 0.6, 0.01),
  };
  const sync = () => {
    $$('button', seg).forEach((b) => { b.classList.toggle('on', b.dataset.v === tool.shape); b.setAttribute('aria-pressed', String(b.dataset.v === tool.shape)); });
    rows.angle.style.display = tool.shape === 'circle' ? '' : 'none';
    rows.offset.style.display = tool.shape === 'lineX' || tool.shape === 'lineY' ? '' : 'none';
    rows.spacing.style.display = tool.shape === 'random' ? '' : 'none';
  };
  for (const [v, l] of shapes) seg.append(h('button', { 'data-v': v, onclick: () => { tool.shape = v; sync(); } }, l));
  const hchk = (key, label) => h('label', { class: 'chk' }, h('input', {
    type: 'checkbox', checked: tool.h[key], onchange: (e) => { tool.h[key] = e.target.checked; },
  }), label);
  root.replaceChildren(
    h('div', { class: 'section' }, t('tools.scatter')),
    h('p', { class: 'hint' }, t('tools.scatter.hint')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('tools.shape')), h('div', { class: 'ctl' }, seg)),
    toolRange(t('tools.radius'), 'radius', 0.05, 1, 0.01),
    rows.angle, rows.offset, rows.spacing,
    h('button', { class: 'accent tool-run', id: 'btnScatter', onclick: runScatter }),
    h('div', { class: 'section' }, t('tools.humanize')),
    h('p', { class: 'hint' }, t('tools.humanize.hint')),
    toolRange(t('tools.amount'), 'amount', 0, 1, 0.01, pct),
    h('div', { class: 'card' },
      hchk('timing', t('tools.h.timing')), ' ', hchk('range', t('tools.h.range')), ' ', hchk('glide', t('tools.h.glide')), ' ',
      hchk('drift', t('tools.h.drift')), ' ', hchk('phase', t('tools.h.phase')), ' ', hchk('dir', t('tools.h.dir'))),
    h('button', { class: 'accent tool-run', id: 'btnHumanize', onclick: runHumanize }),
  );
  sync();
  updateToolCounts();
}

function updateToolCounts() {
  const n = selected.size;
  const a = $('#btnScatter');
  const b = $('#btnHumanize');
  if (a) a.textContent = t('tools.scatter.run', { n });
  if (b) b.textContent = t('tools.humanize.run', { n });
}

// ---------------- presets ----------------
function loadSlot(slot) {
  const p = PRESETS.find((x) => x.slot === slot);
  if (!p) { toast(t('slot.emptyHint', { slot }), 'warn'); return; }
  send({ type: 'slot.load', slot, ...loadOpts() });
}

function presetFade() {
  const v = $('#presetFade')?.value;
  return v === '' || v === undefined ? {} : { fade: Number(v) };
}

function loadOpts() {
  return { ...presetFade(), globals: localStorage.getItem('objitter.loadGlobals') === '1' ? 'preset' : 'keep' };
}

const saveGlobals = () => $('#presetSaveGlobals')?.checked ?? true;

function buildPresets() {
  const root = $('#tab-presets');
  const name = h('input', { type: 'text', id: 'presetName', placeholder: t('pre.name'), maxLength: 64, 'aria-label': t('pre.name') });
  const save = () => {
    const n = name.value.trim();
    if (!n) { toast(t('pre.needName'), 'error'); return; }
    if (send({ type: 'preset.save', name: n, saveGlobals: saveGlobals() })) name.value = '';
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) save();
  });
  const file = h('input', { type: 'file', accept: '.json,application/json', multiple: true, style: 'display:none' });
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      try {
        const data = JSON.parse(await f.text());
        const n = String(data?.name || f.name.replace(/(\.objitter)?\.json$/i, '')).trim();
        send({ type: 'preset.import', name: n, data });
      } catch {
        toast(t('ui.jsonFailed', { file: f.name }), 'error');
      }
    }
    file.value = '';
  });
  root.replaceChildren(
    h('div', { class: 'section' }, t('pre.saveScene')),
    h('div', { class: 'preset-save' }, name, h('button', { class: 'accent', onclick: save }, t('common.save'))),
    h('div', { class: 'preset-opts' },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'presetSaveGlobals', checked: true }), t('pre.saveGlobals'))),
    h('p', { class: 'hint' }, t('pre.saveHint')),
    h('p', { class: 'hint' }, t('pre.libHint'), ' ', h('button', { type: 'button', class: 'linkish', onclick: openLibraryTab }, t('pre.libHint.btn'))),
    h('div', { class: 'section' }, t('pre.recall')),
    h('div', { class: 'row' }, h('label', { for: 'presetFade' }, t('pre.fade')),
      h('div', { class: 'ctl' }, h('input', { type: 'number', id: 'presetFade', min: 0, max: 60, step: 0.1, placeholder: t('top.fade') }),
        h('span', { class: 'muted' }, t('pre.fadeEmpty')))),
    h('label', { class: 'chk', title: t('pre.loadGlobals.title') },
      h('input', {
        type: 'checkbox', id: 'presetLoadGlobals', checked: localStorage.getItem('objitter.loadGlobals') === '1',
        onchange: (e) => localStorage.setItem('objitter.loadGlobals', e.target.checked ? '1' : '0'),
      }), t('pre.loadGlobals')),
    h('div', { class: 'preset-list', id: 'presetList' }),
    h('div', { class: 'btn-row', style: 'grid-template-columns:1fr' }, h('button', { onclick: () => { if (guardEdit()) file.click(); } }, t('pre.importJson'))),
    file,
    h('div', { class: 'card' },
      h('p', {}, t('pre.osc'), h('code', {}, t('pre.osc.preset')), ' · ', h('code', {}, t('pre.osc.slot', { max: ST.constants.slots }))),
      h('p', {}, t('pre.dragHint')),
      h('p', {}, t('pre.oscMore'))),
  );
}

function editNote(noteEl, p) {
  if (!guardEdit()) return;
  const inp = h('input', {
    type: 'text', class: 'pnote-in', maxLength: 120, value: p.note || '', spellcheck: false,
    placeholder: t('pre.note.ph'), 'aria-label': t('pre.note.aria', { name: p.name }),
  });
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    if (save && v !== (p.note || '')) send({ type: 'preset.meta', name: p.name, note: v });
    if (inp.isConnected) inp.replaceWith(noteEl);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); done(true); }
    else if (e.code === 'Escape' && !e.shiftKey) done(false);
  });
  inp.addEventListener('blur', () => done(true));
  noteEl.replaceWith(inp);
  inp.focus();
}

let presetSig = null;
let presetDownTarget = null;
function renderPresets() {
  const list = $('#presetList');
  if (!list) return;
  const sig = JSON.stringify(PRESETS) + JSON.stringify(palette());
  if (sig === presetSig) { renderPresetsActive(); return; }
  presetSig = sig;
  if (!PRESETS.length) {
    list.replaceChildren(h('div', { class: 'empty', style: 'padding:16px' }, t('pre.none')));
    return;
  }
  const slotOpts = (cur) => [h('option', { value: '' }, t('pre.slotNone')), ...Array.from({ length: ST.constants.slots }, (_, i) => h('option', { value: i + 1, selected: cur === i + 1 }, t('slot.n', { n: i + 1 })))];
  list.replaceChildren(...PRESETS.map((p) => {
    const hex = palHex(p.color);
    const slotSel = h('select', { class: 'pslot p-edit', 'aria-label': t('pre.slot.aria', { name: p.name }) }, slotOpts(p.slot));
    slotSel.addEventListener('change', () => {
      if (!send({ type: 'preset.setSlot', name: p.name, slot: slotSel.value === '' ? null : Number(slotSel.value) })) slotSel.value = p.slot ?? '';
    });
    const chip = h('button', {
      class: 'pchip p-edit', style: hex ? `--pc:${hex}` : null, title: t('pre.color'), 'aria-label': t('pre.color.aria', { name: p.name }),
      onclick: (e) => {
        if (guardEdit()) openPalette(e.currentTarget, p.color, (k) => send({ type: 'preset.meta', name: p.name, color: k }));
      },
    });
    const noteEl = h('div', { class: 'pnote', hidden: !p.note, title: p.note || '' }, p.note || '');
    return h('div', {
      class: `preset${hex ? ' colored' : ''}`, 'data-name': p.name, draggable: FINE_POINTER ? 'true' : null, style: hex ? `--pc:${hex}` : null,
      onpointerdown: (e) => { presetDownTarget = e.target; },
      ondragstart: (e) => {
        if (presetDownTarget instanceof Element && presetDownTarget.closest('button, select, input')) { e.preventDefault(); return; }
        e.dataTransfer.setData(DRAG_TYPE, p.name);
        e.dataTransfer.effectAllowed = 'move';
      },
    },
      h('div', { class: 'ptop' }, chip, h('div', { class: 'pname', title: p.name }, p.name), slotSel),
      h('div', { class: 'pmeta' }, `${new Date(p.mtime).toLocaleString(getLang())} · ${t(p.count < 32 ? 'pre.countPartial' : 'pre.count', { n: p.count })}`),
      noteEl,
      h('div', { class: 'puse', 'data-name': p.name, hidden: true }),
      h('div', { class: 'pact' },
        h('button', { class: 'load', onclick: () => send({ type: 'preset.load', name: p.name, ...loadOpts() }) }, t('pre.loadAll')),
        h('button', {
          onclick: () => {
            if (!selected.size) { toast(t('srv.noSelection'), 'warn'); return; }
            send({ type: 'preset.load', name: p.name, ids: [...selected], ...loadOpts() });
          },
        }, t('pre.loadSel')),
        h('button', { class: 'p-edit', title: t('pre.note.edit'), onclick: () => editNote(noteEl, p) }, t('pre.note')),
        armButton(h('button', { class: 'p-edit', title: t('pre.overwrite.title') }, t('common.overwrite')),
          () => send({ type: 'preset.save', name: p.name, overwrite: true, keepScope: true, saveGlobals: saveGlobals() })),
        h('button', { title: t('pre.exportJson'), 'aria-label': t('pre.exportJson'), onclick: () => send({ type: 'preset.get', name: p.name }) }, '⇩'),
        armButton(h('button', { class: 'danger p-edit', title: t('common.delete'), 'aria-label': t('common.delete') }, '✕'), () => send({ type: 'preset.delete', name: p.name }))));
  }));
  renderPresetsActive();
  renderPresetUsage();
}

function renderPresetUsage() {
  for (const el of $$('#presetList .puse')) {
    const nums = tcui.cuesUsing?.(el.dataset.name) ?? [];
    el.hidden = !nums.length;
    el.textContent = nums.length ? t('pre.usedBy', { cues: nums.join('·') }) : '';
  }
}

function renderPresetsActive() {
  const lp = S?.lastPreset;
  for (const el of $$('#presetList .preset')) {
    const on = !!lp && lp.name.toLowerCase() === el.dataset.name.toLowerCase();
    el.classList.toggle('active', on);
    $('.pname', el).textContent = `${el.dataset.name}${on && lp.modified ? ' *' : ''}`;
  }
}

const DRAG_TYPE = 'application/x-objitter-preset';
const FINE_POINTER = matchMedia('(pointer: fine)').matches;

function assignSlot(slot, name) {
  if (!guardEdit()) return;
  if (name === null) send({ type: 'slot.clear', slot });
  else send({ type: 'preset.setSlot', name, slot });
}

function buildSlots() {
  const box = $('#slots');
  box.replaceChildren(...Array.from({ length: ST.constants.slots }, (_, i) => {
    const s = i + 1;
    const b = h('button', { class: 'slot', 'data-slot': s, 'aria-keyshortcuts': slotKeyLabel(s) },
      h('span', { class: 'sn' }, s), h('span', { class: 'sk', 'aria-hidden': 'true' }, slotKeyShort(s)), h('span', { class: 'sl' }));
    b.addEventListener('pointerenter', () => setSlotHint(s));
    b.addEventListener('focus', () => setSlotHint(s));
    b.addEventListener('pointerleave', () => setSlotHint(null));
    b.addEventListener('blur', () => setSlotHint(null));
    let lp = null;
    let suppress = false;
    const cancel = () => { clearTimeout(lp); lp = null; };
    b.addEventListener('click', (e) => {
      if (suppress) { suppress = false; return; }
      if (IS_MAC && e.ctrlKey) return;
      loadSlot(s);
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSlotMenu(s, b);
    });
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      lp = setTimeout(() => {
        lp = null;
        suppress = true;
        navigator.vibrate?.(15);
        openSlotMenu(s, b);
      }, 550);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, cancel);
    b.addEventListener('dragstart', (e) => {
      const p = PRESETS.find((x) => x.slot === s);
      if (!p) { e.preventDefault(); return; }
      e.dataTransfer.setData(DRAG_TYPE, p.name);
      e.dataTransfer.effectAllowed = 'move';
    });
    b.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      b.classList.add('drop');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => {
      b.classList.remove('drop');
      const name = e.dataTransfer.getData(DRAG_TYPE);
      if (!name) return;
      e.preventDefault();
      assignSlot(s, name);
    });
    return b;
  }));
}

let slotHintFor = null;
function setSlotHint(s) {
  slotHintFor = s;
  const el = $('#slotHint');
  if (!s) { el.textContent = t('slots.hint', staticParams); el.classList.remove('live'); return; }
  const p = PRESETS.find((x) => x.slot === s);
  el.textContent = p ? `${t('slot.n', { n: s })}: ${p.name}${p.note ? ` — ${p.note}` : ''}` : t('slot.nEmpty', { n: s });
  el.classList.add('live');
}

function renderSlots() {
  if (!ST) return;
  const lp = S?.lastPreset;
  const cueSlot = tcui.nextCueSlot?.() ?? null;
  for (const b of $$('#slots .slot')) {
    const s = Number(b.dataset.slot);
    const p = PRESETS.find((x) => x.slot === s);
    const on = !!(p && lp && lp.name.toLowerCase() === p.name.toLowerCase());
    const hex = palHex(p?.color);
    b.classList.toggle('vacant', !p);
    b.classList.toggle('active', on);
    b.classList.toggle('modified', on && !!lp.modified);
    b.classList.toggle('cue-next', cueSlot === s);
    b.classList.toggle('colored', !!hex);
    const partial = !!p && p.count < 32;
    b.classList.toggle('partial', partial);
    if (hex) b.style.setProperty('--pc', hex);
    else b.style.removeProperty('--pc');
    b.draggable = FINE_POINTER && !!p;
    $('.sl', b).textContent = p ? p.name : '—';
    const head = p ? t('slot.title.full', { n: s, name: p.name, note: p.note ? ` — ${p.note}` : '' }) : t('slot.nEmpty', { n: s });
    const part = partial ? ` · ${t('slot.partial', { n: p.count })}` : '';
    b.title = `${head}${part} ${t('slot.title.tail', { key: slotKeyLabel(s) })}${on && lp.modified ? ` · ${t('slot.modified')}` : ''}${cueSlot === s ? ` · ${t('slot.nextCue')}` : ''}`;
    b.setAttribute('aria-label', `${p ? `${t('slot.n', { n: s })} ${p.name}` : t('slot.nEmpty', { n: s })}${part ? `, ${t('slot.partial', { n: p.count })}` : ''}${on ? `, ${t('slot.current')}` : ''}${on && lp.modified ? `, ${t('slot.modified')}` : ''}`);
  }
  if (slotHintFor) setSlotHint(slotHintFor);
}

let slotMenuFor = null;
function closeSlotMenu() {
  const m = $('#slotMenu');
  if (m.hidden) return;
  m.hidden = true;
  m.replaceChildren();
  slotMenuFor?.focus?.();
  slotMenuFor = null;
}

function openSlotMenu(slot, anchor) {
  if (!guardEdit()) return;
  const menu = $('#slotMenu');
  const cur = PRESETS.find((x) => x.slot === slot);
  const pick = (name) => { closeSlotMenu(); assignSlot(slot, name); };
  const items = PRESETS.map((p) => {
    const hex = palHex(p.color);
    return h('button', {
      role: 'menuitemradio', 'aria-checked': String(p === cur), class: p === cur ? 'on' : '', onclick: () => pick(p.name),
    }, h('i', { class: `cdot${hex ? '' : ' none'}`, style: hex ? `--pc:${hex}` : null, 'aria-hidden': 'true' }),
    h('span', { class: 'smn' }, p.name), p.slot && p.slot !== slot ? h('span', { class: 'sms' }, t('slot.move', { from: p.slot, to: slot })) : null);
  });
  const snap = h('button', {
    class: 'sm-snap accent', title: t('slot.snapshot.title'),
    onclick: () => { closeSlotMenu(); if (guardEdit()) send({ type: 'preset.snapshot', slot }); },
  }, t('slot.snapshot', { n: slot }));
  menu.replaceChildren(
    snap,
    cur && cur.count < 32 ? h('div', { class: 'sm-note muted' }, t('slot.partialNote', { name: cur.name, n: cur.count })) : null,
    h('div', { class: 'sm-note muted' }, t('slot.libHint'), ' ', h('button', { type: 'button', class: 'linkish', onclick: () => { closeSlotMenu(); openLibraryTab(); } }, t('pre.libHint.btn'))),
    h('div', { class: 'sm-head' }, t('slot.assign', { n: slot })),
    h('div', { class: 'sm-list' }, items.length ? items : h('div', { class: 'muted', style: 'padding:8px' }, t('pre.none'))),
    cur ? h('div', { class: 'sm-pal' }, h('span', { class: 'muted' }, t('slot.colorOf', { name: cur.name })),
      palRow(cur.color, (k) => { closeSlotMenu(); send({ type: 'preset.meta', name: cur.name, color: k }); })) : null,
    h('div', { class: 'sm-foot' },
      h('button', { class: 'danger', disabled: !cur, onclick: () => pick(null) }, t('slot.clear')),
      h('button', { onclick: closeSlotMenu }, t('common.close'))),
  );
  menu.hidden = false;
  slotMenuFor = anchor;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = clamp(r.left + r.width / 2 - mw / 2, 8, window.innerWidth - mw - 8);
  const top = r.top - mh - 6 >= 8 ? r.top - mh - 6 : Math.min(r.bottom + 6, window.innerHeight - mh - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  (menu.querySelector('.sm-list button.on') || menu.querySelector('.sm-list button') || menu.querySelector('.sm-foot button:last-child')).focus();
}

$('#slotMenu').addEventListener('keydown', (e) => {
  if (e.code === 'Escape') return;
  e.stopPropagation();
  const items = $$('.sm-list button', $('#slotMenu'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  let n = null;
  if (e.code === 'ArrowDown') n = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.code === 'ArrowUp') n = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.code === 'Home') n = 0;
  else if (e.code === 'End') n = items.length - 1;
  if (n === null) return;
  e.preventDefault();
  items[n].focus();
});
$('#confirmBar').addEventListener('keydown', (e) => { if (e.code !== 'Escape') e.stopPropagation(); });

document.addEventListener('pointerdown', (e) => {
  const m = $('#slotMenu');
  if (!m.hidden && !m.contains(e.target)) closeSlotMenu();
  if (palPop && !palPop.contains(e.target) && !palAnchor?.contains(e.target)) closePalette();
}, true);
window.addEventListener('resize', () => { closeSlotMenu(); closePalette(); closePops(); });

const wsm = createWorkspaces();

function buildSystemPrefs() {
  const [popT, pop] = toggleEl('sys-popout', (e) => wsm.setPopoutDefault(e.target.checked));
  pop.checked = wsm.popoutDefault();
  return h('div', { id: 'sysPrefs' },
    h('div', { class: 'section' }, t('sys.windows')),
    h('div', { class: 'row' }, h('label', { for: 'sys-popout' }, t('sys.popout')), h('div', { class: 'ctl' }, popT)),
    h('p', { class: 'hint' }, t('sys.popout.hint')));
}
const wsMount = (id, cls) => (body) => body.append(h('div', { id, class: `ws-scroll ${cls}` }));
const outUi = createOutput({ statOf, ctlErrText, stats: () => stats });
const stageWs = createStageSetup();
const oscLog = createOscLog();
const sysRoot = h('div', { id: 'tab-system' });
const setupWs = createSetup([
  {
    id: 'output', titleKey: 'tab.output', icon: 'ws-output',
    mount: (body) => {
      const root = h('div', { id: 'tab-output', class: 'ws-scroll ws-output' });
      body.append(root);
      outUi.mount(root, sysRoot);
    },
  },
  { id: 'tc', titleKey: 'tab.tc', icon: 'ws-tc', mount: wsMount('tab-tc', 'ws-tc') },
  {
    id: 'stage', titleKey: 'ws.stage', icon: 'ws-stage',
    mount: (b, tools) => stageWs.mount(b, tools), relang: () => stageWs.relang(),
    onShow: () => stageWs.onShow(), onHide: () => { stageWs.onHide(); dirty = true; },
  },
  {
    id: 'log', titleKey: 'ws.log', icon: 'ws-log',
    mount: (b, tools) => oscLog.mount(b, tools), relang: () => oscLog.relang(),
    onShow: () => oscLog.onShow(), onHide: () => oscLog.onHide(),
  },
  {
    id: 'system', titleKey: 'ws.system', icon: 'ws-system',
    mount: (b) => { b.append(h('div', { class: 'ws-scroll ws-output' }, buildSystemPrefs(), sysRoot)); },
    relang: () => $('#sysPrefs')?.replaceWith(buildSystemPrefs()),
  },
], { popout: wsm.popout });
wsm.register('setup', {
  titleKey: 'ws.setup', icon: 'ws-setup', prebuild: true,
  mount: (b, tools) => setupWs.mount(b, tools), relang: () => setupWs.relang(),
  onShow: () => setupWs.onShow(), onHide: () => setupWs.onHide(), onKey: (e) => setupWs.onKey(e),
  select: (p) => setupWs.select(p), page: () => setupWs.current(),
});
for (const p of ['output', 'tc', 'stage', 'log', 'system']) wsm.alias(p, 'setup', p);
const showWs = createShow();
wsm.register('show', {
  titleKey: 'ws.show', icon: 'ws-show', prebuild: true,
  mount: (b, tools) => showWs.mount(b, tools), relang: () => showWs.relang(),
  onShow: () => showWs.onShow(), onHide: () => showWs.onHide(), onKey: (e) => showWs.onKey(e),
});
const autoWs = createAutomation();
wsm.register('auto', {
  titleKey: 'ws.auto', icon: 'ws-auto', prebuild: true,
  mount: (b, tools) => autoWs.mount(b, tools), relang: () => autoWs.relang(),
  onShow: () => autoWs.onShow(), onHide: () => autoWs.onHide(), onKey: (e) => autoWs.onKey(e),
});
const tcui = createTimecode({
  h, $, $$, send, sendRaw, toast, guardEdit, armButton, downloadJson, askConfirm,
  presets: () => PRESETS,
  constants: () => ST?.constants,
  palette,
  groups: () => S?.groups ?? [],
  isLocked,
  renderSlots: () => { renderSlots(); renderPresetUsage(); },
  renderWarnings: () => renderWarnings(),
  selectedIds: () => [...selected],
  platform: () => ST?.network?.platform,
});

$('#tcTop').addEventListener('click', (e) => wsm.launch('show', e));

const libUi = createLibrary({ openModal, selectedIds: () => [...selected].sort((a, b) => a - b), modeName: (m) => modeName(m) });
libUi.mount($('#tab-library'));

// ---------------- canvas ----------------
const topCanvas = $('#topView');
const sideCanvas = $('#sideView');
if (MONITOR) {
  for (const c of [topCanvas, sideCanvas]) {
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'contextmenu', 'wheel']) c.addEventListener(ev, (e) => { e.stopImmediatePropagation(); if (ev !== 'pointermove') e.preventDefault(); }, { passive: false });
  }
  const badge = h('span', { class: 'badge monitor-badge' });
  const label = () => { badge.textContent = t('monitor.badge'); document.title = `${t('ws.monitor')} — Objitter`; };
  label();
  on('lang', label);
  on('init', label);
  $('.panel.stage .panel-head h2').after(badge);
}
const view = { top: { w: 1, h: 1, dpr: 1 }, side: { w: 1, h: 1, dpr: 1 } };
let bgCanvas = null;
let lastBeatIdx = -1;

const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const CANVAS_FONT = cssVar('--font-ui', 'system-ui, sans-serif');
const CANVAS_MONO = cssVar('--mono', 'ui-monospace, monospace');
const SEL_COLOR = cssVar('--sel', '#f5d76e');

/** Backing store = the canvas content box in device pixels (exact when the browser reports devicePixelContentBoxSize). */
const devBox = new Map();
function measure() {
  const dpr = window.devicePixelRatio || 1;
  for (const [key, c] of [['top', topCanvas], ['side', sideCanvas]]) {
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const d = devBox.get(c);
    // device-pixel box is only trusted when it agrees with clientSize × DPR (zoom/emulation can desync them)
    const ok = d && d.dpr === dpr && Math.abs(d.w - cw * dpr) <= 2 && Math.abs(d.h - ch * dpr) <= 2;
    const w = Math.max(1, ok ? d.w : Math.round(cw * dpr));
    const hh = Math.max(1, ok ? d.h : Math.round(ch * dpr));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    view[key] = { w: cw, h: ch, dpr: cw > 0 ? w / cw : dpr };
  }
  bgCanvas = null;
  dirty = true;
}
const canvasRO = new ResizeObserver((entries) => {
  const dpr = window.devicePixelRatio || 1;
  for (const en of entries) {
    const s = en.devicePixelContentBoxSize?.[0];
    if (s) devBox.set(en.target, { w: s.inlineSize, h: s.blockSize, dpr });
  }
  measure();
});
for (const c of [topCanvas, sideCanvas]) {
  try { canvasRO.observe(c, { box: 'device-pixel-content-box' }); } catch { canvasRO.observe(c); }
}
// Moving the window between a Retina and a non-Retina display changes devicePixelRatio without a resize.
(function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => { measure(); watchDpr(); }, { once: true });
})();
// Trackpad pinch (ctrl+wheel / Safari gesture events) over the stage must not zoom the whole page.
for (const c of [topCanvas, sideCanvas]) {
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) c.addEventListener(ev, (e) => e.preventDefault());
}

function topMapping() {
  const { w, h: hh } = view.top;
  const size = Math.max(10, Math.min(w, hh) - 44);
  const cx = w / 2;
  const cy = hh / 2;
  return {
    size,
    cx,
    cy,
    toPx: (x, y) => [cx + (x * size) / 2, cy - (y * size) / 2],
    fromPx: (px, py) => [((px - cx) * 2) / size, (-(py - cy) * 2) / size],
  };
}

function sideMapping() {
  const { w, h: hh } = view.side;
  const size = topMapping().size;
  const cx = w / 2;
  const cy = hh / 2;
  const zs = (hh - 20) / 2;
  return { toPx: (x, z) => [cx + (x * size) / 2, cy - z * zs], fromPx: (px, pz) => [((px - cx) * 2) / size, (cy - pz) / zs], size, zs, cx, cy };
}

function pushTrails() {
  for (let i = 0; i < positions.length; i++) {
    const t = trails[i];
    t.push(positions[i]);
    if (t.length > 24) t.shift();
  }
}

const JUMP_MS = 300;
const JUMP_BREAK_DIST = 0.15;
const jumps = [];

/** pos.j bit i = object i+1 jumped on purpose since the previous pos: break its trail and mark the landing. */
function trackJumps(prev, mask) {
  const now = performance.now();
  for (let i = 0; i < positions.length; i++) {
    const a = prev[i];
    const b = positions[i];
    if (!a || !b) continue;
    if ((mask >>> i) & 1) {
      trails[i].length = 0;
      if (a[0] !== b[0] || a[1] !== b[1]) jumps.push({ i, from: a, to: b, t: now });
    } else if (Math.hypot(b[0] - a[0], b[1] - a[1]) > JUMP_BREAK_DIST) {
      trails[i].length = 0;
    }
  }
  pruneJumps(now);
}

function pruneJumps(now) {
  while (jumps.length && now - jumps[0].t > JUMP_MS) jumps.shift();
  if (jumps.length > 64) jumps.splice(0, jumps.length - 64);
}

function drawJumps(ctx, m) {
  const now = performance.now();
  pruneJumps(now);
  if (!jumps.length) return;
  ctx.save();
  for (const jp of jumps) {
    const o = OBJ[jp.i];
    const age = (now - jp.t) / JUMP_MS;
    if (!o?.enabled || age >= 1) continue;
    const [ax, ay] = m.toPx(jp.from[0], jp.from[1]);
    const [bx, by] = m.toPx(jp.to[0], jp.to[1]);
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = COLORS[o.id].solid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(bx, by, 10 + age * 18, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function buildBackground() {
  const { w, h: hh, dpr } = view.top;
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(hh * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m = topMapping();
  const [x0, y0] = m.toPx(-1, 1);
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(x0, y0, m.size, m.size);
  ctx.strokeStyle = '#1a2130';
  ctx.lineWidth = 1;
  for (let i = -4; i <= 4; i++) {
    const [a] = m.toPx(i / 4, 0);
    const [, b] = m.toPx(0, i / 4);
    ctx.beginPath(); ctx.moveTo(a, y0); ctx.lineTo(a, y0 + m.size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0, b); ctx.lineTo(x0 + m.size, b); ctx.stroke();
  }
  ctx.strokeStyle = '#2a3346';
  ctx.strokeRect(x0, y0, m.size, m.size);
  ctx.beginPath(); ctx.arc(m.cx, m.cy, m.size / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(m.cx, m.cy, m.size / 4, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#8a95ad';
  ctx.font = `600 11px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('FRONT / STAGE', m.cx, y0 - 8);
  ctx.fillText('BACK', m.cx, y0 + m.size + 16);
  ctx.fillStyle = '#4a5578';
  ctx.beginPath(); ctx.moveTo(m.cx, m.cy - 8); ctx.lineTo(m.cx - 6, m.cy + 6); ctx.lineTo(m.cx + 6, m.cy + 6); ctx.closePath(); ctx.fill();
  bgCanvas = c;
}

function regionPath(ctx, m, o) {
  const [cx, cy] = m.toPx(o.center.x, o.center.y);
  const rx = Math.max(0.5, (o.range.x * m.size) / 2);
  const ry = Math.max(0.5, (o.range.y * m.size) / 2);
  ctx.beginPath();
  if (o.mode === 'orbit' || o.rangeShape === 'ellipse' || o.rangeShape === 'ring') {
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (o.mode !== 'orbit' && o.rangeShape === 'ring' && o.innerRadius > 0) {
      ctx.moveTo(cx + rx * o.innerRadius, cy);
      ctx.ellipse(cx, cy, rx * o.innerRadius, ry * o.innerRadius, 0, 0, Math.PI * 2, true);
    }
  } else {
    ctx.rect(cx - rx, cy - ry, rx * 2, ry * 2);
  }
  return [cx, cy];
}

function visibleIds() {
  return OBJ.filter((o) => o.enabled || selected.has(o.id)).map((o) => o.id);
}

function posOf(id) {
  const o = OBJ[id - 1];
  return positions[id - 1] || [o.center.x, o.center.y, o.center.z];
}

function drawTop(ctx) {
  const { w, h: hh } = view.top;
  const m = topMapping();
  ctx.clearRect(0, 0, w, hh);
  if (!bgCanvas) buildBackground();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.restore();
  if (!S) return;
  const stg = store.stage;
  if (stg) {
    if ($('#showImage').checked) drawBackground(ctx, m, stg.background);
    if ($('#showSpeakers').checked) drawSpeakers(ctx, m, stg.speakers, { font: `600 9.5px ${CANVAS_FONT}` });
  }

  if ($('#showRegions').checked) {
    ctx.lineWidth = 1;
    for (const id of selected) {
      const o = OBJ[id - 1];
      if (!o || o.mode === 'hold') continue;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = COLORS[id].region;
      ctx.fillStyle = COLORS[id].regionFill;
      const [ccx, ccy] = regionPath(ctx, m, o);
      ctx.fill('evenodd');
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ccx - 5, ccy); ctx.lineTo(ccx + 5, ccy); ctx.moveTo(ccx, ccy - 5); ctx.lineTo(ccx, ccy + 5); ctx.stroke();
    }
  }

  drawPaths(ctx, m);

  if (running && $('#showTrails').checked) {
    ctx.lineWidth = 2;
    for (let i = 0; i < positions.length; i++) {
      const o = OBJ[i];
      if (!o?.enabled || trails[i].length < 2) continue;
      ctx.strokeStyle = COLORS[o.id].trail;
      ctx.beginPath();
      trails[i].forEach(([x, y], k) => {
        const [px, py] = m.toPx(x, y);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }

  drawJumps(ctx, m);

  const dup = new Set(S.dupSources.flatMap((d) => d.ids));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 10px ${CANVAS_MONO}`;
  const order = visibleIds().sort((a, b) => (selected.has(a) - selected.has(b)) || (OBJ[a - 1].enabled - OBJ[b - 1].enabled));
  for (const id of order) {
    const o = OBJ[id - 1];
    const p = posOf(id);
    const [px, py] = m.toPx(p[0], p[1]);
    const r = Math.max(5, 9 + p[2] * 4);
    if (o.enabled) {
      ctx.fillStyle = COLORS[id].glow;
      ctx.beginPath(); ctx.arc(px, py, r + 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = o.enabled ? COLORS[id].solid : COLORS[id].dim;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    if (selected.has(id)) {
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, r + 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (dup.has(id)) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(px, py, r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = o.enabled ? '#05070b' : '#dde2ec';
    ctx.fillText(String(id), px, py + 0.5);
  }

  if (drag?.mode === 'rect') {
    ctx.strokeStyle = '#38e1c6';
    ctx.fillStyle = 'rgba(56,225,198,.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    ctx.strokeRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    ctx.setLineDash([]);
  }
}

function drawSide(ctx) {
  const { w, h: hh } = view.side;
  const m = sideMapping();
  ctx.clearRect(0, 0, w, hh);
  const left = m.cx - m.size / 2;
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(left, m.cy - m.zs, m.size, m.zs * 2);
  ctx.strokeStyle = '#2a3346';
  ctx.lineWidth = 1;
  ctx.strokeRect(left, m.cy - m.zs, m.size, m.zs * 2);
  ctx.strokeStyle = '#3a4460';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(left, m.cy); ctx.lineTo(left + m.size, m.cy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a95ad';
  ctx.font = `600 10px ${CANVAS_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('TOP', left + 6, m.cy - m.zs + 12);
  ctx.fillText('EAR', left + 6, m.cy - 5);
  if (!S) return;
  if (store.stage && $('#showSpeakers').checked) drawSpeakersSide(ctx, m, store.stage.speakers);
  drawPathsSide(ctx, m);
  for (const id of visibleIds()) {
    const o = OBJ[id - 1];
    const p = posOf(id);
    const [px, pz] = m.toPx(p[0], p[2]);
    ctx.fillStyle = o.enabled ? COLORS[id].solid : COLORS[id].dim;
    ctx.beginPath(); ctx.arc(px, pz, 5, 0, Math.PI * 2); ctx.fill();
    if (selected.has(id)) {
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, pz, 7.5, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function renderBeats() {
  const b = Math.floor(beat);
  const idx = beat - b < 0.25 ? ((b % 4) + 4) % 4 : -1;
  if (idx === lastBeatIdx) return;
  lastBeatIdx = idx;
  $$('#beats i').forEach((l, i) => l.classList.toggle('on', i === idx));
}

function frame() {
  if (jumps.length) dirty = true;
  if (dirty && !wsm.current() && topCanvas.width > 0) {
    dirty = false;
    const tctx = topCanvas.getContext('2d');
    tctx.setTransform(view.top.dpr, 0, 0, view.top.dpr, 0, 0);
    drawTop(tctx);
    const sctx = sideCanvas.getContext('2d');
    sctx.setTransform(view.side.dpr, 0, 0, view.side.dpr, 0, 0);
    drawSide(sctx);
  }
  renderBeats();
  requestAnimationFrame(frame);
}

let stoppedTrailsCleared = false;
setInterval(() => {
  if (!running && !runMask && !stoppedTrailsCleared) {
    trails.forEach((t) => { t.length = 0; });
    stoppedTrailsCleared = true;
    dirty = true;
  } else if (running || runMask) {
    stoppedTrailsCleared = false;
  }
}, 500);

// ---------- canvas interaction ----------
let drag = null;
let pendingNudge = null;
let nudgeTimer = null;

function flushNudge() {
  nudgeTimer = null;
  if (!pendingNudge) return;
  const n = pendingNudge;
  pendingNudge = null;
  send({ type: 'nudgeCenter', ids: n.ids, dx: n.dx, dy: n.dy, dz: n.dz });
}

function queueNudge(ids, dx, dy, dz) {
  if (!pendingNudge) pendingNudge = { ids, dx: 0, dy: 0, dz: 0 };
  pendingNudge.dx += dx;
  pendingNudge.dy += dy;
  pendingNudge.dz += dz;
  nudgeTimer ??= setTimeout(flushNudge, isLive() ? 16 : 30);
}

function canvasPoint(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function hitTest(px, py, toPx, coords, radius) {
  let hit = null;
  let best = radius;
  for (const id of visibleIds()) {
    const p = posOf(id);
    const [ox, oy] = toPx(p[coords[0]], p[coords[1]]);
    const d = Math.hypot(ox - px, oy - py);
    if (d < best) { best = d; hit = id; }
  }
  return hit;
}

const dragInfo = $('#dragInfo');
function showDragInfo(text) {
  dragInfo.hidden = !text;
  dragInfo.textContent = text || '';
}
const sgn = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

topCanvas.addEventListener('pointerdown', (e) => {
  if (!S) return;
  if (pathEdit) { pathPointerDown(e); return; }
  const [px, py] = canvasPoint(topCanvas, e);
  const m = topMapping();
  const additive = multiMode || e.shiftKey || e.ctrlKey || e.metaKey;
  const hit = hitTest(px, py, m.toPx, [0, 1], e.pointerType === 'touch' ? 28 : 16);
  if (hit) {
    if (!selected.has(hit)) selectObject(hit, additive);
    drag = { mode: isLocked() ? 'none' : 'move', last: m.fromPx(px, py), total: [0, 0] };
  } else {
    drag = { mode: 'rect', x0: px, y0: py, x1: px, y1: py, additive };
  }
  topCanvas.setPointerCapture(e.pointerId);
});

topCanvas.addEventListener('pointermove', (e) => {
  if (pathDrag && !('side' in pathDrag)) { pathPointerMove(e); return; }
  if (!drag) return;
  const [px, py] = canvasPoint(topCanvas, e);
  if (drag.mode === 'rect') {
    drag.x1 = px;
    drag.y1 = py;
    dirty = true;
    return;
  }
  if (drag.mode !== 'move') return;
  const [nx, ny] = topMapping().fromPx(px, py);
  const dx = nx - drag.last[0];
  const dy = ny - drag.last[1];
  if (Math.abs(dx) + Math.abs(dy) < 0.002) return;
  drag.last = [nx, ny];
  drag.total[0] += dx;
  drag.total[1] += dy;
  const ids = [...selected];
  for (const id of ids) {
    const c = OBJ[id - 1].center;
    c.x = clamp(c.x + dx, -1, 1);
    c.y = clamp(c.y + dy, -1, 1);
  }
  queueNudge(ids, dx, dy, 0);
  showDragInfo(`ΔX ${sgn(drag.total[0])}  ΔY ${sgn(drag.total[1])}`);
  updateEditorValues();
  dirty = true;
});

function endTopDrag() {
  if (pathDrag && !('side' in pathDrag)) { pathPointerUp(); return; }
  if (!drag) return;
  if (drag.mode === 'rect') {
    const small = Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) < 6;
    if (!drag.additive) selected.clear();
    if (!small) {
      const m = topMapping();
      const [xa, xb] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
      const [ya, yb] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
      for (const o of OBJ) {
        if (!o.enabled) continue;
        const p = posOf(o.id);
        const [ox, oy] = m.toPx(p[0], p[1]);
        if (ox >= xa && ox <= xb && oy >= ya && oy <= yb) selected.add(o.id);
      }
    }
    selectionChanged();
  }
  drag = null;
  showDragInfo('');
  dirty = true;
}
topCanvas.addEventListener('pointerup', endTopDrag);
topCanvas.addEventListener('pointercancel', endTopDrag);

let sideDrag = null;
sideCanvas.addEventListener('pointerdown', (e) => {
  if (!S) return;
  if (pathEdit && pathSideDown(e)) return;
  const [px, pz] = canvasPoint(sideCanvas, e);
  const m = sideMapping();
  const hit = hitTest(px, pz, m.toPx, [0, 2], e.pointerType === 'touch' ? 24 : 12);
  if (!hit) return;
  if (!selected.has(hit)) selectObject(hit, multiMode || e.shiftKey || e.ctrlKey || e.metaKey);
  sideDrag = { last: m.fromPx(px, pz)[1], total: 0, active: !isLocked() };
  sideCanvas.setPointerCapture(e.pointerId);
});
sideCanvas.addEventListener('pointermove', (e) => {
  if (pathDrag && 'side' in pathDrag) { pathSideMove(e); return; }
  if (!sideDrag?.active) return;
  const [px, pz] = canvasPoint(sideCanvas, e);
  const z = sideMapping().fromPx(px, pz)[1];
  const dz = z - sideDrag.last;
  if (Math.abs(dz) < 0.003) return;
  sideDrag.last = z;
  sideDrag.total += dz;
  const ids = [...selected];
  for (const id of ids) {
    const c = OBJ[id - 1].center;
    c.z = clamp(c.z + dz, -1, 1);
  }
  queueNudge(ids, 0, 0, dz);
  showDragInfo(`ΔZ ${sgn(sideDrag.total)}`);
  updateEditorValues();
  dirty = true;
});
const endSide = () => {
  if (pathDrag && 'side' in pathDrag) { pathPointerUp(); return; }
  sideDrag = null;
  showDragInfo('');
};
sideCanvas.addEventListener('pointerup', endSide);
sideCanvas.addEventListener('pointercancel', endSide);

// ---------- drawn paths ----------
const PATH_MAX = 64;
const FREEHAND_MAX = 24;
/** Path edit mode on the stage: { id, tool: 'points' | 'free', sel: point index | null }. */
let pathEdit = null;
/** Active pointer gesture inside path edit: { k } (point drag), { free: [[x, y], ...] } or { side: k }. */
let pathDrag = null;
let pathSendTimer = null;

const isDrawnObj = (o) => !!o && DRAWN(o);
const pathAbs = (o) => o.pathPts.map(([dx, dy, dz]) => [clamp(o.center.x + dx, -1, 1), clamp(o.center.y + dy, -1, 1), clamp(o.center.z + dz, -1, 1)]);
const toOffset = (o, x, y, z) => [
  Math.round((clamp(x, -1, 1) - o.center.x) * 10000) / 10000,
  Math.round((clamp(y, -1, 1) - o.center.y) * 10000) / 10000,
  Math.round((clamp(z, -1, 1) - o.center.z) * 10000) / 10000,
];
const pathClosed = (o) => o.pathOrder !== 'pingpong';
const pathStartIdx = (o) => (o.pathPts.length ? Math.floor(o.pathStart * o.pathPts.length + 1e-6) % o.pathPts.length : -1);

function defaultPathPts(o) {
  const rx = Math.max(o.range.x, 0.25) * 0.8;
  const ry = Math.max(o.range.y, 0.25) * 0.8;
  return [[-rx, ry, 0], [rx, ry, 0], [rx, -ry, 0], [-rx, -ry, 0]].map((p) => toOffset(o, o.center.x + p[0], o.center.y + p[1], o.center.z));
}

/** The object the path tools act on: the one in edit mode, else the lowest selected drawn-path object. */
function pathTarget() {
  if (pathEdit && OBJ[pathEdit.id - 1]) return OBJ[pathEdit.id - 1];
  return selectedObjects().find(isDrawnObj) ?? null;
}

function startPathEdit(id, tool) {
  if (!guardEdit()) return;
  pathEdit = { id, tool, sel: null };
  renderPathEdit();
}

function exitPathEdit() {
  if (!pathEdit) return false;
  flushPathSend();
  pathEdit = null;
  pathDrag = null;
  renderPathEdit();
  return true;
}

function togglePathTool(tool) {
  const o = pathTarget();
  if (!o) return;
  if (pathEdit?.tool === tool && pathEdit.id === o.id) exitPathEdit();
  else startPathEdit(o.id, tool);
}

/** Leaves edit mode when its object is no longer an editable drawn path (deselected, mode change, show lock). */
function checkPathEdit() {
  if (!pathEdit) return;
  const o = OBJ[pathEdit.id - 1];
  if (!isDrawnObj(o) || !selected.has(pathEdit.id) || isLocked()) exitPathEdit();
  else if (pathEdit.sel !== null && pathEdit.sel >= o.pathPts.length) pathEdit.sel = null;
}

function renderPathEdit() {
  topCanvas.classList.toggle('path-editing', !!pathEdit);
  topCanvas.classList.toggle('path-free', pathEdit?.tool === 'free');
  showPathBanner();
  updateEditorValues();
  dirty = true;
}

function showPathBanner() {
  const b = $('#pathBanner');
  if (!b) return;
  b.hidden = !pathEdit;
  if (pathEdit) b.textContent = t(pathEdit.tool === 'free' ? 'path.banner.free' : 'path.banner.points', { id: pathEdit.id });
}

function flushPathSend() {
  const pending = pathSendTimer !== null;
  clearTimeout(pathSendTimer);
  pathSendTimer = null;
  const o = pathEdit && OBJ[pathEdit.id - 1];
  if (pending && o) send({ type: 'updateObjects', ids: [o.id], patch: { pathPts: o.pathPts } });
}

function queuePathSend() {
  pathSendTimer ??= setTimeout(flushPathSend, isLive() ? 16 : 40);
}

/** Local edit of the edited object's points; `fn` mutates a copy, then it is sent (throttled while dragging). */
function editPath(fn, { now = false } = {}) {
  const o = pathTarget();
  if (!o || !guardEdit()) return;
  const pts = o.pathPts.map((p) => [...p]);
  fn(pts, o);
  o.pathPts = pts.slice(0, PATH_MAX);
  if (now || !pathEdit) {
    clearTimeout(pathSendTimer);
    pathSendTimer = null;
    send({ type: 'updateObjects', ids: [o.id], patch: { pathPts: o.pathPts } });
  } else {
    queuePathSend();
  }
  updateEditorValues();
  dirty = true;
}

function deletePathPoint(k) {
  editPath((pts) => { pts.splice(k, 1); }, { now: true });
  if (pathEdit) pathEdit.sel = null;
}

/** Ramer–Douglas–Peucker on [x, y] points. */
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  let best = -1;
  let bestD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = len < 1e-9 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > bestD) { bestD = d; best = i; }
  }
  if (bestD <= eps) return [a, b];
  return [...rdp(pts.slice(0, best + 1), eps).slice(0, -1), ...rdp(pts.slice(best), eps)];
}

function commitFreehand(stroke) {
  const o = pathTarget();
  if (!o || stroke.length < 2) return;
  let travel = 0;
  for (let i = 1; i < stroke.length; i++) travel += Math.hypot(stroke[i][0] - stroke[i - 1][0], stroke[i][1] - stroke[i - 1][1]);
  if (travel < 0.05) return;
  let eps = 0.02;
  let s = rdp(stroke, eps);
  while (s.length > FREEHAND_MAX) { eps *= 1.35; s = rdp(stroke, eps); }
  // A stroke that ends where it started is a closed shape: the loop closes it, so drop the duplicate end.
  if (s.length > 3 && Math.hypot(s[0][0] - s.at(-1)[0], s[0][1] - s.at(-1)[1]) < 0.06) s.pop();
  if (s.length < 2) return;
  const pathPts = s.map(([x, y]) => toOffset(o, x, y, o.center.z));
  const patch = { pathPts, pathCurve: 'catmull', easing: 'linear', pathTiming: 'even', glide: 1 };
  if (!send({ type: 'updateObjects', ids: [o.id], patch })) return;
  mergeLocal(o, structuredClone(patch));
  o.pathPts = pathPts;
  if (pathEdit) pathEdit.sel = null;
  toast(t('path.freeDone', { n: pathPts.length }));
  afterLocalEdit();
}

function copyPathToSelection() {
  const src = pathTarget();
  if (!src) return;
  const keys = ['pathPts', 'pathCurve', 'pathOrder', 'pathTiming', 'pathJitter', 'pathWobble', 'easing', 'glide'];
  const items = selectedObjects().filter((o) => o.id !== src.id).map((o) => {
    const patch = { mode: 'path', pathSource: 'custom', center: { ...src.center } };
    for (const k of keys) patch[k] = structuredClone(src[k]);
    return { id: o.id, patch };
  });
  if (items.length && applyEach(items)) toast(t('path.copied', { n: items.length }));
}

function staggerPathStarts() {
  const objs = selectedObjects().filter(isDrawnObj);
  if (objs.length < 2) return;
  if (applyEach(objs.map((o, k) => ({ id: o.id, patch: { pathStart: Math.round((k / objs.length) * 100) / 100 } })))) {
    toast(t('path.staggered', { n: objs.length }));
  }
}

function buildPathTools(f) {
  const tool = (key, icon) => h('button', {
    type: 'button', class: `path-tool ico-${icon}`, 'aria-pressed': 'false', title: t(`path.${key}.title`),
    onclick: () => togglePathTool(key),
  }, h('i', { 'aria-hidden': 'true' }), t(`path.${key}`));
  const bPoints = tool('points', 'path-points');
  const bFree = tool('free', 'path-free');
  const info = h('span', { class: 'path-info' });
  const bRev = h('button', { type: 'button', onclick: () => editPath((pts) => pts.reverse(), { now: true }) }, t('path.reverse'));
  const bClear = armButton(h('button', { type: 'button', class: 'danger' }, t('path.clear')), () => {
    editPath((pts) => { pts.length = 0; }, { now: true });
    const o = pathTarget();
    if (o && !pathEdit) startPathEdit(o.id, 'points');
  });
  const bCopy = h('button', { type: 'button', title: t('path.copy.title'), onclick: () => { if (guardEdit()) copyPathToSelection(); } }, t('path.copy'));
  const bStag = h('button', { type: 'button', title: t('path.stagger.title'), onclick: () => { if (guardEdit()) staggerPathStarts(); } }, t('path.stagger'));
  const zId = nextId('pz');
  const zIn = h('input', { type: 'range', id: zId, min: -1, max: 1, step: 0.01 });
  const zVal = h('span', { class: 'val' });
  zIn.addEventListener('input', () => {
    const k = pathEdit?.sel;
    if (k == null) return;
    const v = Number(zIn.value);
    zVal.textContent = v.toFixed(2);
    editPath((pts, o) => { pts[k] = toOffset(o, o.center.x + pts[k][0], o.center.y + pts[k][1], v); });
  });
  zIn.addEventListener('change', flushPathSend);
  const zRow = h('div', { class: 'row path-z' }, h('label', { for: zId }, t('path.pointZ')), h('div', { class: 'ctl' }, zIn, zVal));
  f.el = h('div', { class: 'path-tools' },
    h('div', { class: 'path-tools-head' }, bPoints, bFree, info),
    zRow,
    h('div', { class: 'btn-row path-actions' }, bRev, bCopy, bStag, bClear));
  f.set = () => {
    const o = pathTarget();
    const lk = isLocked();
    for (const [b, key] of [[bPoints, 'points'], [bFree, 'free']]) {
      const on = !!pathEdit && pathEdit.tool === key;
      b.setAttribute('aria-pressed', String(on));
      b.disabled = lk || !o;
    }
    info.textContent = o ? t('path.info', { id: o.id, n: o.pathPts.length }) : '';
    const multi = selectedObjects().length > 1;
    bCopy.hidden = !multi;
    bStag.hidden = !multi || selectedObjects().filter(isDrawnObj).length < 2;
    bRev.disabled = lk || !o || o.pathPts.length < 2;
    bClear.disabled = lk || !o || !o.pathPts.length;
    const k = pathEdit?.sel;
    zRow.hidden = k == null || !o?.pathPts[k];
    if (!zRow.hidden && document.activeElement !== zIn) {
      const z = clamp(o.center.z + o.pathPts[k][2], -1, 1);
      zIn.value = z;
      zVal.textContent = z.toFixed(2);
    }
  };
  return f.el;
}

/** Catmull-Rom samples through the points (closed loops wrap), matching the engine's curve. */
function pathCurvePoints(pts, closed, curved) {
  if (!curved || pts.length < 3) return closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  const n = pts.length;
  const at = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < 12; s++) {
      const tt = s / 12;
      const t2 = tt * tt;
      const t3 = t2 * tt;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * tt + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([0, 1, 2].map((k) => clamp(f(p0[k], p1[k], p2[k], p3[k]), -1, 1)));
    }
  }
  out.push(closed ? pts[0] : pts[n - 1]);
  return out;
}

function drawPaths(ctx, m) {
  const ids = new Set([...selected].filter((id) => isDrawnObj(OBJ[id - 1])));
  if (pathEdit) ids.add(pathEdit.id);
  for (const id of ids) {
    const o = OBJ[id - 1];
    if (!isDrawnObj(o) || !o.pathPts.length) continue;
    const editing = pathEdit?.id === id;
    const abs = pathAbs(o);
    const col = COLORS[id].solid;
    ctx.save();
    if (o.pathJitter > 0 && editing) {
      ctx.fillStyle = COLORS[id].regionFill;
      for (const [x, y] of abs) {
        const [px, py] = m.toPx(x, y);
        ctx.beginPath(); ctx.arc(px, py, (o.pathJitter * m.size) / 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    const line = pathCurvePoints(abs, pathClosed(o), o.pathCurve === 'catmull');
    ctx.strokeStyle = col;
    ctx.globalAlpha = editing ? 0.95 : 0.6;
    ctx.lineWidth = editing ? 2 : 1.5;
    ctx.setLineDash(editing ? [] : [6, 4]);
    ctx.beginPath();
    line.forEach(([x, y], k) => {
      const [px, py] = m.toPx(x, y);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Direction arrow on the first segment.
    if (abs.length >= 2) {
      const [ax, ay] = m.toPx(abs[0][0], abs[0][1]);
      const [bx, by] = m.toPx(abs[1][0], abs[1][1]);
      const ang = Math.atan2(by - ay, bx - ax);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6);
      ctx.closePath();
      ctx.fill();
    }
    const start = pathStartIdx(o);
    ctx.font = `700 9px ${CANVAS_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    abs.forEach(([x, y, z], k) => {
      const [px, py] = m.toPx(x, y);
      const r = editing ? 6 + clamp(z, -1, 1) * 1.5 : 3;
      const isSel = editing && pathEdit.sel === k;
      ctx.fillStyle = isSel ? SEL_COLOR : editing ? '#0b0f17' : col;
      ctx.strokeStyle = isSel ? SEL_COLOR : col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (k === start && abs.length > 1) {
        ctx.beginPath(); ctx.arc(px, py, r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (editing) {
        ctx.fillStyle = isSel ? '#05070b' : '#dde2ec';
        ctx.fillText(String(k + 1), px, py + 0.5);
      }
    });
    ctx.restore();
  }
  if (pathDrag?.free?.length > 1) {
    ctx.save();
    ctx.strokeStyle = SEL_COLOR;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pathDrag.free.forEach(([x, y], k) => {
      const [px, py] = m.toPx(x, y);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }
}

function drawPathsSide(ctx, m) {
  const o = pathEdit && OBJ[pathEdit.id - 1];
  if (!isDrawnObj(o) || !o.pathPts.length) return;
  const col = COLORS[o.id].solid;
  const abs = pathAbs(o);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.beginPath();
  pathCurvePoints(abs, pathClosed(o), o.pathCurve === 'catmull').forEach(([x, , z], k) => {
    const [px, pz] = m.toPx(x, z);
    if (k === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
  abs.forEach(([x, , z], k) => {
    const [px, pz] = m.toPx(x, z);
    ctx.fillStyle = pathEdit.sel === k ? SEL_COLOR : '#0b0f17';
    ctx.strokeStyle = pathEdit.sel === k ? SEL_COLOR : col;
    ctx.beginPath(); ctx.arc(px, pz, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  ctx.restore();
}

function nearestPathPoint(abs, px, py, toPx, coords, radius) {
  let best = -1;
  let bestD = radius;
  abs.forEach((p, k) => {
    const [x, y] = toPx(p[coords[0]], p[coords[1]]);
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) { bestD = d; best = k; }
  });
  return best;
}

/** Index to insert at when the click lands on a drawn segment (straight-line distance), else -1. */
function segmentInsertIndex(o, abs, px, py, m, tol) {
  const n = abs.length;
  if (n < 2) return -1;
  const segs = pathClosed(o) && n > 2 ? n : n - 1;
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = m.toPx(abs[i][0], abs[i][1]);
    const [bx, by] = m.toPx(abs[(i + 1) % n][0], abs[(i + 1) % n][1]);
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const u = L2 > 0 ? clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2, 0, 1) : 0;
    const d = Math.hypot(px - (ax + u * (bx - ax)), py - (ay + u * (by - ay)));
    if (d < bestD && u > 0.02 && u < 0.98) { bestD = d; best = i + 1; }
  }
  return best;
}

/** Top view pointerdown while editing a path. Always consumes the event. */
function pathPointerDown(e) {
  const o = OBJ[pathEdit.id - 1];
  if (!isDrawnObj(o) || !guardEdit()) return;
  const [px, py] = canvasPoint(topCanvas, e);
  const m = topMapping();
  const touch = e.pointerType === 'touch';
  if (pathEdit.tool === 'free') {
    pathDrag = { free: [m.fromPx(px, py)] };
    topCanvas.setPointerCapture(e.pointerId);
    return;
  }
  const abs = pathAbs(o);
  let k = nearestPathPoint(abs, px, py, m.toPx, [0, 1], touch ? 22 : 11);
  if (e.button === 2 || e.altKey) {
    if (k >= 0) deletePathPoint(k);
    return;
  }
  if (k < 0) {
    if (o.pathPts.length >= PATH_MAX) { toastThrottled(t('path.max', { n: PATH_MAX }), 'warn'); return; }
    const ins = segmentInsertIndex(o, abs, px, py, m, touch ? 14 : 7);
    // Off the line: continue after the selected point, so consecutive clicks draw in order.
    const sel = pathEdit.sel;
    const at = ins >= 0 ? ins : sel !== null && sel < o.pathPts.length ? sel + 1 : o.pathPts.length;
    const [x, y] = m.fromPx(px, py);
    const near = abs[at - 1] ?? abs[0];
    editPath((pts) => { pts.splice(at, 0, toOffset(o, x, y, near ? near[2] : o.center.z)); });
    k = at;
  }
  pathEdit.sel = k;
  pathDrag = { k };
  topCanvas.setPointerCapture(e.pointerId);
  updateEditorValues();
  dirty = true;
}

function pathPointerMove(e) {
  const [px, py] = canvasPoint(topCanvas, e);
  const [x, y] = topMapping().fromPx(px, py);
  if (pathDrag.free) {
    const last = pathDrag.free.at(-1);
    if (Math.hypot(x - last[0], y - last[1]) > 0.004) pathDrag.free.push([clamp(x, -1, 1), clamp(y, -1, 1)]);
    dirty = true;
    return;
  }
  const k = pathDrag.k;
  editPath((pts, o) => { pts[k] = toOffset(o, x, y, o.center.z + pts[k][2]); });
  const o = OBJ[pathEdit.id - 1];
  showDragInfo(`#${k + 1}  X ${sgn(clamp(o.center.x + o.pathPts[k][0], -1, 1))}  Y ${sgn(clamp(o.center.y + o.pathPts[k][1], -1, 1))}`);
}

function pathPointerUp() {
  const d = pathDrag;
  pathDrag = null;
  showDragInfo('');
  if (d?.free) commitFreehand(d.free);
  else flushPathSend();
  dirty = true;
}

/** Side view: drag a point of the edited path up/down (Z). Returns true when a point was grabbed. */
function pathSideDown(e) {
  const o = pathEdit && OBJ[pathEdit.id - 1];
  if (!isDrawnObj(o) || isLocked()) return false;
  const [px, pz] = canvasPoint(sideCanvas, e);
  const m = sideMapping();
  const k = nearestPathPoint(pathAbs(o), px, pz, m.toPx, [0, 2], e.pointerType === 'touch' ? 20 : 9);
  if (k < 0) return false;
  pathEdit.sel = k;
  pathDrag = { side: k };
  sideCanvas.setPointerCapture(e.pointerId);
  updateEditorValues();
  dirty = true;
  return true;
}

function pathSideMove(e) {
  const [px, pz] = canvasPoint(sideCanvas, e);
  const z = sideMapping().fromPx(px, pz)[1];
  const k = pathDrag.side;
  editPath((pts, o) => { pts[k] = toOffset(o, o.center.x + pts[k][0], o.center.y + pts[k][1], z); });
  showDragInfo(`#${k + 1}  Z ${sgn(clamp(z, -1, 1))}`);
}

for (const id of ['showRegions', 'showTrails']) $(`#${id}`).addEventListener('change', () => { dirty = true; });
for (const id of ['showImage', 'showSpeakers']) {
  const el = $(`#${id}`);
  el.checked = localStorage.getItem(`objitter.${id}`) !== '0';
  el.addEventListener('change', () => { localStorage.setItem(`objitter.${id}`, el.checked ? '1' : '0'); dirty = true; });
}
onImageLoad(() => { dirty = true; });
window.addEventListener('objitter:stage-local', () => { dirty = true; });

function renderStageToggles() {
  const stg = store.stage;
  $('#showImageLbl').hidden = !stg?.background.asset;
  $('#showSpeakersLbl').hidden = !stg?.speakers.items.length;
}

const topbar = $('.topbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
}).observe(topbar);
// Fallback for tablets: if the top-bar STOP scrolls/wraps out of view, show a floating STOP.
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([en]) => { $('#floatStop').hidden = en.isIntersecting; }, { threshold: 0.6 }).observe($('#btnStop'));
}

for (const b of $$('#langSeg button')) b.addEventListener('click', () => applyLang(b.dataset.lang));
$('#btnAbout').addEventListener('click', openAbout);
$('#sessionBadge').addEventListener('click', openSessions);
applyLang(storedLang());
renderConn(false);
$('#offline').textContent = t('ui.connecting');
wsm.link('monitor', { titleKey: 'ws.monitor', icon: 'ws-monitor' });
wsm.boot();
connect();
requestAnimationFrame(frame);
