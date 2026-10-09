import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run } from './harness.js';
import { encodeMessage, encodeBundles, decodePacket, isValidHost } from '../server/osc.js';
import { Engine, MODES, sanitizeObject, defaultObject, mulberry32 } from '../server/engine.js';
import {
  SYSTEMS, MAX_TARGETS, defaultOutputConfig, defaultTarget, sanitizeOutput, sanitizeTarget, targetWarnings, setPlatformForTests,
  applyTransform, lerpScale, pickScale,
} from '../server/adapters.js';
import { safeName, PresetStore, validSlot } from '../server/presets.js';
import { writeFileAtomicAsync } from '../server/fsutil.js';
import { tm, tr, L, DICTS } from '../public/i18n.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Runs the engine on a synthetic clock. */
function runFor(e, seconds, dt = 0.01, onStep = null) {
  let t = e.lastT;
  const n = Math.round(seconds / dt);
  for (let k = 0; k < n; k++) {
    t += dt;
    e.update(t);
    onStep?.(t);
  }
  return t;
}

function freshEngine() {
  const e = new Engine();
  e.updateObjects([1, 2, 3, 4], { enabled: false });
  return e;
}

// ---------- OSC ----------
test('OSC encode/decode round trip', () => {
  const [msg] = decodePacket(encodeMessage('/source/3/xyz', [1.5, -2, { type: 'i', value: 7 }, 'hello']));
  assert.equal(msg.address, '/source/3/xyz');
  assert.deepEqual(msg.args, [1.5, -2, 7, 'hello']);
});

test('OSC bundles split under MTU and decode back', () => {
  const msgs = Array.from({ length: 64 }, (_, i) => ({ address: `/source/${i + 1}/xyz`, args: [{ type: 'f', value: i }, { type: 'f', value: 0.5 }, { type: 'f', value: -1 }] }));
  const bufs = encodeBundles(msgs, 1400);
  assert.ok(bufs.length > 1, 'should split');
  for (const b of bufs) {
    assert.ok(b.length <= 1400, `bundle ${b.length} bytes`);
    assert.equal(b.toString('ascii', 0, 8), '#bundle\0');
    assert.equal(b.readUInt32BE(12), 1, 'immediate timetag');
  }
  const decoded = bufs.flatMap((b) => decodePacket(b));
  assert.equal(decoded.length, 64);
  assert.equal(decoded[63].address, '/source/64/xyz');
});

test('OSC decoder rejects malformed and deeply nested packets', () => {
  assert.throws(() => decodePacket(Buffer.from('noslash\0')));
  assert.throws(() => decodePacket(Buffer.from([0x2f, 0x61, 0x62, 0x63])), RangeError);
  let inner = encodeMessage('/x', []);
  for (let i = 0; i < 6; i++) inner = wrap(inner);
  assert.throws(() => decodePacket(inner), /deep/);
  function wrap(b) {
    const head = Buffer.alloc(16);
    head.write('#bundle\0');
    const len = Buffer.alloc(4);
    len.writeInt32BE(b.length);
    return Buffer.concat([head, len, b]);
  }
});

test('host validation', () => {
  assert.ok(isValidHost('127.0.0.1'));
  assert.ok(isValidHost('ds100.local'));
  assert.ok(!isValidHost(''));
  assert.ok(!isValidHost('  '));
  assert.ok(!isValidHost('bad host'));
  assert.ok(!isValidHost(42));
});

// ---------- adapters ----------
test('L-ISA native: pan 0..1 (0.5 centre), short and long addresses', () => {
  const c = { ...defaultTarget('lisa').cfg };
  assert.equal(defaultTarget('lisa').rate, 25);
  assert.equal(SYSTEMS.lisa.bundleable, true);
  let ms = SYSTEMS.lisa.messages(7, { x: 0, y: -1, z: 0.5 }, c);
  assert.deepEqual(ms.map((m) => m.address), ['/ext/src/7/p', '/ext/src/7/d', '/ext/src/7/e']);
  assert.equal(ms[0].args[0].value, 0.5);
  assert.equal(ms[1].args[0].value, 0);
  assert.equal(SYSTEMS.lisa.messages(7, { x: -1, y: 0, z: 0 }, c)[0].args[0].value, 0);
  assert.equal(SYSTEMS.lisa.messages(7, { x: 1, y: 0, z: 0 }, c)[0].args[0].value, 1);
  ms = SYSTEMS.lisa.messages(7, { x: 0, y: 0, z: 0 }, { ...c, addrStyle: 'long', sendElevation: false });
  assert.deepEqual(ms.map((m) => m.address), ['/ext/src/7/pan', '/ext/src/7/distance']);
  assert.equal(SYSTEMS.lisa.messages(2, { x: 0, y: 0, z: 0 }, { ...c, format: 'adm' })[0].address, '/adm/obj/2/xyz');
});

test('L-ISA polar mapping: azimuth → pan over ±90° / 360°, radius → distance', () => {
  const c = { ...defaultTarget('lisa').cfg, mapping: 'polar', panRange: 180 };
  const pd = (p, cfg = c) => SYSTEMS.lisa.messages(1, p, cfg).slice(0, 2).map((m) => m.args[0].value);
  assert.deepEqual(pd({ x: 0, y: 1, z: 0 }), [0.5, 1], 'front centre');
  const [pr, dr] = pd({ x: 0.5, y: 0, z: 0 });
  assert.ok(near(pr, 1) && near(dr, 0.5), 'right edge at ±90°');
  assert.ok(near(pd({ x: -0.5, y: 0.5, z: 0 })[0], 0.25), 'left 45°');
  const sur = { ...c, panRange: 360 };
  assert.ok(near(pd({ x: 0, y: -1, z: 0 }, sur)[0], 1) || near(pd({ x: 0, y: -1, z: 0 }, sur)[0], 0), 'rear = ±180°');
  assert.ok(near(pd({ x: 1, y: 0, z: 0 }, sur)[0], 0.75), 'right = 90° of 360');
});

test('DS100 position 0..1 on the selected mapping area', () => {
  const c = defaultTarget('ds100').cfg;
  const [m] = SYSTEMS.ds100.messages(12, { x: 1, y: -1, z: 1 }, { ...c, mapping: 3 });
  assert.equal(m.address, '/dbaudio1/coordinatemapping/source_position_xy/3/12');
  assert.deepEqual(m.args.map((a) => a.value), [1, 0]);
});

test('DS100 xyz message and virtual P1/P3 scaling', () => {
  const c = { ...defaultTarget('ds100').cfg, posMsg: 'xyz', minX: -10, maxX: 10, minY: 0, maxY: 20, minZ: 0, maxZ: 5 };
  const [m] = SYSTEMS.ds100.messages(3, { x: 0.5, y: 0, z: 1 }, c);
  assert.equal(m.address, '/dbaudio1/coordinatemapping/source_position/1/3');
  assert.deepEqual(m.args.map((a) => a.value), [5, 10, 5]);
  const [o] = SYSTEMS.ds100.messages(3, { x: 2, y: -2, z: 0 }, c);
  assert.deepEqual(o.args.map((a) => a.value).slice(0, 2), [10, 0], 'clamped to the virtual range');
  const w = targetWarnings({ ...defaultTarget('ds100'), idOffset: 100 }, [20, 40]);
  assert.ok(w.some((s) => s.$t === 'srv.warn.ds100Range' && tm(s, 'en').includes('1–128')), 'source id > 128 warns');
});

