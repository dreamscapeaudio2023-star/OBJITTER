// Per-object clips inside a cue (the show timeline). A 'clips' cue starts a run; each clip applies
// at cue time + start and finishes at + dur with its `then` rule. Pure scheduling: the server wires
// the engine through the api object, tests pass a fake.
import { isPlainObject } from './fsutil.js';
import { num, toBool, EASINGS, defaultObject, sanitizeObject, deepMerge } from './engine.js';
import { safeName } from './presets.js';
import { safeLibPath } from './library.js';
import { L } from './i18n.js';

export const CLIP_KINDS = ['motion', 'move', 'path', 'preset', 'library', 'home', 'transport'];
export const CLIP_THEN = ['continue', 'hold', 'home', 'revert'];
export const MAX_CLIPS = 128;
export const MAX_CLIP_TIME = 3600;
const TARGETS_RE = /^[\p{L}\p{N}_ ,@\-.]*$/u;
const PATCH_KEYS = Object.keys(defaultObject(1)).filter((k) => !['id', 'enabled', 'name', 'sourceId'].includes(k));
/** Jumps in TC-relative time larger than this are a locate inside the run (re-sync instead of firing). */
const JUMP = 0.75;
const BACK_TOL = 0.25;
const EPS = 1e-6;

const mod = (x, d) => ((x % d) + d) % d;
const cdiff = (a, b, d) => mod(a - b + d / 2, d) - d / 2;
const newClipId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/** Keeps only object-config keys that were given, with sanitized values. */
export function cleanPatch(p) {
  if (!isPlainObject(p)) return {};
  const s = sanitizeObject(deepMerge(defaultObject(1), p), 1);
  const out = {};
  for (const k of PATCH_KEYS) {
    if (!Object.hasOwn(p, k)) continue;
    if (isPlainObject(p[k]) && isPlainObject(s[k])) {
      out[k] = {};
      for (const kk of Object.keys(p[k])) if (Object.hasOwn(s[k], kk)) out[k][kk] = s[k][kk];
    } else {
      out[k] = s[k];
    }
  }
  return out;
}

function cleanParams(kind, p) {
  const src = isPlainObject(p) ? p : {};
  switch (kind) {
    case 'motion': return cleanPatch(src);
    case 'path': return cleanPatch({ ...src, mode: 'path' });
    case 'move': return { x: num(src.x, -1, 1, 0), y: num(src.y, -1, 1, 0), z: num(src.z, -1, 1, 0) };
    case 'preset': return { name: typeof src.name === 'string' ? safeName(src.name) || '' : '' };
    case 'library': return { path: safeLibPath(src.path, { allowRoot: false }) ?? '' };
    case 'transport': return { play: toBool(src.play, true) };
    default: return {};
  }
}

/**
 * Strict list validation (same contract as validateCue): returns { clips, errors }; errors are
 * localized fragments with field 'clips'. Clip ids are kept when valid and unique.
 */
