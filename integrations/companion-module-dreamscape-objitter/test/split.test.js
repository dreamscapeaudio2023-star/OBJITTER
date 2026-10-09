// Regression for "Companion shows Objitter's state, but buttons do nothing" (module 1.0.1):
// two Objitter instances on one PC (e.g. a dev server on 8080 + the tray app on 8081). The first one holds the
// OSC control port, the second one fails with EADDRINUSE. The module's feedback follows the second instance while
// its OSC commands land on the first. Since 1.0.2, commands go over the feedback WebSocket (same instance) and the
// module reports the OSC problem.
// Run: node test/split.test.js   (env: OBJITTER_TEST_PORT=18900, OBJITTER_TEST_CONTROL_PORT=19900)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')
const { buildActions } = require('../src/actions')
const { ObjitterState } = require('../src/state')
const { OscSender } = require('../src/osc')
const { ObjitterSocket } = require('../src/ws-client')
const { CommandRouter, plainArgs } = require('../src/commands')

const ROOT = path.resolve(__dirname, '../../..')
const PORT_A = Number(process.env.OBJITTER_TEST_PORT || 18900)
const PORT_B = PORT_A + 1
const CONTROL_PORT = Number(process.env.OBJITTER_TEST_CONTROL_PORT || 19900)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what, ms = 5000) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return
		await sleep(25)
	}
	throw new Error(`timeout waiting for: ${what}`)
}

/** No HOST: binds all interfaces like a default install, so localhost / LAN-IP senders are exercised too. */
function startServer(tmp, name, port) {
	const dir = path.join(tmp, name)
	fs.mkdirSync(path.join(dir, 'presets'), { recursive: true })
	const proc = spawn(process.execPath, ['server/index.js'], {
		cwd: ROOT,
		env: {
			...process.env,
			HOST: '',
			PORT: String(port),
			CONTROL_PORT: String(CONTROL_PORT),
			DATA_DIR: path.join(dir, 'data'),
			PRESET_DIR: path.join(dir, 'presets'),
			LIBRARY_DIR: path.join(dir, 'library'),
			OBJITTER_CAFFEINATE: '0',
		},
		stdio: 'pipe',
	})
	const srv = { proc, log: '', exit: undefined }
	proc.stdout.on('data', (d) => (srv.log += d))
	proc.stderr.on('data', (d) => (srv.log += d))
	proc.on('exit', (code) => (srv.exit = code))
	return srv
}

/** One-shot read of a server's full state (separate raw client). */
async function snapshot(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
	try {
		return await new Promise((resolve, reject) => {
			ws.once('error', reject)
			ws.once('open', () => ws.send(JSON.stringify({ type: 'hello' })))
			ws.on('message', (raw) => {
				const m = JSON.parse(raw)
				if (m.type === 'init') resolve(m)
			})
		})
	} finally {
		ws.close()
	}
}
const running = async (port) => (await snapshot(port)).state.master.running

function lanIPv4() {
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address
	}
	return null
}

function unitTests() {
	assert.deepEqual(plainArgs([1, 'a', { type: 'f', value: 0.5 }, { type: 'i', value: 2.4 }, { type: 's', value: 3 }]), [1, 'a', 0.5, 2, '3'])
	const st = new ObjitterState()
	st.link = 'connected'
	st.handle({ type: 'init', static: { version: 'x' }, state: { master: {}, control: { enabled: true, port: 9000 }, controlStatus: { state: 'listening', port: 9000 } } })
	assert.equal(st.wsControl, false, 'older server: no WS control')
	assert.equal(st.oscProblem(9000), '')
	assert.match(st.oscProblem(9001), /listens for OSC on UDP 9000, but the module sends to UDP 9001/)
	st.handle({ type: 'state', state: { master: {}, controlStatus: { state: 'error', port: 9000, message: 'UDP port 9000 is in use by another program', code: 'EADDRINUSE' } } })
	assert.match(st.oscProblem(9000), /in use by another program/)
	st.handle({ type: 'state', state: { master: {}, control: { enabled: false, port: 9000 }, controlStatus: { state: 'disabled', port: null } } })
	assert.match(st.oscProblem(9000), /turned off/)
}

