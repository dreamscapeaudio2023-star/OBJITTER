import assert from 'node:assert/strict';
import { test, run } from './harness.js';
import {
  parseTc, formatTc, tcToFrames, framesToTc, tcToSeconds, normalizeRate, RATE_REAL, validTcForRate, daySeconds,
  MtcParser, mtcQuarterFrames, mtcFullFrame, LtcDecoder, synthLtc,
} from '../public/tc-core.js';
import {
  CueEngine, InternalClock, OffsetEstimator, defaultCue, validateCue, sanitizeCueList, sortCues,
  sanitizeTcSettings, parseOscTc,
} from '../server/timecode.js';
import { tm } from '../public/i18n.js';

const T = (s) => parseTc(s);
const str = (tc) => formatTc(tc);

// ---------- conversions ----------
test('drop-frame TC ↔ frames: known values and round trips for every rate', () => {
  assert.equal(tcToFrames(T('00:00:59:29'), '29.97df'), 1799);
  assert.equal(tcToFrames(T('00:01:00:02'), '29.97df'), 1800);
  assert.equal(tcToFrames(T('00:10:00:00'), '29.97df'), 17982);
  assert.equal(tcToFrames(T('01:00:00:00'), '29.97df'), 107892);
  assert.equal(str(framesToTc(1800, '29.97df')), '00:01:00:02');
  assert.equal(str(framesToTc(17982, '29.97df')), '00:10:00:00');
  assert.equal(str(framesToTc(17981, '29.97df')), '00:09:59:29');
  assert.ok(Math.abs(tcToSeconds(T('01:00:00:00'), '29.97df') - 3599.9964) < 1e-6, 'DF hour = 3599.9964 s real time');
  assert.equal(tcToSeconds(T('01:00:00:00'), '25'), 3600);
  for (const rate of ['23.976', '24', '25', '29.97df', '29.97nd', '30']) {
    for (let f = 0; f < 200000; f += 997) assert.equal(tcToFrames(framesToTc(f, rate), rate), f, `${rate} frame ${f}`);
  }
  assert.equal(str(framesToTc(-1, '25')), '23:59:59:24', 'wraps at 24 h');
  assert.ok(Math.abs(daySeconds('25') - 86400) < 1e-9);
  assert.ok(Math.abs(daySeconds('29.97nd') - 86486.4) < 1e-6, 'non-drop 29.97: a TC day is 86486.4 real seconds');
});

test('parseTc / formatTc / normalizeRate / validTcForRate', () => {
  assert.deepEqual(T('1:02:03;04'), { h: 1, m: 2, s: 3, f: 4, neg: false, dfSep: true });
  assert.equal(T('-00:00:01:00').neg, true);
  assert.equal(T('24:00:00:00'), null);
  assert.equal(T('00:60:00:00'), null);
  assert.equal(T('00:00:00:30'), null);
  assert.equal(T('garbage'), null);
  assert.equal(formatTc(T('01:02:03:04'), { df: true }), '01:02:03;04');
  assert.equal(formatTc(T('00:00:01:00'), { sign: true }), '+00:00:01:00');
  assert.equal(normalizeRate(29.97), '29.97df', 'bare 29.97 = drop-frame (documented)');
  assert.equal(normalizeRate(Math.fround(29.97)), '29.97df', 'OSC float32 argument');
  assert.equal(normalizeRate('29.97nd'), '29.97nd');
  assert.equal(normalizeRate('25'), '25');
  assert.equal(normalizeRate(23.976), '23.976');
  assert.equal(normalizeRate('23.98'), '23.976');
  assert.equal(normalizeRate('x'), null);
  assert.equal(validTcForRate(T('00:00:00:24'), '25'), true);
  assert.equal(validTcForRate(T('00:00:00:25'), '25'), false);
  assert.equal(validTcForRate(T('00:01:00:00'), '29.97df'), false, 'dropped label');
  assert.equal(validTcForRate(T('00:10:00:00'), '29.97df'), true, 'every 10th minute keeps 00/01');
  assert.equal(validTcForRate(T('00:01:00:00'), '29.97nd'), true);
});

// ---------- MTC ----------
function feedAll(p, msgs) {
  return msgs.map((m) => p.feed(Uint8Array.from(m))).filter(Boolean);
}

