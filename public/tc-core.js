// Timecode core shared by the browser (UI, AudioWorklet) and the Node server/tests. No DOM / Node APIs here.

export const TC_RATES = ['23.976', '24', '25', '29.97df', '29.97nd', '30'];
/** Frames counted per second in the TC label. */
export const RATE_FPS = { '23.976': 24, 24: 24, 25: 25, '29.97df': 30, '29.97nd': 30, 30: 30 };
/** Real frames per second. */
export const RATE_REAL = { '23.976': 24000 / 1001, 24: 24, 25: 25, '29.97df': 30000 / 1001, '29.97nd': 30000 / 1001, 30: 30 };
const MTC_RATES = ['24', '25', '29.97df', '30'];
const DF_FRAMES_PER_DAY = 24 * 107892;

export const isDf = (rate) => rate === '29.97df';

/**
 * Accepts 24 / '25' / '23.976' / 29.97 / '29.97df' / '29.97nd' / 'df' / 30 → canonical rate id or null.
 * A bare 29.97 is ambiguous; it means drop-frame (by far the common case), senders using
 * non-drop 29.97 must say '29.97nd'.
 */
export function normalizeRate(v) {
  if (typeof v === 'number') v = Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '23.976' || s === '23.98' || s === '23.97') return '23.976';
  if (s === '24') return '24';
  if (s === '25') return '25';
  if (s === '29.97' || s === '29.97df' || s === 'df' || s === '30df' || s === '29.97d') return '29.97df';
  if (s === '29.97nd' || s === '29.97n' || s === 'nd' || s === '30nd') return '29.97nd';
  if (s === '30') return '30';
  return null;
}

/** Frames in one 24 h day for the rate. */
export const framesPerDay = (rate) => (isDf(rate) ? DF_FRAMES_PER_DAY : 86400 * (RATE_FPS[rate] ?? 25));
/** Length of one TC day in real seconds (not exactly 86400 for 23.976 / 29.97). */
export const daySeconds = (rate) => framesPerDay(rate) / (RATE_REAL[rate] ?? 25);

