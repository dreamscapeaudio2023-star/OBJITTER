import {
  parseTc, formatTc, tcToSeconds, secondsToTc, normalizeRate, isDf, validTc, validTcForRate, daySeconds,
  RATE_REAL, RATE_FPS, TC_RATES,
} from '../public/tc-core.js';
import { isPlainObject } from './fsutil.js';
import { num, toBool, EASINGS } from './engine.js';
import { SLOT_COUNT, safeName } from './presets.js';
import { safeLibPath } from './library.js';
import { L } from './i18n.js';
import { validateClips } from './clips.js';

export const CUE_ACTIONS = ['slot', 'library', 'start', 'stop', 'home', 'freeze', 'unfreeze', 'clips'];
export const TC_INPUTS = ['mtc', 'ltc', 'osc', 'internal'];
export const TC_RATE_SETTINGS = ['auto', ...TC_RATES];
export const LOSS_MODES = ['hold', 'stop'];
export const TC_TRIGGERS = ['tc', 'go'];
export const CUE_CURVES = ['inOut', 'linear', 'in', 'out', 'smooth'];
export const STAGGER_ORDERS = ['id', 'random', 'distance'];
export const GLOBALS_MODES = ['keep', 'preset'];
export const MAX_CUES = 999;
/**
 * Cues in the same group replace each other's state; chase re-applies the most recent one.
 * 'scene' is tracked per object: a home cue counts as that object's scene, so on chase an object
 * goes home only when the home cue is later than its last slot cue.
 */
export const GROUP = { slot: 'scene', library: 'scene', home: 'scene', clips: 'scene', start: 'run', stop: 'run', freeze: 'freeze', unfreeze: 'freeze' };
/** Frames a source needs before its first value reaches us (MTC: 8 quarter frames, LTC: one frame + decode). */
const LOCK_FRAMES = { mtc: 2, ltc: 3, osc: 0, internal: 0 };
/** Backward movement smaller than this is treated as jitter (no re-arm). */
const REARM_TOLERANCE = 0.25;
const LOCKED_GAP = 0.15;
const ROLL_MIN = 0.8;
const ROLL_MAX = 1.25;
const ROLL_EXIT_LO = 0.5;
const ROLL_EXIT_HI = 1.35;
const SPEED_WINDOW = 0.3;
const CHASE_SETTLE = 0.25;
const OFFSET_WINDOW = 10;
const EPS = 1e-6;
const ALL_IDS = Array.from({ length: 32 }, (_, i) => i + 1);

const pick = (v, list, def) => (list.includes(v) ? v : def);
const mod = (x, d) => ((x % d) + d) % d;
/** Signed shortest distance a − b on a circle of length d. */
const cdiff = (a, b, d) => mod(a - b + d / 2, d) - d / 2;

/** Strips control/format characters and truncates by code point (never splits a surrogate pair). */
export function cleanText(v, max) {
  return Array.from(String(v).replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, max).join('');
}

export function defaultTcSettings() {
  return {
    enabled: false, input: 'mtc', rate: 'auto', offset: '+00:00:00:00', chase: true, chaseFade: 0.3,
    locateThreshold: 0.5, freewheel: 0.5, freewheelFire: true, autoStart: false, onLoss: 'hold',
    latencyMs: 0, preroll: 2, trigger: 'tc',
  };
}

export function canonicalTc(v, { signed = false } = {}) {
  const tc = typeof v === 'string' ? parseTc(v) : null;
  if (!tc || (!signed && tc.neg)) return null;
  return formatTc(tc, { sign: signed });
}

