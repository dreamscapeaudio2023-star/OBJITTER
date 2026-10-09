import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { test, run, sleep, freeTcpPort, freeUdpPort, waitFor } from './harness.js';
import { decodePacket, encodeMessage } from '../server/osc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-test-'));
const realState = path.join(ROOT, 'data', 'state.json');
const realStateMtime = fs.existsSync(realState) ? fs.statSync(realState).mtimeMs : null;
const procs = new Set();

async function startServer({ dataDir, env = {}, wait = true } = {}) {
  const port = await freeTcpPort();
  const controlPort = await freeUdpPort();
  const dir = dataDir ?? fs.mkdtempSync(path.join(tmpRoot, 'data-'));
  const presetDir = fs.mkdtempSync(path.join(tmpRoot, 'presets-'));
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CONTROL_PORT: String(controlPort), DATA_DIR: dir, PRESET_DIR: presetDir, LIBRARY_DIR: path.join(dir, 'library'), HOST: '127.0.0.1', ...env },
    stdio: 'pipe',
  });
  procs.add(proc);
  const srv = { proc, port, controlPort, dataDir: dir, presetDir, log: '', exitCode: undefined };
  proc.stdout.on('data', (d) => { srv.log += d; });
  proc.stderr.on('data', (d) => { srv.log += d; });
  proc.on('exit', (code) => { srv.exitCode = code; procs.delete(proc); });
  if (wait) await waitFor(() => srv.log.includes(`Local:   http://localhost:${port}`) || srv.exitCode !== undefined, 8000);
  return srv;
}

function stopServer(srv) {
  if (srv.exitCode === undefined) srv.proc.kill();
}

function applyTcDelta(tc, m) {
  if (m.settings) tc.settings = m.settings;
  if ('source' in m) tc.source = m.source;
  const byId = new Map(tc.cues.map((c) => [c.id, c]));
  for (const c of m.upsert ?? []) byId.set(c.id, c);
  for (const id of m.remove ?? []) byId.delete(id);
  const order = m.order ?? tc.cues.map((c) => c.id).concat((m.upsert ?? []).map((c) => c.id).filter((id) => !tc.cues.some((c) => c.id === id)));
  tc.cues = order.map((id) => byId.get(id)).filter(Boolean);
}

async function client(srv, { origin, headers, clientId } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { ...(origin ? { origin } : {}), ...(headers ? { headers } : {}) });
  const c = { ws, msgs: [], state: null, objects: [], presets: [], stats: null, closed: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'init') { c.state = m.state; c.objects = m.objects; c.presets = m.presets; c.static = m.static; c.tc = m.tc; c.tcs = m.tcs; c.you = m.you; }
    if (m.type === 'tc.delta') applyTcDelta(c.tc, m);
    if (m.type === 'tcs') c.tcs = m;
    if (m.type === 'init' || m.type === 'auto') c.auto = m.type === 'init' ? m.auto : m;
    if (m.type === 'autos' || (m.type === 'init' && m.autos)) c.autos = m.type === 'init' ? m.autos : m;
    if (m.type === 'pos') c.pos = m;
    if (m.type === 'state') { c.state = m.state; for (const o of m.objects) c.objects[o.id - 1] = o; }
    if (m.type === 'presets') c.presets = m.presets;
    if (m.type === 'init' || m.type === 'sessions') c.sessions = m.sessions;
    if (m.type === 'stats') c.stats = m;
  });
  ws.on('close', (code) => { c.closed = code; });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.send({ type: 'hello', ...(clientId ? { clientId } : {}) });
  await waitFor(() => c.state);
  c.toast = (re) => c.msgs.find((m) => m.type === 'toast' && (re.test(m.text) || re.test(m.key ?? '')));
  c.mark = () => c.msgs.length;
  c.since = (k) => c.msgs.slice(k);
  return c;
}

function httpGet(port, rawPath, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function udpListener() {
  const sock = dgram.createSocket('udp4');
  const l = { sock, msgs: [], raw: [] };
  sock.on('message', (b) => { l.raw.push(b); try { l.msgs.push(...decodePacket(b)); } catch { /* ignore */ } });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  l.port = sock.address().port;
  return l;
}

function sendUdp(port, buf) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.send(buf, port, '127.0.0.1', () => { s.close(); resolve(); });
  });
}

let srv;
let c;
const osc = (address, args = []) => sendUdp(srv.controlPort, encodeMessage(address, args));
const t1 = () => c.state.output.targets[0];

test('server boots on temp dirs and free ports', async () => {
  srv = await startServer();
  assert.ok(srv.log.includes(srv.dataDir), 'uses DATA_DIR');
  c = await client(srv);
  assert.equal(c.objects.length, 32);
  assert.ok(c.static.systems.spat && c.static.constants.divisions.length === 15);
  assert.equal(c.static.constants.maxTargets, 8);
  assert.equal(c.state.control.port, srv.controlPort);
  assert.equal(c.state.showLock, false);
  assert.equal(c.state.output.targets.length, 1);
  await waitFor(() => c.state.controlStatus.state === 'listening');
});

test('HTTP: Host allowlist (DNS rebinding), malformed URL, null byte, ":" and traversal rejected', async () => {
  assert.equal(await httpGet(srv.port, '/'), 200);
  assert.equal(await httpGet(srv.port, '/', `localhost:${srv.port}`), 200);
  assert.equal(await httpGet(srv.port, '/', `objitter.localhost:${srv.port}`), 200);
  assert.equal(await httpGet(srv.port, '/', 'evil.example.com'), 403);
  assert.equal(await httpGet(srv.port, '/', `evil.example.com:${srv.port}`), 403);
  assert.equal(await httpGet(srv.port, '/%E0%A4%A'), 400);
  assert.equal(await httpGet(srv.port, '/index.html%00.js'), 400);
  assert.equal(await httpGet(srv.port, '/index.html::$DATA'), 400);
  assert.equal(await httpGet(srv.port, '/C:/Windows/win.ini'), 400);
  assert.ok([403, 404].includes(await httpGet(srv.port, '/..%2f..%2fpackage.json')));
  assert.ok([403, 404].includes(await httpGet(srv.port, '/..%5c..%5cpackage.json')));
  assert.equal(await httpGet(srv.port, '/app.js'), 200);
  assert.equal(srv.exitCode, undefined, 'server must still be running');
});

test('WebSocket: foreign Origin or Host rejected, same-host Origin accepted', async () => {
  await assert.rejects(client(srv, { origin: 'http://evil.example.com' }), /401|403|Unexpected server response/);
  await assert.rejects(client(srv, { headers: { Host: 'evil.example.com' } }), /401|403|Unexpected server response/);
  const ok = await client(srv, { origin: `http://127.0.0.1:${srv.port}` });
  ok.ws.close();
});

