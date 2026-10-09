export const MAX_OBJECTS = 32;
export const MODES = ['hold', 'jitter', 'glide', 'path', 'drift', 'orbit'];
export const DIVISIONS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];
export const ORBIT_DIRS = ['cw', 'ccw', 'random'];
export const RANGE_SHAPES = ['box', 'ellipse', 'ring'];
export const PATH_ORDERS = ['loop', 'pingpong', 'shuffle'];
export const PATH_CURVES = ['linear', 'catmull'];
export const PATH_SOURCES = ['random', 'custom'];
export const PATH_TIMINGS = ['step', 'even'];
export const MAX_PATH_PTS = 64;
export const TEMPO_MODES = ['grid', 'length'];
export const TEMPO_MULTS = [0.25, 0.5, 1, 2, 4];
export const STOP_MODES = ['freeze', 'center', 'release'];
export const DISABLE_MODES = ['release', 'center'];
/** Automatable object parameters → [min, max] (same limits as sanitizeObject). `pos` is the output position itself. */
export const AUTO_PARAMS = {
  'center.x': [-1, 1], 'center.y': [-1, 1], 'center.z': [-1, 1],
  'range.x': [0, 1], 'range.y': [0, 1], 'range.z': [0, 1],
  innerRadius: [0, 0.95], speedScale: [0.25, 4], glide: [0, 1], jumpChance: [0, 1],
  pathWobble: [0, 0.5], driftRate: [0.01, 10], driftDepth: [0, 1.5],
};
export const MASTER_AUTO_PARAMS = { speed: [0, 4] };
/** Crossfade (s) when an automation override is released and the object returns to its own settings. */
const AUTO_RELEASE_FADE = 0.3;
/** Crossfade (s) used when a live edit has to re-target instead of remap (shape change). */
const LIVE_FADE = 0.08;

export const EASINGS = {
  linear: (t) => t,
  inOut: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  smooth: (t) => t * t * t * (t * (6 * t - 15) + 10),
};

export const now = () => performance.now() / 1000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp1 = (v) => clamp(v, -1, 1);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const lerp3 = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
const copy3 = (p) => ({ x: p.x, y: p.y, z: p.z });
const TAU = Math.PI * 2;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toBool(v, def) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'off') return false;
  return def;
}

export function num(v, min, max, def) {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return def;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, min, max) : def;
}

const pickEnum = (v, list, def) => (list.includes(v) ? v : def);
const matchDiv = (v) => DIVISIONS.find((d) => Math.abs(d - Number(v)) < 1e-4);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

const fbm = (x) => clamp1(noise1(x) * 0.75 + noise1(x * 2.13 + 17.3) * 0.35);
const TANH_N = Math.tanh(1.6);
/** fbm rarely reaches its extremes; soft-expand so drift actually fills the region. */
const fbmN = (x) => Math.tanh(fbm(x) * 1.6) / TANH_N;

/** Concentric square→disc mapping (continuous, area-preserving). */
function squareToDisc(u, v) {
  if (u === 0 && v === 0) return [0, 0];
  let r;
  let phi;
  if (Math.abs(u) > Math.abs(v)) {
    r = u;
    phi = (Math.PI / 4) * (v / u);
  } else {
    r = v;
    phi = Math.PI / 2 - (Math.PI / 4) * (u / v);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return {
    x: clamp1(f(p0.x, p1.x, p2.x, p3.x)),
    y: clamp1(f(p0.y, p1.y, p2.y, p3.y)),
    z: clamp1(f(p0.z, p1.z, p2.z, p3.z)),
  };
}

export function defaultObject(id) {
  return {
    id,
    enabled: false,
    name: `Obj ${id}`,
    sourceId: id,
    mode: 'glide',
    center: { x: 0, y: 0, z: 0 },
    range: { x: 0.6, y: 0.6, z: 0 },
    rangeShape: 'box',
    innerRadius: 0.5,
    timing: { sync: 'free', min: 1, max: 3, divisions: [1, 2], tempoMode: 'grid', phaseOffset: 0 },
    glide: 1,
    easing: 'inOut',
    jumpChance: 0,
    jumpSlew: 20,
    restChance: 0,
    minStep: 0.3,
    pathPoints: 4,
    pathRegen: true,
    pathOrder: 'loop',
    pathCurve: 'linear',
    pathSource: 'random',
    pathPts: [],
    pathTiming: 'step',
    pathJitter: 0,
    pathWobble: 0,
    pathStart: 0,
    driftRate: 0.25,
    driftDepth: 1,
    orbitDir: 'cw',
    speedScale: 1,
    seed: 0,
  };
}

/** Drawn waypoints: [dx, dy, dz] offsets from the object center (so moving the center moves the whole path). */
export function sanitizePathPts(list) {
  const out = [];
  for (const p of list) {
    if (out.length >= MAX_PATH_PTS) break;
    const v = Array.isArray(p) ? p : isPlainObject(p) ? [p.x, p.y, p.z] : null;
    if (!v) continue;
    const x = num(v[0], -2, 2, null);
    const y = num(v[1], -2, 2, null);
    if (x === null || y === null) continue;
    const z = num(v[2], -2, 2, 0);
    const q = (n) => Math.round(n * 10000) / 10000;
    out.push([q(x), q(y), q(z)]);
  }
  return out;
}

/** Every invalid field falls back to `base` (the previous value when editing). */
export function sanitizeObject(o, id, base = defaultObject(id)) {
  const src = isPlainObject(o) ? o : {};
  const c = isPlainObject(src.center) ? src.center : {};
  const r = isPlainObject(src.range) ? src.range : {};
  const t = isPlainObject(src.timing) ? src.timing : {};
  const bt = base.timing;
  const min = num(t.min, 0.05, 60, bt.min);
  const max = Math.max(min, num(t.max, 0.05, 60, bt.max));
  let divisions = bt.divisions;
  if (Array.isArray(t.divisions)) {
    const d = [...new Set(t.divisions.map(matchDiv).filter((v) => v !== undefined))].sort((a, b) => a - b);
    if (d.length) divisions = d;
  }
  const name = typeof src.name === 'string' || typeof src.name === 'number'
    ? String(src.name).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 32)
    : base.name;
  return {
    id,
    enabled: toBool(src.enabled, base.enabled),
    name,
    sourceId: Math.round(num(src.sourceId, 1, 999, base.sourceId)),
    mode: pickEnum(src.mode, MODES, base.mode),
    center: { x: num(c.x, -1, 1, base.center.x), y: num(c.y, -1, 1, base.center.y), z: num(c.z, -1, 1, base.center.z) },
    range: { x: num(r.x, 0, 1, base.range.x), y: num(r.y, 0, 1, base.range.y), z: num(r.z, 0, 1, base.range.z) },
    rangeShape: pickEnum(src.rangeShape, RANGE_SHAPES, base.rangeShape),
    innerRadius: num(src.innerRadius, 0, 0.95, base.innerRadius),
    timing: {
      sync: pickEnum(t.sync, ['free', 'tempo'], bt.sync),
      min,
      max,
      divisions,
      tempoMode: pickEnum(t.tempoMode, TEMPO_MODES, bt.tempoMode),
      phaseOffset: num(t.phaseOffset, 0, 1, bt.phaseOffset),
    },
    glide: num(src.glide, 0, 1, base.glide),
    easing: typeof src.easing === 'string' && Object.hasOwn(EASINGS, src.easing) ? src.easing : base.easing,
    jumpChance: num(src.jumpChance, 0, 1, base.jumpChance),
    jumpSlew: num(src.jumpSlew, 0, 2000, base.jumpSlew),
    restChance: num(src.restChance, 0, 1, base.restChance),
    minStep: num(src.minStep, 0, 1, base.minStep),
    pathPoints: Math.round(num(src.pathPoints, 2, 16, base.pathPoints)),
    pathRegen: toBool(src.pathRegen, base.pathRegen),
    pathOrder: pickEnum(src.pathOrder, PATH_ORDERS, base.pathOrder),
    pathCurve: pickEnum(src.pathCurve, PATH_CURVES, base.pathCurve),
    pathSource: pickEnum(src.pathSource, PATH_SOURCES, base.pathSource),
    pathPts: Array.isArray(src.pathPts) ? sanitizePathPts(src.pathPts) : (base.pathPts ?? []).map((p) => [...p]),
    pathTiming: pickEnum(src.pathTiming, PATH_TIMINGS, base.pathTiming),
    pathJitter: num(src.pathJitter, 0, 0.5, base.pathJitter),
    pathWobble: num(src.pathWobble, 0, 0.5, base.pathWobble),
    pathStart: num(src.pathStart, 0, 1, base.pathStart),
    driftRate: num(src.driftRate, 0.01, 10, base.driftRate),
    driftDepth: num(src.driftDepth, 0, 1.5, base.driftDepth),
    orbitDir: pickEnum(src.orbitDir, ORBIT_DIRS, base.orbitDir),
    speedScale: num(src.speedScale, 0.25, 4, base.speedScale),
    seed: Math.round(num(src.seed, 0, 999999, base.seed)),
  };
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(target, patch) {
  const out = { ...target };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (BLOCKED_KEYS.has(k)) continue;
    out[k] = isPlainObject(v) && isPlainObject(target?.[k]) ? deepMerge(target[k], v) : v;
  }
  return out;
}