export function sanitizeTcSettings(s, prev = defaultTcSettings()) {
  const src = isPlainObject(s) ? s : {};
  return {
    enabled: toBool(src.enabled, prev.enabled),
    input: pick(src.input, TC_INPUTS, prev.input),
    rate: src.rate === 'auto' ? 'auto' : pick(normalizeRate(src.rate), TC_RATE_SETTINGS, prev.rate),
    offset: canonicalTc(src.offset, { signed: true }) ?? prev.offset,
    chase: toBool(src.chase, prev.chase),
    chaseFade: num(src.chaseFade, 0, 10, prev.chaseFade),
    locateThreshold: num(src.locateThreshold, 0.1, 60, prev.locateThreshold),
    freewheel: num(src.freewheel, 0.1, 10, prev.freewheel),
    freewheelFire: toBool(src.freewheelFire, prev.freewheelFire),
    autoStart: toBool(src.autoStart, prev.autoStart),
    onLoss: pick(src.onLoss, LOSS_MODES, prev.onLoss),
    latencyMs: Math.round(num(src.latencyMs, -500, 500, prev.latencyMs)),
    preroll: num(src.preroll, 0, 30, prev.preroll),
    trigger: pick(src.trigger, TC_TRIGGERS, prev.trigger),
  };
}

const newCueId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

export function defaultCue() {
  return {
    id: newCueId(), tc: '00:00:00:00', action: 'slot', preset: '', slot: null, fade: null, enabled: true, label: '',
    curve: 'inOut', stagger: 0, staggerOrder: 'id', targets: '', bpm: null, globals: 'keep', anchorBeat: false,
    seedOffset: 0, follow: null, clips: [], lib: '',
  };
}

/** Integer from a number or a plain digit string; anything else (1.5, '2x', ' ', true) is null. */
export function strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function strictNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

const TARGETS_RE = /^[\p{L}\p{N}_ ,@\-.]*$/u;

/**
 * Strict cue validation. Fields present in `src` must be valid, otherwise they are reported in
 * `errors` (localized fragments with a `field` key) and the cue must not be stored. Absent fields keep `base`.
 * `rate` (effective TC rate) rejects labels that do not exist at that rate.
 */
export function validateCue(src, base = defaultCue(), { rate = null } = {}) {
  const errors = [];
  if (!isPlainObject(src)) return { cue: null, errors: [L('cue.err.notCue')] };
  const cue = { ...defaultCue(), ...base };
  const has = (k) => Object.hasOwn(src, k) && src[k] !== undefined;
  const bad = (field, key, params) => errors.push({ ...L('cue.err', { field: L(`cue.field.${field}`), msg: L(key, params) }), field });

  if (has('tc')) {
    const tc = typeof src.tc === 'string' ? parseTc(src.tc) : null;
    if (!tc || tc.neg) bad('tc', 'cue.err.tcFormat', { v: String(src.tc).slice(0, 16) });
    else if (rate && !validTcForRate(tc, rate)) bad('tc', 'cue.err.tcRate', { tc: formatTc(tc), rate });
    else cue.tc = formatTc(tc);
  }
  if (has('action')) {
    if (CUE_ACTIONS.includes(src.action)) cue.action = src.action;
    else bad('action', 'cue.err.action', { v: String(src.action).slice(0, 16) });
  }
  if (has('slot')) {
    if (src.slot === null || src.slot === '') cue.slot = null;
    else {
      const n = strictInt(src.slot);
      if (n === null || n < 1 || n > SLOT_COUNT) bad('slot', 'cue.err.range', { min: 1, max: SLOT_COUNT });
      else cue.slot = n;
    }
  }
  if (has('preset')) {
    if (typeof src.preset !== 'string') bad('preset', 'cue.err.notString');
    else cue.preset = src.preset.trim() ? safeName(src.preset) : '';
  }
  const optNum = (key, min, max, { int = false, nullable = true } = {}) => {
    if (!has(key)) return;
    if (nullable && (src[key] === null || src[key] === '')) { cue[key] = null; return; }
    const n = int ? strictInt(src[key]) : strictNum(src[key]);
    if (n === null || n < min || n > max) bad(key, 'cue.err.range', { min, max });
    else cue[key] = n;
  };
  optNum('fade', 0, 60);
  optNum('stagger', 0, 10, { nullable: false });
  optNum('bpm', 20, 300);
  optNum('seedOffset', 0, 999, { int: true, nullable: false });
  optNum('follow', 0, 600);
  const optEnum = (key, list) => {
    if (!has(key)) return;
    if (list.includes(src[key])) cue[key] = src[key];
    else bad(key, 'cue.err.notAllowed', { v: String(src[key]).slice(0, 16) });
  };
  optEnum('curve', CUE_CURVES.filter((c) => Object.hasOwn(EASINGS, c)));
  optEnum('staggerOrder', STAGGER_ORDERS);
  optEnum('globals', GLOBALS_MODES);
  const optBool = (key) => {
    if (!has(key)) return;
    const b = toBool(src[key], null);
    if (b === null) bad(key, 'cue.err.bool');
    else cue[key] = b;
  };
  optBool('enabled');
  optBool('anchorBeat');
  if (has('label')) {
    if (typeof src.label !== 'string' && typeof src.label !== 'number') bad('label', 'cue.err.notString');
    else cue.label = cleanText(src.label, 48);
  }
  if (has('targets')) {
    const tg = typeof src.targets === 'string' ? src.targets.trim() : null;
    if (tg === null || tg.length > 64 || !TARGETS_RE.test(tg)) bad('targets', 'cue.err.targets');
    else cue.targets = tg.toLowerCase() === 'all' ? '' : tg;
  }
  if (has('clips')) {
    const r = validateClips(src.clips);
    if (r.errors.length) for (const e of r.errors.slice(0, 5)) errors.push({ ...L('cue.err', { field: L('cue.field.clips'), msg: e }), field: 'clips' });
    else cue.clips = r.clips;
  }
  if (!Array.isArray(cue.clips)) cue.clips = [];
  if (has('lib')) {
    const p = typeof src.lib === 'string' ? safeLibPath(src.lib) : null;
    if (p === null) bad('lib', 'cue.err.notString');
    else cue.lib = p;
  }
  if (cue.action === 'slot' && !cue.preset && cue.slot === null) bad('preset', 'cue.err.needPreset');
  if (cue.action === 'library' && !cue.lib) bad('lib', 'cue.err.needLib');
  if (typeof base.id === 'string' && /^[a-z0-9]{1,16}$/i.test(base.id)) cue.id = base.id;
  return { cue: errors.length ? null : cue, errors };
}