test('MTC quarter frames: lock after 8 pieces, +1.75 frame compensation as label + sub, per-frame updates', () => {
  const p = new MtcParser();
  const tc = T('01:02:03:04');
  const qf = mtcQuarterFrames(tc, '25');
  assert.deepEqual(feedAll(p, qf.slice(3)), [], 'partial sequence must not lock');
  assert.equal(p.locked, false);
  const out = feedAll(p, qf);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'qf');
  assert.equal(str(out[0].tc), '01:02:03:05');
  assert.ok(Math.abs(out[0].sub - 0.75) < 1e-9, `sub ${out[0].sub}`);
  assert.equal(out[0].rate, '25');
  assert.equal(out[0].dir, 1);
  const next = feedAll(p, mtcQuarterFrames(T('01:02:03:06'), '25'));
  assert.deepEqual(next.map((x) => str(x.tc)), ['01:02:03:06', '01:02:03:07'], 'mid-sequence estimate + re-sync');
});

test('MTC rate bits (24 / 29.97df / 30), hour high bit and invalid frames', () => {
  for (const [rate, s] of [['24', '23:59:58:20'], ['29.97df', '17:00:00:10'], ['30', '16:30:00:27']]) {
    const p = new MtcParser();
    const out = feedAll(p, [...mtcQuarterFrames(T(s), rate)]);
    assert.equal(out[0].rate, rate);
    assert.equal(tcToFrames(out[0].tc, rate) + out[0].sub, tcToFrames(T(s), rate) + 1.75);
  }
  const p = new MtcParser();
  assert.deepEqual(feedAll(p, mtcQuarterFrames({ h: 0, m: 0, s: 0, f: 27 }, '25')), [], 'frame 27 is invalid at 25 fps');
  const q = new MtcParser();
  assert.deepEqual(feedAll(q, mtcQuarterFrames(T('00:01:00:00'), '29.97df')), [], 'dropped DF label is invalid');
});

test('MTC reverse direction and out-of-sequence unlock', () => {
  const p = new MtcParser();
  const rev = mtcQuarterFrames(T('00:10:00:10'), '25').reverse();
  const out = feedAll(p, [rev[7], ...rev]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dir, -1);
  assert.equal(tcToFrames(out[0].tc, '25') + out[0].sub, tcToFrames(T('00:10:00:10'), '25') - 1.75);
  assert.equal(p.feed(Uint8Array.from([0xf1, 0x30]))?.kind, 'unlock', 'piece 3 after piece 0 is out of sequence');
  assert.equal(p.locked, false);
});

test('MTC full-frame SysEx parse (any device id) resets quarter-frame lock', () => {
  const p = new MtcParser();
  feedAll(p, mtcQuarterFrames(T('00:00:01:00'), '25'));
  assert.equal(p.locked, true);
  const msg = mtcFullFrame(T('10:20:30:15'), '29.97df');
  msg[2] = 0x10;
  const r = p.feed(Uint8Array.from(msg));
  assert.equal(r.kind, 'full');
  assert.equal(str(r.tc), '10:20:30:15');
  assert.equal(r.rate, '29.97df');
  assert.equal(p.locked, false);
  assert.equal(p.feed(Uint8Array.from([0xf0, 0x7f, 0x7f, 0x01])), null);
  assert.equal(p.feed(Uint8Array.from([0x90, 60, 100])), null);
});

// ---------- LTC ----------
function decode(sig, sampleRate = 48000, block = 128) {
  const d = new LtcDecoder(sampleRate);
  const out = [];
  for (let i = 0; i < sig.length; i += block) out.push(...d.process(sig.subarray(i, i + block)));
  return out;
}
const consecutive = (frames, rate, dir) => frames.every((f, i) => i === 0 || tcToFrames(f.tc, rate) - tcToFrames(frames[i - 1].tc, rate) === dir);

test('LTC decoder: 25 fps forward; rate unknown (null) until a second wrap is seen', () => {
  const out = decode(synthLtc({ rate: '25', start: T('10:00:00:00'), frames: 75 }));
  assert.ok(out.length >= 70, `decoded ${out.length}`);
  assert.ok(consecutive(out, '25', 1));
  assert.ok(out.every((f) => f.dir === 1 && !f.df));
  const firstKnown = out.findIndex((f) => f.rate !== null);
  assert.ok(firstKnown > 0, 'no rate guess before the wrap');
  assert.ok(out.slice(firstKnown).every((f) => f.rate === '25'));
  assert.equal(str(out.at(-1).tc), '10:00:02:24');
  assert.ok(Math.abs(out.at(-1).fps - 25) < 0.1);
});

