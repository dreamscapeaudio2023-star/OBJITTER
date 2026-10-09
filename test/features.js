// Stage layouts, assets, show clips and automation (pure modules, no server).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, run } from './harness.js';
import {
  parseSpat, parseLisa, parseCsv, parseLayout, aedToXyz, fitScale, sanitizeStage, defaultStage, speakerToStage,
} from '../server/layouts.js';
import { ClipRunner, validateClips } from '../server/clips.js';
import { validateCue } from '../server/timecode.js';
import { defaultObject, Engine } from '../server/engine.js';
import { AutoRunner, validateLane, validateLanes, valueAt, rdp } from '../server/automation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EX = (f) => path.join(ROOT, 'example', f);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------- layouts ----------
test('SPAT layout: rooms listed, room 3 has 31 speakers, AED → XYZ with + = right', () => {
  const r = parseSpat(fs.readFileSync(EX('kosound_spat.json'), 'utf8'));
  assert.deepEqual(r.rooms.map((x) => x.speakers.length), [7, 4, 31, 22]);
  const room3 = r.rooms[2].speakers;
  const f1 = room3.find((s) => s.name === 'F 1');
  assert.ok(f1.x < 0 && f1.y > 5, 'F 1 is front-left');
  assert.ok(near(f1.y, 5.27, 0.01));
  assert.equal(f1.yaw, 180, 'front array faces straight back (SPAT yaw = relative to the listener)');
  const r3 = room3.find((s) => s.name === 'R 3');
  assert.ok(r3.x > 3.8, 'R 3 is on the right');
  assert.equal(r3.yaw, -90, 'side speaker aimed across the room');
  const top = room3.find((s) => s.name === 'CS 5');
  assert.ok(near(top.z, 2, 1e-3) && near(Math.hypot(top.x, top.y), 0, 1e-3), 'elevation 90 → straight above');
  assert.ok(room3.every((s) => s.name === s.name.trim()));
});

test('L-ISA layout: 12 mains + 1 sub from the Speakers bus, facing from Azimuth (rad)', () => {
  const r = parseLisa(fs.readFileSync(EX('New Session.lisa'), 'utf8'));
  const sp = r.rooms[0].speakers;
  assert.equal(sp.length, 13);
  assert.equal(sp.filter((s) => s.kind === 'main').length, 12);
  const subs = sp.filter((s) => s.kind === 'sub');
  assert.deepEqual(subs.map((s) => s.name), ['Subwoofer']);
  assert.ok(near(subs[0].z, -1.2));
  const s1 = sp.find((s) => s.name === 'Speaker 1');
  assert.deepEqual([s1.x, s1.y, s1.yaw], [-2, 0, 90]);
  assert.equal(sp.find((s) => s.name === 'Speaker 4').yaw, 180);
  assert.equal(sp.find((s) => s.name === 'Speaker 1').group, '12.0');
});

test('CSV layout: xyz and polar columns, header-less rows, TSV, sub detection', () => {
  const a = parseCsv('name,x,y,z\nL,-3,4,0\nR,3,4,0\nSub L,-1,4,-1\n');
  assert.equal(a.rooms[0].speakers.length, 3);
  assert.equal(a.rooms[0].speakers[2].kind, 'sub');
  assert.equal(a.rooms[0].speakers[0].yaw, null);
  const b = parseCsv('Name\tAzimuth\tElevation\tDistance\nC\t0\t0\t5\nR\t90\t0\t2\n');
  assert.ok(near(b.rooms[0].speakers[0].y, 5) && near(b.rooms[0].speakers[1].x, 2));
  const c = parseCsv('A,1,2,3,45\nB,-1,2,0\n');
  assert.deepEqual([c.rooms[0].speakers[0].z, c.rooms[0].speakers[0].yaw], [3, 45]);
  assert.throws(() => parseCsv('foo,bar\n1,2\n'));
});