/** Lenient loader for persisted state: invalid cues are dropped, ids de-duplicated. */
export function sanitizeCueList(list, opts) {
  const out = [];
  const seen = new Set();
  for (const c of (Array.isArray(list) ? list : []).filter(isPlainObject).slice(0, MAX_CUES)) {
    const id = typeof c.id === 'string' && /^[a-z0-9]{1,16}$/i.test(c.id) && !seen.has(c.id) ? c.id : newCueId();
    const { cue } = validateCue(c, { ...defaultCue(), id }, opts);
    if (!cue) continue;
    seen.add(cue.id);
    out.push(cue);
  }
  return out;
}

/** Stable sort by label; cues at the same TC keep their list order (= execution order). */
export function sortCues(cues) {
  const key = (c) => {
    const tc = parseTc(c.tc);
    return tc ? ((tc.h * 60 + tc.m) * 60 + tc.s) * 30 + tc.f : 0;
  };
  return [...cues].sort((a, b) => key(a) - key(b));
}

/**
 * Sliding minimum of (server arrival − sender timestamp) over ~10 s. The minimum is the sample
 * with the least transport delay, so `at + offset` maps sender time onto the server clock.
 */
export class OffsetEstimator {
  constructor(window = OFFSET_WINDOW) {
    this.window = window;
    this.q = [];
  }

  reset() {
    this.q = [];
  }

  /** at = sender ms, now = server s → reference time (server s) for the sample. */
  ref(at, now) {
    const d = now * 1000 - at;
    while (this.q.length && this.q[this.q.length - 1][1] >= d) this.q.pop();
    this.q.push([now, d]);
    while (this.q[0][0] < now - this.window) this.q.shift();
    return Math.min(now, (at + this.q[0][1]) / 1000);
  }
}

/** Free-running show clock (seconds of TC label time). */
export class InternalClock {
  constructor() {
    this.playing = false;
    this.base = 0;
    this.t0 = 0;
  }

  position(now) {
    return this.playing ? this.base + (now - this.t0) : this.base;
  }