test('LTC decoder: 29.97 drop-frame across a minute boundary', () => {
  const out = decode(synthLtc({ rate: '29.97df', start: T('00:00:59:10'), frames: 60 }));
  assert.ok(out.length >= 55);
  assert.ok(out.every((f) => f.df));
  assert.equal(out.at(-1).rate, '29.97df');
  const labels = out.map((f) => str(f.tc));
  assert.ok(labels.includes('00:00:59:29') && labels.includes('00:01:00:02'));
  assert.ok(!labels.includes('00:01:00:00') && !labels.includes('00:01:00:01'), 'dropped labels never appear');
  assert.ok(consecutive(out, '29.97df', 1));
});

test('LTC decoder: reverse playback (25 fps and 29.97df)', () => {
  for (const rate of ['25', '29.97df']) {
    const out = decode(synthLtc({ rate, start: T('01:00:00:00'), frames: 60, reverse: true }));
    assert.ok(out.length >= 55, `${rate}: decoded ${out.length}`);
    assert.ok(out.every((f) => f.dir === -1));
    assert.ok(consecutive(out, rate, -1), `${rate} descending`);
    assert.equal(str(out.at(-1).tc), '01:00:00:01', 'the very first frame has no closing edge in reverse');
  }
});

test('LTC decoder: fps detection 24 / 30 and robustness (polarity, noise, rise time, varispeed, low level)', () => {
  assert.equal(decode(synthLtc({ rate: '24', frames: 60 })).at(-1).rate, '24');
  assert.equal(decode(synthLtc({ rate: '30', frames: 70 })).at(-1).rate, '30');
  const sig = synthLtc({ rate: '25', frames: 75, amplitude: 0.05, noise: 0.004, rise: 0.00004, speed: 1.08 }).map((v) => -v);
  const out = decode(sig, 48000, 512);
  assert.ok(out.length >= 65, `decoded ${out.length}`);
  assert.ok(consecutive(out, '25', 1));
  assert.equal(decode(synthLtc({ rate: '25', frames: 50, sampleRate: 44100 }), 44100).length >= 45, true, '44.1 kHz works too');
});

test('LTC decoder ignores silence and noise', () => {
  const noise = synthLtc({ rate: '25', frames: 0, lead: 1, noise: 0.3 });
  assert.equal(decode(noise).length, 0);
  assert.equal(decode(new Float32Array(48000)).length, 0);
});

// ---------- cue engine ----------
function engineWith(cues, settings = {}) {
  const e = new CueEngine();
  e.setSettings({ enabled: true, input: 'osc', rate: '25', ...settings });
  e.setCues(cues.map((c, i) => {
    const { cue, errors } = validateCue(c, { ...defaultCue(), id: `c${i}` });
    assert.deepEqual(errors, []);
    return cue;
  }));
  return e;
}

/** Plays TC from `from` for `frames` frames at real time; returns all actions (with tick between frames). */
function play(e, from, frames, { rate = '25', t0 = 100, step = 1, ticks = true, kind = 'osc' } = {}) {
  const dt = 1 / RATE_REAL[rate];
  const base = tcToFrames(T(from), rate);
  const actions = [];
  let t = t0;
  for (let k = 0; k < frames; k++) {
    actions.push(...e.input({ tc: framesToTc(base + k * step, rate), rate, kind }, t));
    if (ticks) actions.push(...e.tick(t + dt / 2));
    t += dt;
  }
  return { actions, t };
}
/** Same label repeated (parked transport sending its position). */
function park(e, at, seconds, { t0, rate = '25', kind = 'osc' }) {
  const actions = [];
  let t = t0;
  for (; t < t0 + seconds; t += 0.04) {
    actions.push(...e.input({ tc: T(at), rate, kind }, t));
    actions.push(...e.tick(t + 0.02));
  }
  return { actions, t };
}
const labels = (actions, type) => actions.filter((a) => !type || a.type === type).map((a) => `${a.type}:${a.cue?.label ?? ''}`);
const fires = (actions) => labels(actions, 'fire');