test('format auto-detection and fit scale', () => {
  assert.equal(parseLayout(fs.readFileSync(EX('kosound_spat.json'), 'utf8')).format, 'spat');
  assert.equal(parseLayout(fs.readFileSync(EX('New Session.lisa'), 'utf8')).format, 'lisa');
  assert.equal(parseLayout('[{"name":"A","x":1,"y":2,"z":0}]').format, 'json');
  assert.equal(parseLayout('name,x,y\nA,1,2').format, 'csv');
  assert.equal(fitScale([{ x: -3, y: 1 }, { x: 2, y: -5.5 }]), 5.5);
  const p = aedToXyz(-90, 0, 2);
  assert.ok(near(p.x, -2) && near(p.y, 0));
});

test('stage state: partial patches merge, bad values are clamped, transform maps metres → stage', () => {
  let s = sanitizeStage({ background: { asset: '0123456789abcdef0123456789abcdef.png', opacity: 5, scale: -1 } }, defaultStage());
  assert.equal(s.background.asset, '0123456789abcdef0123456789abcdef.png');
  assert.equal(s.background.opacity, 1);
  assert.equal(s.background.scale, 0.05);
  s = sanitizeStage({ background: { asset: '../evil.png' } }, s);
  assert.equal(s.background.asset, '0123456789abcdef0123456789abcdef.png', 'invalid id ignored');
  s = sanitizeStage({ background: { asset: null } }, s);
  assert.equal(s.background.asset, null);
  s = sanitizeStage({ speakers: { items: [{ name: 'A', x: 4, y: 0, z: 0 }], transform: { metersPerUnit: 4, rotation: 90 } } }, s);
  assert.equal(s.speakers.items.length, 1);
  const p = speakerToStage(s.speakers.items[0], s.speakers.transform);
  assert.ok(near(p.x, 0) && near(p.y, -1), 'rotation is clockwise seen from above');
  const m = speakerToStage({ x: 4, y: 0, z: 0 }, { ...s.speakers.transform, rotation: 0, mirrorX: true });
  assert.ok(near(m.x, -1));
});

// ---------- clips ----------
function fakeEngine() {
  const objs = Array.from({ length: 32 }, (_, i) => ({ ...defaultObject(i + 1), enabled: true }));
  const log = [];
  const paused = new Set();
  const api = {
    resolve: (spec) => (spec ? parseSpec(spec) : objs.map((o) => o.id)),
    object: (id) => objs[id - 1],
    apply: (ids, list, { fade }) => {
      for (const o of list) objs[o.id - 1] = { ...o };
      log.push({ op: 'apply', ids: [...ids], fade, mode: list[0]?.mode, cx: list[0]?.center.x });
    },
    home: (ids, fade) => log.push({ op: 'home', ids: [...ids], fade }),
    preset: (name, ids, fade) => { log.push({ op: 'preset', name, ids: [...ids], fade }); return true; },
    run: (ids, play) => { for (const id of ids) (play ? paused.delete(id) : paused.add(id)); log.push({ op: play ? 'play' : 'pause', ids: [...ids] }); },
  };
  return { objs, log, paused, api };
}
const parseSpec = (s) => s.split(',').flatMap((p) => {
  const [a, b] = p.split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
});
const clipCue = (clips) => {
  const r = validateClips(clips);
  assert.deepEqual(r.errors, []);
  return { id: 'c1', action: 'clips', enabled: true, clips: r.clips };
};

