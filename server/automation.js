// Automation lanes: parameter curves that follow show time (TC / internal clock) or a cue's own
// time, plus server-side recording (Touch / Latch / Write). Pure scheduling: the server wires the
// engine through the api object, tests pass a fake.
import { isPlainObject } from './fsutil.js';
import { num, toBool, MAX_OBJECTS, AUTO_PARAMS, MASTER_AUTO_PARAMS } from './engine.js';
import { L } from './i18n.js';

export const AUTO_MODES = ['off', 'read', 'touch', 'latch', 'write'];
export const AUTO_GLOBAL = ['off', 'read', 'write'];
export const AUTO_CURVES = ['linear', 'step', 'smooth'];
export const MAX_LANES = 64;
export const MAX_POINTS = 4000;
export const MAX_AUTO_TIME = 86400;
/** Recording sample rate (Hz) and how long after the last edit a Touch pass lets go. */
export const REC_HZ = 30;
export const TOUCH_HOLD = 0.5;
const RECORD_MODES = new Set(['touch', 'latch', 'write']);
const CUE_ID_RE = /^[a-z0-9]{1,16}$/i;
const newLaneId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/** [min, max] for a scalar param, 'pos' for the 3-D output position, null when not automatable. */
export function paramRange(target, param) {
  if (target === 'master') return MASTER_AUTO_PARAMS[param] ?? null;
  if (param === 'pos') return 'pos';
  return AUTO_PARAMS[param] ?? null;
}

const q4 = (v) => Math.round(v * 10000) / 10000;
const q3 = (v) => Math.round(v * 1000) / 1000;

/** Sorted, de-duplicated, clamped points; invalid entries are dropped. */
export function sanitizePoints(list, range) {
  if (!Array.isArray(list) || !range) return [];
  const out = [];
  for (const p of list) {
    if (!Array.isArray(p)) continue;
    const t = num(p[0], 0, MAX_AUTO_TIME, null);
    if (t === null) continue;
    let v;
    if (range === 'pos') {
      if (!Array.isArray(p[1])) continue;
      const x = num(p[1][0], -1, 1, null);
      const y = num(p[1][1], -1, 1, null);
      if (x === null || y === null) continue;
      v = [q4(x), q4(y), q4(num(p[1][2], -1, 1, 0))];
    } else {
      v = num(p[1], range[0], range[1], null);
      if (v === null) continue;
      v = q4(v);
    }
    const curve = AUTO_CURVES.includes(p[2]) && p[2] !== 'linear' ? p[2] : null;
    out.push(curve ? [q3(t), v, curve] : [q3(t), v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const dedup = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1][0] === p[0]) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup.slice(0, MAX_POINTS);
}

const lerpV = (a, b, k) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * k) : a + (b - a) * k);

/** Lane value at time t: holds the first/last value outside the points; the left point's curve shapes each segment. */
export function valueAt(points, t) {
  const n = points.length;
  if (!n) return null;
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const curve = a[2] ?? 'linear';
  if (curve === 'step') return a[1];
  let k = (t - a[0]) / (b[0] - a[0]);
  if (curve === 'smooth') k = k * k * (3 - 2 * k);
  return lerpV(a[1], b[1], k);
}

const vdist = (a, b) => (Array.isArray(a) ? Math.max(...a.map((x, i) => Math.abs(x - b[i]))) : Math.abs(a - b));

/** Ramer–Douglas–Peucker on time series: drops points whose value is within eps of the straight line. */
export function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a];
    const pb = points[b];
    let best = -1;
    let bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const k = (points[i][0] - pa[0]) / Math.max(pb[0] - pa[0], 1e-9);
      const d = vdist(points[i][1], lerpV(pa[1], pb[1], k));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Thinning tolerance: 0.2 % of the parameter span. */
export function thinEps(range) {
  return range === 'pos' ? 0.004 : (range[1] - range[0]) * 0.002;
}