const CUES = [
  { tc: '00:00:02:00', action: 'slot', slot: 3, label: 'A' },
  { tc: '00:00:04:00', action: 'start', label: 'GO' },
  { tc: '00:00:06:00', action: 'slot', slot: 20, label: 'B' },
  { tc: '00:00:08:00', action: 'freeze', label: 'F' },
];

test('cue engine: forward pass fires each cue exactly once, in order', () => {
  const e = engineWith(CUES);
  const { actions } = play(e, '00:00:01:00', 25 * 9);
  assert.deepEqual(fires(actions), ['fire:A', 'fire:GO', 'fire:B', 'fire:F']);
  assert.equal(actions.filter((a) => a.type === 'rolling').length, 1);
  assert.equal(actions.filter((a) => a.type === 'chase').length, 0, 'locking before the first cue chases nothing');
});

test('cue engine: a cue exactly at the start position fires on roll (OSC / MTC / LTC / internal)', () => {
  for (const kind of ['osc', 'mtc', 'ltc', 'internal']) {
    const e = engineWith(CUES);
    const { actions } = play(e, '00:00:02:00', 10, { kind });
    assert.deepEqual(fires(actions), ['fire:A'], kind);
    assert.equal(labels(actions, 'chase').length, 0, `${kind}: start cue is fired, not chased`);
  }
});

test('cue engine: parked on a cue never fires it; rolling off the park fires it once', () => {
  const e = engineWith(CUES);
  const parked = park(e, '00:00:02:00', 2, { t0: 100 });
  assert.equal(parked.actions.filter((a) => a.type === 'fire').length, 0);
  const rolled = play(e, '00:00:02:01', 25, { t0: parked.t });
  assert.deepEqual(fires(rolled.actions), ['fire:A']);
});

test('cue engine: frame jitter / small backward steps never re-fire', () => {
  const e = engineWith(CUES);
  const pre = play(e, '00:00:05:10', 10);
  let t = pre.t;
  const seq = ['00:00:05:20', '00:00:05:21', '00:00:05:22', '00:00:05:23', '00:00:05:24', '00:00:06:00', '00:00:05:24', '00:00:06:00', '00:00:06:01', '00:00:05:23', '00:00:06:02'];
  const actions = [];
  for (const s of seq) { actions.push(...e.input({ tc: T(s), rate: '25' }, t)); t += 0.04; }
  assert.deepEqual(fires(actions), ['fire:B']);
});

test('cue engine: FF / shuttle never fires; skipped cues are chased once it settles', () => {
  const e = engineWith(CUES);
  const a = play(e, '00:00:01:00', 10);
  const ff = play(e, '00:00:01:10', 60, { t0: a.t, step: 4 });
  assert.equal(ff.actions.filter((x) => x.type === 'fire').length, 0, '4× FF');
  const settle = park(e, str(framesToTc(35 + 59 * 4, '25')), 0.5, { t0: ff.t });
  assert.deepEqual(labels(settle.actions, 'chase'), ['chase:B', 'chase:F', 'chase:GO']);

  const s = engineWith(CUES);
  const p = park(s, '00:00:01:00', 0.5, { t0: 100 });
  const shuttle = play(s, '00:00:01:00', 60, { t0: p.t, step: 2 });
  assert.equal(shuttle.actions.filter((x) => x.type === 'fire').length, 0, '2× shuttle from park');
});

test('cue engine: a jump below the locate threshold is not played through (chased instead)', () => {
  const e = engineWith(CUES);
  const a = play(e, '00:00:01:00', 15);
  const b = play(e, '00:00:02:01', 25, { t0: a.t });
  assert.equal(fires(b.actions).includes('fire:A'), false);
  assert.deepEqual(labels(b.actions, 'chase'), ['chase:A']);
});

test('cue engine: locate backward re-arms; replaying fires again; reverse never fires', () => {
  const e = engineWith(CUES);
  assert.deepEqual(fires(play(e, '00:00:05:00', 50).actions), ['fire:B']);
  const a2 = play(e, '00:00:03:00', 25 * 3 + 5, { t0: 110 }).actions;
  assert.deepEqual(labels(a2, 'chase'), ['chase:A'], 'scene group re-applied (B was applied), GO not yet');
  assert.deepEqual(fires(a2), ['fire:GO', 'fire:B']);

  const r = engineWith(CUES);
  play(r, '00:00:05:00', 2);
  const rev = play(r, '00:00:05:00', 25 * 3, { t0: 100.08, step: -1 }).actions;
  assert.equal(rev.filter((x) => x.type === 'fire').length, 0);
  const fwd = play(r, '00:00:02:01', 25 * 3, { t0: 104 }).actions;
  assert.deepEqual(fires(fwd), ['fire:GO'], 'A at 00:00:02:00 is behind; GO re-armed');
});