test('WebSocket limits: oversized normal message refused with a toast, > 2 MB closes with 1009', async () => {
  const k = c.mark();
  c.send({ type: 'updateObjects', ids: [1], patch: { name: 'x'.repeat(300 * 1024) } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.msgTooBig' && m.text.includes('too large')));
  assert.notEqual(c.objects[0].name, 'x'.repeat(300 * 1024));
  const big = await client(srv);
  big.ws.send(JSON.stringify({ type: 'tc.show.preview', data: 'x'.repeat(2.2 * 1024 * 1024) }));
  await waitFor(() => big.closed !== null, 3000);
  assert.equal(big.closed, 1009);
  assert.equal(srv.exitCode, undefined);
});

test('inherited system key in a target patch does not crash or persist', async () => {
  c.send({ type: 'output.target.update', id: 't1', patch: { system: 'toString' } });
  c.send({ type: 'output.target.update', id: 't1', patch: { system: '__proto__', cfg: { constructor: { host: 'x' } } } });
  c.send({ type: 'output.target.update', id: '__proto__', patch: { host: '10.0.0.1' } });
  await sleep(150);
  assert.equal(srv.exitCode, undefined);
  assert.equal(t1().system, 'spat');
  assert.equal(c.state.output.targets.length, 1);
});

test('multiple output targets: SPAT + L-ISA both receive OSC on UDP; disabled target is silent; stats per target', async () => {
  const a = await udpListener();
  const b = await udpListener();
  const off = await udpListener();
  c.send({ type: 'output.target.update', id: 't1', patch: { host: '127.0.0.1', port: a.port, rate: 50 } });
  c.send({ type: 'output.target.add', system: 'lisa' });
  c.send({ type: 'output.target.add', system: 'spat' });
  await waitFor(() => c.state.output.targets.length === 3);
  const [, lisa, spare] = c.state.output.targets;
  assert.equal(lisa.system, 'lisa');
  c.send({ type: 'output.target.update', id: lisa.id, patch: { host: '127.0.0.1', port: b.port } });
  c.send({ type: 'output.target.update', id: spare.id, patch: { host: '127.0.0.1', port: off.port, enabled: false } });
  c.send({ type: 'updateObjects', ids: [1, 2], patch: { enabled: true, mode: 'jitter', timing: { sync: 'free', min: 0.05, max: 0.1 } } });
  c.send({ type: 'master', running: true });
  await waitFor(() => a.msgs.filter((m) => m.address === '/source/1/xyz').length > 5, 3000);
  await waitFor(() => b.msgs.filter((m) => m.address === '/ext/src/1/p').length > 3, 3000);
  assert.ok(b.raw.some((x) => x.toString('ascii', 0, 8) === '#bundle\0'), 'L-ISA bundles by default');
  for (const m of b.msgs.filter((x) => x.address.endsWith('/p'))) assert.ok(m.args[0] >= -1 && m.args[0] <= 1);
  await sleep(1300);
  const st = c.stats.targets;
  assert.equal(st.length, 3);
  const hz = st[0].frameHz;
  assert.ok(hz > 40 && hz < 60, `frame rate ${hz} Hz for 50 Hz setting`);
  assert.ok(st[1].frameHz > 18 && st[1].frameHz < 32, `L-ISA ${st[1].frameHz} Hz for 25 Hz`);
  assert.equal(off.raw.length, 0, 'disabled target receives nothing');
  assert.equal(typeof c.stats.jitterWarn, 'boolean');
  console.log(`      (measured SPAT ${hz} Hz p95 ${st[0].p95Ms} ms, L-ISA ${st[1].frameHz} Hz, ${a.msgs.length}+${b.msgs.length} msgs)`);
  c.send({ type: 'master', running: false });
  c.send({ type: 'output.target.remove', id: spare.id });
  c.send({ type: 'output.target.remove', id: lisa.id });
  await waitFor(() => c.state.output.targets.length === 1);
  c.send({ type: 'output.target.remove', id: 't1' });
  await waitFor(() => c.toast(/^srv\.out\.lastTarget$/));
  for (const l of [a, b, off]) l.sock.close();
});

test('keepalive is sent while stopped for enabled objects', async () => {
  const l = await udpListener();
  c.send({ type: 'output.target.update', id: 't1', patch: { port: l.port } });
  await sleep(2300);
  assert.ok(l.msgs.filter((m) => m.address === '/source/1/xyz').length >= 2, 'expected ~1 Hz keepalive');
  l.sock.close();
});

test('output scale: scaled OSC (and OSC log) after a glide, strict validation, show lock, persistence', async () => {
  const l = await udpListener();
  c.send({ type: 'output.target.update', id: 't1', patch: { port: l.port } });
  const last = () => l.msgs.filter((m) => m.address === '/source/1/xyz').at(-1);
  await waitFor(() => last(), 3000);
  assert.deepEqual(t1().transform, { flipX: false, flipY: false, swapXY: false, scaleX: 1, scaleY: 1, scaleZ: 1, offsetX: 0, offsetY: 0, offsetZ: 0, clamp: true });
  const [x0, y0, z0] = last().args;
  assert.deepEqual(c.static.constants.outScale, { min: 0, max: 4 });

  c.send({ type: 'osclog.sub', on: true });
  const k0 = c.mark();
  c.send({ type: 'output.target.update', id: 't1', patch: { transform: { scaleX: 0.5, scaleZ: 0.5, offsetY: 0.1 } } });
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const want = [x0 * 0.5, y0 + 0.5, z0 * 0.5];
  await waitFor(() => t1().transform.scaleX === 0.5);
  await sleep(700);
  l.msgs.length = 0;
  await waitFor(() => last() && last().args.every((v, i) => near(v, want[i])), 3000);
  const logged = () => c.since(k0).filter((m) => m.type === 'osclog').flatMap((m) => m.entries)
    .filter((e) => e.dir === 'out' && e.addr === '/source/1/xyz').map((e) => e.args.split(' ').map(Number));
  await waitFor(() => logged().some((a) => a.every((v, i) => Math.abs(v - want[i]) < 1e-3)), 3000);
  c.send({ type: 'osclog.sub', on: false });

  let k = c.mark();
  c.send({ type: 'output.target.update', id: 't1', patch: { transform: { scaleY: 9, offsetX: 'abc' } } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.out.badScale' && /scaleY/.test(m.params.keys) && /offsetX/.test(m.params.keys)));
  assert.equal(t1().transform.scaleY, 1);
  assert.equal(t1().transform.offsetX, 0);
  assert.equal(srv.exitCode, undefined);

  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  k = c.mark();
  c.send({ type: 'output.target.update', id: 't1', patch: { transform: { scaleX: 2 } } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.locked'));
  assert.equal(t1().transform.scaleX, 0.5, 'show lock blocks scale edits');
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);

  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'state.json'), 'utf8')).output.targets[0].transform.scaleX === 0.5;
    } catch { return false; }
  }, 5000);
  const copy = fs.mkdtempSync(path.join(tmpRoot, 'scale-'));
  fs.copyFileSync(path.join(srv.dataDir, 'state.json'), path.join(copy, 'state.json'));
  const s2 = await startServer({ dataDir: copy });
  const c2 = await client(s2);
  assert.equal(c2.state.output.targets[0].transform.offsetY, 0.1, 'restored from state.json');
  assert.equal(c2.state.output.targets[0].transform.scaleZ, 0.5);
  c2.ws.close();
  stopServer(s2);
  c.send({ type: 'output.target.update', id: 't1', patch: { transform: { scaleX: 1, scaleY: 1, scaleZ: 1, offsetX: 0, offsetY: 0, offsetZ: 0 } } });
  await waitFor(() => t1().transform.offsetY === 0 && t1().transform.scaleZ === 1);
  l.sock.close();
});