  play(now) {
    if (this.playing) return;
    this.t0 = now;
    this.playing = true;
  }

  pause(now) {
    if (!this.playing) return;
    this.base = this.position(now);
    this.playing = false;
  }

  locate(sec, now) {
    this.base = Math.max(0, sec);
    this.t0 = now;
  }
}

/**
 * Timecode-driven cue engine. Pure: callers pass the current time (seconds, monotonic) and act on
 * the returned actions: { type: 'fire' | 'chase' | 'go', cue, ids, elapsed } | { type: 'lost' } | { type: 'rolling' }.
 *
 * Rules (live-show safety):
 * - Positions live on a 24 h circle (midnight wrap, offsets) and are compared with circular math.
 * - Cues fire only while the transport is "rolling" (speed 0.8–1.25 to enter, 0.5–1.35 to stay,
 *   forward). Shuttle/FF, reverse and parked TC never fire; skipped ranges are chased afterwards.
 * - On locate the fire pointer is armed (lock latency + ½ frame) behind the position, so a cue at
 *   the start point fires on the first forward motion, never while parked.
 * - Chase is debounced (250 ms stable or as soon as it rolls) and uses only cues behind the pointer.
 * - Between inputs the position is extrapolated: cues keep firing through dropouts up to the
 *   freewheel time (or only ~1 frame interval when freewheelFire is off).
 */
export class CueEngine {
  constructor() {
    this.settings = defaultTcSettings();
    this.cues = [];
    this.applied = { scene: {}, run: null, freeze: null };
    this.cache = null;
    this.resolveIds = () => null;
    this.offset = new OffsetEstimator();
    this.standbyId = null;
    this.followAt = null;
    this.lastTc = null;
    this.firedT = null;
    this.resetInput();
  }

  resetInput({ keepRate = false } = {}) {
    this.state = 'off';
    this.src = null;
    this.kind = null;
    if (!keepRate) this.inRate = null;
    this.raw = null;
    this.lastIn = null;
    this.lastRef = null;
    this.lastT = null;
    this.firedT = null;
    this.nextT = null;
    this.dir = 0;
    this.fwd = 0;
    this.v = 0;
    this.vEma = 0;
    this.interval = null;
    this.hist = [];
    this.rolling = false;
    this.sessionRolled = false;
    this.chase = null;
    this.offset.reset();
  }

  setSettings(patch) {
    const before = this.settings;
    this.settings = sanitizeTcSettings({ ...before, ...(isPlainObject(patch) ? patch : {}) }, before);
    const s = this.settings;
    if (s.rate !== before.rate || s.offset !== before.offset || s.input !== before.input) {
      this.cache = null;
      this.resetInput({ keepRate: s.input === before.input });
    }
    if (s.enabled && !before.enabled && this.lastT !== null) this.setFired(this.lastT);
    if (!s.enabled || !s.chase || s.trigger !== 'tc') this.chase = null;
    if (s.trigger === 'go' && before.trigger !== 'go') this.fixStandby(true);
    if (s.trigger !== 'go') this.followAt = null;
    return s;
  }

  setCues(cues) {
    this.cues = sortCues(cues);
    this.cache = null;
    if (this.firedT !== null) this.setFired(this.firedT);
    this.fixStandby(false);
  }

  rate() {
    return this.settings.rate === 'auto' ? this.inRate || '25' : this.settings.rate;
  }

  day(rate = this.rate()) {
    return daySeconds(rate);
  }

  offsetSec(rate = this.rate()) {
    const tc = parseTc(this.settings.offset);
    return tc ? tcToSeconds(tc, rate) : 0;
  }

  /** Enabled cues with their time (s) for the effective rate, in execution order. */
  timeline() {
    const rate = this.rate();
    if (this.cache?.rate === rate) return this.cache.list;
    const list = [];
    this.cues.forEach((cue, i) => {
      const tc = parseTc(cue.tc);
      if (cue.enabled && tc) list.push({ cue, t: tcToSeconds(tc, rate), i });
    });
    list.sort((a, b) => a.t - b.t || a.i - b.i);
    this.cache = { rate, list };
    return list;
  }