const validTarget = (v) => {
  if (v === 'master') return 'master';
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_OBJECTS ? n : null;
};

/** Strict lane validation: returns { lane } or { error } (localized). `base` fills fields that were not given. */
export function validateLane(raw, base = null) {
  if (!isPlainObject(raw)) return { error: L('auto.err.notLane') };
  const src = { ...(base ?? {}), ...raw };
  const target = validTarget(src.target);
  if (target === null) return { error: L('auto.err.target') };
  const param = typeof src.param === 'string' ? src.param : '';
  const range = paramRange(target, param);
  if (!range) return { error: L('auto.err.param', { v: param.slice(0, 24) }) };
  const owner = src.owner === undefined || src.owner === 'show' ? 'show' : typeof src.owner === 'string' && CUE_ID_RE.test(src.owner) ? src.owner : null;
  if (owner === null) return { error: L('auto.err.owner') };
  const mode = src.mode ?? 'read';
  if (!AUTO_MODES.includes(mode)) return { error: L('auto.err.mode', { v: String(mode).slice(0, 12) }) };
  if (src.points !== undefined && !Array.isArray(src.points)) return { error: L('auto.err.points') };
  if (Array.isArray(src.points) && src.points.length > MAX_POINTS) return { error: L('auto.err.tooMany', { max: MAX_POINTS }) };
  const id = typeof src.id === 'string' && /^[a-z0-9]{1,16}$/i.test(src.id) ? src.id : newLaneId();
  const label = typeof src.label === 'string' ? src.label.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 32) : '';
  return {
    lane: {
      id, owner, target, param, mode, armed: toBool(src.armed, false), label,
      points: sanitizePoints(src.points ?? [], range),
    },
  };
}

/** Validates a whole list (show files, sessions, state). Invalid lanes are reported, duplicates dropped. */
export function validateLanes(list) {
  const errors = [];
  const lanes = [];
  if (!Array.isArray(list)) return { lanes, errors: list === undefined ? [] : [L('auto.err.notList')] };
  const ids = new Set();
  const keys = new Set();
  for (const [i, raw] of list.slice(0, MAX_LANES).entries()) {
    const { lane, error } = validateLane(raw);
    if (error) {
      errors.push({ index: i + 1, message: error });
      continue;
    }
    const key = laneKey(lane);
    if (keys.has(key)) continue;
    if (ids.has(lane.id)) lane.id = newLaneId();
    ids.add(lane.id);
    keys.add(key);
    lanes.push(lane);
  }
  if (list.length > MAX_LANES) errors.push({ index: 0, message: L('auto.err.tooManyLanes', { max: MAX_LANES }) });
  return { lanes, errors };
}

/** One lane per owner + target + param. */
export const laneKey = (l) => `${l.owner}|${l.target}|${l.param}`;
const outKey = (l) => `${l.target}|${l.param}`;
const sameV = (a, b) => (Array.isArray(a) ? Array.isArray(b) && vdist(a, b) < 1e-5 : Math.abs(a - b) < 1e-6);

/**
 * api: {
 *   apply(target, param, value|null)   value null = release the override
 *   sample(target, param)              current value of the operator's own setting (recording source)
 *   locked()                           Show Lock: recording is refused, playback continues
 *   running()                          engine transport; playback holds while stopped (STOP stays STOP)
 *   cueTime(cueId)                     TC seconds of a cue, null when it is not on the timeline
 *   onRecorded(laneIds)                lanes changed by a finished recording pass
 * }
 */
export class AutoRunner {
  constructor(api) {
    this.api = api;
    this.lanes = [];
    this.global = 'read';
    /** cueId → { clock: 'tc'|'wall', cueT, t0, elapsed } for cue-owned lanes. */
    this.cueRuns = new Map();
    /** outKey → { lane, v } currently applied. */
    this.active = new Map();
    /** laneId → recording pass { t0, last, pts, lastSample, touchAt, latched }. */
    this.rec = new Map();
    this.touched = new Map();
  }