test('cue engine: freewheel keeps firing through a dropout; no duplicate when TC returns', () => {
  const e = engineWith(CUES);
  const { t } = play(e, '00:00:03:00', 20);
  const last = t - 0.04;
  const during = [];
  for (let k = 1; k <= 12; k++) during.push(...e.tick(t + k * 0.03));
  assert.equal(e.state, 'freewheel');
  assert.deepEqual(fires(during), ['fire:GO'], 'cue inside the dropout fires on time');
  const back = play(e, '00:00:04:05', 10, { t0: last + 0.44 }).actions;
  assert.deepEqual(fires(back), []);
  assert.equal(e.state, 'locked');
});

test('cue engine: freewheelFire off holds cues during a dropout and catches up on return', () => {
  const e = engineWith(CUES, { freewheelFire: false });
  const { t } = play(e, '00:00:03:00', 20);
  const last = t - 0.04;
  const during = [];
  for (let k = 1; k <= 12; k++) during.push(...e.tick(t + k * 0.03));
  assert.deepEqual(fires(during), []);
  assert.deepEqual(fires(play(e, '00:00:04:05', 10, { t0: last + 0.44 }).actions), ['fire:GO']);
});

test('cue engine: loss after freewheel; resuming where it stopped keeps the pointer (no chase, no double)', () => {
  const e = engineWith(CUES, { freewheel: 1 });
  const { t } = play(e, '00:00:05:00', 36);
  assert.deepEqual(e.tick(t + 1.5), [{ type: 'lost' }]);
  assert.equal(e.state, 'lost');
  assert.equal(e.status(t + 2).tc, null);
  assert.match(e.status(t + 2).lastTc, /^00:00:06:/);
  const a3 = play(e, '00:00:06:10', 5, { t0: t + 3 }).actions;
  assert.deepEqual(labels(a3), ['rolling:'], 'relock: already-fired cues not re-applied');
  e.invalidate('scene');
  e.stop(t + 4);
  assert.deepEqual(labels(play(e, '00:00:07:00', 20, { t0: t + 5 }).actions, 'chase'), ['chase:B'], 'manual recall invalidated the scene → a locate chases again');
});

test('cue engine: midnight wrap fires in order without chasing across the day boundary', () => {
  const e = engineWith([
    { tc: '23:59:59:20', action: 'slot', slot: 1, label: 'W1' },
    { tc: '00:00:00:00', action: 'start', label: 'W2' },
    { tc: '00:00:00:10', action: 'slot', slot: 2, label: 'W3' },
  ]);
  const { actions } = play(e, '23:59:58:00', 25 * 3);
  assert.deepEqual(fires(actions), ['fire:W1', 'fire:W2', 'fire:W3']);
  assert.equal(labels(actions, 'chase').length, 0);
});

test('cue engine: offsets (negative and wrapping past midnight) and drop-frame cue times', () => {
  const e = engineWith([{ tc: '00:00:10:00', action: 'start', label: 'O' }], { offset: '-01:00:00:00' });
  assert.deepEqual(fires(play(e, '01:00:09:20', 10).actions), ['fire:O']);
  const w = engineWith([{ tc: '00:00:05:00', action: 'start', label: 'W' }], { offset: '+01:00:00:00' });
  const wa = play(w, '23:00:04:00', 40).actions;
  assert.deepEqual(labels(wa).filter((x) => x !== 'rolling:'), ['fire:W'], 'offset wraps to 00:00:04 → fired, not chased');
  const df = engineWith([{ tc: '00:01:00:02', action: 'start', label: 'D' }], { rate: 'auto' });
  const r = play(df, '00:00:59:20', 15, { rate: '29.97df' });
  assert.deepEqual(fires(r.actions), ['fire:D']);
  assert.equal(df.rate(), '29.97df');
  assert.match(df.status(r.t).tc, /^00:01:00;0\d$/);
});