  invalidate(group, ids = null) {
    if (group === 'scene') {
      if (!ids) this.applied.scene = {};
      else for (const id of ids) delete this.applied.scene[id];
    } else {
      this.applied[group] = null;
    }
  }

  expected() {
    return Math.min(2, Math.max(0.01, this.interval ?? 0.04));
  }

  lockedGap() {
    return Math.max(LOCKED_GAP, 1.5 * this.expected());
  }

  position(now) {
    if (this.lastT === null) return null;
    const gap = Math.min(Math.max(0, now - this.lastRef), this.lockedGap() + this.settings.freewheel);
    return mod(this.lastT + (this.rolling ? this.vEma * gap : 0), this.day());
  }

  /** Pointer up to which cues are done; also caches the next cue time on the circle. */
  setFired(t) {
    this.firedT = t;
    this.nextT = null;
    if (t === null) return;
    const D = this.day();
    let best = Infinity;
    for (const { t: ct } of this.timeline()) {
      const d = mod(ct - t, D);
      if (d > EPS && d < best) {
        best = d;
        this.nextT = ct;
      }
    }
  }

  /**
   * One decoded timecode label. `tc` = { h, m, s, f }, `sub` = extra fractional frames (signed),
   * `at` = sender timestamp in ms (clock offset is estimated), `kind` = source type for lock latency.
   */
  input({ tc, sub = 0, rate = null, src = null, at = null, kind = null }, now) {
    const nr = normalizeRate(rate);
    if (nr && nr !== this.inRate) {
      this.inRate = nr;
      if (this.settings.rate === 'auto') this.cache = null;
    }
    if (!validTc(tc)) return [];
    if (this.settings.rate === 'auto' && !nr && tc.f >= RATE_FPS[this.rate()]) {
      this.inRate = tc.f >= 25 ? '30' : '25';
      this.cache = null;
    }
    const R = this.rate();
    if (!validTcForRate(tc, R)) return [];
    this.raw = formatTc(tc, { df: isDf(R) });
    const t = tcToSeconds(tc, R) + (Number(sub) || 0) / RATE_REAL[R] + this.offsetSec(R);
    return this.feed(t, { src, at, kind: kind ?? src?.kind ?? this.settings.input }, now);
  }

  /** Position in seconds (internal clock, or decoded label). */
  feed(tIn, { src = null, at = null, kind = null } = {}, now) {
    const D = this.day();
    const t = mod(tIn, D);
    const s = this.settings;
    let ref = Number.isFinite(at) ? this.offset.ref(at, now) : now;
    ref -= s.latencyMs / 1000;
    const fresh = this.lastT === null || this.state === 'off' || this.state === 'lost';
    this.src = src;
    this.kind = kind;
    this.lastIn = now;
    this.state = 'locked';
    if (kind === 'internal') this.raw = formatTc(secondsToTc(t, this.rate()), { df: isDf(this.rate()) });
    if (fresh) return this.locate(t, ref, now, true);

    const dref = ref - this.lastRef;
    const p1 = mod(this.lastT + Math.max(0, dref) * (this.rolling ? this.vEma : 1), D);
    const err = Math.min(Math.abs(cdiff(t, p1, D)), Math.abs(cdiff(t, this.lastT, D)));
    if (err > s.locateThreshold) return this.locate(t, ref, now, false);

    const step = cdiff(t, this.lastT, D);
    const prevDir = this.dir;
    this.dir = step > EPS ? 1 : step < -EPS ? -1 : 0;
    if (dref > 0.002 && dref < 2) this.interval = this.interval === null ? dref : this.interval + 0.2 * (dref - this.interval);
    // Speed over the last 3 frame steps (≤ 0.3 s); restarted when motion resumes so parked samples don't damp it.
    if (this.dir !== 0 && prevDir === 0) this.hist = [];
    this.hist.push([ref, t]);
    while (this.hist.length > 4 || (this.hist.length > 2 && ref - this.hist[1][0] >= SPEED_WINDOW)) this.hist.shift();
    const [r0, t0] = this.hist[0];
    const v = ref - r0 > 0.002 ? cdiff(t, t0, D) / (ref - r0) : this.v;
    this.v = v;
    if (this.rolling) {
      if (v < ROLL_EXIT_LO || v > ROLL_EXIT_HI || this.dir < 0) {
        this.rolling = false;
        this.fwd = 0;
      } else {
        this.vEma += 0.3 * (v - this.vEma);
      }
    } else {
      this.fwd = v >= ROLL_MIN && v <= ROLL_MAX && this.dir > 0 ? this.fwd + 1 : 0;
      if (this.fwd >= 2) {
        this.rolling = true;
        this.vEma = v;
      }
    }
    const prevReal = this.lastT;
    this.lastT = t;
    this.lastRef = ref;

    const actions = [];
    if (this.rolling) {
      actions.push(...this.flushChase());
      actions.push(...this.advance(t, prevReal));
      if (!this.sessionRolled) {
        this.sessionRolled = true;
        actions.push({ type: 'rolling' });
      }
    } else {
      this.idleMove(t, v, now);
      actions.push(...this.maybeChase(now));
    }
    return actions;
  }