test('clips: validation is strict, params sanitized per kind, ids kept unique', () => {
  const ok = validateClips([
    { kind: 'motion', targets: '1-4', start: 0, dur: 8, params: { mode: 'orbit', range: { x: 9 }, enabled: false, bogus: 1 } },
    { id: 'abc', kind: 'move', targets: '5', start: 2, dur: 3, params: { x: 3, y: -0.5 }, then: 'revert' },
    { id: 'abc', kind: 'preset', start: 1, dur: 1, params: { name: 'Look A' } },
  ]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clips[0].params, { mode: 'orbit', range: { x: 1 } }, 'enabled/unknown keys dropped, range clamped');
  assert.deepEqual(ok.clips[1].params, { x: 1, y: -0.5, z: 0 });
  assert.equal(ok.clips[1].then, 'revert');
  assert.equal(ok.clips[2].then, 'continue');
  assert.notEqual(ok.clips[2].id, 'abc', 'duplicate id replaced');
  for (const bad of [{ kind: 'warp' }, { kind: 'move', dur: 0 }, { kind: 'move', start: -1 }, { kind: 'move', then: 'loop' }, { kind: 'preset' }, { kind: 'move', targets: '1;rm' }]) {
    assert.equal(validateClips([bad]).errors.length, 1, JSON.stringify(bad));
  }
  const { cue, errors } = validateCue({ action: 'clips', tc: '00:00:10:00', clips: [{ kind: 'home', start: 0, dur: 1 }] });
  assert.deepEqual(errors, []);
  assert.equal(cue.clips.length, 1);
  assert.equal(validateCue({ action: 'clips', clips: [{ kind: 'nope' }] }).cue, null);
  assert.deepEqual(validateCue({ action: 'slot', slot: 1 }).cue.clips, [], 'old cues get an empty clip list');
});

test('clips: start and end on time, then-rules (home / hold / revert / continue)', () => {
  const f = fakeEngine();
  const r = new ClipRunner(f.api);
  r.start(clipCue([
    { kind: 'move', targets: '1', start: 0, dur: 2, fade: 0.5, params: { x: 0.5 }, then: 'home' },
    { kind: 'motion', targets: '2', start: 1, dur: 1, params: { mode: 'orbit' }, then: 'hold' },
    { kind: 'move', targets: '3', start: 0.5, dur: 1, params: { x: -0.5 }, then: 'revert' },
    { kind: 'motion', targets: '4', start: 0, dur: 1, params: { mode: 'drift' } },
  ]), { now: 100 });
  assert.deepEqual(f.log.map((e) => `${e.op}:${e.ids}`), ['apply:1', 'apply:4'], 'start-0 clips fire immediately');
  assert.equal(f.objs[0].center.x, 0.5);
  f.log.length = 0;
  r.tick(100.6);
  assert.deepEqual(f.log.map((e) => `${e.op}:${e.ids}`), ['apply:3']);
  f.log.length = 0;
  r.tick(101.05);
  assert.deepEqual(f.log.map((e) => `${e.op}:${e.ids}`), ['apply:2'], 'clip 4 ends with continue (no-op), clip 2 starts');
  assert.equal(f.objs[3].mode, 'drift');
  f.log.length = 0;
  r.tick(101.6);
  assert.deepEqual(f.log.map((e) => `${e.op}:${e.ids}`), ['apply:3']);
  assert.equal(f.objs[2].center.x, 0, 'revert restored the config from before the clip');
  f.log.length = 0;
  r.tick(102.1);
  assert.deepEqual(f.log.map((e) => `${e.op}:${e.ids}`).sort(), ['home:1', 'pause:2']);
  assert.ok(f.paused.has(2));
  assert.equal(r.runs.length, 0, 'run finished after the last clip');
});

test('clips: overlapping clips — the later start owns the object; earlier end leaves it alone', () => {
  const f = fakeEngine();
  const r = new ClipRunner(f.api);
  r.start(clipCue([
    { kind: 'motion', targets: '1-2', start: 0, dur: 4, params: { mode: 'orbit' }, then: 'home' },
    { kind: 'move', targets: '2', start: 1, dur: 1, params: { x: 0.8 }, then: 'continue' },
  ]), { now: 0 });
  r.tick(1.1);
  assert.equal(f.objs[1].mode, 'hold');
  f.log.length = 0;
  r.tick(4.2);
  const home = f.log.find((e) => e.op === 'home');
  assert.deepEqual(home.ids, [1], 'object 2 was taken over, so the first clip only homes object 1');
  const r2 = new ClipRunner(f.api);
  r2.start(clipCue([{ kind: 'motion', targets: '5', start: 0, dur: 5, params: { mode: 'orbit' }, then: 'home' }]), { now: 0 });
  r2.release([5]);
  f.log.length = 0;
  r2.tick(5.5);
  assert.equal(f.log.filter((e) => e.op === 'home').length, 0, 'a scene cue that took the object cancels the clip end');
});