async function main() {
	unitTests()
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-split-'))
	const srvB = startServer(tmp, 'b', PORT_B)
	let srvA
	const sock = new ObjitterSocket()
	const osc = new OscSender()
	try {
		await waitFor(() => srvB.log.includes(`listening for control on UDP ${CONTROL_PORT}`) || srvB.exit !== undefined, 'B: OSC input', 10000)
		assert.equal(srvB.exit, undefined, `server B exited:\n${srvB.log}`)
		srvA = startServer(tmp, 'a', PORT_A)
		await waitFor(() => srvA.log.includes(`UDP port ${CONTROL_PORT} is in use`) || srvA.exit !== undefined, 'A: EADDRINUSE', 10000)
		await waitFor(() => srvA.log.includes(`:${PORT_A}`), 'A: web server', 10000)
		assert.equal(srvA.exit, undefined, `server A exited:\n${srvA.log}`)

		// module wired as in main.js, connected (feedback) to A, OSC to the shared control port
		const state = new ObjitterState()
		const logs = []
		const log = (level, msg) => logs.push([level, msg])
		const router = new CommandRouter({ osc, sock, state, log })
		const self = { state, log, sendOsc: (a, args) => router.send(a, args), sendWs: (m) => sock.send(m), parse: async (t) => t }
		const act = (id, options = {}) => buildActions(self)[id].callback({ options }, {})
		sock.on('status', (s) => {
			if (s.state === 'open') state.link = 'connected'
		})
		sock.on('message', (m) => state.handle(m))
		osc.configure('127.0.0.1', CONTROL_PORT)
		sock.start('127.0.0.1', PORT_A)
		await waitFor(() => state.ready, 'module WebSocket init from A')
		assert.equal(state.controlStatus?.code, 'EADDRINUSE')
		assert.match(state.oscProblem(CONTROL_PORT), /in use by another program/, 'module can explain why OSC misses A')
		assert.equal(state.wsControl, true, 'A advertises WebSocket control')

		// the 1.0.1 behaviour (OSC only): START reaches B, A — the instance Companion displays — stays stopped
		const features = state.features
		for (const host of ['127.0.0.1', 'localhost', lanIPv4()].filter(Boolean)) {
			state.features = []
			osc.configure(host, CONTROL_PORT)
			assert.equal(await router.send('/objitter/start'), 'osc')
			await waitFor(running.bind(null, PORT_B), `OSC via ${host} lands on B`)
			assert.equal(await running(PORT_A), false, `OSC via ${host} must not reach A (bug reproduced)`)
			await router.send('/objitter/stop')
			await waitFor(async () => !(await running(PORT_B)), `B stopped via ${host}`)
		}
		state.features = features
		osc.configure('127.0.0.1', CONTROL_PORT)

		// fixed: actions follow the feedback link to A; B is untouched
		await act('start')
		await waitFor(() => state.master.running === true, 'A running via WebSocket control')
		assert.equal(await running(PORT_B), false, 'B untouched')
		await act('slot_recall', { slot: 1, fade: '0' })
		await act('freeze', { mode: 'on' })
		await waitFor(() => state.master.frozen === true, 'A frozen via WebSocket control')
		await act('freeze', { mode: 'off' })
		await waitFor(() => state.master.frozen === false, 'A unfrozen')

		// Show Lock: same rules as OSC — object edits refused, transport allowed
		const modeOf1 = async () => (await snapshot(PORT_A)).objects[0].mode
		const before = await modeOf1()
		const other = before === 'orbit' ? 'hold' : 'orbit'
		await act('show_lock', { mode: 'on' })
		await waitFor(() => state.showLock === true, 'show lock on')
		await act('obj_mode', { targets: '1', motion: other })
		await act('stop')
		await waitFor(() => state.master.running === false, 'STOP allowed under Show Lock')
		assert.equal(await modeOf1(), before, 'object edit refused under Show Lock')
		await act('show_lock', { mode: 'off' })
		await waitFor(() => state.showLock === false, 'show lock off')
		await act('obj_mode', { targets: '1', motion: other })
		await waitFor(async () => (await modeOf1()) === other, 'object edit applied when unlocked')

		// OSC send failure is reported, not swallowed
		const bad = new OscSender()
		bad.configure('no-such-host.invalid', CONTROL_PORT)
		let reported = null
		const r2 = new CommandRouter({ osc: bad, sock: { connected: false }, state, log, onOscResult: (e) => (reported = e) })
		assert.equal(await r2.send('/objitter/start'), null)
		assert.ok(reported, 'OSC error surfaced to the instance')
		assert.ok(logs.some(([l, m]) => l === 'warn' && m.includes('no-such-host.invalid')), 'OSC error logged')
		bad.close()

		console.log(`ok - split instances: OSC :${CONTROL_PORT} held by B (:${PORT_B}); commands follow feedback to A (:${PORT_A})`)
	} finally {
		sock.stop()
		osc.close()
		for (const s of [srvA, srvB]) if (s && s.exit === undefined) s.proc.kill()
		await sleep(300)
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