test('unresolvable host: no sending, status reported, previous host kept on invalid input', async () => {
  c.send({ type: 'output.target.update', id: 't1', patch: { host: 'no-such-host.invalid' } });
  await waitFor(() => c.stats?.targets[0].target.startsWith('no-such-host.invalid') && !['ok', 'resolving'].includes(c.stats.targets[0].resolve), 8000);
  assert.equal(c.stats.targets[0].ip, null);
  const k = c.mark();
  c.send({ type: 'output.target.update', id: 't1', patch: { host: 'bad host!' } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.out.badHost' && m.params.host === 'bad host!'));
  assert.equal(t1().host, 'no-such-host.invalid');
  c.send({ type: 'output.target.update', id: 't1', patch: { host: '127.0.0.1' } });
  await waitFor(() => c.stats?.targets[0].resolve === 'ok', 5000);
});

test('OSC control input: range addressing, set path, invalid args ignored', async () => {
  const bpm = c.state.bpm;
  await osc('/objitter/bpm', []);
  await osc('/objitter/speed', ['abc']);
  await osc('/objitter/obj/3-5/set', ['range.x', 0.25]);
  await osc('/objitter/obj/6/set', ['__proto__', 1]);
  await sendUdp(srv.controlPort, Buffer.from('garbage!'));
  await waitFor(() => c.objects[4].range.x === 0.25, 2000);
  assert.equal(c.objects[2].range.x, 0.25);
  assert.equal(c.objects[5].range.x, 0.6);
  assert.equal(c.state.bpm, bpm);
  assert.equal(c.state.master.speedTarget, 1);
  await osc('/objitter/bpm', [90]);
  await waitFor(() => Math.abs(c.state.bpm - 90) < 1e-6);
  assert.equal(srv.exitCode, undefined);
});

test('presets: overwrite confirmation, import capped to 32, strict numeric slot, metadata', async () => {
  c.send({ type: 'preset.save', name: 'Show A' });
  await waitFor(() => c.presets.some((p) => p.name === 'Show A'));
  c.send({ type: 'preset.save', name: 'Show A. ' });
  const conf = await waitFor(() => c.msgs.find((m) => m.type === 'confirm'));
  assert.ok(conf.text.includes('"Show A"'));
  assert.equal(conf.key, 'srv.preset.exists');
  assert.equal(conf.yes.key, 'common.overwrite');
  c.send({ type: 'preset.import', name: 'Big', data: { objects: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, mode: 'drift' })) } });
  await waitFor(() => c.presets.some((p) => p.name === 'Big'));
  assert.equal(c.presets.find((p) => p.name === 'Big').count, 32);
  c.send({ type: 'preset.save', name: 'CON', ids: [1, 2] });
  await waitFor(() => c.presets.some((p) => p.name === '_CON'));
  assert.equal(c.presets.find((p) => p.name === '_CON').count, 2);
  c.send({ type: 'preset.load', name: 'Show A', ids: [] });
  await waitFor(() => c.toast(/^srv\.noSelection$/));
  c.send({ type: 'preset.setSlot', name: 'Big', slot: '2x' });
  await waitFor(() => c.toast(/Slot numbers are 1–32/));
  c.send({ type: 'preset.setSlot', name: 'Big', slot: 2 });
  await waitFor(() => c.presets.find((p) => p.name === 'Big').slot === 2);
  c.send({ type: 'preset.meta', name: 'Big', color: 'teal', note: 'Verse 2' });
  await waitFor(() => c.presets.find((p) => p.name === 'Big').color === 'teal');
  assert.equal(c.presets.find((p) => p.name === 'Big').note, 'Verse 2');
  c.send({ type: 'slot.load', slot: 2 });
  await waitFor(() => c.state.lastPreset?.name === 'Big');
  assert.equal(c.objects[31].mode, 'drift');
});

test('32 slots: OSC recalls slot 32 and 20, slot 33 rejected, slot.clear empties a slot', async () => {
  c.send({ type: 'preset.save', name: 'Thirty Two' });
  c.send({ type: 'preset.save', name: 'Twenty' });
  await waitFor(() => c.presets.some((p) => p.name === 'Thirty Two') && c.presets.some((p) => p.name === 'Twenty'));
  c.send({ type: 'preset.setSlot', name: 'Thirty Two', slot: 32 });
  c.send({ type: 'preset.setSlot', name: 'Twenty', slot: 20 });
  await waitFor(() => c.presets.find((p) => p.name === 'Twenty').slot === 20 && c.presets.find((p) => p.name === 'Thirty Two').slot === 32);
  await osc('/objitter/slot', [32]);
  await waitFor(() => c.state.lastPreset?.name === 'Thirty Two', 2000);
  await osc('/objitter/slot/20');
  await waitFor(() => c.state.lastPreset?.name === 'Twenty', 2000);
  const k = c.mark();
  c.send({ type: 'preset.setSlot', name: 'Big', slot: 33 });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.text.includes('1–32')));
  assert.equal(c.presets.find((p) => p.name === 'Big').slot, 2);
  c.send({ type: 'slot.clear', slot: 2 });
  await waitFor(() => c.presets.find((p) => p.name === 'Big').slot == null);
  assert.equal(srv.exitCode, undefined);
});

test('slot snapshot: stores all 32 objects as "Slot NN"; replacing a partial preset asks first and keeps it', async () => {
  c.send({ type: 'preset.snapshot', slot: 5 });
  await waitFor(() => c.presets.find((p) => p.name === 'Slot 05')?.slot === 5);
  assert.equal(c.presets.find((p) => p.name === 'Slot 05').count, 32);
  c.send({ type: 'preset.save', name: 'Part', ids: [1, 2] });
  await waitFor(() => c.presets.some((p) => p.name === 'Part'));
  c.send({ type: 'preset.setSlot', name: 'Part', slot: 6 });
  await waitFor(() => c.presets.find((p) => p.name === 'Part').slot === 6);
  assert.equal(c.presets.find((p) => p.name === 'Part').count, 2);
  const k = c.mark();
  c.send({ type: 'preset.snapshot', slot: 6 });
  const conf = await waitFor(() => c.since(k).find((m) => m.type === 'confirm'));
  assert.equal(conf.key, 'srv.slot.snapshotReplace');
  assert.equal(c.presets.find((p) => p.name === 'Part').slot, 6);
  c.send(conf.msg);
  await waitFor(() => c.presets.find((p) => p.name === 'Slot 06')?.slot === 6);
  assert.equal(c.presets.find((p) => p.name === 'Part').slot, null);
  await waitFor(() => c.state.lastPreset?.name === 'Slot 06');
  const k2 = c.mark();
  c.send({ type: 'preset.snapshot', slot: 40 });
  await waitFor(() => c.since(k2).some((m) => m.type === 'toast' && m.key === 'srv.slot.range'));
});

async function streamTc(fromFrames, count, { fps = 25, step = 1 } = {}) {
  for (let k = 0; k < count; k++) {
    const f = fromFrames + k * step;
    const s = Math.floor(f / fps);
    await osc('/objitter/tc', [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % fps]);
    await sleep(1000 / fps);
  }
}
const cueMsgs = (k, id) => c.since(k).filter((m) => m.type === 'cue' && (!id || m.id === id));