test('clips: chase into the middle applies the net state once with the chase fade; TC clock follows rolling only', () => {
  const f = fakeEngine();
  const r = new ClipRunner(f.api);
  const cue = clipCue([
    { kind: 'move', targets: '1', start: 0, dur: 2, params: { x: 0.2 }, then: 'home' },
    { kind: 'move', targets: '2', start: 1, dur: 10, params: { x: 0.4 } },
    { kind: 'move', targets: '3', start: 0, dur: 2, params: { x: 0.6 }, then: 'revert' },
    { kind: 'move', targets: '4', start: 8, dur: 1, params: { x: 0.9 } },
  ]);
  r.start(cue, { now: 50, elapsed: 5, chase: true, chaseFade: 0.3, clock: 'tc', cueT: 10 });
  const ops = Object.fromEntries(f.log.map((e) => [e.ids.join(','), e]));
  assert.equal(ops['1'].op, 'home');
  assert.equal(ops['1'].fade, 0.3);
  assert.equal(ops['2'].op, 'apply');
  assert.equal(ops['2'].fade, 0.3);
  assert.equal(ops['3'], undefined, 'ended revert clip nets to nothing');
  assert.equal(ops['4'], undefined, 'future clip not applied');
  f.log.length = 0;
  r.tick(51, { pos: 16, rolling: false, day: 86400 });
  assert.equal(f.log.length, 0, 'parked / shuttling TC never fires clip edges');
  r.tick(51.1, { pos: 18.05, rolling: true, day: 86400 });
  assert.equal(f.log.length, 1, 'a jump inside the run re-syncs instead of replaying');
  assert.deepEqual(f.log[0].ids, [4]);
  f.log.length = 0;
  r.tick(52, { pos: 5, rolling: true, day: 86400 });
  assert.equal(r.runs.length, 0, 'locating before the cue cancels the run');
});

// ---------- automation ----------
function fakeAuto({ locked = false, running = true } = {}) {
  const st = { locked, running, base: new Map(), applied: new Map(), recorded: [] };
  const api = {
    apply: (target, param, v) => (v === null ? st.applied.delete(`${target}|${param}`) : st.applied.set(`${target}|${param}`, v)),
    sample: (target, param) => st.base.get(`${target}|${param}`) ?? 0,
    locked: () => st.locked,
    running: () => st.running,
    cueTime: () => null,
    onRecorded: (ids) => st.recorded.push(...ids),
  };
  return { st, api };
}

test('automation: lane validation, interpolation curves, hold outside the points', () => {
  assert.ok(validateLane({ target: 33, param: 'glide' }).error);
  assert.ok(validateLane({ target: 1, param: 'name' }).error);
  assert.ok(validateLane({ target: 'master', param: 'glide' }).error, 'master only automates speed');
  assert.ok(validateLane({ target: 1, param: 'glide', mode: 'loud' }).error);
  const { lane } = validateLane({ target: '2', param: 'center.x', points: [[4, 2], [0, -0.5], [2, 0.5, 'step'], ['x', 1], [2, 0.25, 'step']] });
  assert.equal(lane.target, 2);
  assert.equal(lane.owner, 'show');
  assert.equal(lane.mode, 'read');
  assert.deepEqual(lane.points, [[0, -0.5], [2, 0.25, 'step'], [4, 1]], 'sorted, clamped, duplicates keep the last');
  assert.equal(valueAt(lane.points, -1), -0.5);
  assert.equal(valueAt(lane.points, 1), -0.125);
  assert.equal(valueAt(lane.points, 3), 0.25, 'step holds the left value');
  assert.equal(valueAt(lane.points, 9), 1);
  assert.equal(valueAt([[0, 0, 'smooth'], [2, 1]], 0.5), 0.15625);
  const pos = validateLane({ target: 1, param: 'pos', points: [[0, [0, 0, 0]], [1, [1, -1, 5]]] }).lane;
  assert.deepEqual(valueAt(pos.points, 0.5), [0.5, -0.5, 0.5]);
  const many = validateLanes([{ target: 1, param: 'glide' }, { target: 1, param: 'glide' }, { target: 1, param: 'nope' }]);
  assert.equal(many.lanes.length, 1, 'one lane per owner/target/param');
  assert.equal(many.errors.length, 1);
});