  setLanes(list) {
    this.lanes = list;
    for (const id of [...this.rec.keys()]) if (!list.some((l) => l.id === id)) this.rec.delete(id);
  }

  lane(id) {
    return this.lanes.find((l) => l.id === id) ?? null;
  }

  /** Called whenever a cue fires; only cues that own lanes start a run. */
  cueStarted(cue, { clock = 'wall', cueT = null, now, elapsed = 0 } = {}) {
    if (!this.lanes.some((l) => l.owner === cue.id)) return;
    this.cueRuns.set(cue.id, { clock: clock === 'tc' && cueT !== null ? 'tc' : 'wall', cueT, t0: now, elapsed });
  }

  /** Operator STOP: cue-owned runs end and recording passes are written; held values stay where they are. */
  stopRuns(now) {
    this.cueRuns.clear();
    this.commitAll(now);
  }

  /** Show or session load: like STOP, and every override is released. */
  stopAll(now) {
    this.stopRuns(now);
    this.releaseAll();
  }

  releaseAll() {
    for (const [, a] of this.active) this.api.apply(a.lane.target, a.lane.param, null);
    this.active.clear();
  }

  setGlobal(mode, now) {
    if (!AUTO_GLOBAL.includes(mode) || mode === this.global) return false;
    this.global = mode;
    if (mode !== 'write') this.commitAll(now);
    if (mode === 'off') this.releaseAll();
    return true;
  }

  /** Operator edits (canvas, sliders, OSC). params: the changed param names; center edits also touch `pos`. */
  touch(target, params, now) {
    for (const p of params) this.touched.set(`${target}|${p}`, now);
    if (target !== 'master' && params.some((p) => p.startsWith('center.'))) this.touched.set(`${target}|pos`, now);
  }

  laneTime(lane, now, tc) {
    if (lane.owner === 'show') return tc && tc.pos !== null && tc.pos !== undefined ? tc.pos : null;
    const run = this.cueRuns.get(lane.owner);
    if (!run) return null;
    if (run.clock === 'tc') {
      if (!tc || tc.pos === null || tc.pos === undefined) return null;
      const t = tc.pos - run.cueT;
      if (t < -0.25) {
        this.cueRuns.delete(lane.owner);
        return null;
      }
      return Math.max(0, t);
    }
    return now - run.t0 + run.elapsed;
  }

  /** Recording needs: global Write, an armed lane in a recording mode, no Show Lock and moving time. */
  canRecord(lane, tc) {
    if (this.global !== 'write' || !lane.armed || !RECORD_MODES.has(lane.mode) || this.api.locked()) return false;
    if (lane.owner === 'show') return !!tc?.rolling;
    const run = this.cueRuns.get(lane.owner);
    return !!run && (run.clock === 'wall' || !!tc?.rolling);
  }