test('cue engine: auto rate upgrades when frame numbers exceed the guess; illegal labels ignored', () => {
  const e = engineWith([], { rate: 'auto' });
  e.input({ tc: T('00:00:01:27') }, 100);
  assert.equal(e.rate(), '30');
  const d = engineWith([], { rate: '29.97df' });
  assert.deepEqual(d.input({ tc: T('00:01:00:00'), rate: '29.97df' }, 100), []);
  assert.equal(d.lastT, null, 'dropped label never becomes a position');
});

test('cue engine: chase is debounced while scrubbing and fires once parked', () => {
  const e = engineWith(CUES);
  const { t } = play(e, '00:00:00:00', 25);
  const scrub = [];
  let now = t;
  for (const s of ['00:00:07:00', '00:00:03:00', '00:00:07:10', '00:00:02:10', '00:00:07:00']) {
    scrub.push(...e.input({ tc: T(s), rate: '25' }, now));
    scrub.push(...e.tick(now + 0.05));
    now += 0.12;
  }
  assert.equal(labels(scrub, 'chase').length, 0, 'no chase while scrubbing');
  assert.equal(e.status(now).chasePending, true);
  const settled = park(e, '00:00:07:00', 0.4, { t0: now });
  assert.deepEqual(labels(settled.actions, 'chase'), ['chase:B', 'chase:GO']);
  assert.ok(settled.actions.filter((a) => a.type === 'chase').every((a) => a.elapsed > 0.9), 'elapsed time reported for fade shortening');
});

test('cue engine: chase resolves the scene per object; home counts as that object\'s scene', () => {
  const range = (s) => {
    const [a, b = a] = s.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  };
  const resolve = (cue) => (cue.targets ? range(cue.targets) : null);
  const e = engineWith([
    { tc: '00:00:02:00', action: 'slot', slot: 1, targets: '1-4', label: 'A' },
    { tc: '00:00:04:00', action: 'slot', slot: 2, targets: '3-8', label: 'B' },
    { tc: '00:00:05:00', action: 'home', targets: '1', label: 'H' },
  ]);
  e.resolveIds = resolve;
  const a = park(e, '00:00:05:10', 0.4, { t0: 100 }).actions.filter((x) => x.type === 'chase');
  assert.deepEqual(a.map((x) => [x.cue.label, x.ids]), [['A', [2]], ['B', [3, 4, 5, 6, 7, 8]], ['H', [1]]]);
  const again = park(e, '00:00:05:20', 0.4, { t0: 101 }).actions;
  assert.equal(labels(again, 'chase').length, 0, 'everything already applied');

  const h = engineWith([
    { tc: '00:00:01:00', action: 'home', label: 'H' },
    { tc: '00:00:02:00', action: 'slot', slot: 1, targets: '1-4', label: 'S' },
  ]);
  h.resolveIds = resolve;
  const b = park(h, '00:00:03:00', 0.4, { t0: 100 }).actions.filter((x) => x.type === 'chase');
  assert.deepEqual(b.map((x) => x.cue.label), ['H', 'S']);
  assert.deepEqual(b[0].ids, range('5-32'), 'home applies only where no later slot cue exists');
  assert.deepEqual(b[1].ids, [1, 2, 3, 4]);
});

test('cue engine: "rolling" (autoStart) is reported once per session', () => {
  const e = engineWith([]);
  const a = play(e, '00:00:01:00', 25);
  const ff = play(e, '00:00:02:00', 10, { t0: a.t, step: 4 });
  const b = play(e, '00:00:03:20', 25, { t0: ff.t });
  assert.equal([...a.actions, ...ff.actions, ...b.actions].filter((x) => x.type === 'rolling').length, 1);
  e.tick(b.t + 5);
  assert.equal(play(e, '00:10:00:00', 10, { t0: b.t + 6 }).actions.filter((x) => x.type === 'rolling').length, 1, 'new session after loss');
});

test('cue engine: cues at the same TC run in list order', () => {
  const two = [
    { tc: '00:00:02:00', action: 'start', label: 'S1' },
    { tc: '00:00:02:00', action: 'freeze', label: 'S2' },
  ];
  assert.deepEqual(fires(play(engineWith(two), '00:00:01:00', 40).actions), ['fire:S1', 'fire:S2']);
  assert.deepEqual(fires(play(engineWith([...two].reverse()), '00:00:01:00', 40).actions), ['fire:S2', 'fire:S1']);
});