const isTempo = (o) => o.timing.sync === 'tempo';
const usesSteps = (o) => o.mode === 'jitter' || o.mode === 'glide' || o.mode === 'path';
export const usesDrawnPath = (o) => o.mode === 'path' && o.pathSource === 'custom' && o.pathPts.length >= 2;
const samePts = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1] && p[2] === b[i][2]);
const makeRng = (o) => (o.seed ? mulberry32(o.seed) : Math.random);

export class Engine {
  constructor() {
    this.objects = Array.from({ length: MAX_OBJECTS }, (_, i) => defaultObject(i + 1));
    for (let i = 0; i < 4; i++) {
      this.objects[i] = sanitizeObject({
        enabled: true,
        rangeShape: 'ring',
        innerRadius: 0.45,
        range: { x: 0.85, y: 0.85, z: 0.15 },
        timing: { sync: 'free', min: 2, max: 5 },
      }, i + 1);
    }
    this.master = {
      running: false,
      speed: 1,
      speedTarget: 1,
      transition: 1.5,
      tempoMult: 1,
      frozen: false,
      stopMode: 'freeze',
      disableMode: 'release',
      maxVelocity: 0,
      vmaxExceptJumps: true,
      reseedOnStart: false,
      livePreview: true,
    };
    this.speedRate = 0;
    this.jumpBits = 0;
    this.clock = { bpm: 120, origin: now() };
    this.taps = [];
    this.lastT = now();
    this.lastB = this.beatAt(this.lastT);
    /** Shortest allowed orbit period (s); set from the output rate so orbits never alias. */
    this.minPeriod = 0.1;
    this.rt = this.objects.map((o) => this.makeRuntime(o));
    /** Automation layer: per-object param → value overrides that never touch the stored config. */
    this.auto = Array.from({ length: MAX_OBJECTS }, () => null);
    this.autoEff = Array.from({ length: MAX_OBJECTS }, () => null);
    this.autoPos = Array.from({ length: MAX_OBJECTS }, () => null);
    this.autoMaster = {};
  }

  // ---------- automation overrides ----------
  /** Config the motion actually uses: stored settings with automation values on top. */
  effective(i) {
    const base = this.objects[i];
    const vals = this.auto[i];
    if (!vals || !base) return base;
    const c = this.autoEff[i];
    if (c && c.base === base) return c.o;
    const o = { ...base, center: { ...base.center }, range: { ...base.range } };
    for (const [k, v] of Object.entries(vals)) {
      const dot = k.indexOf('.');
      if (dot > 0) o[k.slice(0, dot)][k.slice(dot + 1)] = v;
      else o[k] = v;
    }
    this.autoEff[i] = { base, o };
    return o;
  }

  /**
   * value null = release (the object glides back to its own settings). Returns false for an invalid param/value.
   * `pos` takes [x, y, z] and sets the output position directly (max velocity still applies).
   */
  setAutomation(id, param, value, t = now()) {
    const i = id - 1;
    const r = this.rt[i];
    if (!this.objects[i]) return false;
    if (param === 'pos') {
      if (value === null || value === undefined) {
        if (this.autoPos[i]) {
          this.autoPos[i] = null;
          this.startXf(r, AUTO_RELEASE_FADE, t);
        }
        return true;
      }
      if (!Array.isArray(value)) return false;
      const p = { x: num(value[0], -1, 1, null), y: num(value[1], -1, 1, null), z: num(value[2], -1, 1, 0) };
      if (p.x === null || p.y === null) return false;
      this.autoPos[i] = p;
      return true;
    }
    const lim = AUTO_PARAMS[param];
    if (!lim) return false;
    const prev = this.effective(i);
    const vals = { ...(this.auto[i] ?? {}) };
    const release = value === null || value === undefined;
    if (release) {
      if (!(param in vals)) return true;
      delete vals[param];
    } else {
      const n = num(value, lim[0], lim[1], null);
      if (n === null) return false;
      if (vals[param] === n) return true;
      vals[param] = n;
    }
    this.auto[i] = Object.keys(vals).length ? vals : null;
    this.autoEff[i] = null;
    this.onAutoChange(prev, this.effective(i), r, t, release);
    return true;
  }