test('timecode (OSC): cue recalls preset by name; cue at the start position fires; stop → lost; cues persist', async () => {
  c.send({ type: 'preset.load', name: 'Thirty Two' });
  await waitFor(() => c.state.lastPreset?.name === 'Thirty Two');
  c.send({ type: 'tc.settings', patch: { enabled: true, input: 'osc', rate: '25' } });
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:10:00', action: 'slot', preset: 'Twenty', label: 'Scene 20' } });
  await waitFor(() => c.tc?.settings.enabled && c.tc.settings.input === 'osc' && c.tc.cues.length === 1);
  const cue = c.tc.cues[0];
  assert.equal(cue.preset, 'Twenty');
  let k = c.mark();
  await streamTc(9 * 25, 40);
  const fired = await waitFor(() => cueMsgs(k, cue.id)[0], 2000);
  assert.equal(fired.how, 'fire');
  assert.equal(fired.ok, true);
  assert.equal(c.state.lastPreset?.name, 'Twenty');
  assert.equal(c.tcs.src, 'osc');
  await osc('/objitter/tc/stop');
  await waitFor(() => c.tcs?.state === 'lost', 2000);

  c.send({ type: 'preset.load', name: 'Thirty Two' });
  await waitFor(() => c.state.lastPreset?.name === 'Thirty Two');
  k = c.mark();
  await streamTc(10 * 25, 15);
  const start = await waitFor(() => cueMsgs(k, cue.id)[0], 2000);
  assert.equal(start.how, 'fire', 'cue exactly at the first received frame fires (not chased)');
  await osc('/objitter/tc/stop');
  await waitFor(() => c.tcs?.state === 'lost', 2000);
  await waitFor(() => {
    const s = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'state.json'), 'utf8'));
    return s.timecode?.cues?.[0]?.preset === 'Twenty';
  }, 5000);
});

test('timecode (OSC): fast-forward through a cue never fires it; it is chased once parked', async () => {
  c.send({ type: 'preset.load', name: 'Thirty Two' });
  await waitFor(() => c.state.lastPreset?.name === 'Thirty Two');
  const k = c.mark();
  await streamTc(5 * 25, 12);
  await streamTc(5 * 25 + 12, 30, { step: 4 });
  assert.equal(cueMsgs(k).filter((m) => m.how === 'fire').length, 0, 'no fire during 4× FF');
  const last = 5 * 25 + 12 + 29 * 4;
  for (let i = 0; i < 12; i++) {
    const s = Math.floor(last / 25);
    await osc('/objitter/tc', [0, 0, s, last % 25]);
    await sleep(40);
  }
  const ch = await waitFor(() => cueMsgs(k).find((m) => m.how === 'chase'), 2000);
  assert.equal(ch.ok, true);
  assert.equal(c.state.lastPreset?.name, 'Twenty');
  await osc('/objitter/tc/stop');
  await waitFor(() => c.tcs?.state === 'lost', 2000);
});

test('timecode (internal clock): locate + play fires the cue on time; GO list mode', async () => {
  c.send({ type: 'preset.load', name: 'Thirty Two' });
  c.send({ type: 'tc.settings', patch: { input: 'internal' } });
  await waitFor(() => c.tc.settings.input === 'internal' && c.tcs?.internal);
  c.send({ type: 'tc.int.locate', tc: '00:00:09:10' });
  await sleep(300);
  const k = c.mark();
  const t0 = performance.now();
  c.send({ type: 'tc.int.play' });
  const fired = await waitFor(() => cueMsgs(k)[0], 3000);
  const ms = performance.now() - t0;
  assert.equal(fired.how, 'fire');
  assert.ok(ms > 450 && ms < 800, `fired after ${Math.round(ms)} ms (expected ~600)`);
  console.log(`      (internal clock: cue due in 600 ms fired after ${Math.round(ms)} ms incl. WS round trip)`);
  c.send({ type: 'tc.int.pause' });
  await waitFor(() => c.tcs?.internal?.playing === false);

  c.send({ type: 'tc.settings', patch: { trigger: 'go' } });
  await waitFor(() => c.tcs?.standby?.label === 'Scene 20');
  const g = c.mark();
  c.send({ type: 'tc.go' });
  const go = await waitFor(() => cueMsgs(g)[0]);
  assert.equal(go.how, 'go');
  c.send({ type: 'tc.settings', patch: { trigger: 'tc' } });
  await waitFor(() => c.tc.settings.trigger === 'tc');
});

test('cue validation: strict errors are reported, nothing is stored', async () => {
  const n = c.tc.cues.length;
  const k = c.mark();
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:99:00', action: 'slot', slot: 1 } });
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:20:00', action: 'slot', slot: '2x' } });
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:20:00', action: 'slot', slot: 1, targets: '@nogroup' } });
  await waitFor(() => c.since(k).filter((m) => m.type === 'toast' && m.level === 'error' && m.key === 'srv.cue.errors' && m.text.startsWith('Cue error')).length === 3);
  await sleep(100);
  assert.equal(c.tc.cues.length, n);
});

test('quiet recall: cues and GO never push undo steps', async () => {
  while (c.state.canUndo) {
    c.send({ type: 'undo' });
    await sleep(60);
  }
  const k = c.mark();
  c.send({ type: 'tc.cue.fire', id: c.tc.cues[0].id });
  c.send({ type: 'tc.settings', patch: { trigger: 'go' } });
  c.send({ type: 'tc.go' });
  await waitFor(() => cueMsgs(k).length === 2);
  c.send({ type: 'tc.settings', patch: { trigger: 'tc' } });
  await sleep(100);
  assert.equal(c.state.canUndo, false);
});

test('clips cue: manual fire runs clips on time, revert restores, bad clips rejected, no undo steps', async () => {
  const x0 = c.objects[6].center.x;
  const k = c.mark();
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:40:00', action: 'clips', label: 'Clips', clips: [{ kind: 'warp' }] } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.cue.errors'));
  c.send({
    type: 'tc.cue.add', cue: {
      tc: '00:00:40:00', action: 'clips', label: 'Clips', clips: [
        { kind: 'move', targets: '7', start: 0, dur: 0.5, fade: 0, params: { x: 0.55, y: 0.1 }, then: 'revert' },
        { kind: 'motion', targets: '8', start: 0.25, dur: 5, fade: 0, params: { mode: 'orbit' } },
      ],
    },
  });
  const cue = await waitFor(() => c.tc.cues.find((x) => x.action === 'clips'));
  assert.equal(cue.clips.length, 2);
  assert.ok(cue.clips.every((x) => typeof x.id === 'string'));
  const k2 = c.mark();
  c.send({ type: 'tc.cue.fire', id: cue.id });
  await waitFor(() => c.objects[6].center.x === 0.55, 1000);
  assert.notEqual(c.objects[7].mode, 'orbit', 'second clip waits for its start time');
  await waitFor(() => c.objects[7].mode === 'orbit', 1000);
  await waitFor(() => c.objects[6].center.x === x0, 1500);
  assert.ok(c.since(k2).some((m) => m.type === 'clip' && m.phase === 'end'));
  assert.equal(c.state.canUndo, false);
  c.send({ type: 'tc.cue.delete', id: cue.id });
  await waitFor(() => !c.tc.cues.some((x) => x.id === cue.id));
});