test('cue engine: extrapolation fires between frames (sparse 12.5 Hz input)', () => {
  const e = engineWith([{ tc: '00:00:01:02', action: 'start', label: 'X' }]);
  let t = 100;
  const pre = [];
  for (let k = 0; k <= 12; k++) { pre.push(...e.input({ tc: framesToTc(k * 2, '25'), rate: '25' }, t)); t += 0.08; }
  assert.equal(pre.filter((x) => x.type === 'fire').length, 0);
  assert.deepEqual(fires(e.tick(t - 0.08 + 0.13)), ['fire:X'], 'fires before the next frame arrives');
});

test('cue engine: disabled tracks position silently; enabling does not fire the past', () => {
  const e = engineWith(CUES, { enabled: false });
  const a = play(e, '00:00:01:00', 25 * 4).actions;
  assert.equal(a.filter((x) => x.type === 'fire' || x.type === 'chase').length, 0);
  e.setSettings({ enabled: true });
  const b = play(e, '00:00:05:00', 25 * 2, { t0: 104 }).actions;
  assert.deepEqual(fires(b), ['fire:B']);
});

test('cue engine: latency compensation shifts the reference time', () => {
  const e = engineWith([{ tc: '00:00:02:00', action: 'start', label: 'L' }], { latencyMs: 100 });
  const { t } = play(e, '00:00:01:00', 20, { ticks: false });
  const p = e.position(t - 0.04);
  assert.ok(Math.abs(p - (1 + 19 / 25 + 0.1)) < 0.01, `position ${p}`);
});

test('cue engine: next cue countdown, status and scheduler wake time', () => {
  const e = engineWith(CUES);
  const { t } = play(e, '00:00:04:10', 10);
  const st = e.status(t);
  assert.equal(st.state, 'locked');
  assert.equal(st.rolling, true);
  assert.equal(st.next.label, 'B');
  const pos = 4 + 19 / 25 + 0.04;
  assert.ok(Math.abs(st.next.in - (6 - pos)) < 0.05, `countdown ${st.next.in}`);
  assert.ok(Math.abs(e.nextWake(t) - (t + 6 - pos)) < 0.05);
});

test('GO list: standby, go, back, standby n, follow timer; TC never fires in GO mode', () => {
  const e = engineWith([
    { tc: '00:00:02:00', action: 'slot', slot: 1, label: 'Q1', follow: 1 },
    { tc: '00:00:04:00', action: 'start', label: 'Q2' },
    { tc: '00:00:06:00', action: 'stop', label: 'Q3', enabled: false },
    { tc: '00:00:08:00', action: 'freeze', label: 'Q4' },
  ], { trigger: 'go' });
  assert.equal(e.standbyInfo().label, 'Q1');
  assert.deepEqual(fires(play(e, '00:00:01:00', 25 * 8).actions), [], 'GO mode ignores TC');
  assert.deepEqual(labels(e.go(10)), ['go:Q1']);
  assert.equal(e.standbyInfo().label, 'Q2');
  assert.deepEqual(labels(e.tick(10.5)), []);
  assert.deepEqual(labels(e.tick(11)), ['go:Q2'], 'follow 1 s');
  assert.equal(e.standbyInfo().label, 'Q4', 'disabled cue skipped');
  assert.equal(e.back(), true);
  assert.equal(e.standbyInfo().label, 'Q2', 'BACK only moves standby');
  assert.equal(e.standbyTo(4), true);
  assert.deepEqual(labels(e.go(12)), ['go:Q4']);
  assert.equal(e.standbyId, 'end');
  assert.deepEqual(e.go(13), []);
  assert.equal(e.back(), true);
  assert.equal(e.standbyInfo().label, 'Q4');
});