test('SPAT Z modes and azimuth hold near the origin', () => {
  const c = { ...defaultTarget('spat').cfg, scaleZ: 4, zMode: 'height' };
  assert.equal(SYSTEMS.spat.messages(1, { x: 0, y: 0, z: -1 }, c)[0].args[2].value, 0, 'height mode: no negative z');
  assert.equal(SYSTEMS.spat.messages(1, { x: 0, y: 0, z: 0.5 }, c)[0].args[2].value, 2);
  assert.equal(SYSTEMS.spat.messages(1, { x: 0, y: 0, z: -1 }, { ...c, zMode: 'sym' })[0].args[2].value, -4);
  const aed = { ...c, format: 'aed', zMode: 'sym' };
  const st = {};
  SYSTEMS.spat.messages(1, { x: 1, y: 0, z: 0 }, aed, st);
  const [held] = SYSTEMS.spat.messages(1, { x: 0.001, y: -0.0001, z: 0.5 }, aed, st);
  assert.ok(near(held.args[0].value, 90), 'azimuth held at the last value through the origin');
});

test('SPAT xyz uses scaleX/scaleY/scaleZ + zOffset, aed is consistent', () => {
  const c = { ...defaultTarget('spat').cfg, scaleX: 4, scaleY: 2, scaleZ: 3, zOffset: 1 };
  const [m] = SYSTEMS.spat.messages(1, { x: 0.5, y: -0.5, z: 0.5 }, c);
  assert.equal(m.address, '/source/1/xyz');
  assert.deepEqual(m.args.map((a) => a.value), [2, -1, 2.5]);
  const [a] = SYSTEMS.spat.messages(1, { x: 0, y: 1, z: 0 }, { ...c, format: 'aed', zOffset: 0 });
  assert.equal(a.address, '/source/1/aed');
  assert.ok(near(a.args[0].value, 0) && near(a.args[1].value, 0) && near(a.args[2].value, 2));
  const [r] = SYSTEMS.spat.messages(1, { x: 1, y: 0, z: 0 }, { ...c, format: 'aed', zOffset: 0 });
  assert.ok(near(r.args[0].value, 90), 'right = +90° azimuth');
});

test('ADM-OSC AED: split keeps the room centre at distance ≈ 0 with height as elevation; azimuth held near centre', () => {
  const c = { ...defaultTarget('adm').cfg, admCoord: 'aed' };
  const st = {};
  const [front] = SYSTEMS.adm.messages(4, { x: 0, y: 0.35, z: 0.2 }, c, st);
  assert.equal(front.address, '/adm/obj/4/aed');
  assert.ok(near(front.args[0].value, 0) && near(front.args[1].value, 18) && near(front.args[2].value, 0.35));
  const [mid] = SYSTEMS.adm.messages(4, { x: 0.0633, y: 0.0052, z: 0.2 }, c, st);
  assert.ok(mid.args[2].value < 0.07, `centre distance ${mid.args[2].value}`);
  assert.ok(near(mid.args[1].value, 18), 'elevation from z, not from the near-vertical angle');
  assert.ok(near(mid.args[0].value, -85.3, 0.1), 'outside the hold radius the azimuth is computed (+ = left)');
  const [held] = SYSTEMS.adm.messages(4, { x: 0.001, y: -0.002, z: 0.2 }, c, st);
  assert.ok(near(held.args[0].value, mid.args[0].value), 'azimuth held inside the hold radius');
  const [geo] = SYSTEMS.adm.messages(4, { x: 0.0633, y: 0.0052, z: 0.2 }, { ...c, admElev: 'geo' }, {});
  assert.ok(near(geo.args[2].value, 0.2099, 1e-3) && geo.args[1].value > 70, '3D geometry is singular near the vertical axis');
  assert.equal(SYSTEMS.lisa.messages(4, { x: 0, y: 0, z: 0 }, { ...defaultTarget('lisa').cfg, format: 'adm', admCoord: 'aed' })[0].address, '/adm/obj/4/aed');
});

test('ADM-OSC is clamped to -1..1', () => {
  const [m] = SYSTEMS.adm.messages(3, { x: 2, y: -2, z: 0.3 }, {});
  assert.deepEqual(m.args.map((a) => a.value), [1, -1, 0.3]);
});

test('sanitizeTarget rejects inherited system keys and keeps previous values', () => {
  const prev = defaultTarget('lisa', 't1');
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(sanitizeTarget({ system: bad }, prev).system, 'lisa', bad);
  }
  const sp = defaultTarget('spat', 't1');
  const s = sanitizeTarget(JSON.parse('{"host":"","port":"x","rate":-5,"cfg":{"scaleXY":7},"transform":{"flipX":"false"}}'), sp);
  assert.equal(s.host, sp.host);
  assert.equal(s.port, sp.port);
  assert.equal(s.rate, sp.rate);
  assert.equal(s.cfg.scaleX, 7, 'scaleXY migrates to scaleX');
  assert.equal(s.cfg.scaleY, 7);
  assert.equal(s.transform.flipX, false, 'string "false" is false');
  assert.equal(sanitizeTarget({ host: 'bad host!' }, sp).host, sp.host);
  const sw = sanitizeTarget({ system: 'ds100' }, sp);
  assert.equal(sw.port, 50010, 'system change starts from that system\'s defaults');
});

test('old single-output config migrates to one target; target list is capped', () => {
  const old = { system: 'ds100', systems: { ds100: { host: '10.0.0.5', port: 50010, rate: 15, mapping: 2 } }, transform: { flipY: true }, precise: true };
  const out = sanitizeOutput(old, defaultOutputConfig());
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].system, 'ds100');
  assert.equal(out.targets[0].host, '10.0.0.5');
  assert.equal(out.targets[0].rate, 15);
  assert.equal(out.targets[0].cfg.mapping, 2);
  assert.equal(out.targets[0].transform.flipY, true);
  assert.equal(out.precise, true);
  const many = sanitizeOutput({ targets: Array.from({ length: 20 }, () => ({ system: 'adm' })) }, defaultOutputConfig());
  assert.equal(many.targets.length, MAX_TARGETS);
  assert.equal(new Set(many.targets.map((t) => t.id)).size, MAX_TARGETS, 'unique ids');
});

// ---------- output scaling ----------
const ADAPTER_CASES = [
  ['spat xyz', 'spat', {}], ['spat aed', 'spat', { format: 'aed' }],
  ['lisa native', 'lisa', {}], ['lisa polar', 'lisa', { mapping: 'polar', panRange: 360 }], ['lisa adm', 'lisa', { format: 'adm' }],
  ['ds100 xy', 'ds100', {}], ['ds100 xyz', 'ds100', { posMsg: 'xyz', minX: -10, maxX: 10 }],
  ['adm xyz', 'adm', {}], ['adm aed', 'adm', { admCoord: 'aed' }], ['custom', 'custom', {}],
];
const PTS = [{ x: 0.3, y: -0.7, z: 0.25 }, { x: -1, y: 1, z: -1 }, { x: 0.123456789, y: 0.5, z: 0.999 }];
const send = (sys, cfg, tf, p) => SYSTEMS[sys].messages(5, applyTransform(p, tf), cfg, {});