  tick(now, tc) {
    const want = new Map();
    const recKeys = new Set();
    const changed = [];
    const hold = !this.api.running();
    for (const lane of this.lanes) {
      const time = lane.mode === 'off' || this.global === 'off' ? null : this.laneTime(lane, now, tc);
      const rec = this.rec.get(lane.id);
      if (time === null) {
        if (rec && this.commit(lane, rec)) changed.push(lane.id);
        continue;
      }
      const touchedAt = this.touched.get(outKey(lane)) ?? -Infinity;
      const touching = now - touchedAt < TOUCH_HOLD;
      let recording = false;
      if (this.canRecord(lane, tc)) {
        if (lane.mode === 'write') recording = true;
        else if (lane.mode === 'touch') recording = touching || (!!rec && now - rec.touchAt < TOUCH_HOLD);
        else recording = touching || !!rec?.latched;
      }
      if (rec && (!recording || time < rec.last - 0.05)) {
        if (this.commit(lane, rec)) changed.push(lane.id);
      }
      if (recording) {
        recKeys.add(outKey(lane));
        let r = this.rec.get(lane.id);
        if (!r) {
          r = { t0: time, last: time, pts: [], lastSample: -Infinity, touchAt: touchedAt, latched: lane.mode === 'latch' };
          this.rec.set(lane.id, r);
        }
        if (touching) r.touchAt = touchedAt;
        if (now - r.lastSample >= 1 / REC_HZ - 1e-4 || time - r.last > 1 / REC_HZ) {
          const v = this.api.sample(lane.target, lane.param);
          if (v !== null && v !== undefined) {
            r.pts.push([time, Array.isArray(v) ? [...v] : v]);
            r.last = time;
            r.lastSample = now;
          }
        }
        continue;
      }
      if (!lane.points.length) continue;
      const key = outKey(lane);
      const prev = want.get(key);
      // A playing cue lane wins over the show lane for the same parameter.
      if (prev && prev.lane.owner !== 'show' && lane.owner === 'show') continue;
      want.set(key, { lane, v: valueAt(lane.points, time) });
    }
    // Transport stopped: every value holds (STOP stays STOP) except what the operator is recording.
    for (const [key, a] of this.active) {
      if (want.has(key) || (hold && !recKeys.has(key))) continue;
      this.api.apply(a.lane.target, a.lane.param, null);
      this.active.delete(key);
    }
    if (!hold) {
      for (const [key, w] of want) {
        const a = this.active.get(key);
        if (a && sameV(a.v, w.v)) {
          a.lane = w.lane;
          continue;
        }
        this.api.apply(w.lane.target, w.lane.param, w.v);
        this.active.set(key, w);
      }
    }
    if (changed.length) this.api.onRecorded(changed);
    return changed;
  }

  commitAll(now) {
    const changed = [];
    for (const lane of this.lanes) {
      const rec = this.rec.get(lane.id);
      if (rec && this.commit(lane, rec)) changed.push(lane.id);
    }
    if (changed.length) this.api.onRecorded(changed);
    return changed;
  }

  /** Writes a finished pass into the lane: the recorded span replaces what was there, joined by anchor points. */
  commit(lane, rec) {
    this.rec.delete(lane.id);
    if (!rec.pts.length) return false;
    const range = paramRange(lane.target, lane.param);
    const t0 = rec.pts[0][0];
    const t1 = rec.pts[rec.pts.length - 1][0];
    const old = lane.points;
    const before = old.filter((p) => p[0] < t0 - 1e-3);
    const after = old.filter((p) => p[0] > t1 + 1e-3);
    const pts = [...rec.pts];
    if (old.length && before.length) pts.unshift([Math.max(0, t0 - 1 / REC_HZ), valueAt(old, t0)]);
    if (old.length && after.length && lane.mode !== 'latch') pts.push([t1 + 0.1, valueAt(old, t1 + 0.1)]);
    let eps = thinEps(range);
    let thin = rdp(pts, eps);
    while (before.length + after.length + thin.length > MAX_POINTS && eps < 1) {
      eps *= 2;
      thin = rdp(pts, eps);
    }
    const merged = [...before.filter((p) => p[0] < thin[0][0]), ...thin, ...after.filter((p) => p[0] > thin[thin.length - 1][0])];
    lane.points = sanitizePoints(merged, range);
    return true;
  }

  /** Earliest time the loop must run again: every output frame while lanes play or record. */
  busy() {
    return this.active.size > 0 || this.rec.size > 0 || this.cueRuns.size > 0;
  }

  status() {
    const rec = {};
    for (const [id, r] of this.rec) rec[id] = { t0: r.t0, t: r.last, v: r.pts[r.pts.length - 1]?.[1] ?? null };
    const vals = {};
    for (const [, a] of this.active) vals[a.lane.id] = a.v;
    return { global: this.global, rec, vals, runs: [...this.cueRuns.keys()] };
  }
}