test('automation: RDP thinning keeps the shape within tolerance', () => {
  const pts = [];
  for (let i = 0; i <= 300; i++) pts.push([i / 30, i < 150 ? i / 150 : 1]);
  const thin = rdp(pts, 0.002);
  assert.ok(thin.length <= 4, `ramp + hold collapses to a few points (${thin.length})`);
  for (const [t, v] of pts) assert.ok(Math.abs(valueAt(thin, t) - v) <= 0.002 + 1e-9);
  const sine = [];
  for (let i = 0; i <= 300; i++) sine.push([i / 30, Math.sin(i / 20)]);
  const ts = rdp(sine, 0.004);
  assert.ok(ts.length < 120 && ts.length > 8);
  for (const [t, v] of sine) assert.ok(Math.abs(valueAt(ts, t) - v) <= 0.004 + 1e-9);
});

test('automation: show lanes follow TC, cue lanes follow the cue, STOP holds, release on off', () => {
  const f = fakeAuto();
  const r = new AutoRunner(f.api);
  const show = validateLane({ target: 1, param: 'glide', points: [[10, 0], [20, 1]] }).lane;
  const cueL = validateLane({ target: 1, param: 'glide', owner: 'c1', points: [[0, 0.5], [4, 0.9]] }).lane;
  r.setLanes([show, cueL]);
  r.tick(0, { pos: 15, rolling: false });
  assert.equal(f.st.applied.get('1|glide'), 0.5, 'parked TC still shows the value at the playhead');
  r.cueStarted({ id: 'c1' }, { clock: 'wall', now: 100 });
  r.tick(102, { pos: 15, rolling: true });
  assert.ok(Math.abs(f.st.applied.get('1|glide') - 0.7) < 1e-9, 'a playing cue lane wins over the show lane');
  r.stopAll(103);
  assert.equal(f.st.applied.size, 0);
  f.st.running = false;
  r.tick(104, { pos: 12, rolling: true });
  assert.equal(f.st.applied.size, 0, 'transport stopped: nothing new is applied');
  f.st.running = true;
  r.tick(105, { pos: 12, rolling: true });
  assert.ok(Math.abs(f.st.applied.get('1|glide') - 0.2) < 1e-9);
  r.setGlobal('off', 106);
  assert.equal(f.st.applied.size, 0, 'global off releases every override');
  r.setGlobal('read', 107);
  show.mode = 'off';
  r.tick(108, { pos: 12, rolling: true });
  assert.equal(f.st.applied.size, 0);
});