test('output scale: default transform is identity — byte-identical messages for every adapter', () => {
  const tf = defaultTarget('spat').transform;
  assert.deepEqual(pickScale(tf), { scaleX: 1, scaleY: 1, scaleZ: 1, offsetX: 0, offsetY: 0, offsetZ: 0 });
  assert.equal(tf.clamp, true);
  for (const [label, sys, extra] of ADAPTER_CASES) {
    const cfg = { ...defaultTarget(sys).cfg, ...extra };
    for (const p of PTS) {
      assert.deepEqual(send(sys, cfg, tf, p), SYSTEMS[sys].messages(5, p, cfg, {}), label);
      assert.deepEqual(send(sys, cfg, { flipX: false, flipY: false, swapXY: false }, p), SYSTEMS[sys].messages(5, p, cfg, {}), `${label} (old transform)`);
    }
  }
  const out = { x: 1.5, y: 0, z: 0 };
  assert.deepEqual(applyTransform(out, tf), out, 'identity never clamps');
});

test('output scale: scale, offset and clamp in the normalized cube (after flip/swap)', () => {
  const base = defaultTarget('spat').transform;
  const tf = { ...base, scaleX: 0.5, scaleY: 2, scaleZ: 0, offsetX: 0.1, offsetY: 0, offsetZ: 0.2 };
  const q = applyTransform({ x: 0.4, y: 0.3, z: 0.9 }, tf);
  assert.ok(near(q.x, 0.3) && near(q.y, 0.6) && near(q.z, 0.2));
  const c = applyTransform({ x: 1, y: 0.8, z: -1 }, { ...base, scaleX: 3, scaleY: 3, offsetZ: -0.5 });
  assert.deepEqual([c.x, c.y, c.z], [1, 1, -1], 'clamped to -1..1');
  const u = applyTransform({ x: 1, y: 0.8, z: 0 }, { ...base, scaleX: 3, clamp: false });
  assert.equal(u.x, 3, 'clamp off lets SPAT/custom exceed the configured half-width');
  const s = applyTransform({ x: 0.5, y: 0.1, z: 0 }, { ...base, swapXY: true, flipX: true, scaleX: 2 });
  assert.ok(near(s.x, -0.2) && near(s.y, 0.5), 'scale applies to the output axes');
});

test('output scale per adapter: SPAT metres, polar in Cartesian space, ADM/L-ISA/DS100 stay in range', () => {
  const tf = { ...defaultTarget('spat').transform, scaleX: 2, scaleY: 2, scaleZ: 2 };
  const spat = { ...defaultTarget('spat').cfg, scaleX: 5, scaleY: 5, scaleZ: 3 };
  assert.deepEqual(send('spat', spat, tf, { x: 0.25, y: -0.25, z: 0.5 })[0].args.map((a) => a.value), [2.5, -2.5, 3]);
  assert.deepEqual(send('spat', spat, tf, { x: 0.9, y: 0, z: 0 })[0].args.map((a) => a.value), [5, 0, 0], 'clamped at the SPAT half-width');
  const [aed] = send('spat', { ...spat, format: 'aed' }, tf, { x: 0.3, y: 0.3, z: 0 });
  assert.ok(near(aed.args[0].value, 45) && near(aed.args[2].value, Math.hypot(3, 3)), 'AED: azimuth kept, distance scaled');
  const adm = send('adm', { ...defaultTarget('adm').cfg, admCoord: 'aed' }, tf, { x: 0, y: 0.3, z: 0 })[0];
  assert.ok(near(adm.args[2].value, 0.6), 'ADM AED distance scaled');
  for (const v of send('adm', defaultTarget('adm').cfg, tf, { x: 0.8, y: -0.9, z: 1 })[0].args) assert.ok(Math.abs(v.value) <= 1);
  const lisa = send('lisa', { ...defaultTarget('lisa').cfg, mapping: 'polar' }, { ...tf, scaleX: 0.5, scaleY: 0.5 }, { x: 0, y: 1, z: 0 });
  assert.ok(near(lisa[1].args[0].value, 0.5), 'L-ISA polar radius halved');
  const ds = send('ds100', defaultTarget('ds100').cfg, { ...tf, scaleX: 0.5, offsetX: 0.5 }, { x: -1, y: 0, z: 0 })[0];
  assert.ok(near(ds.args[0].value, 0.5), 'DS100: -1 × 0.5 + 0.5 = 0 → mapping-area centre');
  const cu = send('custom', defaultTarget('custom').cfg, { ...tf, offsetX: 0.5, scaleX: 1 }, { x: 0.25, y: 0, z: 0 })[0];
  assert.ok(near(cu.args[0].value, 0.75));
});

test('output scale validation: strict ranges keep the previous value, old targets get defaults', () => {
  const sp = defaultTarget('spat', 't1');
  const ok = sanitizeTarget({ transform: { scaleX: '2.5', offsetY: -0.25, clamp: 'false' } }, sp);
  assert.deepEqual([ok.transform.scaleX, ok.transform.offsetY, ok.transform.clamp, ok.transform.flipX], [2.5, -0.25, false, false]);
  for (const bad of [-0.1, 4.01, 'x', '', null, NaN, Infinity, {}, [2]]) {
    assert.equal(sanitizeTarget({ transform: { scaleY: bad } }, ok).transform.scaleY, 1, `scale ${String(bad)}`);
  }
  for (const bad of [-1.01, 1.5, 'x', '', null, NaN, -Infinity, {}, [0.2]]) {
    assert.equal(sanitizeTarget({ transform: { offsetZ: bad } }, ok).transform.offsetZ, 0, `offset ${String(bad)}`);
  }
  const old = sanitizeOutput({ targets: [{ id: 't1', system: 'adm', transform: { flipY: true } }] }, defaultOutputConfig());
  assert.deepEqual(pickScale(old.targets[0].transform), pickScale(sp.transform));
  assert.equal(old.targets[0].transform.flipY, true);
  assert.equal(old.targets[0].transform.clamp, true);
  const sw = sanitizeTarget({ system: 'lisa' }, ok);
  assert.equal(sw.transform.scaleX, 2.5, 'system change keeps the scale');
});

test('output scale ramp: linear glide, exact target at the end', () => {
  const a = pickScale(defaultTarget('spat').transform);
  const b = { ...a, scaleX: 3, offsetZ: -1 };
  const mid = lerpScale(a, b, 0.5);
  assert.ok(near(mid.scaleX, 2) && near(mid.offsetZ, -0.5) && mid.scaleY === 1);
  assert.equal(lerpScale(b, a, 1), a, 'end returns the exact target (identity stays byte-identical)');
  assert.deepEqual(lerpScale(a, b, -3), a);
});

// ---------- engine ----------
test('every mode stays in bounds and moves', () => {
  const e = freshEngine();
  MODES.forEach((mode, i) => e.updateObjects([i + 1], {
    enabled: true, mode, rangeShape: ['box', 'ellipse', 'ring'][i % 3], center: { x: 0.2, y: -0.1, z: 0 }, range: { x: 0.5, y: 0.5, z: 0.3 },
    timing: { sync: i % 2 ? 'tempo' : 'free', min: 0.05, max: 0.1, divisions: [0.25, 0.5] },
  }));
  e.setRunning(true, e.lastT);
  const startPos = e.positions();
  runFor(e, 8, 0.02, () => {
    for (const p of e.positions()) for (const v of p) assert.ok(v >= -1 && v <= 1, 'out of bounds');
  });
  const end = e.positions();
  MODES.forEach((mode, i) => {
    if (mode !== 'hold') assert.notDeepEqual(end[i], startPos[i], `${mode} did not move`);
  });
});