test('automation: lanes play on the internal clock, Write records edits, lock refuses edits, nothing saved into the scene', async () => {
  const k = c.mark();
  c.send({ type: 'auto.lane.add', lane: { target: 1, param: 'nope' } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'auto.err.param'));
  c.send({ type: 'auto.lane.add', lane: { target: 1, param: 'pos', points: [[0, [0.3, -0.2, 0]], [3600, [0.3, -0.2, 0]]] } });
  const lane = await waitFor(() => c.auto?.lanes.find((l) => l.param === 'pos'));
  c.send({ type: 'auto.lane.add', lane: { target: 1, param: 'pos' } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'auto.err.dup'));
  const prevTc = { input: c.tc.settings.input, enabled: c.tc.settings.enabled };
  c.send({ type: 'tc.settings', patch: { input: 'internal', enabled: true } });
  await waitFor(() => c.tc.settings.input === 'internal');
  c.send({ type: 'master', running: true });
  c.send({ type: 'tc.int.locate', tc: '00:00:05:00' });
  await waitFor(() => c.pos && Math.abs(c.pos.p[0][0] - 0.3) < 1e-3 && Math.abs(c.pos.p[0][1] + 0.2) < 1e-3, 2000);
  assert.ok(Object.keys(c.autos.vals).includes(lane.id));
  const cx = c.objects[0].center.x;

  c.send({ type: 'auto.lane.add', lane: { target: 2, param: 'glide', mode: 'write', points: [] } });
  const wl = await waitFor(() => c.auto?.lanes.find((l) => l.param === 'glide'));
  c.send({ type: 'auto.arm', id: wl.id, armed: true });
  c.send({ type: 'auto.global', mode: 'write' });
  await waitFor(() => c.auto.global === 'write' && c.auto.lanes.find((l) => l.id === wl.id).armed);
  c.send({ type: 'tc.int.play' });
  await waitFor(() => c.autos?.rec?.[wl.id], 2000);
  c.send({ type: 'updateObjects', ids: [2], patch: { glide: 0.25 } });
  await sleep(400);
  c.send({ type: 'tc.int.pause' });
  const rec = await waitFor(() => c.auto.lanes.find((l) => l.id === wl.id && l.points.length >= 2), 2000);
  assert.ok(rec.points.some((p) => p[1] === 0.25), 'the edit was recorded');
  assert.ok(c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.auto.recorded'));

  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  const k2 = c.mark();
  c.send({ type: 'auto.lane.delete', id: lane.id });
  await waitFor(() => c.since(k2).some((m) => m.type === 'toast' && m.key === 'srv.locked'));
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);

  assert.equal(c.objects[0].center.x, cx, 'pos automation never edits the stored centre');
  c.send({ type: 'auto.global', mode: 'read' });
  c.send({ type: 'auto.lane.delete', ids: [lane.id, wl.id] });
  await waitFor(() => c.auto.lanes.length === 0);
  c.send({ type: 'master', running: false });
  c.send({ type: 'tc.settings', patch: prevTc });
  await waitFor(() => c.tc.settings.input === prevTc.input && c.tc.settings.enabled === prevTc.enabled);
});

test('show lock: a second client cannot edit (WS + OSC), recall and transport still work', async () => {
  const other = await client(srv);
  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => other.state.showLock === true);
  const k = other.mark();
  const range = other.objects[0].range.x;
  other.send({ type: 'updateObjects', ids: [1], patch: { range: { x: 0.9 } } });
  other.send({ type: 'tc.cue.add', cue: { tc: '00:00:30:00', action: 'start' } });
  other.send({ type: 'output.target.update', id: 't1', patch: { port: 9 } });
  other.send({ type: 'master', maxVelocity: 0.1 });
  await waitFor(() => other.since(k).filter((m) => m.type === 'toast' && m.key === 'srv.locked').length >= 4);
  await osc('/objitter/obj/1/set', ['range.x', 0.9]);
  await sleep(200);
  assert.equal(other.objects[0].range.x, range);
  assert.equal(c.tc.cues.length, 1);
  assert.notEqual(t1().port, 9);
  other.send({ type: 'preset.load', name: 'Thirty Two' });
  await waitFor(() => c.state.lastPreset?.name === 'Thirty Two');
  other.send({ type: 'master', running: true });
  await waitFor(() => c.state.master.running === true);
  other.send({ type: 'master', running: false });
  other.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);
  other.ws.close();
});

test('TC source claim: busy source asks to confirm, force takes over and notifies; resume needs the same client id', async () => {
  c.send({ type: 'tc.settings', patch: { input: 'mtc' } });
  await waitFor(() => c.tc.settings.input === 'mtc');
  const a = await client(srv, { clientId: 'client-a-1234' });
  const b = await client(srv, { clientId: 'client-b-5678' });
  b.send({ type: 'tc.frame', kind: 'mtc', tc: '00:00:05:00', rate: '25' });
  await sleep(150);
  assert.notEqual(c.tcs.src, 'mtc', 'frames from a non-source client are ignored');
  a.send({ type: 'tc.claim', kind: 'mtc' });
  await waitFor(() => c.tc.source?.cid === a.you);
  for (let i = 0; i < 5; i++) {
    a.send({ type: 'tc.frame', kind: 'mtc', tc: `00:00:05:0${i}`, rate: '25' });
    await sleep(40);
  }
  await waitFor(() => c.tcs?.src === 'mtc' && c.tcs.state === 'locked', 2000);
  b.send({ type: 'tc.claim', kind: 'mtc' });
  const conf = await waitFor(() => b.msgs.find((m) => m.type === 'confirm'));
  assert.equal(c.tc.source.cid, a.you, 'not taken without confirmation');
  b.send(conf.msg);
  await waitFor(() => c.tc.source?.cid === b.you);
  await waitFor(() => a.msgs.some((m) => m.type === 'tc.source.lost'));
  a.send({ type: 'tc.claim', kind: 'mtc', resume: true });
  await sleep(150);
  assert.equal(c.tc.source.cid, b.you, 'auto-resume never steals');
  b.ws.close();
  await waitFor(() => c.tc.source === null, 2000);
  const b2 = await client(srv, { clientId: 'client-b-5678' });
  b2.send({ type: 'tc.claim', kind: 'mtc', resume: true });
  await waitFor(() => c.tc.source?.cid === b2.you);
  a.ws.close();
  b2.ws.close();
  await waitFor(() => c.tc.source === null, 2000);
  c.send({ type: 'tc.settings', patch: { enabled: false, input: 'osc' } });
  await waitFor(() => !c.tc.settings.enabled);
});

test('show file: preview reports errors, import refuses invalid files, valid import applies', async () => {
  const bad = { app: 'objitter', kind: 'show', timecode: { cues: [{ tc: '00:00:01:00', slot: 1 }, { tc: 'nope', slot: 1 }, { tc: '00:00:02:00', action: 'boom' }] } };
  c.send({ type: 'tc.show.preview', data: bad });
  const pv = await waitFor(() => c.msgs.find((m) => m.type === 'tc.show.preview'));
  assert.equal(pv.ok, false);
  assert.equal(pv.cues, 1);
  assert.deepEqual(pv.errors.map((e) => e.index), [2, 3]);
  const k = c.mark();
  c.send({ type: 'tc.show.import', data: bad });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.show.importFailed'));
  assert.equal(c.tc.cues.length, 1);
  const good = { app: 'objitter', kind: 'show', groups: [{ name: 'front', ids: [1, 2, 3] }], timecode: { settings: { rate: '25' }, cues: [
    { tc: '00:00:01:00', preset: 'Twenty', targets: '@front', label: 'G1' },
    { tc: '00:00:02:00', action: 'start', label: 'G2' },
  ] } };
  c.send({ type: 'tc.show.import', data: good });
  await waitFor(() => c.tc.cues.length === 2 && c.tc.cues[0].label === 'G1');
  assert.deepEqual(c.state.groups.map((g) => g.name), ['front']);
});