/** Label exists at this rate: frame below fps and, for drop-frame, not one of the skipped labels. */
export function validTcForRate(tc, rate) {
  if (!validTc(tc)) return false;
  if (tc.f >= (RATE_FPS[rate] ?? 30)) return false;
  return !(isDf(rate) && tc.s === 0 && tc.f < 2 && tc.m % 10 !== 0);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "hh:mm:ss:ff" (";" or "." before frames allowed, optional sign) → { h, m, s, f, neg, dfSep } or null. */
export function parseTc(str) {
  const m = /^\s*([+-])?\s*(\d{1,2})[:.](\d{1,2})[:.](\d{1,2})([:;.,])(\d{1,2})\s*$/.exec(String(str ?? ''));
  if (!m) return null;
  const tc = { h: Number(m[2]), m: Number(m[3]), s: Number(m[4]), f: Number(m[6]), neg: m[1] === '-', dfSep: m[5] === ';' || m[5] === ',' };
  return validTc(tc) ? tc : null;
}

export function validTc(tc) {
  return !!tc && [tc.h, tc.m, tc.s, tc.f].every((v) => Number.isInteger(v) && v >= 0)
    && tc.h < 24 && tc.m < 60 && tc.s < 60 && tc.f < 30;
}

export function formatTc(tc, { df = false, sign = false } = {}) {
  if (!tc) return '--:--:--:--';
  const s = sign ? (tc.neg ? '-' : '+') : tc.neg ? '-' : '';
  return `${s}${pad2(tc.h)}:${pad2(tc.m)}:${pad2(tc.s)}${df ? ';' : ':'}${pad2(tc.f)}`;
}

/** Label → frame count since 00:00:00:00 (drop-frame aware). Frames above the rate are clamped. */
export function tcToFrames(tc, rate) {
  const fps = RATE_FPS[rate] ?? 25;
  const f = Math.min(tc.f, fps - 1);
  let frames = ((tc.h * 60 + tc.m) * 60 + tc.s) * fps + f;
  if (isDf(rate)) {
    const tm = tc.h * 60 + tc.m;
    frames -= 2 * (tm - Math.floor(tm / 10));
  }
  return frames;
}

/** Frame count → label, wrapping at 24 h. */
export function framesToTc(frames, rate) {
  const fps = RATE_FPS[rate] ?? 25;
  const perDay = isDf(rate) ? DF_FRAMES_PER_DAY : 86400 * fps;
  let n = ((Math.round(frames) % perDay) + perDay) % perDay;
  if (isDf(rate)) {
    const d = Math.floor(n / 17982);
    const mm = n % 17982;
    n += 18 * d + (mm >= 2 ? 2 * Math.floor((mm - 2) / 1798) : 0);
  }
  const tot = Math.floor(n / fps);
  return { h: Math.floor(tot / 3600), m: Math.floor(tot / 60) % 60, s: tot % 60, f: n % fps };
}

export const tcToSeconds = (tc, rate) => (tc.neg ? -1 : 1) * (tcToFrames(tc, rate) / (RATE_REAL[rate] ?? 25));
export const secondsToFrames = (sec, rate) => Math.floor(sec * (RATE_REAL[rate] ?? 25) + 1e-6);
export const secondsToTc = (sec, rate) => framesToTc(secondsToFrames(sec, rate), rate);

// ---------------- MIDI Time Code ----------------

/**
 * Feed complete MIDI messages (Web MIDI delivers one message per event). Returns
 * { kind: 'qf' | 'full' | 'unlock', tc, rate, dir, sub } or null.
 * Quarter frames lock only after 8 consecutive pieces in one direction. The last piece arrives
 * 7 quarter frames after the encoded frame started, so the position is label + 1.75 frames in the
 * playing direction: returned as an integer label plus a positive fractional `sub` (frames).
 */
export class MtcParser {
  constructor() {
    this.pieces = new Uint8Array(8);
    this.reset();
  }

  reset() {
    this.last = null;
    this.dir = 0;
    this.count = 0;
    this.locked = false;
    this.base = null;
    this.qf = 0;
    this.rate = null;
  }

  feed(data) {
    if (!data || !data.length) return null;
    if (data[0] === 0xf1 && data.length >= 2) return this.quarter(data[1]);
    if (data[0] === 0xf0 && data.length >= 10 && data[1] === 0x7f && data[3] === 0x01 && data[4] === 0x01) return this.full(data);
    return null;
  }

  full(b) {
    const tc = { h: b[5] & 0x1f, m: b[6] & 0x3f, s: b[7] & 0x3f, f: b[8] & 0x1f };
    const rate = MTC_RATES[(b[5] >> 5) & 3];
    if (!validTcForRate(tc, rate)) return null;
    this.reset();
    this.rate = rate;
    return { kind: 'full', tc, rate, dir: 0, sub: 0 };
  }

  quarter(d) {
    const idx = (d >> 4) & 7;
    const v = d & 0x0f;
    let step = 0;
    if (this.last !== null) {
      if (idx === ((this.last + 1) & 7)) step = 1;
      else if (idx === ((this.last + 7) & 7)) step = -1;
    }
    this.last = idx;
    this.pieces[idx] = v;
    if (step === 0 || (this.dir !== 0 && step !== this.dir)) {
      const was = this.locked;
      this.dir = step;
      this.count = 1;
      this.locked = false;
      this.base = null;
      return was ? { kind: 'unlock', tc: null, rate: this.rate, dir: 0, sub: 0 } : null;
    }
    this.dir = step;
    this.count++;
    const complete = step > 0 ? idx === 7 : idx === 0;
    if (complete && this.count >= 8) {
      const p = this.pieces;
      const tc = { f: p[0] | (p[1] << 4), s: p[2] | (p[3] << 4), m: p[4] | (p[5] << 4), h: p[6] | ((p[7] & 1) << 4) };
      const rate = MTC_RATES[(p[7] >> 1) & 3];
      if (!validTcForRate(tc, rate)) {
        this.locked = false;
        this.count = 0;
        return null;
      }
      this.rate = rate;
      this.locked = true;
      this.base = tcToFrames(tc, rate) + 1.75 * step;
      this.qf = 0;
      return this.emit(this.base, step);
    }
    if (!this.locked) return null;
    this.qf++;
    if (this.qf % 4 !== 0) return null;
    return this.emit(this.base + (step * this.qf) / 4, step);
  }

  emit(pos, dir) {
    const whole = Math.floor(pos + 1e-9);
    return { kind: 'qf', tc: framesToTc(whole, this.rate), rate: this.rate, dir, sub: pos - whole };
  }
}

/** Builds MTC messages for tests / simulators: 8 quarter-frame messages for `tc`. */
export function mtcQuarterFrames(tc, rate) {
  const code = MTC_RATES.indexOf(rate);
  const vals = [tc.f & 15, tc.f >> 4, tc.s & 15, tc.s >> 4, tc.m & 15, tc.m >> 4, tc.h & 15, ((tc.h >> 4) & 1) | (code << 1)];
  return vals.map((v, i) => [0xf1, (i << 4) | v]);
}

export function mtcFullFrame(tc, rate) {
  return [0xf0, 0x7f, 0x7f, 0x01, 0x01, (MTC_RATES.indexOf(rate) << 5) | tc.h, tc.m, tc.s, tc.f, 0xf7];
}

// ---------------- Linear Time Code ----------------

const SYNC_FWD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const SYNC_REV = [...SYNC_FWD].reverse();

export function ltcFrameBits(tc, df = false) {
  const bits = new Uint8Array(80);
  const put = (start, n, v) => { for (let i = 0; i < n; i++) bits[start + i] = (v >> i) & 1; };
  put(0, 4, tc.f % 10);
  put(8, 2, Math.floor(tc.f / 10));
  bits[10] = df ? 1 : 0;
  put(16, 4, tc.s % 10);
  put(24, 3, Math.floor(tc.s / 10));
  put(32, 4, tc.m % 10);
  put(40, 3, Math.floor(tc.m / 10));
  put(48, 4, tc.h % 10);
  put(56, 2, Math.floor(tc.h / 10));
  SYNC_FWD.forEach((b, i) => { bits[64 + i] = b; });
  return bits;
}

function decodeLtcBits(get) {
  const v = (s, n) => {
    let r = 0;
    for (let i = 0; i < n; i++) r |= get(s + i) << i;
    return r;
  };
  const fu = v(0, 4);
  const su = v(16, 4);
  const mu = v(32, 4);
  const hu = v(48, 4);
  if (fu > 9 || su > 9 || mu > 9 || hu > 9) return null;
  const tc = { h: hu + 10 * v(56, 2), m: mu + 10 * v(40, 3), s: su + 10 * v(24, 3), f: fu + 10 * v(8, 2) };
  return validTc(tc) ? { tc, df: get(10) === 1 } : null;
}

/**
 * Biphase-mark LTC decoder working on raw samples. Polarity-insensitive, adaptive bit period
 * (24–30 fps, roughly ±30 % varispeed), forward and reverse playback.
 * process() returns decoded frames: { tc, df, dir, rate, fps, sample } where `sample` is the
 * (fractional) sample index at which the frame ended — the frame's label is one frame old there.
 */
export class LtcDecoder {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.minT = sampleRate / 3200;
    this.maxT = sampleRate / 1400;
    this.decay = Math.exp(-1 / (0.03 * sampleRate));
    this.minLevel = 0.004;
    this.n = 0;
    this.px = 0;
    this.zc = 0;
    this.sign = 0;
    this.env = 0;
    this.T = sampleRate / 2000;
    this.lastEdge = null;
    this.half = false;
    this.halfD = 0;
    this.bits = new Uint8Array(80);
    this.nbits = 0;
    this.frameLen = 0;
    this.lastFrameEnd = null;
    this.unlock();
  }

  unlock() {
    this.locked = false;
    this.prevFrames = null;
    this.prevF = null;
    this.base = null;
    this.cand = null;
  }

  /** Confirmed rate, or null until a frame-number wrap has been observed. The DF flag only refines 30. */
  rate(df) {
    if (!this.base) return null;
    if (this.base === 30) return df ? '29.97df' : '30';
    return String(this.base);
  }

  /** Rate used only to check label continuity before the wrap is seen. */
  guessRate(df) {
    if (df) return '29.97df';
    if (!this.frameLen) return '30';
    const fps = this.sr / this.frameLen;
    return fps < 24.5 ? '24' : fps < 27.5 ? '25' : '30';
  }

  observeWrap(count) {
    if (count !== 24 && count !== 25 && count !== 30) return;
    if (this.base === null) {
      this.base = count;
    } else if (count !== this.base) {
      // A dropped frame at the wrap fakes a shorter count; switch only after two agreeing wraps.
      if (this.cand === count) {
        this.base = count;
        this.cand = null;
      } else {
        this.cand = count;
      }
    } else {
      this.cand = null;
    }
  }

  process(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const n = this.n++;
      const ax = x < 0 ? -x : x;
      this.env = ax > this.env ? ax : this.env * this.decay;
      if ((x >= 0) !== (this.px >= 0)) this.zc = n - 1 + (this.px === x ? 0 : this.px / (this.px - x));
      this.px = x;
      const th = Math.max(this.minLevel, this.env * 0.25);
      const s = x > th ? 1 : x < -th ? -1 : this.sign;
      if (s !== this.sign) {
        if (this.sign !== 0) this.edge(this.zc, out);
        this.sign = s;
      }
    }
    if (this.locked && this.n - this.lastFrameEnd > Math.max(3 * this.frameLen, this.sr / 8)) this.unlock();
    return out;
  }

  glitch() {
    this.half = false;
    this.nbits = 0;
  }

  edge(t, out) {
    if (this.lastEdge === null) {
      this.lastEdge = t;
      return;
    }
    const d = t - this.lastEdge;
    this.lastEdge = t;
    if (!(d > 0)) return;
    const T = this.T;
    if (d > 0.75 * T && d < 1.5 * T) {
      if (this.half) this.glitch();
      this.T += 0.1 * (d - T);
      this.bit(0, t, out);
    } else if (d >= 0.25 * T && d <= 0.75 * T) {
      if (this.half) {
        this.half = false;
        this.T += 0.1 * (d + this.halfD - T);
        this.bit(1, t, out);
      } else {
        this.half = true;
        this.halfD = d;
      }
    } else {
      this.glitch();
      if (d >= this.minT && d <= this.maxT) this.T = d;
    }
    this.T = Math.min(this.maxT, Math.max(this.minT, this.T));
  }

  bit(b, t, out) {
    const bits = this.bits;
    bits.copyWithin(0, 1);
    bits[79] = b;
    if (this.nbits < 80) this.nbits++;
    if (this.nbits < 80) return;
    let dir = 0;
    if (SYNC_FWD.every((v, i) => bits[64 + i] === v)) dir = 1;
    else if (SYNC_REV.every((v, i) => bits[i] === v)) dir = -1;
    else return;
    const dec = decodeLtcBits(dir > 0 ? (i) => bits[i] : (i) => bits[79 - i]);
    if (!dec) return;
    this.nbits = 0;
    this.frame(dec, dir, t, out);
  }

  frame({ tc, df }, dir, t, out) {
    if (this.lastFrameEnd !== null) {
      const len = t - this.lastFrameEnd;
      if (len > this.sr / 45 && len < this.sr / 15) this.frameLen = this.frameLen ? this.frameLen + 0.2 * (len - this.frameLen) : len;
    }
    this.lastFrameEnd = t;
    if (this.prevF !== null) {
      const wrapFwd = dir > 0 && tc.f === 0 && this.prevF >= 23;
      const wrapRev = dir < 0 && this.prevF === 0 && tc.f >= 23;
      const count = wrapFwd ? this.prevF + 1 : wrapRev ? tc.f + 1 : 0;
      if (count) this.observeWrap(count);
    }
    const rate = this.rate(df);
    const known = rate ?? this.guessRate(df);
    const frames = tcToFrames(tc, known);
    if (this.prevFrames !== null && Math.abs(frames - this.prevFrames) === 1) this.locked = true;
    this.prevFrames = frames;
    this.prevF = tc.f;
    if (!this.locked) return;
    out.push({ tc, df, dir, rate, fps: this.frameLen ? this.sr / this.frameLen : RATE_REAL[known], sample: t });
  }
}