test('validateCue is strict and reports localized field errors; lenient list loader drops bad cues', () => {
  const ok = validateCue({ tc: '1:2:3:4', action: 'slot', slot: '5', label: 'x\u0000y', targets: 'ALL', enabled: 'false' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.cue.tc, '01:02:03:04');
  assert.equal(ok.cue.slot, 5);
  assert.equal(ok.cue.label, 'xy');
  assert.equal(ok.cue.targets, '');
  assert.equal(ok.cue.enabled, false);
  for (const [bad, field] of [
    [{ tc: 'x' }, 'tc'], [{ tc: '-00:00:01:00' }, 'tc'], [{ action: 'nope', slot: 1 }, 'action'],
    [{ slot: 33 }, 'slot'], [{ slot: '2x' }, 'slot'], [{ slot: 1.5 }, 'slot'], [{ slot: 1, fade: 99 }, 'fade'],
    [{ slot: 1, curve: 'boing' }, 'curve'], [{ slot: 1, targets: '1;rm' }, 'targets'], [{}, 'preset'],
  ]) {
    const r = validateCue(bad);
    assert.equal(r.cue, null, JSON.stringify(bad));
    assert.ok(r.errors.some((e) => e.field === field), `${JSON.stringify(bad)} → ${JSON.stringify(r.errors)}`);
  }
  assert.equal(tm(validateCue({ slot: 33 }).errors[0], 'en'), 'Slot: Must be a number between 1 and 32');
  assert.equal(tm(validateCue({ slot: 33 }).errors[0], 'ko'), '슬롯: 1–32 범위의 숫자여야 합니다');
  assert.ok(tm(validateCue({ tc: '00:01:00:00', slot: 1 }, defaultCue(), { rate: '29.97df' }).errors[0], 'en').includes('29.97df'));
  assert.ok(validateCue({ tc: '00:00:00:27', slot: 1 }, defaultCue(), { rate: '25' }).errors.length);
  assert.equal(validateCue({ preset: 'Intro' }).cue.preset, 'Intro', 'preset name alone is enough');
  const list = sanitizeCueList([{ id: 'a1', slot: 1 }, { id: 'a1', slot: 2 }, { slot: 99 }, 'junk', { tc: 'bad', slot: 1 }]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  const sorted = sortCues([{ tc: '00:00:02:00', label: 'b' }, { tc: '00:00:01:00', label: 'a' }, { tc: '00:00:02:00', label: 'c' }]);
  assert.deepEqual(sorted.map((c) => c.label), ['a', 'b', 'c']);
});

test('TC settings sanitizing and OSC timecode args (negatives rejected)', () => {
  const s = sanitizeTcSettings({ rate: 29.97, offset: '00:00:01:00', onLoss: 'boom', freewheel: 0, input: 'internal', trigger: 'go' });
  assert.equal(s.rate, '29.97df');
  assert.equal(s.offset, '+00:00:01:00');
  assert.equal(s.onLoss, 'hold');
  assert.equal(s.freewheel, 0.1);
  assert.equal(s.input, 'internal');
  assert.equal(s.trigger, 'go');
  assert.equal(sanitizeTcSettings({ rate: '23.98' }).rate, '23.976');
  assert.deepEqual(parseOscTc([1, 2, 3, 4]), { tc: { h: 1, m: 2, s: 3, f: 4 }, rate: null });
  assert.deepEqual(parseOscTc(['01:02:03;04']), { tc: { h: 1, m: 2, s: 3, f: 4 }, rate: '29.97df' });
  assert.equal(parseOscTc(['01:02:03:04', 25]).rate, '25');
  assert.equal(parseOscTc([1, 2, 3]), null);
  assert.equal(parseOscTc([25, 0, 0, 0]), null);
  assert.equal(parseOscTc([-1, 0, 0, 0]), null);
  assert.equal(parseOscTc([0, 0, 1.5, 0]), null);
  assert.equal(parseOscTc(['-00:00:01:00']), null);
  assert.equal(parseOscTc(['nope']), null);
});

test('OffsetEstimator maps sender timestamps onto the server clock (min-delay sample)', () => {
  const o = new OffsetEstimator();
  const skew = 5000;
  let last = 0;
  for (let k = 0; k < 100; k++) {
    const sent = 1000 + k * 40;
    const delay = k === 50 ? 1 : 5 + (k * 7) % 20;
    last = o.ref(sent, (sent + skew + delay) / 1000);
  }
  assert.ok(Math.abs(last - (1000 + 99 * 40 + skew + 1) / 1000) < 1e-9);
});

test('InternalClock: play / pause / locate', () => {
  const c = new InternalClock();
  c.locate(10, 0);
  assert.equal(c.position(5), 10);
  c.play(5);
  assert.equal(c.position(7.5), 12.5);
  c.pause(8);
  assert.equal(c.position(20), 13);
  c.locate(2, 20);
  c.play(21);
  assert.equal(c.position(22), 3);
});

export default () => run('Timecode unit tests');