test('sessions: save → modify → load restores scene/groups/cues; output kept unless includeOutput; dirty flag', async () => {
  c.send({ type: 'session.save', name: 'Gig 1' });
  await waitFor(() => c.sessions?.some((s) => s.name === 'Gig 1') && c.state.session?.name === 'Gig 1');
  await waitFor(() => c.state.session.modified === false);
  const file = path.join(srv.dataDir, 'sessions', 'Gig 1.objitter-session.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.kind, 'session');
  assert.equal(saved.version, 1);
  assert.equal(saved.scene.objects.length, 32);
  assert.ok(saved.presets.Twenty, 'presets referenced by cues are embedded');
  assert.equal(saved.showLock, undefined, 'show lock is not part of a session');
  const range = c.objects[0].range.x;
  const port = t1().port;
  const groups = c.state.groups.map((g) => g.name);
  const cueCount = c.tc.cues.length;
  const transition = c.state.master.transition;
  const running = c.state.master.running;

  c.send({ type: 'updateObjects', ids: [1], patch: { range: { x: 0.33 } } });
  c.send({ type: 'master', transition: 7 });
  c.send({ type: 'output.target.update', id: 't1', patch: { port: port + 1 } });
  c.send({ type: 'groups.save', name: 'back', ids: [9, 10] });
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:40:00', action: 'stop' } });
  await waitFor(() => c.state.session?.modified === true && c.tc.cues.length === cueCount + 1 && t1().port === port + 1);

  const k = c.mark();
  c.send({ type: 'session.load', name: 'gig 1' });
  await waitFor(() => c.objects[0].range.x === range && c.tc.cues.length === cueCount, 3000);
  assert.deepEqual(c.state.groups.map((g) => g.name), groups);
  assert.equal(c.state.master.transition, transition);
  assert.equal(t1().port, port + 1, 'output targets kept by default');
  assert.equal(c.state.master.running, running, 'load never starts/stops transport');
  assert.ok(c.state.canUndo, 'undo snapshot before load');
  await waitFor(() => c.state.session?.name === 'Gig 1' && c.state.session.modified === false);
  assert.ok(c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.session.loaded'));

  c.send({ type: 'session.load', name: 'Gig 1', includeOutput: true });
  await waitFor(() => t1().port === port, 3000);
});

test('sessions: invalid files, path traversal and newer formats rejected; lock blocks load; OSC save/load; NFD names', async () => {
  const dir = path.join(srv.dataDir, 'sessions');
  let k = c.mark();
  c.send({ type: 'session.import', name: 'Bad', data: { app: 'objitter', kind: 'show', version: 1 } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.importFailed' && m.text.includes('Not a valid Objitter session file')));
  const good = JSON.parse(fs.readFileSync(path.join(dir, 'Gig 1.objitter-session.json'), 'utf8'));
  k = c.mark();
  c.send({ type: 'session.import', name: 'Future', data: { ...good, version: 99 } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.importFailed' && m.text.includes('newer')));
  k = c.mark();
  c.send({ type: 'session.import', name: 'BadCue', data: { ...good, timecode: { settings: {}, cues: [{ tc: 'zz', slot: 1 }] } } });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.importFailed'));
  assert.ok(!c.sessions.some((s) => /Bad|Future/.test(s.name)));

  c.send({ type: 'session.import', name: '../../evil', data: good });
  await waitFor(() => c.sessions.some((s) => s.name.endsWith('evil')));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'evil.objitter-session.json')));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, '..', 'evil.objitter-session.json')));
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('evil.objitter-session.json')));
  k = c.mark();
  c.send({ type: 'session.load', name: '../state' });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.session.notFound'));

  fs.writeFileSync(path.join(dir, 'Broken.objitter-session.json'), '{ nope');
  k = c.mark();
  c.send({ type: 'session.load', name: 'Broken' });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.session.loadFailed'));

  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  k = c.mark();
  c.send({ type: 'session.load', name: 'Gig 1' });
  await osc('/objitter/session/load', ['Gig 1']);
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.locked'));
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.lockedOsc'));
  assert.ok(!c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.session.loaded'));
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);

  await osc('/objitter/session/save', ['Osc Saved']);
  await waitFor(() => c.sessions.some((s) => s.name === 'Osc Saved') && c.state.session?.name === 'Osc Saved');
  await osc('/objitter/session/load', ['Gig 1']);
  await waitFor(() => c.state.session?.name === 'Gig 1');

  const nfd = '공연 A'.normalize('NFD');
  fs.writeFileSync(path.join(dir, `${nfd}.objitter-session.json`), JSON.stringify({ ...good, name: nfd }));
  c.send({ type: 'session.list' });
  await waitFor(() => c.sessions.some((s) => s.name === '공연 A'));
  c.send({ type: 'session.load', name: '공연 A' });
  await waitFor(() => c.state.session?.name === '공연 A');
  c.send({ type: 'session.rename', name: 'Osc Saved', to: 'Renamed' });
  await waitFor(() => c.sessions.some((s) => s.name === 'Renamed') && !c.sessions.some((s) => s.name === 'Osc Saved'));
  c.send({ type: 'session.delete', name: 'renamed' });
  await waitFor(() => !c.sessions.some((s) => s.name === 'Renamed'));
  c.send({ type: 'session.export', name: 'Gig 1' });
  const ex = await waitFor(() => c.msgs.find((m) => m.type === 'session.data'));
  assert.equal(ex.data.kind, 'session');
});

test('HTTP: icons, manifest and svg are served with the right MIME types', async () => {
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p }, (res) => { res.resume(); resolve(res); }).on('error', reject);
  });
  const svg = await get('/assets/logo.svg');
  assert.equal(svg.statusCode, 200);
  assert.match(svg.headers['content-type'], /image\/svg\+xml/);
  const mf = await get('/manifest.webmanifest');
  assert.equal(mf.statusCode, 200);
  assert.match(mf.headers['content-type'], /application\/manifest\+json/);
  const png = await get('/assets/icon-192.png');
  assert.equal(png.statusCode, 200);
  assert.match(png.headers['content-type'], /image\/png/);
  assert.match(png.headers['cache-control'], /max-age/);
  const jpg = await get('/assets/hero.jpg');
  assert.match(jpg.headers['content-type'], /image\/jpeg/);
  const lang = await get('/lang/ko.js');
  assert.match(lang.headers['content-type'], /javascript/);
});