test('live preview: region edits carry running step motion immediately (off = waits for next step)', () => {
  for (const live of [true, false]) {
    for (const mode of ['jitter', 'glide', 'path']) {
      const e = freshEngine();
      e.applyMaster({ livePreview: live });
      e.updateObjects([1], {
        enabled: true, mode, rangeShape: 'box', center: { x: -0.3, y: 0, z: 0 }, range: { x: 0.4, y: 0.4, z: 0 },
        glide: 0.9, timing: { sync: 'free', min: 30, max: 30 },
      }, e.lastT);
      e.setRunning(true, e.lastT);
      runFor(e, 3, 0.02);
      const before = e.positions()[0];
      e.nudgeCenters([1], 0.5, 0, 0, e.lastT);
      runFor(e, 0.02, 0.02);
      const after = e.positions()[0];
      if (live) assert.ok(near(after[0] - before[0], 0.5, 0.03), `${mode}: live shift ${after[0] - before[0]}`);
      else assert.ok(Math.abs(after[0] - before[0]) < 0.05, `${mode}: non-live should not jump yet`);
      if (live) {
        e.updateObjects([1], { range: { x: 0.2, y: 0.2, z: 0 } }, e.lastT);
        runFor(e, 0.02, 0.02);
        const p = e.positions()[0];
        assert.ok(Math.abs(p[0] - 0.2) <= 0.2 + 1e-6 && Math.abs(p[1]) <= 0.2 + 1e-6, `${mode}: inside shrunk region ${p}`);
      }
    }
  }
});

test('live preview: shape change re-targets into the new region within a short fade', () => {
  const e = freshEngine();
  e.updateObjects([1], {
    enabled: true, mode: 'jitter', rangeShape: 'box', center: { x: 0, y: 0, z: 0 }, range: { x: 0.8, y: 0.8, z: 0 },
    timing: { sync: 'free', min: 30, max: 30 },
  }, e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 1, 0.02);
  e.updateObjects([1], { rangeShape: 'ring', innerRadius: 0.9 }, e.lastT);
  runFor(e, 0.12, 0.02);
  const [x, y] = e.positions()[0];
  const rr = Math.hypot(x / 0.8, y / 0.8);
  assert.ok(rr >= 0.89 && rr <= 1.01, `on ring after live fade (r=${rr})`);
});

test('per-object transport: pause holds one object while running; play runs one object while stopped; global START/STOP resets', () => {
  const e = freshEngine();
  e.updateObjects([1, 2], { enabled: true, mode: 'drift', range: { x: 0.6, y: 0.6, z: 0 }, driftRate: 1 }, e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 0.5, 0.02);
  assert.deepEqual(e.setObjectsRunning([2], false, e.lastT), [2]);
  assert.equal(e.runMask(), 0b01);
  const held = e.positions()[1];
  const p1 = e.positions()[0];
  runFor(e, 1, 0.02);
  assert.deepEqual(e.positions()[1], held, 'paused object holds');
  assert.notDeepEqual(e.positions()[0], p1, 'other object keeps moving');
  assert.deepEqual(e.setObjectsRunning([2], false, e.lastT), [], 'no-op when already paused');
  e.setObjectsRunning([2], true, e.lastT);
  runFor(e, 2, 0.02);
  assert.notDeepEqual(e.positions()[1], held, 'resumed');

  e.setRunning(false, e.lastT);
  assert.equal(e.runMask(), 0);
  e.setObjectsRunning([1], true, e.lastT);
  assert.equal(e.runMask(), 0b01);
  const s1 = e.positions()[0];
  const s2 = e.positions()[1];
  runFor(e, 1, 0.02);
  assert.notDeepEqual(e.positions()[0], s1, 'solo object moves while global is stopped');
  assert.deepEqual(e.positions()[1], s2, 'others stay stopped');

  e.setObjectsRunning([2], false, e.lastT);
  e.setRunning(true, e.lastT);
  assert.equal(e.runMask(), 0b11, 'global START plays everything');
  e.setObjectsRunning([1], false, e.lastT);
  e.setRunning(false, e.lastT);
  e.setRunning(true, e.lastT);
  assert.equal(e.runMask(), 0b11, 'per-object pause does not survive a global restart');
  e.setRunning(false, e.lastT);
  e.setObjectsRunning([1], true, e.lastT);
  e.setRunning(false, e.lastT);
  assert.equal(e.runMask(), 0, 'global STOP stops solo objects');
});

test('per-object transport: tempo steps resume on the grid without a catch-up burst', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'jitter', timing: { sync: 'tempo', divisions: [1] } }, e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 1, 0.01);
  e.setObjectsRunning([1], false, e.lastT);
  runFor(e, 4, 0.01);
  e.setObjectsRunning([1], true, e.lastT);
  let jumps = 0;
  let last = e.positions()[0].join();
  runFor(e, 0.3, 0.01, () => {
    const p = e.positions()[0].join();
    if (p !== last) jumps++;
    last = p;
  });
  assert.ok(jumps <= 1, `at most one step right after resume (got ${jumps})`);
});

const SQUARE = [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 0.2], [-0.5, -0.5, 0]];
const drawnPatch = (extra = {}) => ({
  enabled: true, mode: 'path', pathSource: 'custom', pathPts: SQUARE, center: { x: 0, y: 0, z: 0 },
  glide: 1, easing: 'linear', pathCurve: 'linear', timing: { sync: 'free', min: 4, max: 4 }, ...extra,
});

test('drawn path: points are sanitized and capped', () => {
  const o = sanitizeObject({ pathSource: 'custom', pathPts: [[0.1, 0.2], { x: 3, y: -3, z: 0.5 }, ['a', 0], 'x', [0.123456, 0, 0]] }, 1);
  assert.deepEqual(o.pathPts, [[0.1, 0.2, 0], [2, -2, 0.5], [0.1235, 0, 0]]);
  assert.equal(sanitizeObject({ pathPts: Array.from({ length: 100 }, () => [0, 0, 0]) }, 1).pathPts.length, 64);
  assert.equal(sanitizeObject({ pathSource: 'nope' }, 1).pathSource, 'random');
  assert.deepEqual(defaultObject(1).pathPts, []);
});

test('drawn path: visits the drawn points in order, offset by the center', () => {
  const e = freshEngine();
  e.updateObjects([1], drawnPatch({ center: { x: 0.2, y: 0, z: 0 }, glide: 0.5 }), e.lastT);
  e.setRunning(true, e.lastT);
  const seen = [];
  runFor(e, 25, 0.02, () => {
    const [x, y, z] = e.positions()[0];
    SQUARE.forEach((p, k) => {
      if (Math.hypot(x - (p[0] + 0.2), y - p[1], z - p[2]) < 0.005 && seen.at(-1) !== k) seen.push(k);
    });
  });
  const str = seen.join('');
  assert.ok(str.includes('0123') || str.includes('1230') || str.includes('2301') || str.includes('3012'), `loop order (got ${str})`);
});

test('drawn path: even timing gives one lap per Min–Max and a start offset per object', () => {
  const e = freshEngine();
  e.updateObjects([1, 2], drawnPatch({ pathTiming: 'even' }), e.lastT);
  e.updateObjects([2], { pathStart: 0.5 }, e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 8, 0.01);
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.02;
  const t0 = e.lastT;
  const hits = [];
  runFor(e, 8.5, 0.01, (t) => { if (near(e.positions()[0], SQUARE[0]) && (!hits.length || t - hits.at(-1) > 1)) hits.push(t); });
  assert.ok(hits.length >= 2, 'reaches point 1 every lap');
  assert.ok(Math.abs(hits[1] - hits[0] - 4) < 0.15, `lap ≈ 4 s (got ${(hits[1] - hits[0]).toFixed(2)})`);
  const [a, b] = e.positions();
  assert.ok(Math.hypot(a[0] + b[0], a[1] + b[1]) < 0.1, 'start offset 50% keeps the two objects opposite');
  assert.ok(t0 > 0);
});