  /** Not rolling: never fire. Keep only a short armed window behind the position; anything else is chased. */
  idleMove(t, v, now) {
    if (this.firedT === null) return;
    const D = this.day();
    const behind = cdiff(t, this.firedT, D);
    const armMax = this.armWindow() + Math.max(4 / RATE_REAL[this.rate()], 2.5 * this.expected());
    if (v > ROLL_EXIT_HI || (this.dir < 0 && behind < -REARM_TOLERANCE)) {
      this.setFired(t);
      this.markChase(now);
    } else if (behind > armMax) {
      this.setFired(mod(t - armMax, D));
      this.markChase(now);
    }
  }

  armWindow() {
    return ((LOCK_FRAMES[this.kind] ?? 0) + 0.5) / RATE_REAL[this.rate()];
  }

  /** Explicit stop (OSC /tc/stop, source released) or signal loss. */
  stop() {
    if (this.state === 'off' || this.state === 'lost') return [];
    const actions = this.flushChase();
    if (this.lastT !== null) this.lastTc = formatTc(secondsToTc(this.lastT, this.rate()), { df: isDf(this.rate()) });
    this.state = 'lost';
    this.lastT = null;
    this.rolling = false;
    this.dir = 0;
    this.hist = [];
    actions.push({ type: 'lost' });
    return actions;
  }

  tick(now) {
    const actions = [];
    if (this.followAt !== null && now >= this.followAt) {
      this.followAt = null;
      actions.push(...this.go(now));
    }
    if (this.lastT === null || this.state === 'lost' || this.state === 'off') return actions;
    const gap = now - this.lastIn;
    const lockedGap = this.lockedGap();
    if (gap > lockedGap + this.settings.freewheel) return [...actions, ...this.stop()];
    this.state = gap > lockedGap ? 'freewheel' : 'locked';
    if (this.rolling) {
      const horizon = this.settings.freewheelFire ? Infinity : 1.25 * this.expected();
      if (gap <= horizon) actions.push(...this.advance(this.position(now), null));
    } else {
      actions.push(...this.maybeChase(now));
    }
    return actions;
  }

  /** Forward fire window (firedT, t]. prevReal = previous real input (null when extrapolating). */
  advance(t, prevReal) {
    if (this.firedT === null) {
      this.setFired(t);
      return [];
    }
    const D = this.day();
    const span = mod(t - this.firedT, D);
    if (span > D / 2) {
      const back = D - span;
      // Real input behind our extrapolated pointer (dropout ended at the stop point) is not a rewind.
      const realRewind = prevReal === null || cdiff(t, prevReal, D) < -REARM_TOLERANCE;
      if (back > REARM_TOLERANCE && realRewind) this.setFired(t);
      return [];
    }
    if (span <= EPS) return [];
    const s = this.settings;
    if (this.nextT === null || mod(this.nextT - this.firedT, D) > span + EPS) {
      this.firedT = t;
      return [];
    }
    if (!s.enabled || s.trigger !== 'tc') {
      this.setFired(t);
      return [];
    }
    const hits = [];
    for (const x of this.timeline()) {
      const d = mod(x.t - this.firedT, D);
      if (d > EPS && d <= span + EPS) hits.push({ ...x, d });
    }
    hits.sort((a, b) => a.d - b.d || a.i - b.i);
    this.setFired(t);
    return hits.map((h) => this.fire(h.cue, 'fire', null, 0));
  }