  setMasterAutomation(param, value) {
    const lim = MASTER_AUTO_PARAMS[param];
    if (!lim) return false;
    if (value === null || value === undefined) {
      delete this.autoMaster[param];
      return true;
    }
    const n = num(value, lim[0], lim[1], null);
    if (n === null) return false;
    this.autoMaster[param] = n;
    return true;
  }

  /** Releases every override (ids null = all objects, plus master). */
  clearAutomation(ids = null, t = now()) {
    for (let i = 0; i < MAX_OBJECTS; i++) {
      if (ids && !ids.includes(i + 1)) continue;
      this.setAutomation(i + 1, 'pos', null, t);
      for (const k of Object.keys(this.auto[i] ?? {})) this.setAutomation(i + 1, k, null, t);
    }
    if (!ids) this.autoMaster = {};
  }

  hasAutomation() {
    return this.auto.some(Boolean) || this.autoPos.some(Boolean) || Object.keys(this.autoMaster).length > 0;
  }

  /** Automation moves the region every frame, so the motion is carried along instead of re-targeted. */
  onAutoChange(prev, next, r, t, release) {
    if (!next.enabled) return;
    const regionChanged = prev.center.x !== next.center.x || prev.center.y !== next.center.y || prev.center.z !== next.center.z
      || prev.range.x !== next.range.x || prev.range.y !== next.range.y || prev.range.z !== next.range.z
      || prev.innerRadius !== next.innerRadius;
    if (regionChanged) {
      if (this.rtRunning(r)) {
        this.remapRegion(prev, next, r);
      } else {
        r.gen = copy3(next.center);
        r.from = copy3(next.center);
        r.to = copy3(next.center);
      }
      if (release) this.startXf(r, AUTO_RELEASE_FADE, t);
    }
    if (isTempo(next) && prev.speedScale !== next.speedScale) r.retime = true;
  }

  makeRuntime(o) {
    const c = copy3(o.center);
    const rng = makeRng(o);
    return {
      pos: copy3(c), gen: copy3(c), from: copy3(c), to: copy3(c), prevFrom: copy3(c), peek: null,
      tau: 0, tStart: 0, tEnd: 0, tNext: 0,
      pending: true, retime: false, recall: null, jumpFrame: false,
      wps: [], queue: [], filled: false, lastIdx: -1, toIdx: -1, peekIdx: -1, resumeIdx: null, rot: 0, seg: null,
      phase: rng() * 1000,
      zPhase: rng() * 1000,
      orb: { angle: rng() * TAU, period: 0, left: 0, dir: rng() < 0.5 ? 1 : -1, cycle: null, base: 0 },
      xf: null, slew: null, fadeOutUntil: 0, evt: false, touchedAt: -Infinity,
      paused: false, solo: false,
      rng,
    };
  }

  // ---------- tempo ----------
  beatAt(t) {
    return ((t - this.clock.origin) * this.clock.bpm) / 60;
  }

  timeAtBeat(b) {
    return this.clock.origin + (b * 60) / this.clock.bpm;
  }

  setBpm(bpm, t = now()) {
    const nb = num(bpm, 20, 300, null);
    if (nb === null) return false;
    const beat = this.beatAt(t);
    this.clock.bpm = nb;
    this.clock.origin = t - (beat * 60) / nb;
    return true;
  }

  retimeTempoObjects() {
    for (let i = 0; i < MAX_OBJECTS; i++) {
      if (isTempo(this.objects[i])) this.rt[i].retime = true;
    }
  }

  /** Current moment becomes beat 0. Running motions are re-aimed at the new grid, never jumped. */
  resync(t = now()) {
    this.clock.origin = t;
    this.lastB = 0;
    this.retimeTempoObjects();
  }