function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Length': body.length, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('stage assets: same-origin upload only, MIME sniffed, 10 MB cap, Show Lock refuses; served immutable; layout import + session round trip', async () => {
  const origin = `http://127.0.0.1:${srv.port}`;
  const ok = { Origin: origin, 'X-Objitter': '1' };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  assert.equal((await post(srv.port, '/api/assets', png, { Origin: 'http://evil.example', 'X-Objitter': '1' })).status, 403);
  assert.equal((await post(srv.port, '/api/assets', png, { Origin: origin })).status, 403, 'custom header required');
  assert.equal((await post(srv.port, '/api/assets', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), ok)).status, 415);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  assert.equal((await post(srv.port, '/api/assets', big, ok)).status, 413);
  const up = await post(srv.port, '/api/assets', png, ok);
  assert.equal(up.status, 200);
  assert.match(up.body.id, /^[a-f0-9]{32}\.png$/);
  const again = await post(srv.port, '/api/assets', png, ok);
  assert.equal(again.body.id, up.body.id, 'content-hash name');
  const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: srv.port, path: `/assets/${up.body.id}` }, (r) => { r.resume(); resolve(r); }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(await httpGet(srv.port, '/assets/0123456789abcdef0123456789abcdef.png'), 404);

  c.send({ type: 'stage.set', patch: { background: { asset: up.body.id, name: 'plan.png', opacity: 0.4 } } });
  const st1 = await waitFor(() => c.msgs.findLast((m) => m.type === 'stage' && m.stage.background.asset === up.body.id));
  assert.equal(st1.stage.background.opacity, 0.4);
  const k = c.mark();
  c.send({ type: 'stage.layout.parse', text: 'name,x,y,z\nL,-4,3,0\nR,4,3,0\nSub,0,3,-1\n', filename: 'room.csv' });
  const parsed = await waitFor(() => c.since(k).find((m) => m.type === 'stage.layout.parsed'));
  assert.deepEqual([parsed.format, parsed.rooms[0].count, parsed.rooms[0].subs], ['csv', 3, 1]);
  c.send({ type: 'stage.layout', text: 'name,x,y,z\nL,-4,3,0\nR,4,3,0\nSub,0,3,-1\n', filename: 'room.csv' });
  const st2 = await waitFor(() => c.since(k).findLast((m) => m.type === 'stage' && m.stage.speakers.items.length === 3));
  assert.equal(st2.stage.speakers.transform.metersPerUnit, 4, 'fit: farthest speaker at 1.0');
  assert.equal(st2.stage.speakers.name, 'room');

  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  const locked = await post(srv.port, '/api/assets', Buffer.concat([png, Buffer.from([1])]), ok);
  assert.equal(locked.status, 423);
  const k2 = c.mark();
  c.send({ type: 'stage.set', patch: { background: { opacity: 0.9 } } });
  await waitFor(() => c.since(k2).some((m) => m.type === 'toast' && m.key === 'srv.locked'));
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);

  c.send({ type: 'session.save', name: 'Stage RT' });
  await waitFor(() => c.toast(/Stage RT/));
  const file = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'sessions', 'Stage RT.objitter-session.json'), 'utf8'));
  assert.equal(file.stage.background.asset, up.body.id);
  assert.ok(file.assets[up.body.id], 'image embedded in the session');
  assert.equal(file.stage.speakers.items.length, 3);
  fs.unlinkSync(path.join(srv.dataDir, 'assets', up.body.id));
  c.send({ type: 'stage.clear', what: 'speakers' });
  await waitFor(() => c.msgs.findLast((m) => m.type === 'stage')?.stage.speakers.items.length === 0);
  c.send({ type: 'session.load', name: 'Stage RT' });
  await waitFor(() => c.msgs.findLast((m) => m.type === 'stage')?.stage.speakers.items.length === 3);
  await waitFor(() => fs.existsSync(path.join(srv.dataDir, 'assets', up.body.id)), 3000);
});

test('layout upload over HTTP: same-origin only, parse errors 422, token import, expired token, Show Lock 423', async () => {
  const origin = `http://127.0.0.1:${srv.port}`;
  const ok = { Origin: origin, 'X-Objitter': '1' };
  const csv = Buffer.from('name,x,y,z\nL,-4,3,0\nR,4,3,0\nC,0,4,0\nSub,0,3,-1\n');
  assert.equal((await post(srv.port, '/api/layout?filename=room.csv', csv, { Origin: 'http://evil.example', 'X-Objitter': '1' })).status, 403);
  assert.equal((await post(srv.port, '/api/layout?filename=room.csv', csv, { Origin: origin })).status, 403, 'custom header required');
  assert.equal((await post(srv.port, '/api/layout?filename=junk.json', Buffer.from('{"nope": 1}'), ok)).status, 422);
  const up = await post(srv.port, '/api/layout?filename=room.csv', csv, ok);
  assert.equal(up.status, 200);
  assert.equal(up.body.format, 'csv');
  assert.equal(up.body.rooms[0].count, 4);
  assert.match(up.body.token, /^[\w-]{8,}$/);
  const k = c.mark();
  c.send({ type: 'stage.layout', token: up.body.token, room: up.body.rooms[0].index });
  await waitFor(() => c.since(k).findLast((m) => m.type === 'stage' && m.stage.speakers.items.length === 4));
  c.send({ type: 'stage.layout', token: up.body.token, room: 0 });
  await waitFor(() => c.since(k).some((m) => m.type === 'toast' && m.key === 'srv.stage.layoutExpired'), 2000);
  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  assert.equal((await post(srv.port, '/api/layout?filename=room.csv', csv, ok)).status, 423);
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);
});

test('manual speakers: add / update / delete, validation, bad index, Show Lock', async () => {
  c.send({ type: 'stage.clear', what: 'speakers' });
  await waitFor(() => c.msgs.findLast((m) => m.type === 'stage')?.stage.speakers.items.length === 0);
  const last = () => c.msgs.findLast((m) => m.type === 'stage').stage.speakers;
  const k = c.mark();
  c.send({ type: 'stage.speaker.add', kind: 'main', x: 1, y: 2, z: 0.5 });
  const added = await waitFor(() => c.since(k).find((m) => m.type === 'stage.speaker.added'));
  assert.equal(added.index, 0);
  assert.equal(last().items.length, 1, 'stage broadcast precedes the reply');
  assert.equal(last().source, 'manual');
  assert.equal(last().transform.metersPerUnit, 5);
  c.send({ type: 'stage.speaker.add', kind: 'sub', x: 'bad', y: 1e9 });
  await waitFor(() => last().items.length === 2);
  assert.deepEqual([last().items[1].kind, last().items[1].x, last().items[1].y, last().items[1].name], ['sub', 0, 1000, 'SUB 1']);
  c.send({ type: 'stage.speaker.update', index: 0, patch: { x: -3.25, name: 'Left', yaw: 30, kind: 'sub', bogus: 1 } });
  await waitFor(() => last().items[0].name === 'Left');
  assert.deepEqual([last().items[0].x, last().items[0].y, last().items[0].yaw, last().items[0].kind], [-3.25, 2, 30, 'sub']);
  const k2 = c.mark();
  c.send({ type: 'stage.speaker.update', index: 7, patch: { x: 1 } });
  c.send({ type: 'stage.speaker.delete', index: '0x' });
  await waitFor(() => c.since(k2).filter((m) => m.type === 'toast' && m.key === 'srv.stage.spBadIndex').length === 2);
  c.send({ type: 'stage.speaker.delete', index: 1 });
  await waitFor(() => last().items.length === 1);
  c.send({ type: 'lock.set', locked: true });
  await waitFor(() => c.state.showLock === true);
  const k3 = c.mark();
  c.send({ type: 'stage.speaker.add', kind: 'main' });
  await waitFor(() => c.since(k3).some((m) => m.type === 'toast' && m.key === 'srv.locked'));
  c.send({ type: 'lock.set', locked: false });
  await waitFor(() => c.state.showLock === false);
  assert.equal(last().items.length, 1);
});