test('drawn path: dragging a point while running re-aims the move in flight', () => {
  const e = freshEngine();
  e.updateObjects([1], drawnPatch(), e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 2.5, 0.01);
  const r = e.rt[0];
  const k = r.toIdx;
  assert.ok(k >= 0);
  const pts = SQUARE.map((p) => [...p]);
  pts[k] = [pts[k][0] * 0.5, pts[k][1] * 0.5, 0];
  e.updateObjects([1], { pathPts: pts }, e.lastT);
  assert.ok(Math.hypot(r.to.x - pts[k][0], r.to.y - pts[k][1]) < 1e-9, 'target follows the edited point');
  assert.equal(r.resumeIdx, k);
  const before = e.positions()[0];
  runFor(e, 0.02, 0.01);
  const after = e.positions()[0];
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.05, 'no jump');
});

test('drawn path: fewer than 2 points falls back to random waypoints', () => {
  const e = freshEngine();
  e.updateObjects([1], drawnPatch({ pathPts: [[0.3, 0.3, 0]] }), e.lastT);
  e.setRunning(true, e.lastT);
  runFor(e, 6, 0.02);
  assert.ok(e.positions()[0].every(Number.isFinite));
});

test('live preview: touched objects stay output-active briefly', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true }, e.lastT);
  const t0 = e.lastT;
  e.nudgeCenters([1], 0.1, 0, 0, t0);
  assert.ok(e.isLiveTouched(0, t0 + 0.5));
  assert.ok(!e.isLiveTouched(0, t0 + 1.5));
  e.applyMaster({ livePreview: false });
  assert.ok(!e.isLiveTouched(0, t0 + 0.5));
  assert.equal(e.settings().livePreview, false);
});

test('tempo grid: steps land on division grid (+ phase offset)', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'jitter', timing: { sync: 'tempo', divisions: [1] } });
  e.updateObjects([2], { enabled: true, mode: 'glide', timing: { sync: 'tempo', divisions: [0.5], phaseOffset: 0.5 } });
  e.updateObjects([3], { enabled: true, mode: 'glide', timing: { sync: 'tempo', divisions: [1 / 3] } });
  e.setRunning(true, e.lastT);
  const seen = [new Set(), new Set(), new Set()];
  runFor(e, 6, 0.005, () => { for (let i = 0; i < 3; i++) seen[i].add(e.rt[i].tNext); });
  for (const b of seen[0]) assert.ok(near(b, Math.round(b), 1e-6), `beat ${b} not on grid`);
  for (const b of seen[1]) assert.ok(near(((b % 0.5) + 0.5) % 0.5, 0.25, 1e-6), `beat ${b} not on half-beat grid offset by 0.25`);
  for (const b of seen[2]) assert.ok(near(b * 3, Math.round(b * 3), 1e-6), `triplet ${b}`);
  assert.ok(seen[0].size >= 8);
});

test('tempo mult and speedScale scale divisions on the grid', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'jitter', timing: { sync: 'tempo', divisions: [1] } });
  e.setTempoMult(2);
  e.setRunning(true, e.lastT);
  const seen = new Set();
  runFor(e, 3, 0.005, () => seen.add(e.rt[0].tNext));
  for (const b of seen) assert.ok(near(b * 2, Math.round(b * 2), 1e-6));
  assert.ok([...seen].some((b) => !near(b, Math.round(b))), 'half-beat steps expected at ×2');
});

test('BPM change stretches a running glide without a jump', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'glide', glide: 1, easing: 'linear', range: { x: 1, y: 1, z: 0 }, timing: { sync: 'tempo', divisions: [4] } });
  e.setRunning(true, e.lastT);
  let t = runFor(e, 3.2, 0.01);
  const r = e.rt[0];
  const endBeat = r.tEnd;
  const before = { ...r.pos };
  e.setBpm(60, t);
  e.update(t);
  assert.ok(Math.hypot(r.pos.x - before.x, r.pos.y - before.y) < 1e-6, 'position jumped on BPM change');
  assert.equal(r.tEnd, endBeat, 'end stays on the same beat');
  const remainingSec = e.timeAtBeat(endBeat) - t;
  const remainingBeats = endBeat - e.beatAt(t);
  assert.ok(near(remainingSec, remainingBeats, 1e-6), 'at 60 BPM one beat = 1 s');
  t = runFor(e, 0.1, 0.01);
});

test('tap tempo: median with outlier rejection, phase aligned, slow tempos', () => {
  const e = freshEngine();
  for (const t of [100, 100.5, 101, 101.5, 102.6, 103.1]) e.tap(t);
  assert.ok(Math.abs(e.clock.bpm - 120) < 1, `bpm ${e.clock.bpm}`);
  assert.ok(near(e.beatAt(103.1), Math.round(e.beatAt(103.1)), 1e-9), 'last tap is on a beat');
  const s = freshEngine();
  for (const t of [10, 12, 14, 16]) s.tap(t);
  assert.ok(Math.abs(s.clock.bpm - 30) < 0.01, `slow bpm ${s.clock.bpm}`);
  const one = freshEngine();
  const origin = one.clock.origin;
  one.tap(50);
  assert.equal(one.clock.origin, origin, 'a single tap must not move the phase');
});

test('resync re-aims tempo motion instead of jumping', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'glide', glide: 1, timing: { sync: 'tempo', divisions: [2] } });
  e.setRunning(true, e.lastT);
  let t = runFor(e, 1.3, 0.01);
  const before = { ...e.rt[0].pos };
  e.resync(t);
  t += 0.01;
  e.update(t);
  const after = e.rt[0].pos;
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 0.05, 'jumped on resync');
  assert.ok(near(e.rt[0].tNext, Math.round(e.rt[0].tNext / 2) * 2, 1e-9), 'next step on new grid');
});

test('free-mode speed acts on motion time (0 = freeze) immediately', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'glide', glide: 1, timing: { sync: 'free', min: 2, max: 2 } });
  e.setRunning(true, e.lastT);
  runFor(e, 0.5);
  e.setSpeed(0);
  const p = { ...e.rt[0].pos };
  runFor(e, 1);
  assert.deepEqual(e.rt[0].pos, p);
  e.setSpeed(2, 1);
  runFor(e, 0.05);
  assert.ok(e.master.speed > 0 && e.master.speed < 2, 'ramping');
});

test('loadScene with ids matches by id only (sparse presets)', () => {
  const e = freshEngine();
  e.updateObjects([1], { name: 'keep me', mode: 'drift' });
  const n = e.loadScene({ objects: [{ id: 5, mode: 'orbit', enabled: true, name: 'five' }] });
  assert.equal(n, 1);
  assert.equal(e.objects[0].name, 'keep me');
  assert.equal(e.objects[0].mode, 'drift');
  assert.equal(e.objects[4].mode, 'orbit');
  assert.equal(e.objects[4].name, 'five');
  e.loadScene({ objects: [{ name: 'legacy first' }] });
  assert.equal(e.objects[0].name, 'legacy first', 'id-less arrays still load by index');
  e.loadScene({ objects: [{ id: 2, name: 'two' }, { id: 3, name: 'three' }] }, { onlyIds: [3] });
  assert.equal(e.objects[1].name, 'Obj 2');
  assert.equal(e.objects[2].name, 'three');
});