/** Synthesizes an LTC signal (square biphase mark, optional rise time / noise) for tests and simulators. */
export function synthLtc({
  sampleRate = 48000, rate = '25', start = { h: 0, m: 0, s: 0, f: 0 }, frames = 50,
  reverse = false, amplitude = 0.5, speed = 1, lead = 0.02, rise = 0, noise = 0, seed = 1,
} = {}) {
  const T = sampleRate / (80 * RATE_REAL[rate] * speed);
  const leadN = Math.round(lead * sampleRate);
  const end = leadN + frames * 80 * T;
  const out = new Float32Array(Math.ceil(end) + leadN + 2);
  const base = tcToFrames(start, rate);
  const edges = [];
  let t = leadN;
  for (let k = 0; k < frames; k++) {
    const bits = ltcFrameBits(framesToTc(base + k, rate), isDf(rate));
    for (let i = 0; i < 80; i++) {
      edges.push(t);
      if (bits[i]) edges.push(t + T / 2);
      t += T;
    }
  }
  edges.push(t);
  let rnd = seed >>> 0 || 1;
  const rand = () => {
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    return ((rnd >>> 0) / 4294967296) * 2 - 1;
  };
  const a = rise > 0 ? 1 - Math.exp(-1 / (rise * sampleRate)) : 1;
  let level = -amplitude;
  let e = 0;
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    while (e < edges.length && edges[e] <= i) { level = -level; e++; }
    const x = i < leadN || i > end ? 0 : level;
    y += a * (x - y);
    out[i] = y + (noise ? noise * rand() : 0);
  }
  return reverse ? out.reverse() : out;
}