  tap(t = now()) {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && t - last < 0.06) return this.clock.bpm;
    if (last !== undefined && t - last > Math.max(2.5, 1.5 * (60 / this.clock.bpm))) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > 9) this.taps.shift();
    if (this.taps.length >= 2) {
      const iv = [];
      for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
      const sorted = [...iv].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const good = iv.filter((x) => Math.abs(x - med) <= 0.35 * med);
      const avg = good.reduce((a, b) => a + b, 0) / good.length;
      this.setBpm(clamp(60 / avg, 20, 300), t);
      const b = this.beatAt(t);
      this.clock.origin = t - (Math.round(b) * 60) / this.clock.bpm;
      this.lastB = this.beatAt(t);
      this.retimeTempoObjects();
    }
    return this.clock.bpm;
  }

  setTempoMult(v) {
    const m = TEMPO_MULTS.find((x) => Math.abs(x - Number(v)) < 1e-6);
    if (m === undefined || m === this.master.tempoMult) return false;
    this.master.tempoMult = m;
    this.retimeTempoObjects();
    return true;
  }

  divEff(o, d) {
    return d / (this.master.tempoMult * o.speedScale);
  }

  // ---------- transport ----------
  startXf(r, dur, t = this.lastT, ease = 'inOut', delay = 0) {
    r.xf = dur > 0 || delay > 0
      ? { from: copy3(r.pos), t0: t + delay, dur: Math.max(dur, 1e-3), ease: Object.hasOwn(EASINGS, ease) ? ease : 'inOut' }
      : null;
  }

  setRunning(running, t = now()) {
    const run = toBool(running, null);
    if (run === null) return false;
    const was = this.master.running;
    this.master.running = run;
    const soloBefore = this.rt.map((r) => r.solo);
    // The global transport overrides every per-object state.
    for (const r of this.rt) {
      r.paused = false;
      r.solo = false;
    }
    if (!was && run) {
      this.lastT = t;
      this.lastB = this.beatAt(t);
      for (let i = 0; i < MAX_OBJECTS; i++) {
        if (soloBefore[i]) continue;
        const o = this.objects[i];
        const r = this.rt[i];
        if (this.master.reseedOnStart && o.seed) this.reseed(o, r);
        r.gen = copy3(r.pos);
        r.from = copy3(r.pos);
        r.to = copy3(r.pos);
        r.slew = null;
        r.pending = true;
        r.retime = false;
        if (o.enabled && !usesSteps(o)) this.startXf(r, this.master.transition, t);
      }
    } else if (was && !run && this.master.stopMode === 'center') {
      for (let i = 0; i < MAX_OBJECTS; i++) {
        const o = this.effective(i);
        const r = this.rt[i];
        r.gen = copy3(o.center);
        r.slew = null;
        if (o.enabled) this.startXf(r, this.master.transition, t);
      }
    }
    return true;
  }

  rtRunning(r) {
    return this.master.running ? !r.paused : r.solo;
  }

  /** Effective per-object transport: global running minus paused objects, plus solo objects while stopped. */
  isObjectRunning(i) {
    return this.rtRunning(this.rt[i]);
  }

  /** Bit i set = object i+1 is enabled and moving. */
  runMask() {
    let m = 0;
    for (let i = 0; i < MAX_OBJECTS; i++) if (this.objects[i].enabled && this.rtRunning(this.rt[i])) m |= 1 << i;
    return m >>> 0;
  }

  /** Per-object play/pause; pausing holds the current position, playing resumes like START does. Returns changed ids. */
  setObjectsRunning(ids, play, t = now()) {
    const on = toBool(play, null);
    if (on === null) return [];
    const changed = [];
    for (const id of ids) {
      const i = id - 1;
      const o = this.objects[i];
      const r = this.rt[i];
      if (!o || this.rtRunning(r) === on) continue;
      if (this.master.running) r.paused = !on;
      else r.solo = on;
      if (on) {
        r.gen = copy3(r.pos);
        r.from = copy3(r.pos);
        r.to = copy3(r.pos);
        r.slew = null;
        r.xf = null;
        r.pending = true;
        r.retime = false;
        if (o.enabled && !usesSteps(o)) this.startXf(r, this.master.transition, t);
      } else {
        r.gen = copy3(r.pos);
        r.slew = null;
        r.xf = null;
      }
      changed.push(id);
    }
    return changed;
  }

  reseed(o, r, offset = 0) {
    r.rng = mulberry32(o.seed + offset * 7919);
    r.phase = r.rng() * 1000;
    r.zPhase = r.rng() * 1000;
    r.wps = [];
    r.queue = [];
    r.filled = false;
    r.resumeIdx = null;
  }

  setSpeed(speed, ramp = 0) {
    const n = num(speed, 0, 4, null);
    if (n === null) return false;
    const rs = num(ramp, 0, 60, 0);
    this.master.speedTarget = n;
    if (rs > 0) this.speedRate = Math.abs(n - this.master.speed) / rs;
    else this.master.speed = n;
    return true;
  }

  setFrozen(frozen, t = now()) {
    const f = toBool(frozen, null);
    if (f === null || f === this.master.frozen) return false;
    this.master.frozen = f;
    if (f) {
      this.frozenAt = t;
    } else {
      this.lastB = this.beatAt(t);
      const held = t - (this.frozenAt ?? t);
      for (let i = 0; i < MAX_OBJECTS; i++) {
        const r = this.rt[i];
        if (r.xf) r.xf.t0 += held;
        if (r.slew) r.slew.t0 += held;
        const o = this.objects[i];
        if (isTempo(o) && (usesSteps(o) || o.mode === 'orbit')) {
          r.gen = copy3(r.pos);
          r.pending = true;
          r.xf = null;
        }
      }
    }
    return true;
  }

  /** Applies validated master settings; unknown/invalid values are ignored. */
  applyMaster(m, t = now()) {
    if (!isPlainObject(m)) return;
    if ('running' in m) this.setRunning(m.running, t);
    if ('speed' in m) this.setSpeed(m.speed, m.speedRamp);
    if ('transition' in m) this.master.transition = num(m.transition, 0, 30, this.master.transition);
    if ('tempoMult' in m) this.setTempoMult(m.tempoMult);
    if ('frozen' in m) this.setFrozen(m.frozen, t);
    if ('stopMode' in m) this.master.stopMode = pickEnum(m.stopMode, STOP_MODES, this.master.stopMode);
    if ('disableMode' in m) this.master.disableMode = pickEnum(m.disableMode, DISABLE_MODES, this.master.disableMode);
    if ('maxVelocity' in m) this.master.maxVelocity = num(m.maxVelocity, 0, 20, this.master.maxVelocity);
    if ('vmaxExceptJumps' in m) this.master.vmaxExceptJumps = toBool(m.vmaxExceptJumps, this.master.vmaxExceptJumps);
    if ('reseedOnStart' in m) this.master.reseedOnStart = toBool(m.reseedOnStart, this.master.reseedOnStart);
    if ('livePreview' in m) this.master.livePreview = toBool(m.livePreview, this.master.livePreview);
  }

  settings() {
    const { transition, tempoMult, stopMode, disableMode, maxVelocity, vmaxExceptJumps, reseedOnStart, livePreview } = this.master;
    return { transition, tempoMult, stopMode, disableMode, maxVelocity, vmaxExceptJumps, reseedOnStart, livePreview };
  }

  /** Objects edited interactively within `hold` seconds (live preview keeps sending them while stopped/released). */
  isLiveTouched(i, t, hold = 1) {
    return this.master.livePreview && t - this.rt[i].touchedAt < hold;
  }

  // ---------- config ----------
  updateObjects(ids, patch, t = now()) {
    for (const id of ids) this.updateObject(id, patch, t);
  }

  updateObject(id, patch, t = now()) {
    const i = id - 1;
    const prev = this.objects[i];
    if (!prev || !isPlainObject(patch)) return;
    const merged = deepMerge(prev, patch);
    const pt = isPlainObject(patch.timing) ? patch.timing : null;
    if (pt && isPlainObject(merged.timing)) {
      const mn = num(merged.timing.min, 0.05, 60, prev.timing.min);
      const mx = num(merged.timing.max, 0.05, 60, prev.timing.max);
      if ('min' in pt && !('max' in pt) && mn > mx) merged.timing = { ...merged.timing, max: mn };
      if ('max' in pt && !('min' in pt) && mx < mn) merged.timing = { ...merged.timing, min: mx };
    }
    const next = sanitizeObject(merged, id, prev);
    const prevE = this.effective(i);
    this.objects[i] = next;
    this.onConfigChange(prevE, this.effective(i), this.rt[i], t);
  }

  nudgeCenters(ids, dx, dy, dz = 0, t = now()) {
    for (const id of ids) {
      const o = this.objects[id - 1];
      if (!o) continue;
      this.updateObject(id, {
        center: { x: clamp1(o.center.x + dx), y: clamp1(o.center.y + dy), z: clamp1(o.center.z + dz) },
      }, t);
    }
  }

  /** fade === undefined means an interactive edit; a number means preset/undo load with that crossfade. */
  onConfigChange(prev, next, r, t, fade) {
    const running = this.rtRunning(r);
    const tr = fade ?? this.master.transition;
    const centerChanged = prev.center.x !== next.center.x || prev.center.y !== next.center.y || prev.center.z !== next.center.z;
    const regionChanged = centerChanged
      || prev.range.x !== next.range.x || prev.range.y !== next.range.y || prev.range.z !== next.range.z
      || prev.rangeShape !== next.rangeShape || prev.innerRadius !== next.innerRadius;

    const shapeChanged = prev.rangeShape !== next.rangeShape || prev.innerRadius !== next.innerRadius;
    const live = fade === undefined && this.master.livePreview && prev.enabled && next.enabled;
    if (live) {
      r.touchedAt = t;
      r.evt = true;
    }
    // Live: the in-flight motion is carried into the edited region now instead of at the next step.
    const remapped = live && running && regionChanged && !shapeChanged && prev.mode === next.mode;
    if (remapped) {
      this.remapRegion(prev, next, r);
      r.jumpFrame = true;
    }

    if (prev.seed !== next.seed) this.reseed(next, r);
    const ptsChanged = !samePts(prev.pathPts, next.pathPts);
    const drawnChanged = ptsChanged || prev.pathSource !== next.pathSource || prev.pathJitter !== next.pathJitter
      || prev.pathStart !== next.pathStart || prev.pathTiming !== next.pathTiming;
    if ((regionChanged && !remapped) || prev.pathPoints !== next.pathPoints || prev.pathOrder !== next.pathOrder || drawnChanged) {
      // Running drawn path: continue after the waypoint currently being approached instead of restarting the lap.
      const keepPlace = running && usesDrawnPath(prev) && usesDrawnPath(next) && prev.pathOrder === next.pathOrder
        && prev.pathStart === next.pathStart && r.toIdx >= 0;
      r.resumeIdx = keepPlace ? r.toIdx : null;
      r.wps = [];
      r.queue = [];
      r.filled = false;
      if (keepPlace && ptsChanged && prev.pathPts.length === next.pathPts.length && next.enabled) {
        // Same point count (a point was dragged): re-aim the segment in flight so the edit is heard immediately,
        // continuing from where the source is now so there is no jump.
        const at = (k) => this.drawnPoint(next, k);
        const u = isTempo(next) ? this.beatAt(t) : r.tau;
        if (r.toIdx < next.pathPts.length) {
          const target = at(r.toIdx);
          const moved = dist3(target, r.to) > 1e-9;
          if (moved && r.tEnd > u) {
            r.from = copy3(r.gen);
            r.tStart = u;
          } else if (moved) {
            this.startXf(r, LIVE_FADE, t);
          }
          r.to = target;
        }
        if (r.peek && r.peekIdx >= 0 && r.peekIdx < next.pathPts.length) r.peek = at(r.peekIdx);
      }
    }
    if (prev.timing.sync !== next.timing.sync) {
      r.pending = true;
      r.orb.cycle = null;
      r.orb.left = 0;
    } else if (isTempo(next) && (prev.timing.phaseOffset !== next.timing.phaseOffset || prev.speedScale !== next.speedScale
      || prev.timing.tempoMode !== next.timing.tempoMode || String(prev.timing.divisions) !== String(next.timing.divisions))) {
      r.retime = true;
    }

    if (!prev.enabled && next.enabled) {
      r.fadeOutUntil = 0;
      r.pos = copy3(next.center);
      r.gen = copy3(next.center);
      r.from = copy3(next.center);
      r.to = copy3(next.center);
      r.slew = null;
      r.xf = null;
      r.pending = true;
      if (running && !usesSteps(next)) this.startXf(r, tr, t);
      return;
    }
    if (prev.enabled && !next.enabled) {
      if (this.master.disableMode === 'center') {
        r.gen = copy3(next.center);
        this.startXf(r, tr, t);
        r.fadeOutUntil = t + tr + 0.15;
      }
      return;
    }
    if (!next.enabled) {
      if (regionChanged) {
        r.pos = copy3(next.center);
        r.gen = copy3(next.center);
      }
      return;
    }
    if (prev.mode !== next.mode) {
      r.pending = true;
      r.slew = null;
      this.startXf(r, tr, t);
    } else if (live && running && shapeChanged && usesSteps(next)) {
      r.pending = true;
      r.recall = 'scene';
      r.slew = null;
      this.startXf(r, LIVE_FADE, t);
    }
    if (!running && centerChanged) {
      // Stopped: moving the center moves the source, so the operator can set a "home" position.
      r.gen = copy3(next.center);
      r.from = copy3(next.center);
      r.to = copy3(next.center);
      if (fade === undefined) {
        r.pos = copy3(next.center);
        r.xf = null;
      } else {
        this.startXf(r, tr, t);
      }
    }
  }

  /** Maps every runtime point from the old region into the new one, keeping its relative position. */
  remapRegion(prev, next, r) {
    // A drawn path is not scaled by the range, only carried along with the center.
    const rigid = usesDrawnPath(prev) && usesDrawnPath(next);
    const axis = (k) => {
      const a = prev.range[k];
      const s = !rigid && a > 1e-4 ? next.range[k] / a : 1;
      return (v) => clamp1(next.center[k] + (v - prev.center[k]) * s);
    };
    const fx = axis('x');
    const fy = axis('y');
    const fz = axis('z');
    const seen = new Set();
    const map = (p) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      p.x = fx(p.x);
      p.y = fy(p.y);
      p.z = fz(p.z);
    };
    for (const p of [r.gen, r.from, r.to, r.prevFrom, r.peek, r.slew?.from, r.xf?.from]) map(p);
    for (const p of r.wps) map(p);
    for (const q of r.queue) map(q.p);
  }

  /** Step modes then hold the center until their next scheduled step, so "home" visibly lands. */
  home(ids, fade = this.master.transition, t = now(), { ease = 'inOut', delays = null } = {}) {
    const dur = num(fade, 0, 60, this.master.transition);
    for (const id of ids) {
      const o = this.effective(id - 1);
      const r = this.rt[id - 1];
      if (!o) continue;
      r.gen = copy3(o.center);
      r.from = copy3(o.center);
      r.to = copy3(o.center);
      r.slew = null;
      r.pending = true;
      r.recall = 'home';
      r.wps = [];
      r.queue = [];
      r.filled = false;
      r.resumeIdx = null;
      if (o.enabled) this.startXf(r, dur, t, ease, delays?.get(id) ?? 0);
      else r.pos = copy3(o.center);
    }
  }

  /** Per-object xf start delays (s) spreading `stagger` over the ids in the requested order. */
  staggerDelays(ids, stagger, order = 'id') {
    const out = new Map();
    const s = num(stagger, 0, 10, 0);
    if (!s || ids.length < 2) return out;
    let list = [...ids].sort((a, b) => a - b);
    if (order === 'random') {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    } else if (order === 'distance') {
      const d = (id) => Math.hypot(this.rt[id - 1].pos.x, this.rt[id - 1].pos.y);
      list = list.sort((a, b) => d(a) - d(b) || a - b);
    }
    list.forEach((id, k) => out.set(id, (k / (list.length - 1)) * s));
    return out;
  }

  getScene(ids = null) {
    const set = ids ? new Set(ids) : null;
    return {
      objects: this.objects.filter((o) => !set || set.has(o.id)).map((o) => structuredClone(o)),
      bpm: this.clock.bpm,
      speed: this.master.speedTarget,
      tempoMult: this.master.tempoMult,
    };
  }

  /**
   * Entries with an `id` are matched by id only (sparse/partial presets); legacy id-less arrays by index.
   * onlyIds: null = every object in the scene, array = restrict to these ids.
   * Running step-mode objects jump their generator straight into the new region (r.recall);
   * the output crossfade is the only visible transition, so the region is reached within fade + 1 frame.
   * globals: 'preset' applies scene bpm/speed/tempoMult (full loads only), 'keep' leaves them alone.
   */
  loadScene(scene, { onlyIds = null, fade = null, t = now(), seedOffset = 0, ease = 'inOut', stagger = 0, order = 'id', globals = 'preset' } = {}) {
    const list = Array.isArray(scene?.objects) ? scene.objects.filter(isPlainObject) : [];
    const hasIds = list.some((o) => o.id !== undefined);
    const byId = new Map();
    if (hasIds) {
      for (const o of list) {
        const id = Number(o.id);
        if (Number.isInteger(id) && id >= 1 && id <= MAX_OBJECTS && !byId.has(id)) byId.set(id, o);
      }
    }
    const only = onlyIds ? new Set(onlyIds) : null;
    const dur = num(fade, 0, 60, this.master.transition);
    const offset = Math.round(num(seedOffset, 0, 999, 0));
    const picked = [];
    for (let i = 0; i < MAX_OBJECTS; i++) {
      const id = i + 1;
      if (only && !only.has(id)) continue;
      const src = hasIds ? byId.get(id) : list[i];
      if (src) picked.push([id, src]);
    }
    const delays = this.staggerDelays(picked.filter(([id]) => this.objects[id - 1].enabled).map(([id]) => id), stagger, order);
    for (const [id, src] of picked) {
      const i = id - 1;
      const prev = this.effective(i);
      const r = this.rt[i];
      this.objects[i] = sanitizeObject({ ...src, id }, id);
      const next = this.effective(i);
      this.onConfigChange(prev, next, r, t, dur);
      r.pending = true;
      r.recall = null;
      r.wps = [];
      r.queue = [];
      r.filled = false;
      r.resumeIdx = null;
      if (next.seed) this.reseed(next, r, offset);
      if (prev.enabled && next.enabled) {
        if (!this.rtRunning(r)) r.gen = copy3(next.center);
        else if (usesSteps(next)) r.recall = 'scene';
        this.startXf(r, dur, t, ease, delays.get(id) ?? 0);
      }
    }
    if (!only && globals === 'preset') {
      if (scene?.bpm !== undefined) this.setBpm(scene.bpm, t);
      if (scene?.speed !== undefined) this.setSpeed(scene.speed, dur);
      if (scene?.tempoMult !== undefined) this.setTempoMult(scene.tempoMult);
    }
    return picked.length;
  }

  // ---------- motion ----------
  randIn(r, c, half) {
    const lo = Math.max(-1, c - half);
    const hi = Math.min(1, c + half);
    return lo + r.rng() * Math.max(0, hi - lo);
  }

  randomPoint(o, r, from) {
    const { center: c, range: R } = o;
    const gen = () => {
      let x;
      let y;
      if (o.rangeShape === 'box') {
        x = this.randIn(r, c.x, R.x);
        y = this.randIn(r, c.y, R.y);
      } else {
        const inner = o.rangeShape === 'ring' ? o.innerRadius : 0;
        for (let k = 0; k < 8; k++) {
          const a = r.rng() * TAU;
          const rr = Math.sqrt(inner * inner + r.rng() * (1 - inner * inner));
          x = c.x + R.x * rr * Math.cos(a);
          y = c.y + R.y * rr * Math.sin(a);
          if (Math.abs(x) <= 1 && Math.abs(y) <= 1) break;
        }
        x = clamp1(x);
        y = clamp1(y);
      }
      return { x, y, z: this.randIn(r, c.z, R.z) };
    };
    const need = o.minStep * Math.hypot(R.x, R.y, R.z);
    let best = gen();
    let bestD = dist3(best, from);
    for (let i = 0; i < 16 && bestD < need; i++) {
      const p = gen();
      const d = dist3(p, from);
      if (d > bestD) { best = p; bestD = d; }
    }
    return best;
  }

  gridNext(u, d, phase) {
    const ph = phase * d;
    return (Math.floor((u - ph) / d + 1e-6) + 1) * d + ph;
  }

  /**
   * Schedules the next step in the object's clock unit (motion time τ for free, beats for tempo).
   * base = the time the triggering step was due (null when (re)starting).
   */
  schedule(o, r, u, base, span = null) {
    let next;
    if (span !== null) {
      next = (base ?? u) + span;
      if (next <= u) next = u + span;
    } else if (isTempo(o)) {
      const divs = o.timing.divisions;
      const d = this.divEff(o, divs[Math.floor(r.rng() * divs.length)]);
      if (base !== null && o.timing.tempoMode === 'length') next = base + d;
      if (next === undefined || next <= u) {
        next = this.gridNext(u, d, o.timing.phaseOffset);
        if (base === null && next - u < Math.min(0.5, d / 2)) next += d;
      }
    } else {
      const span = o.timing.min + r.rng() * (o.timing.max - o.timing.min);
      next = (base ?? u) + span;
      if (next <= u) next = u + span;
    }
    r.tNext = next;
    return next;
  }

  /** Absolute position of drawn waypoint k (center + offset). */
  drawnPoint(o, k, scatter = 0, r = null) {
    const p = o.pathPts[k];
    let x = o.center.x + p[0];
    let y = o.center.y + p[1];
    if (scatter > 0 && r) {
      const a = r.rng() * TAU;
      const d = scatter * Math.sqrt(r.rng());
      x += d * Math.cos(a);
      y += d * Math.sin(a);
    }
    return { x: clamp1(x), y: clamp1(y), z: clamp1(o.center.z + p[2]) };
  }

  fillQueue(o, r) {
    const drawn = usesDrawnPath(o);
    while (r.queue.length < 2) {
      if (drawn) {
        if (!r.wps.length || (o.pathJitter > 0 && r.filled)) {
          r.wps = o.pathPts.map((_, k) => this.drawnPoint(o, k, o.pathJitter, r));
        }
      } else if (!r.wps.length || (o.pathRegen && r.filled)) {
        r.wps = [];
        let prev = r.gen;
        for (let i = 0; i < o.pathPoints; i++) {
          prev = this.randomPoint(o, r, prev);
          r.wps.push(prev);
        }
      }
      const first = !r.filled;
      r.filled = true;
      const n = r.wps.length;
      let order = [...Array(n).keys()];
      if (o.pathOrder === 'pingpong') {
        order = [...order, ...order.slice(1, -1).reverse()];
      } else if (o.pathOrder === 'shuffle') {
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(r.rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        if (n > 1 && order[0] === r.lastIdx) [order[0], order[n - 1]] = [order[n - 1], order[0]];
      }
      if (drawn && o.pathOrder !== 'shuffle') {
        // Every lap uses the same rotation, so loop/ping-pong stay continuous; only the entry point moves.
        if (first) {
          r.rot = Math.floor(o.pathStart * order.length + 1e-6) % order.length;
          if (r.resumeIdx !== null) {
            const at = order.indexOf(r.resumeIdx);
            if (at >= 0) r.rot = (at + 1) % order.length;
          }
        }
        const s = (r.rot ?? 0) % order.length;
        order = [...order.slice(s), ...order.slice(0, s)];
      }
      r.resumeIdx = null;
      let lapLen = 0;
      for (let k = 0; k < order.length; k++) lapLen += dist3(r.wps[order[k]], r.wps[order[(k + 1) % order.length]]);
      const lap = drawn && o.pathTiming === 'even' ? this.lapSpan(o, r) : 0;
      for (const idx of order) r.queue.push({ p: r.wps[idx], idx, lap, lapLen, n: order.length });
      r.lastIdx = order[order.length - 1];
    }
  }

  /** Lap length for "even" timing: seconds of motion time (free) or beats (tempo). */
  lapSpan(o, r) {
    if (isTempo(o)) {
      const divs = o.timing.divisions;
      return this.divEff(o, divs[Math.floor(r.rng() * divs.length)]);
    }
    return o.timing.min + r.rng() * (o.timing.max - o.timing.min);
  }

  nextWaypoint(o, r) {
    this.fillQueue(o, r);
    const q = r.queue.shift();
    r.peek = r.queue[0]?.p ?? null;
    r.toIdx = q.idx;
    r.peekIdx = r.queue[0]?.idx ?? -1;
    r.seg = q;
    return copy3(q.p);
  }

  markJump(o, r) {
    r.jumpFrame = true;
    this.jumpBits |= 1 << (o.id - 1);
  }

  /** Bitmask of objects that made an intentional jump since the last call. */
  takeJumps() {
    const j = this.jumpBits;
    this.jumpBits = 0;
    return j >>> 0;
  }

  startSlew(o, r, t) {
    r.slew = o.jumpSlew > 0 ? { from: copy3(r.gen), t0: t, dur: o.jumpSlew / 1000 } : null;
  }

  angleFromGen(o, r) {
    return Math.atan2((r.gen.y - o.center.y) / Math.max(o.range.y, 1e-3), (r.gen.x - o.center.x) / Math.max(o.range.x, 1e-3));
  }

  step(o, r, t, dtau, b, db) {
    const tempo = isTempo(o);
    const u = tempo ? b : r.tau;
    let raw;

    if (r.retime) {
      r.retime = false;
      if (tempo && usesSteps(o) && !r.pending) {
        const divs = o.timing.divisions;
        const d = this.divEff(o, divs[Math.floor(r.rng() * divs.length)]);
        let nb = this.gridNext(u, d, o.timing.phaseOffset);
        if (nb - u < Math.min(0.5, d / 2)) nb += d;
        if (o.mode !== 'jitter' && r.tEnd > u) {
          r.from = copy3(r.gen);
          r.prevFrom = copy3(r.gen);
          r.tStart = u;
          r.tEnd = u + (nb - u) * Math.max(o.glide, 0.05);
        }
        r.tNext = nb;
      } else if (tempo && o.mode === 'orbit') {
        r.pending = true;
      }
    }

    switch (o.mode) {
      case 'hold':
        raw = copy3(o.center);
        r.pending = false;
        break;

      case 'jitter': {
        if (r.pending || u >= r.tNext) {
          const restart = r.pending;
          const base = restart ? null : r.tNext;
          r.pending = false;
          if (restart) {
            r.to = r.recall === 'scene' ? this.randomPoint(o, r, r.gen) : copy3(r.gen);
            r.recall = null;
          } else if (r.rng() >= o.restChance) {
            r.to = this.randomPoint(o, r, r.gen);
            this.startSlew(o, r, t);
            this.markJump(o, r);
            r.evt = true;
          }
          this.schedule(o, r, u, base);
        }
        raw = copy3(r.to);
        break;
      }

      case 'glide':
      case 'path': {
        if (r.pending || u >= r.tNext) {
          const restart = r.pending;
          const base = restart ? null : r.tNext;
          const recall = restart ? r.recall : null;
          r.pending = false;
          r.recall = null;
          r.prevFrom = restart ? copy3(r.gen) : r.from;
          r.from = copy3(r.gen);
          const rest = recall === 'home' || (!restart && r.rng() < o.restChance);
          if (rest) {
            r.to = copy3(r.gen);
            r.peek = null;
          } else {
            r.to = o.mode === 'path' ? this.nextWaypoint(o, r) : this.randomPoint(o, r, r.gen);
          }
          if (recall === 'scene') {
            r.from = copy3(r.to);
            r.prevFrom = copy3(r.to);
          }
          r.tStart = u;
          let span = null;
          if (o.mode === 'path' && o.pathTiming === 'even' && usesDrawnPath(o) && r.seg?.lap > 0) {
            // Even speed: each segment gets its share of the lap by length.
            const q = r.seg;
            const d = rest ? (q.lapLen / q.n) : dist3(r.from, r.to);
            const frac = q.lapLen > 1e-6 ? d / q.lapLen : 1 / q.n;
            span = Math.max(0.02, q.lap * Math.min(frac, 1));
          }
          const next = this.schedule(o, r, u, base, span);
          const jump = !rest && !restart && (o.glide <= 0 || r.rng() < o.jumpChance);
          if (jump || recall) {
            r.tEnd = r.tStart;
            if (jump) {
              this.startSlew(o, r, t);
              this.markJump(o, r);
            }
          } else {
            r.tEnd = r.tStart + (next - r.tStart) * o.glide;
          }
          if (!rest) r.evt = true;
        }
        const k = r.tEnd > r.tStart ? clamp((u - r.tStart) / (r.tEnd - r.tStart), 0, 1) : 1;
        const e = EASINGS[o.easing](k);
        raw = o.mode === 'path' && o.pathCurve === 'catmull'
          ? catmull(r.prevFrom, r.from, r.to, r.peek ?? r.to, e)
          : lerp3(r.from, r.to, e);
        if (o.mode === 'path' && o.pathWobble > 0) {
          r.phase += (tempo ? db * (60 / this.clock.bpm) * o.speedScale * this.master.tempoMult : dtau) * 0.8;
          const s = o.id * 31.7;
          raw = {
            x: clamp1(raw.x + o.pathWobble * fbm(r.phase + s)),
            y: clamp1(raw.y + o.pathWobble * fbm(r.phase + s + 517.3)),
            z: raw.z,
          };
        }
        break;
      }

      case 'drift': {
        r.pending = false;
        if (tempo) {
          const divs = o.timing.divisions;
          const avg = this.divEff(o, divs.reduce((a, v) => a + v, 0) / divs.length);
          r.phase += db / avg;
        } else {
          r.phase += dtau * o.driftRate;
        }
        const s = o.id * 101.3;
        const dep = o.driftDepth;
        const w = clamp1(fbmN(r.phase + s + 877.7) * dep);
        let sx;
        let sy;
        if (o.rangeShape === 'ring') {
          const a = fbm((r.phase + s) * 0.5) * TAU * 1.5;
          const rr = o.innerRadius + (1 - o.innerRadius) * clamp((fbmN(r.phase + s + 433.1) * dep + 1) / 2, 0, 1);
          sx = rr * Math.cos(a);
          sy = rr * Math.sin(a);
        } else {
          const nx = clamp1(fbmN(r.phase + s) * dep);
          const ny = clamp1(fbmN(r.phase + s + 433.1) * dep);
          [sx, sy] = o.rangeShape === 'ellipse' ? squareToDisc(nx, ny) : [nx, ny];
        }
        raw = {
          x: clamp1(o.center.x + o.range.x * sx),
          y: clamp1(o.center.y + o.range.y * sy),
          z: clamp1(o.center.z + o.range.z * w),
        };
        break;
      }

      case 'orbit': {
        const ob = r.orb;
        const sign = () => (o.orbitDir === 'cw' ? -1 : o.orbitDir === 'ccw' ? 1 : ob.dir);
        let angle;
        if (tempo) {
          let d = this.divEff(o, o.timing.divisions[o.timing.divisions.length - 1]);
          while ((d * 60) / this.clock.bpm < this.minPeriod) d *= 2;
          const ph = b / d + o.timing.phaseOffset;
          const cyc = Math.floor(ph);
          if (ob.cycle !== cyc) {
            if (o.orbitDir === 'random' && ob.cycle !== null) ob.dir = r.rng() < 0.5 ? 1 : -1;
            ob.cycle = cyc;
          }
          if (r.pending) {
            ob.base = this.angleFromGen(o, r) - sign() * TAU * (ph - cyc);
            r.pending = false;
          }
          angle = ob.base + sign() * TAU * (ph - cyc);
        } else {
          if (r.pending) {
            ob.angle = this.angleFromGen(o, r);
            ob.left = 0;
            r.pending = false;
          }
          if (ob.left <= 0) {
            ob.period = Math.max(this.minPeriod, o.timing.min + r.rng() * (o.timing.max - o.timing.min));
            ob.left = 1;
            if (o.orbitDir === 'random') ob.dir = r.rng() < 0.5 ? 1 : -1;
          }
          const rev = dtau / ob.period;
          ob.left -= rev;
          ob.angle += sign() * TAU * rev;
          angle = ob.angle;
        }
        r.zPhase += (tempo ? db * (60 / this.clock.bpm) : dtau) * 0.2;
        raw = {
          x: clamp1(o.center.x + o.range.x * Math.cos(angle)),
          y: clamp1(o.center.y + o.range.y * Math.sin(angle)),
          z: clamp1(o.center.z + o.range.z * fbm(r.zPhase + o.id * 13.7)),
        };
        break;
      }

      default:
        raw = copy3(r.gen);
    }

    if (r.slew) {
      const k = (t - r.slew.t0) / r.slew.dur;
      if (k >= 1 || k < 0) r.slew = null;
      else raw = lerp3(r.slew.from, raw, k);
    }
    r.gen = raw;
  }

  applyOutput(r, t, dt, i) {
    let p = this.autoPos[i] ?? r.gen;
    if (r.xf) {
      const k = (t - r.xf.t0) / r.xf.dur;
      if (k >= 1) r.xf = null;
      else if (k < 0) p = r.xf.from;
      else p = lerp3(r.xf.from, p, EASINGS[r.xf.ease ?? 'inOut'](k));
    }
    const vmax = this.master.maxVelocity;
    const exempt = this.master.vmaxExceptJumps && (r.jumpFrame || r.slew);
    r.jumpFrame = false;
    if (vmax > 0 && dt > 0 && !exempt) {
      const d = dist3(p, r.pos);
      const lim = vmax * dt;
      if (d > lim) p = lerp3(r.pos, p, lim / d);
    }
    r.pos = copy3(p);
  }

  update(t = now()) {
    const dt = clamp(t - this.lastT, 0, 0.25);
    this.lastT = t;
    const m = this.master;
    if (m.speed !== m.speedTarget) {
      const stepv = this.speedRate > 0 ? this.speedRate * dt : Infinity;
      m.speed = Math.abs(m.speedTarget - m.speed) <= stepv ? m.speedTarget : m.speed + Math.sign(m.speedTarget - m.speed) * stepv;
    }
    const b = this.beatAt(t);
    const db = clamp(b - this.lastB, 0, 64);
    this.lastB = b;
    const holdAll = m.running && m.frozen;
    const speed = this.autoMaster.speed ?? m.speed;
    for (let i = 0; i < MAX_OBJECTS; i++) {
      const o = this.effective(i);
      const r = this.rt[i];
      if (o.enabled && !holdAll && this.rtRunning(r)) {
        const dtau = dt * speed * o.speedScale;
        r.tau += dtau;
        this.step(o, r, t, dtau, b, db);
      }
      if (!holdAll) this.applyOutput(r, t, dt, i);
    }
  }

  /** Engine time (s) of the earliest pending tempo step, so the output loop can wake exactly on the beat. */
  nextEventTime() {
    if (this.master.running && this.master.frozen) return null;
    let best = null;
    for (let i = 0; i < MAX_OBJECTS; i++) {
      const o = this.effective(i);
      const r = this.rt[i];
      if (!o.enabled || !this.rtRunning(r) || !isTempo(o) || !usesSteps(o) || r.pending) continue;
      const te = this.timeAtBeat(r.tNext);
      if (best === null || te < best) best = te;
    }
    return best;
  }

  isOutputActive(i, t) {
    return this.objects[i].enabled || t < this.rt[i].fadeOutUntil;
  }

  clearEvents() {
    for (const r of this.rt) r.evt = false;
  }

  positions() {
    const q = (v) => Math.round(v * 10000) / 10000;
    return this.rt.map((r) => [q(r.pos.x), q(r.pos.y), q(r.pos.z)]);
  }
}