test('sanitize falls back to the previous value and parses booleans strictly', () => {
  const e = freshEngine();
  e.updateObjects([1], { range: { x: 0.33 }, mode: 'path', enabled: true });
  e.updateObjects([1], { range: { x: 'abc' }, mode: 'nope', glide: null, enabled: 'false' });
  assert.equal(e.objects[0].range.x, 0.33);
  assert.equal(e.objects[0].mode, 'path');
  assert.equal(e.objects[0].glide, 1);
  assert.equal(e.objects[0].enabled, false);
  const o = sanitizeObject({ timing: { divisions: [0.3333333, 7, 'x'] } }, 1);
  assert.equal(o.timing.divisions.length, 1);
  assert.ok(near(o.timing.divisions[0], 1 / 3));
  assert.deepEqual(sanitizeObject(null, 2), defaultObject(2));
});

test('timing min above max pushes max', () => {
  const e = freshEngine();
  e.updateObjects([1], { timing: { min: 1, max: 2 } });
  e.updateObjects([1], { timing: { min: 5 } });
  assert.equal(e.objects[0].timing.max, 5);
  e.updateObjects([1], { timing: { max: 0.5 } });
  assert.equal(e.objects[0].timing.min, 0.5);
});

test('no startup jump: stopped objects sit at their centre; editing centre moves output', () => {
  const e = freshEngine();
  e.loadScene({ objects: [{ id: 1, enabled: true, center: { x: 0.5, y: 0.4, z: 0.1 } }] }, { fade: 0 });
  e.update(e.lastT + 0.01);
  assert.deepEqual(e.positions()[0], [0.5, 0.4, 0.1]);
  e.updateObjects([1], { center: { x: -0.3 } });
  e.update(e.lastT + 0.01);
  assert.equal(e.positions()[0][0], -0.3);
});

test('mode change crossfades (no jump between frames)', () => {
  const e = freshEngine();
  e.master.transition = 1;
  e.updateObjects([1], { enabled: true, mode: 'hold', center: { x: 0, y: 0, z: 0 }, range: { x: 0.9, y: 0.9, z: 0 } });
  e.setRunning(true, e.lastT);
  runFor(e, 0.2);
  e.updateObjects([1], { mode: 'orbit' }, e.lastT);
  let prev = e.rt[0].pos;
  let maxStep = 0;
  runFor(e, 1.5, 0.01, () => {
    const p = e.rt[0].pos;
    maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  });
  assert.ok(maxStep < 0.08, `max step per 10 ms ${maxStep}`);
});

test('jump slew turns jitter jumps into short ramps', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'jitter', jumpSlew: 100, minStep: 0.8, range: { x: 1, y: 1, z: 0 }, timing: { sync: 'free', min: 0.5, max: 0.5 } });
  e.setRunning(true, e.lastT);
  let prev = e.rt[0].pos;
  let maxStep = 0;
  runFor(e, 3, 0.01, () => {
    const p = e.rt[0].pos;
    maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  });
  assert.ok(maxStep > 0 && maxStep < 0.4, `step ${maxStep}`);
});

test('jump slew accepts up to 2000 ms and ramps linearly over that time', () => {
  const e = freshEngine();
  e.updateObjects([1], { jumpSlew: 5000 });
  assert.equal(e.objects[0].jumpSlew, 2000);
  e.applyMaster({ transition: 0 });
  e.updateObjects([1], { enabled: true, mode: 'jitter', jumpSlew: 1000, minStep: 0.8, restChance: 0, range: { x: 1, y: 1, z: 0 }, timing: { sync: 'free', min: 5, max: 5 } });
  e.setRunning(true, e.lastT);
  runFor(e, 0.05, 0.01);
  e.rt[0].tNext = e.rt[0].tau;
  let prev = e.rt[0].pos;
  let moving = 0;
  runFor(e, 1.5, 0.02, () => {
    const p = e.rt[0].pos;
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-4) moving++;
    prev = p;
  });
  assert.ok(moving >= 40 && moving <= 55, `frames moving during 1000 ms slew: ${moving}`);
});

test('random points are uniform inside the clipped region (no edge clumping)', () => {
  const e = freshEngine();
  const o = { ...defaultObject(1), center: { x: 0.9, y: 0, z: 0 }, range: { x: 0.5, y: 0.5, z: 0 }, minStep: 0 };
  const r = e.rt[0];
  let atEdge = 0;
  for (let i = 0; i < 2000; i++) {
    const p = e.randomPoint(o, r, { x: 0, y: 0, z: 0 });
    assert.ok(p.x >= 0.4 && p.x <= 1);
    if (p.x > 0.99) atEdge++;
  }
  assert.ok(atEdge < 100, `edge clumping: ${atEdge}`);
  const ring = { ...o, center: { x: 0, y: 0, z: 0 }, rangeShape: 'ring', innerRadius: 0.6 };
  for (let i = 0; i < 500; i++) {
    const p = e.randomPoint(ring, r, { x: 0, y: 0, z: 0 });
    assert.ok(Math.hypot(p.x / 0.5, p.y / 0.5) >= 0.6 - 1e-9, 'ring avoids centre');
  }
});

test('path order: ping-pong revisits in reverse, shuffle covers all points', () => {
  const e = freshEngine();
  const o = { ...defaultObject(1), mode: 'path', pathPoints: 4, pathRegen: false, pathOrder: 'pingpong' };
  const r = e.rt[0];
  const seq = Array.from({ length: 6 }, () => e.nextWaypoint(o, r));
  const idx = seq.map((p) => r.wps.findIndex((w) => w.x === p.x && w.y === p.y));
  assert.deepEqual(idx, [0, 1, 2, 3, 2, 1]);
  const r2 = e.makeRuntime(o);
  const o2 = { ...o, pathOrder: 'shuffle' };
  const s = Array.from({ length: 4 }, () => e.nextWaypoint(o2, r2)).map((p) => r2.wps.findIndex((w) => w.x === p.x));
  assert.deepEqual([...s].sort(), [0, 1, 2, 3]);
});