  locate(t, ref, now, fresh) {
    const D = this.day();
    const arm = mod(t - this.armWindow(), D);
    let fired = arm;
    // Resuming at (or just after) where a dropout started: keep the pointer so nothing fires twice
    // or is skipped. Coming back earlier than that is a rewind and re-arms.
    const ahead = this.firedT === null ? null : cdiff(arm, this.firedT, D);
    if (fresh && ahead !== null && ahead >= -REARM_TOLERANCE && ahead <= this.settings.freewheel + REARM_TOLERANCE) {
      fired = this.firedT;
    }
    if (fresh) this.sessionRolled = false;
    this.setFired(fired);
    this.lastT = t;
    this.lastRef = ref;
    this.hist = [[ref, t]];
    this.rolling = false;
    this.fwd = 0;
    this.dir = 0;
    this.v = 0;
    if (fired === arm) this.markChase(now);
    return [];
  }

  markChase(now) {
    const s = this.settings;
    if (s.enabled && s.chase && s.trigger === 'tc') this.chase = { since: now };
  }

  maybeChase(now) {
    return this.chase && now - this.chase.since >= CHASE_SETTLE ? this.flushChase() : [];
  }

  flushChase() {
    if (!this.chase || this.firedT === null) return [];
    this.chase = null;
    return this.chaseActions(this.firedT);
  }

  /** Most recent cue per group behind T (within half a day); scene resolved per object. */
  chaseActions(T) {
    const D = this.day();
    const behind = [];
    for (const x of this.timeline()) {
      const b = mod(T - x.t, D);
      if (b < D / 2) behind.push({ ...x, b });
    }
    behind.sort((a, z) => a.b - z.b || z.i - a.i);
    const left = new Set(ALL_IDS);
    const scenes = [];
    const other = {};
    for (const x of behind) {
      const g = GROUP[x.cue.action];
      if (g === 'scene') {
        if (!left.size) continue;
        const ids = (this.resolveIds(x.cue) ?? ALL_IDS).filter((id) => left.has(id));
        if (!ids.length) continue;
        for (const id of ids) left.delete(id);
        const pend = ids.filter((id) => this.applied.scene[id] !== x.cue.id);
        if (pend.length) scenes.push({ x, ids: pend });
      } else if (g && !other[g]) {
        other[g] = x;
      }
    }
    const actions = [];
    for (const { x, ids } of scenes.reverse()) actions.push(this.fire(x.cue, 'chase', ids, x.b));
    for (const g of ['freeze', 'run']) {
      const x = other[g];
      if (x && this.applied[g] !== x.cue.id) actions.push(this.fire(x.cue, 'chase', null, x.b));
    }
    return actions;
  }

  fire(cue, type, ids = null, elapsed = 0) {
    const g = GROUP[cue.action];
    const target = ids ?? this.resolveIds(cue);
    if (g === 'scene') for (const id of target ?? ALL_IDS) this.applied.scene[id] = cue.id;
    else if (g) this.applied[g] = cue.id;
    return { type, cue, ids: target, elapsed };
  }

  // ---------- manual GO list ----------
  enabledIdx() {
    return this.cues.map((c, i) => (c.enabled ? i : -1)).filter((i) => i >= 0);
  }

  /** standbyId: cue id, 'end' after the last GO, null = not chosen yet (→ first enabled cue). */
  fixStandby(reset) {
    if (reset || this.standbyId === null || (this.standbyId !== 'end' && this.standbyIndex() < 0)) {
      const first = this.enabledIdx()[0];
      this.standbyId = first === undefined ? null : this.cues[first].id;
    }
  }

  standbyIndex() {
    return this.cues.findIndex((c) => c.id === this.standbyId && c.enabled);
  }