test('automation: Touch / Latch / Write recording, punch-in replaces only the pass, Show Lock refuses', () => {
  const f = fakeAuto();
  const r = new AutoRunner(f.api);
  const lane = validateLane({ target: 1, param: 'center.x', mode: 'touch', armed: true, points: [[0, 0], [10, 0]] }).lane;
  r.setLanes([lane]);
  r.setGlobal('write', 0);
  const run = (from, to, fn) => {
    for (let t = from; t <= to + 1e-9; t += 1 / 30) {
      fn?.(t);
      r.tick(t, { pos: t, rolling: true });
    }
  };
  run(0, 2);
  assert.equal(f.st.applied.get('1|center.x'), 0, 'untouched Touch lane plays back');
  run(2, 4, (t) => { f.st.base.set('1|center.x', 0.5); r.touch(1, ['center.x'], t); });
  assert.equal(f.st.applied.has('1|center.x'), false, 'while touching the operator owns the value');
  run(4, 6);
  assert.deepEqual(f.st.recorded, [lane.id], 'touch released → pass committed');
  assert.ok(Math.abs(valueAt(lane.points, 3) - 0.5) < 1e-9);
  assert.ok(Math.abs(valueAt(lane.points, 1) - 0) < 1e-9, 'before the pass untouched');
  assert.ok(Math.abs(valueAt(lane.points, 8) - 0) < 1e-9, 'after the pass the old curve resumes');
  assert.ok(lane.points.length < 10, `thinned (${lane.points.length} points)`);

  lane.mode = 'latch';
  f.st.recorded.length = 0;
  run(6, 6.2, (t) => { f.st.base.set('1|center.x', -0.4); r.touch(1, ['center.x'], t); });
  run(6.2, 8);
  assert.ok(r.rec.has(lane.id), 'latch keeps writing after the touch ends');
  r.tick(8.1, { pos: 8.1, rolling: false });
  assert.deepEqual(f.st.recorded, [lane.id], 'stopping the clock ends the latch pass');
  assert.ok(Math.abs(valueAt(lane.points, 7.5) + 0.4) < 1e-9);

  lane.mode = 'write';
  f.st.locked = true;
  f.st.recorded.length = 0;
  run(0, 1);
  assert.equal(r.rec.size, 0, 'Show Lock: no recording');
  assert.ok(f.st.applied.has('1|center.x'), 'Show Lock: playback continues');
  f.st.locked = false;
  r.setGlobal('read', 1);
  run(1, 2);
  assert.equal(r.rec.size, 0, 'global Read never records');
});

test('engine automation: overrides never touch the stored config, pos drives the output, release glides back', () => {
  const e = new Engine();
  const t0 = 1000;
  e.lastT = t0;
  e.updateObject(1, { mode: 'hold', center: { x: 0, y: 0, z: 0 } }, t0);
  e.update(t0 + 0.01);
  assert.ok(e.setAutomation(1, 'center.x', 0.5, t0 + 0.02));
  assert.equal(e.objects[0].center.x, 0, 'stored settings unchanged');
  assert.equal(e.effective(0).center.x, 0.5);
  e.setRunning(true, t0 + 0.03);
  e.update(t0 + 2);
  assert.ok(Math.abs(e.rt[0].pos.x - 0.5) < 1e-6, 'hold mode follows the automated centre');
  assert.equal(e.getScene([1]).objects[0].center.x, 0, 'scenes / presets save the operator value');
  assert.equal(e.setAutomation(1, 'enabled', 1), false);
  assert.equal(e.setAutomation(1, 'glide', 7), true);
  assert.equal(e.effective(0).glide, 1, 'clamped to the parameter range');
  e.setAutomation(1, 'pos', [0.2, -0.3, 0], t0 + 2);
  e.update(t0 + 2.02);
  assert.deepEqual([e.rt[0].pos.x, e.rt[0].pos.y], [0.2, -0.3]);
  e.setAutomation(1, 'pos', null, t0 + 2.02);
  e.setAutomation(1, 'center.x', null, t0 + 2.02);
  e.update(t0 + 2.1);
  assert.ok(e.rt[0].pos.x > 0 && e.rt[0].pos.x < 0.2, 'release crossfades instead of jumping');
  e.update(t0 + 3);
  assert.ok(Math.abs(e.rt[0].pos.x) < 1e-6);
  assert.equal(e.hasAutomation(), true, 'glide override still set');
  e.clearAutomation();
  assert.equal(e.hasAutomation(), false);
  assert.ok(e.setMasterAutomation('speed', 2));
  assert.equal(e.master.speed, 1, 'master speed setting untouched');
});

export default () => run('features (stage, clips, automation)');