test('seeded objects reproduce the same motion with reseedOnStart', () => {
  const trace = () => {
    const e = freshEngine();
    e.master.reseedOnStart = true;
    e.updateObjects([1], { enabled: true, mode: 'glide', seed: 4242, timing: { sync: 'free', min: 0.2, max: 0.6 } });
    e.setRunning(true, e.lastT);
    const out = [];
    runFor(e, 2, 0.02, () => out.push(e.positions()[0].join()));
    return out;
  };
  assert.deepEqual(trace(), trace());
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('stop → return to centre fades; release flag honoured by output layer', () => {
  const e = freshEngine();
  e.master.stopMode = 'center';
  e.master.transition = 0.5;
  e.updateObjects([1], { enabled: true, mode: 'orbit', center: { x: 0.2, y: 0.2, z: 0 }, range: { x: 0.5, y: 0.5, z: 0 } });
  e.setRunning(true, e.lastT);
  runFor(e, 1);
  e.setRunning(false, e.lastT);
  runFor(e, 0.7);
  assert.deepEqual(e.positions()[0], [0.2, 0.2, 0]);
});

test('disable with return-to-centre keeps the object output-active during the fade', () => {
  const e = freshEngine();
  e.master.disableMode = 'center';
  e.master.transition = 0.3;
  e.updateObjects([1], { enabled: true, mode: 'orbit', range: { x: 0.5, y: 0.5, z: 0 } });
  e.setRunning(true, e.lastT);
  runFor(e, 0.5);
  e.updateObjects([1], { enabled: false }, e.lastT);
  assert.ok(e.isOutputActive(0, e.lastT + 0.1));
  runFor(e, 0.6);
  assert.ok(!e.isOutputActive(0, e.lastT));
  assert.deepEqual(e.positions()[0], [0, 0, 0]);
});

test('freeze holds positions', () => {
  const e = freshEngine();
  e.updateObjects([1], { enabled: true, mode: 'drift' });
  e.setRunning(true, e.lastT);
  runFor(e, 0.5);
  e.setFrozen(true);
  const p = e.positions()[0];
  runFor(e, 0.5);
  assert.deepEqual(e.positions()[0], p);
});

// ---------- recall latency ----------
const inRegion = (p, c, r) => Math.abs(p[0] - c) <= r + 1e-6;

for (const mode of MODES) {
  for (const fade of [0, 1]) {
    test(`recall (${mode}, fade ${fade}): new region reached within fade + 1 frame`, () => {
      const e = freshEngine();
      const obj = (cx) => ({ id: 1, enabled: true, mode, center: { x: cx, y: 0, z: 0 }, range: { x: 0.1, y: 0.1, z: 0 }, rangeShape: 'box', timing: { sync: 'free', min: 2, max: 5 }, glide: 0.8, minStep: 0 });
      e.loadScene({ objects: [obj(-0.8)] }, { fade: 0 });
      e.setRunning(true, e.lastT);
      runFor(e, 3, 0.02);
      e.loadScene({ objects: [obj(0.8)] }, { fade, t: e.lastT });
      runFor(e, fade + 0.021, 0.02);
      const r = mode === 'orbit' || mode === 'drift' ? 0.11 : 0.1;
      assert.ok(inRegion(e.positions()[0], 0.8, r), `x=${e.positions()[0][0]}`);
    });
  }
}

test('recall keeps step modes inside the new region afterwards (no drift back)', () => {
  const e = freshEngine();
  e.loadScene({ objects: [{ id: 1, enabled: true, mode: 'jitter', center: { x: -0.8, y: 0, z: 0 }, range: { x: 0.1, y: 0.1, z: 0 }, timing: { min: 0.2, max: 0.4 } }] }, { fade: 0 });
  e.setRunning(true, e.lastT);
  runFor(e, 1);
  e.loadScene({ objects: [{ id: 1, enabled: true, mode: 'jitter', center: { x: 0.8, y: 0, z: 0 }, range: { x: 0.1, y: 0.1, z: 0 }, timing: { min: 0.2, max: 0.4 } }] }, { fade: 0.5, t: e.lastT });
  runFor(e, 0.52);
  runFor(e, 3, 0.01, () => assert.ok(inRegion(e.positions()[0], 0.8, 0.1)));
});

test('home lands on the centre within fade + 1 frame and holds one step', () => {
  for (const mode of ['jitter', 'glide', 'path']) {
    const e = freshEngine();
    e.updateObjects([1], { enabled: true, mode, center: { x: 0.3, y: 0, z: 0 }, range: { x: 0.6, y: 0.6, z: 0 }, timing: { min: 1, max: 1.2 } });
    e.setRunning(true, e.lastT);
    runFor(e, 2.3);
    e.home([1], 0.4, e.lastT);
    runFor(e, 0.42);
    const p = e.positions()[0];
    assert.ok(near(p[0], 0.3, 1e-3) && near(p[1], 0, 1e-3), `${mode}: ${p}`);
  }
});

test('stagger delays each object\'s crossfade start; curve is honoured', () => {
  const e = freshEngine();
  const scene = (x) => ({ objects: [1, 2, 3].map((id) => ({ id, enabled: true, mode: 'hold', center: { x, y: 0, z: 0 } })) });
  e.loadScene(scene(-0.5), { fade: 0 });
  e.loadScene(scene(0.5), { fade: 0.2, t: e.lastT, stagger: 1, order: 'id', ease: 'linear' });
  runFor(e, 0.3);
  const p = e.positions();
  assert.ok(near(p[0][0], 0.5, 1e-6), 'first object done');
  assert.ok(near(p[2][0], -0.5, 1e-6), 'last object still waiting');
  runFor(e, 1);
  assert.ok(e.positions().slice(0, 3).every((q) => near(q[0], 0.5, 1e-6)));
});

test('loadScene reseeds seeded objects on every recall (same seed → same motion)', () => {
  const trace = (offset) => {
    const e = freshEngine();
    const sc = { objects: [{ id: 1, enabled: true, mode: 'jitter', seed: 42, timing: { min: 0.1, max: 0.2 } }] };
    e.setRunning(true, e.lastT);
    e.loadScene(sc, { fade: 0, t: e.lastT, seedOffset: offset });
    const out = [];
    runFor(e, 1, 0.01, () => out.push(e.positions()[0][0]));
    return out;
  };
  assert.deepEqual(trace(0), trace(0));
  assert.notDeepEqual(trace(0), trace(3), 'seed offset gives a different variation');
});

test('intentional jumps set the jump bitmask and bypass maxVelocity (option)', () => {
  const e = freshEngine();
  e.updateObjects([2], { enabled: true, mode: 'jitter', jumpSlew: 0, range: { x: 1, y: 1, z: 0 }, minStep: 1, timing: { min: 0.1, max: 0.1 } });
  e.applyMaster({ maxVelocity: 0.1 });
  e.setRunning(true, e.lastT);
  let maxStep = 0;
  let prev = e.positions()[1];
  let bits = 0;
  runFor(e, 1, 0.01, () => {
    const p = e.positions()[1];
    maxStep = Math.max(maxStep, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
    bits |= e.takeJumps();
  });
  assert.equal(bits & 2, 2, 'object 2 flagged');
  assert.ok(maxStep > 0.1, 'jump not slowed down');
  e.applyMaster({ vmaxExceptJumps: false });
  maxStep = 0;
  runFor(e, 1, 0.01, () => {
    const p = e.positions()[1];
    maxStep = Math.max(maxStep, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  });
  assert.ok(maxStep <= 0.1 * 0.01 + 2e-4, `limited ${maxStep}`);
});

// ---------- presets ----------
test('safeName handles Windows reserved names, trailing dots, format chars', () => {
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  assert.equal(safeName('com1'), '_com1');
  assert.equal(safeName('LPT9.json'), '_LPT9.json');
  assert.equal(safeName('console'), 'console');
  assert.equal(safeName('Show 1. . '), 'Show 1');
  assert.equal(safeName('a\u200Bb\u202Ec'), 'abc');
  assert.equal(safeName('a/b:c'), 'a_b_c');
  assert.equal(safeName('...hidden'), 'hidden');
  assert.equal(safeName(123), '');
  assert.equal(safeName(['x']), '');
});

test('PresetStore: atomic save, slots, partial count, metadata cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-presets-'));
  try {
    const store = new PresetStore(dir);
    await store.save('A', { objects: [{ id: 1 }, { id: 2 }] });
    await store.save('B', { objects: Array.from({ length: 32 }, (_, i) => ({ id: i + 1 })) });
    await store.setSlot('A', 3);
    assert.equal(store.bySlot(3).name, 'A');
    await store.setSlot('B', 3);
    assert.equal(store.bySlot(3).name, 'B');
    assert.equal(store.list().find((p) => p.name === 'A').slot, null);
    assert.equal(store.list().find((p) => p.name === 'A').count, 2);
    await store.setMeta('B', { color: 'teal', note: 'intro\u202E' });
    await store.save('B', { objects: [{ id: 1 }] });
    assert.equal(store.bySlot(3).name, 'B', 'overwrite keeps slot');
    assert.equal(store.meta('b').color, 'teal', 'overwrite keeps colour; lookup is case-insensitive');
    assert.equal(store.meta('B').note, 'intro', 'format chars stripped');
    store.invalidate();
    assert.equal(store.bySlot(3).name, 'B', 'slot persisted on disk');
    assert.deepEqual(store.meta('A').ids, [1, 2]);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    store.remove('A');
    assert.ok(!store.list().some((p) => p.name === 'A'));
    assert.throws(() => store.setSlot('B', '2x'), (e) => e.key === 'srv.slot.range' && /1–32/.test(e.message));
    assert.equal(validSlot('7'), 7);
    assert.equal(validSlot(7.5), null);
    assert.equal(validSlot(' '), null);
    assert.equal(validSlot('1e1'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PresetStore perf: 200 presets, 32 slot assignments < 200 ms (no rescans)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-perf-'));
  try {
    const obj = Array.from({ length: 32 }, (_, i) => sanitizeObject({ enabled: true }, i + 1));
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `P${i}.json`), JSON.stringify({ app: 'objitter', objects: obj }));
    const store = new PresetStore(dir);
    store.list();
    const t0 = performance.now();
    const jobs = [];
    for (let s = 1; s <= 32; s++) {
      jobs.push(store.setSlot(`P${s * 3}`, s));
      store.list();
    }
    const ms = performance.now() - t0;
    await Promise.all(jobs);
    assert.ok(ms < 200, `setSlot ×32 took ${ms.toFixed(1)} ms`);
    assert.equal(store.bySlot(32).name, 'P96');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PresetStore: decomposed (NFD, macOS) file names match NFC lookups; no duplicate on save', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-nfd-'));
  try {
    const nfd = '인트로 씬'.normalize('NFD');
    fs.writeFileSync(path.join(dir, `${nfd}.json`), JSON.stringify({ app: 'objitter', objects: [{ id: 1 }], slot: 4 }));
    const store = new PresetStore(dir);
    const nfc = '인트로 씬';
    assert.equal(store.meta(nfc)?.name, nfc, 'listed under the NFC name');
    assert.equal(store.bySlot(4).name, nfc);
    assert.equal(store.load(nfc).slot, 4);
    await store.save(nfc, { objects: [{ id: 1 }, { id: 2 }] });
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1, 'saved over the NFD file');
    assert.equal(store.meta(nfc).count, 2);
    await store.setSlot(nfc.toUpperCase(), 5);
    store.invalidate();
    assert.equal(store.bySlot(5)?.name, nfc);
    store.remove(nfc);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('i18n: en/ko dictionaries have identical keys and placeholders; English has no Hangul', () => {
  const en = Object.keys(DICTS.en).sort();
  const ko = Object.keys(DICTS.ko).sort();
  assert.deepEqual(en.filter((k) => !DICTS.ko[k]), [], 'keys missing in ko');
  assert.deepEqual(ko.filter((k) => !DICTS.en[k]), [], 'keys missing in en');
  const ph = (s) => (typeof s === 'string' ? [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : '');
  for (const k of en) {
    assert.equal(typeof DICTS.en[k], typeof DICTS.ko[k], `${k}: same value type`);
    assert.equal(ph(DICTS.en[k]), ph(DICTS.ko[k]), `${k}: same placeholders`);
    if (typeof DICTS.en[k] === 'string') assert.ok(!/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(DICTS.en[k]), `${k}: Hangul in English`);
  }
  assert.equal(tr('en', 'srv.preset.loaded', { name: 'A', n: 3 }), 'Preset "A" loaded (3 objects)');
  assert.equal(tr('ko', 'srv.preset.loaded', { name: 'A', n: 3 }), '프리셋 "A" 불러옴 (3개 오브젝트)');
  assert.equal(tm({ key: 'nope.key', text: 'fallback' }, 'ko'), 'fallback', 'unknown keys fall back to the server text');
  assert.equal(tm(L('srv.cue.errors', { list: [L('cue.err.notCue'), 'x'], more: '' }), 'en'), 'Cue error — Not a cue · x');
});

test('i18n: every key used in code and index.html exists; adapter texts have en+ko', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'server', f)),
    ...fs.readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'public', f)),
  ];
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:t|L|tk|LocalizedError)\(\s*'([a-zA-Z][\w.]*\.[\w.]+)'/g)) used.add(m[1]);
  }
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) used.add(m[1]);
  const missing = [...used].filter((k) => DICTS.en[k] === undefined);
  assert.deepEqual(missing, [], 'keys used but not defined');
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  assert.ok(!/[\uAC00-\uD7A3]/.test(body), 'index.html has no hard-coded Korean');
  // adapters.js / presets.js carry explicit { en, ko } pairs (checked below)
  for (const f of files.filter((x) => !/(adapters|presets)\.js$/.test(x))) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
      .map((s, i) => [i + 1, s.replace(/\/\/.*$|\/\*.*?\*\//g, '')])
      .filter(([, s]) => /[\uAC00-\uD7A3]/.test(s));
    assert.deepEqual(lines.map(([n]) => n), [], `${path.basename(f)}: UI text must come from public/lang/*.js`);
  }
  for (const [key, sys] of Object.entries(SYSTEMS)) {
    const texts = [sys.help, ...sys.options.flatMap((o) => [o.label, o.note, ...(o.options ?? []).map((x) => x[1])])].filter((v) => v && typeof v === 'object');
    for (const v of texts) assert.ok(v.en && v.ko && !/[\uAC00-\uD7A3]/.test(v.en), `${key}: ${JSON.stringify(v).slice(0, 60)}`);
    const plain = [sys.label, ...sys.options.flatMap((o) => [o.label, o.note, ...(o.options ?? []).map((x) => x[1])])].filter((v) => typeof v === 'string');
    for (const v of plain) assert.ok(!/[\uAC00-\uD7A3]/.test(v), `${key}: untranslated "${v}"`);
  }
});

test('targetWarnings: macOS AirPlay ports 5000/7000 on this machine are flagged (darwin only)', () => {
  const t = { ...defaultTarget('custom'), host: '127.0.0.1', port: 7000 };
  assert.ok(!targetWarnings(t, [1]).some((w) => w.$t === 'srv.warn.macAirPlay') || process.platform === 'darwin');
  setPlatformForTests('darwin');
  try {
    assert.ok(targetWarnings(t, [1]).some((w) => w.$t === 'srv.warn.macAirPlay'));
    assert.ok(!targetWarnings({ ...t, host: '10.0.0.5' }, [1]).some((w) => w.$t === 'srv.warn.macAirPlay'));
  } finally {
    setPlatformForTests(process.platform);
  }
});

test('async atomic writes are serialized per file (last write wins)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-fs-'));
  try {
    const f = path.join(dir, 'x.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomicAsync(f, String(i))));
    assert.equal(fs.readFileSync(f, 'utf8'), '19');
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export default () => run('Unit tests');