  go(now) {
    const i = this.standbyIndex();
    if (i < 0) return [];
    const cue = this.cues[i];
    const next = this.enabledIdx().find((k) => k > i);
    this.standbyId = next === undefined ? 'end' : this.cues[next].id;
    this.followAt = cue.follow !== null && cue.follow !== undefined && next !== undefined ? now + cue.follow : null;
    return [this.fire(cue, 'go', null, 0)];
  }

  back() {
    this.followAt = null;
    const idx = this.enabledIdx();
    if (!idx.length) return false;
    const i = this.standbyIndex();
    const prev = i < 0 ? idx[idx.length - 1] : [...idx].reverse().find((k) => k < i);
    if (prev === undefined) return false;
    this.standbyId = this.cues[prev].id;
    return true;
  }

  standbyTo(index) {
    const cue = this.cues[index - 1];
    if (!cue) return false;
    this.standbyId = cue.id;
    this.followAt = null;
    return true;
  }

  // ---------- status ----------
  /** Server time at which the next cue is due (or a GO follow), for the scheduler to wake on. */
  nextWake(now) {
    let best = this.followAt;
    const s = this.settings;
    if (this.rolling && s.enabled && s.trigger === 'tc' && this.nextT !== null && this.lastT !== null) {
      const p = this.position(now);
      const due = now + mod(this.nextT - p, this.day()) / Math.max(this.vEma, 0.1);
      if (best === null || due < best) best = due;
    }
    return best;
  }

  nextCue(now) {
    if (this.settings.trigger !== 'tc') return null;
    const pos = this.position(now);
    if (pos === null || this.nextT === null) return null;
    const D = this.day();
    const x = this.timeline().filter((e) => Math.abs(e.t - this.nextT) < EPS).sort((a, b) => a.i - b.i)[0];
    if (!x) return null;
    const c = x.cue;
    return { id: c.id, label: c.label, tc: c.tc, action: c.action, slot: c.slot, preset: c.preset, in: cdiff(x.t, pos, D) };
  }

  standbyInfo() {
    const i = this.standbyIndex();
    if (i < 0) return null;
    const c = this.cues[i];
    return { id: c.id, index: i + 1, label: c.label, tc: c.tc, action: c.action, preset: c.preset, slot: c.slot };
  }

  status(now) {
    const pos = this.position(now);
    const rate = this.rate();
    const tc = pos === null ? null : formatTc(secondsToTc(pos, rate), { df: isDf(rate) });
    if (tc) this.lastTc = tc;
    return {
      state: this.state,
      src: this.kind,
      rate,
      detected: this.inRate,
      tc,
      lastTc: this.lastTc,
      raw: this.raw,
      offset: this.settings.offset !== '+00:00:00:00',
      dir: this.dir,
      rolling: this.rolling,
      speed: this.rolling ? Math.round(this.vEma * 1000) / 1000 : 0,
      next: this.nextCue(now),
      enabled: this.settings.enabled,
      input: this.settings.input,
      trigger: this.settings.trigger,
      standby: this.settings.trigger === 'go' ? this.standbyInfo() : null,
      chasePending: !!this.chase,
    };
  }
}

/**
 * OSC args → { tc, rate } : (h m s f [rate]) or ("hh:mm:ss:ff" [rate]); ";" before frames implies 29.97df.
 * Negative or out-of-range fields are rejected.
 */
export function parseOscTc(args) {
  if (!Array.isArray(args) || !args.length) return null;
  if (typeof args[0] === 'string') {
    const tc = parseTc(args[0]);
    if (!tc || tc.neg) return null;
    return { tc: { h: tc.h, m: tc.m, s: tc.s, f: tc.f }, rate: normalizeRate(args[1]) ?? (tc.dfSep ? '29.97df' : null) };
  }
  const n = args.slice(0, 4).map(Number);
  if (n.length < 4 || !n.every((v) => Number.isInteger(v) && v >= 0)) return null;
  const tc = { h: n[0], m: n[1], s: n[2], f: n[3] };
  if (!validTc(tc)) return null;
  return { tc, rate: normalizeRate(args[4]) };
}