export function validateClips(list) {
  const errors = [];
  if (!Array.isArray(list)) return { clips: [], errors: [L('clip.err.notList')] };
  if (list.length > MAX_CLIPS) return { clips: [], errors: [L('clip.err.tooMany', { max: MAX_CLIPS })] };
  const out = [];
  const seen = new Set();
  list.forEach((c, i) => {
    const n = i + 1;
    if (!isPlainObject(c)) { errors.push(L('clip.err.at', { n, msg: L('clip.err.notClip') })); return; }
    const bad = (key, params) => errors.push(L('clip.err.at', { n, msg: L(key, params) }));
    if (!CLIP_KINDS.includes(c.kind)) { bad('clip.err.kind', { v: String(c.kind).slice(0, 16) }); return; }
    const tg = c.targets === undefined || c.targets === null ? '' : typeof c.targets === 'string' ? c.targets.trim() : null;
    if (tg === null || tg.length > 64 || !TARGETS_RE.test(tg)) { bad('clip.err.targets'); return; }
    const start = Number(c.start ?? 0);
    const dur = Number(c.dur ?? 4);
    if (!Number.isFinite(start) || start < 0 || start > MAX_CLIP_TIME) { bad('clip.err.range', { field: 'start', min: 0, max: MAX_CLIP_TIME }); return; }
    if (!Number.isFinite(dur) || dur < 0.05 || dur > MAX_CLIP_TIME) { bad('clip.err.range', { field: 'dur', min: 0.05, max: MAX_CLIP_TIME }); return; }
    const fade = c.fade === undefined || c.fade === null || c.fade === '' ? null : Number(c.fade);
    if (fade !== null && (!Number.isFinite(fade) || fade < 0 || fade > 60)) { bad('clip.err.range', { field: 'fade', min: 0, max: 60 }); return; }
    const then = c.then ?? 'continue';
    if (!CLIP_THEN.includes(then)) { bad('clip.err.then', { v: String(then).slice(0, 16) }); return; }
    const ease = typeof c.ease === 'string' && Object.hasOwn(EASINGS, c.ease) ? c.ease : 'inOut';
    const params = cleanParams(c.kind, c.params);
    if (c.kind === 'preset' && !params.name) { bad('clip.err.preset'); return; }
    if (c.kind === 'library' && !params.path) { bad('clip.err.library'); return; }
    let id = typeof c.id === 'string' && /^[a-z0-9]{1,16}$/i.test(c.id) && !seen.has(c.id) ? c.id : newClipId();
    while (seen.has(id)) id = newClipId();
    seen.add(id);
    const lane = Number.isInteger(c.lane) && c.lane >= 0 && c.lane < 64 ? c.lane : null;
    out.push({
      id, kind: c.kind, targets: tg.toLowerCase() === 'all' ? '' : tg, start: round3(start), dur: round3(dur), fade, ease, then, params,
      label: typeof c.label === 'string' ? Array.from(c.label.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, 32).join('') : '', lane,
    });
  });
  return { clips: errors.length ? [] : out, errors };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export const clipsSpan = (clips) => (clips ?? []).reduce((m, c) => Math.max(m, c.start + c.dur), 0);

/**
 * Runs 'clips' cues.
 * api: {
 *   resolve(spec) → ids[] (spec '' = all enabled); object(id) → config;
 *   apply(ids, objects[], { fade, ease }); home(ids, fade, ease); preset(name, ids, fade, ease) → bool;
 *   library(path, ids, fade, ease) → bool;
 *   run(ids, play); onClip?(info)
 * }
 * Ownership is per object and global over runs: the clip that started last controls the object, an
 * earlier clip ending later leaves it alone. `revert` restores the config captured when the clip started.
 */
export class ClipRunner {
  constructor(api) {
    this.api = api;
    this.runs = [];
    this.owner = new Map();
    this.held = new Set();
    this.seq = 0;
    this.chaseFade = 0.3;
  }

  /**
   * clock 'tc': timing follows the show position (cueT = cue time on the TC circle) and only advances
   * while rolling; 'wall': seconds since GO / manual fire.
   */
  start(cue, { ids = null, elapsed = 0, clock = 'wall', cueT = null, now, chase = false, chaseFade = this.chaseFade } = {}) {
    this.cancel(cue.id);
    const run = {
      uid: ++this.seq, cue, clock, cueT, t0: now - elapsed, onlyIds: ids ? new Set(ids) : null,
      clips: this.resolveClips(cue.clips ?? []), started: new Set(), ended: new Set(), last: elapsed, span: clipsSpan(cue.clips),
      state: new Map(),
    };
    this.runs.push(run);
    if (chase || elapsed > EPS) this.resync(run, elapsed, chaseFade);
    else this.process(run, -EPS, 0);
    return run;
  }

  resolveClips(clips) {
    return clips.map((c) => ({ ...c, ids: this.api.resolve(c.targets) ?? [] }));
  }

  /** Cue list edited: drop runs of removed cues, take new clip data (started/ended kept by clip id). */
  refresh(cueById) {
    this.runs = this.runs.filter((run) => {
      const cue = cueById.get(run.cue.id);
      if (!cue || cue.action !== 'clips' || !cue.enabled) {
        this.dropOwnership(run);
        return false;
      }
      if (cue !== run.cue) {
        const startedIds = new Set([...run.started].map((k) => run.clips[k]?.id));
        const endedIds = new Set([...run.ended].map((k) => run.clips[k]?.id));
        run.cue = cue;
        run.clips = this.resolveClips(cue.clips ?? []);
        run.span = clipsSpan(cue.clips);
        run.started = new Set();
        run.ended = new Set();
        run.clips.forEach((c, k) => {
          if (startedIds.has(c.id)) run.started.add(k);
          if (endedIds.has(c.id)) run.ended.add(k);
        });
      }
      return true;
    });
  }

  cancel(cueId) {
    this.runs = this.runs.filter((r) => {
      if (r.cue.id !== cueId) return true;
      this.dropOwnership(r);
      return false;
    });
  }

  stopAll() {
    for (const r of this.runs) this.dropOwnership(r);
    this.runs = [];
  }

  /** Another scene cue (slot/home) took these objects: pending clip ends must not touch them. */
  release(ids) {
    const list = ids ?? [...this.owner.keys()];
    for (const id of list) this.owner.delete(id);
    const resume = list.filter((id) => this.held.delete(id));
    if (resume.length) this.api.run(resume, true);
  }

  dropOwnership(run) {
    for (const [id, o] of this.owner) if (o.uid === run.uid) this.owner.delete(id);
  }

  elapsed(run, now, tc) {
    if (run.clock === 'wall') return { el: now - run.t0, live: true };
    if (!tc || tc.pos === null || tc.pos === undefined || run.cueT === null) return { el: run.last, live: false };
    return { el: cdiff(tc.pos, run.cueT, tc.day), live: !!tc.rolling };
  }

  /** tc = { pos, rolling, day } from the cue engine (only used by 'tc' runs). */
  tick(now, tc = null) {
    for (const run of [...this.runs]) {
      const { el, live } = this.elapsed(run, now, tc);
      if (run.clock === 'tc') {
        if (el < -BACK_TOL && (live || Math.abs(el - run.last) > JUMP)) {
          this.cancel(run.cue.id);
          continue;
        }
        if (!live) continue;
        if (el - run.last > JUMP || el < run.last - BACK_TOL) {
          this.resync(run, el, this.chaseFade);
          run.last = el;
          continue;
        }
      }
      if (el > run.last) {
        this.process(run, run.last, el);
        run.last = el;
      }
      if (run.ended.size === run.clips.length && el > run.span + EPS) this.finish(run);
    }
  }

  finish(run) {
    this.runs = this.runs.filter((r) => r !== run);
    this.dropOwnership(run);
  }

  /** Events in (a, b]: ends before starts at the same instant so the newer clip wins. */
  process(run, a, b) {
    const ev = [];
    run.clips.forEach((c, k) => {
      if (!run.started.has(k) && c.start > a - EPS && c.start <= b + EPS) ev.push({ t: c.start, k, end: false });
      const e = c.start + c.dur;
      if (!run.ended.has(k) && e > a + EPS && e <= b + EPS) ev.push({ t: e, k, end: true });
    });
    ev.sort((x, y) => x.t - y.t || Number(y.end) - Number(x.end) || x.k - y.k);
    for (const e of ev) {
      if (e.end) {
        if (!run.started.has(e.k)) this.startClip(run, e.k, null);
        this.endClip(run, e.k);
      } else {
        this.startClip(run, e.k, null);
      }
    }
  }

  idsOf(run, c) {
    return run.onlyIds ? c.ids.filter((id) => run.onlyIds.has(id)) : c.ids;
  }

  startClip(run, k, fadeOverride) {
    const c = run.clips[k];
    run.started.add(k);
    const ids = this.idsOf(run, c);
    if (!ids.length) return;
    const before = c.then === 'revert' ? new Map(ids.map((id) => [id, structuredClone(this.api.object(id))])) : null;
    for (const id of ids) {
      this.owner.set(id, { uid: run.uid, k, before: before?.get(id) ?? null });
      run.state.set(id, `a${k}`);
    }
    this.applyClip(c, ids, fadeOverride ?? c.fade);
    this.api.onClip?.({ cue: run.cue.id, clip: c.id, phase: 'start', ids });
  }

  endClip(run, k) {
    const c = run.clips[k];
    run.ended.add(k);
    const mine = this.idsOf(run, c).filter((id) => {
      const o = this.owner.get(id);
      return o && o.uid === run.uid && o.k === k;
    });
    if (!mine.length) return;
    const fade = c.fade;
    if (c.then === 'home') this.api.home(mine, fade, c.ease);
    else if (c.then === 'revert') {
      const objs = mine.map((id) => this.owner.get(id).before).filter(Boolean);
      if (objs.length) this.api.apply(objs.map((o) => o.id), objs, { fade, ease: c.ease });
    } else if (c.then === 'hold') {
      this.api.run(mine, false);
      for (const id of mine) this.held.add(id);
    }
    for (const id of mine) {
      this.owner.delete(id);
      if (c.then === 'revert') run.state.delete(id);
      else run.state.set(id, c.then === 'home' ? `h${k}` : c.then === 'hold' ? `p${k}` : `a${k}`);
    }
    this.api.onClip?.({ cue: run.cue.id, clip: c.id, phase: 'end', ids: mine });
  }

  applyClip(c, ids, fade) {
    const resume = ids.filter((id) => this.held.has(id));
    if (resume.length && c.kind !== 'transport' && c.kind !== 'home') {
      for (const id of resume) this.held.delete(id);
      this.api.run(resume, true);
    }
    switch (c.kind) {
      case 'motion':
      case 'path':
      case 'move': {
        const patch = c.kind === 'move'
          ? { mode: 'hold', center: { x: c.params.x, y: c.params.y, z: c.params.z } }
          : c.kind === 'path' && Array.isArray(c.params.pathPts) && c.params.pathPts.length >= 2
            ? { pathSource: 'custom', ...c.params }
            : c.params;
        const objs = ids.map((id) => ({ ...deepMerge(this.api.object(id), patch), id }));
        this.api.apply(ids, objs, { fade, ease: c.ease });
        break;
      }
      case 'preset': this.api.preset(c.params.name, ids, fade, c.ease); break;
      case 'library': this.api.library?.(c.params.path, ids, fade, c.ease); break;
      case 'home': this.api.home(ids, fade, c.ease); break;
      case 'transport': {
        this.api.run(ids, c.params.play);
        for (const id of ids) (c.params.play ? this.held.delete(id) : this.held.add(id));
        break;
      }
      default: break;
    }
  }

  /**
   * Jump into the middle of a run (chase / locate): per object, the net effect of everything up to
   * `el` is applied once with a short fade; clips active at `el` take ownership.
   */
  resync(run, el, fade) {
    this.dropOwnership(run);
    run.started = new Set();
    run.ended = new Set();
    const order = run.clips.map((c, k) => k).sort((a, b) => run.clips[a].start - run.clips[b].start || a - b);
    const final = new Map();
    for (const k of order) {
      const c = run.clips[k];
      if (c.start > el + EPS) continue;
      const ended = c.start + c.dur <= el + EPS;
      run.started.add(k);
      if (ended) run.ended.add(k);
      for (const id of this.idsOf(run, c)) {
        const prev = final.get(id) ?? null;
        if (!ended) final.set(id, { k, type: 'active', prev });
        else if (c.then === 'revert') final.set(id, prev ? { ...prev } : { type: 'none' });
        else if (c.then === 'home') final.set(id, { k, type: 'home' });
        else final.set(id, { k, type: c.then === 'hold' ? 'hold' : 'apply' });
      }
    }
    const keyOf = (f) => (f.type === 'home' ? `h${f.k}` : f.type === 'hold' ? `p${f.k}` : `a${f.k}`);
    const groups = new Map();
    const prevState = run.state;
    run.state = new Map();
    for (const [id, f] of final) {
      if (f.type === 'none') continue;
      const key = keyOf(f);
      run.state.set(id, key);
      const was = prevState.get(id);
      if (f.type === 'active') {
        const c = run.clips[f.k];
        const before = c.then === 'revert' ? structuredClone(this.api.object(id)) : null;
        this.owner.set(id, { uid: run.uid, k: f.k, before });
      }
      // Already there (locate inside the same clip): nothing to re-apply; active → hold only pauses.
      const step = was === key ? null : f.type === 'hold' && was === `a${f.k}` ? 'pause' : f.type;
      if (!step) continue;
      const g = `${step}:${f.k}`;
      if (!groups.has(g)) groups.set(g, { step, k: f.k, ids: [] });
      groups.get(g).ids.push(id);
    }
    for (const g of groups.values()) {
      const c = run.clips[g.k];
      if (g.step === 'home') this.api.home(g.ids, fade, c.ease);
      else if (g.step !== 'pause') this.applyClip(c, g.ids, fade);
      if (g.step === 'hold' || g.step === 'pause') {
        this.api.run(g.ids, false);
        for (const id of g.ids) this.held.add(id);
      }
    }
    run.last = el;
  }

  /** Server time of the next clip edge of a wall-clock run (TC runs wake through the cue engine / UI tick). */
  nextWake(now) {
    let best = null;
    for (const run of this.runs) {
      if (run.clock !== 'wall') continue;
      const el = now - run.t0;
      run.clips.forEach((c, k) => {
        for (const [t, done] of [[c.start, run.started.has(k)], [c.start + c.dur, run.ended.has(k)]]) {
          if (done || t <= el) continue;
          const at = run.t0 + t;
          if (best === null || at < best) best = at;
        }
      });
    }
    return best;
  }

  status(now, tc = null) {
    return this.runs.map((run) => ({
      cue: run.cue.id, clock: run.clock, elapsed: Math.round(this.elapsed(run, now, tc).el * 1000) / 1000, span: run.span,
      active: run.clips.filter((c, k) => run.started.has(k) && !run.ended.has(k)).map((c) => c.id),
    }));
  }
}