test('library: save one object, folders, path traversal refused, apply to others (region kept), cue + clip, delete asks when used', async () => {
  const items = () => (c.msgs.findLast((m) => m.type === 'library')?.items ?? []);
  c.send({ type: 'updateObjects', ids: [3], patch: { enabled: true, mode: 'orbit', speedScale: 1.7, center: { x: 0.3, y: 0.2, z: 0 } } });
  await waitFor(() => c.objects[2].mode === 'orbit');
  const k = c.mark();
  c.send({ type: 'lib.folder.add', path: 'Moves/Slow' });
  await waitFor(() => c.since(k).some((m) => m.type === 'lib.folder.added' && m.path === 'Moves/Slow'));
  c.send({ type: 'lib.folder.add', path: '../escape' });
  c.send({ type: 'lib.save', id: 3, folder: '../../etc', name: 'x' });
  await waitFor(() => c.since(k).filter((m) => m.type === 'toast' && m.level === 'error').length >= 2);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'escape')) && !fs.existsSync(path.join(srv.dataDir, '..', 'escape')));
  c.send({ type: 'lib.save', id: 3, folder: 'Moves/Slow', name: 'Orbit 1.7' });
  await waitFor(() => c.since(k).some((m) => m.type === 'lib.saved' && m.path === 'Moves/Slow/Orbit 1.7'));
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'library', 'Moves', 'Slow', 'Orbit 1.7.json')));
  const it = items().find((x) => x.path === 'Moves/Slow/Orbit 1.7');
  assert.deepEqual([it.mode, it.includeRegion], ['orbit', false]);
  const k2 = c.mark();
  c.send({ type: 'lib.save', id: 3, folder: 'Moves/Slow', name: 'Orbit 1.7' });
  await waitFor(() => c.since(k2).some((m) => m.type === 'confirm' && m.msg?.overwrite === true));

  const x5 = c.objects[4].center.x;
  c.send({ type: 'lib.apply', path: 'Moves/Slow/Orbit 1.7', ids: [5, 6] });
  await waitFor(() => c.objects[4].mode === 'orbit' && c.objects[5].mode === 'orbit');
  assert.equal(c.objects[4].speedScale, 1.7);
  assert.equal(c.objects[4].center.x, x5, 'region not included → position kept');

  const k3 = c.mark();
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:50:00', action: 'library', label: 'NoLib' } });
  await waitFor(() => c.since(k3).some((m) => m.type === 'toast' && m.key === 'srv.cue.errors'));
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:50:00', action: 'library', lib: 'Moves/Slow/Orbit 1.7', targets: '9', label: 'Lib cue' } });
  const cue = await waitFor(() => c.tc.cues.find((x) => x.action === 'library'));
  c.send({ type: 'tc.cue.fire', id: cue.id });
  await waitFor(() => c.objects[8].mode === 'orbit', 2000);
  c.send({ type: 'tc.cue.add', cue: { tc: '00:00:51:00', action: 'clips', clips: [{ kind: 'library', targets: '10', start: 0, dur: 1, params: { path: '../x' } }] } });
  await waitFor(() => c.since(k3).filter((m) => m.type === 'toast' && m.key === 'srv.cue.errors').length === 2);

  const k4 = c.mark();
  c.send({ type: 'lib.delete', path: 'Moves/Slow/Orbit 1.7' });
  const ask = await waitFor(() => c.since(k4).find((m) => m.type === 'confirm'));
  c.send(ask.msg);
  await waitFor(() => !items().some((x) => x.path === 'Moves/Slow/Orbit 1.7'));
  c.send({ type: 'tc.cue.delete', id: cue.id });
  await waitFor(() => !c.tc.cues.some((x) => x.id === cue.id));
});

test('OSC log: only subscribers get entries; incoming messages are recorded; fast streams are sampled', async () => {
  const other = await client(srv);
  const k = c.mark();
  c.send({ type: 'osclog.sub', on: true });
  await waitFor(() => c.since(k).some((m) => m.type === 'osclog' && m.reset));
  await osc('/objitter/speed', [1]);
  for (let i = 0; i < 40; i++) await osc('/objitter/obj/1/x', [i / 100]);
  const logs = () => c.since(k).filter((m) => m.type === 'osclog').flatMap((m) => m.entries);
  await waitFor(() => logs().some((e) => e.dir === 'in' && e.addr === '/objitter/speed'), 2000);
  await sleep(300);
  const xs = logs().filter((e) => e.addr === '/objitter/obj/1/x');
  assert.ok(xs.length >= 1 && xs.length < 20, `sampled: ${xs.length}`);
  assert.ok(logs().every((e) => typeof e.t === 'number' && typeof e.peer === 'string' && typeof e.args === 'string'));
  assert.ok(!other.msgs.some((m) => m.type === 'osclog'), 'non-subscribers get nothing');
  c.send({ type: 'osclog.sub', on: false });
  other.ws.close();
});

test('state is saved atomically into DATA_DIR only', async () => {
  await waitFor(() => fs.existsSync(path.join(srv.dataDir, 'state.json')), 5000);
  await sleep(300);
  const s = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'state.json'), 'utf8'));
  assert.ok(s.scene.objects.length === 32 && Array.isArray(s.output.targets));
  const now = fs.existsSync(realState) ? fs.statSync(realState).mtimeMs : null;
  assert.equal(now, realStateMtime, 'real data/state.json must not be touched');
});

test('port in use: friendly message and exit code 1', async () => {
  const dup = await startServer({ env: { PORT: String(srv.port) }, wait: false });
  await waitFor(() => dup.exitCode !== undefined, 8000);
  assert.equal(dup.exitCode, 1);
  assert.ok(dup.log.includes('$env:PORT=8081; npm start'), dup.log);
});

test('corrupt state.json (with BOM) is moved aside and the server starts', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'corrupt-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '\uFEFF{"scene": [broken');
  const s2 = await startServer({ dataDir: dir });
  assert.equal(s2.exitCode, undefined);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')));
  const c2 = await client(s2);
  assert.ok(c2.state.startupWarning);
  c2.ws.close();
  stopServer(s2);
});

test('old single-output state (BOM, inherited system key) migrates safely', async () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'bom-'));
  fs.writeFileSync(path.join(dir, 'state.json'), `\uFEFF${JSON.stringify({ output: { system: 'constructor' }, scene: { objects: [{ id: 2, enabled: 'false', name: 'two' }] } })}`);
  const s3 = await startServer({ dataDir: dir });
  const c3 = await client(s3);
  assert.equal(c3.state.output.targets[0].system, 'spat');
  assert.equal(c3.objects[1].name, 'two');
  assert.equal(c3.objects[1].enabled, false);
  c3.ws.close();
  stopServer(s3);
  const dir2 = fs.mkdtempSync(path.join(tmpRoot, 'old-'));
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ output: { system: 'ds100', systems: { ds100: { host: '10.0.0.5', port: 50010, mapping: 2 } } } }));
  const s5 = await startServer({ dataDir: dir2 });
  const c5 = await client(s5);
  const tg = c5.state.output.targets[0];
  assert.deepEqual([tg.system, tg.host, tg.port, tg.cfg.mapping], ['ds100', '10.0.0.5', 50010, 2]);
  assert.deepEqual([tg.transform.scaleX, tg.transform.offsetZ, tg.transform.clamp], [1, 0, true], 'old files get scale defaults');
  c5.ws.close();
  stopServer(s5);
});

test('control port conflict is reported instead of silently sharing', async () => {
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const s4 = await startServer({ env: { CONTROL_PORT: String(port) } });
  const c4 = await client(s4);
  await waitFor(() => c4.state.controlStatus.state === 'error', 3000);
  assert.equal(c4.state.controlStatus.code, 'EADDRINUSE');
  assert.ok(/in use/.test(c4.state.controlStatus.message));
  c4.ws.close();
  stopServer(s4);
  blocker.close();
});

export default async () => {
  try {
    return await run('Server integration tests');
  } finally {
    c?.ws.close();
    for (const p of procs) p.kill();
    await sleep(200);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
  }
};
