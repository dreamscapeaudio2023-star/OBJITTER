// End-to-end check against a real, temporary Objitter server (no Companion needed):
// actions → OSC → Objitter, and Objitter → WebSocket → module state / variables / feedbacks.
// Run: node test/integration.test.js   (env: OBJITTER_TEST_PORT=18700, OBJITTER_TEST_CONTROL_PORT=19700)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')
const { buildActions } = require('../src/actions')
const { buildFeedbacks } = require('../src/feedbacks')
const { ObjitterState } = require('../src/state')
const { OscSender } = require('../src/osc')
const { ObjitterSocket } = require('../src/ws-client')

const ROOT = path.resolve(__dirname, '../../..')
const PORT = Number(process.env.OBJITTER_TEST_PORT || 18700)
const CONTROL_PORT = Number(process.env.OBJITTER_TEST_CONTROL_PORT || 19700)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what, ms = 5000) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (fn()) return
		await sleep(20)
	}
	throw new Error(`timeout waiting for: ${what}`)
}

function startServer(tmp) {
	const dataDir = path.join(tmp, 'data')
	const presetDir = path.join(tmp, 'presets')
	fs.mkdirSync(presetDir, { recursive: true })
	for (const f of fs.readdirSync(path.join(ROOT, 'presets'))) {
		if (f.startsWith('Demo - ') && f.endsWith('.json')) fs.copyFileSync(path.join(ROOT, 'presets', f), path.join(presetDir, f))
	}
	const proc = spawn(process.execPath, ['server/index.js'], {
		cwd: ROOT,
		env: {
			...process.env,
			PORT: String(PORT),
			CONTROL_PORT: String(CONTROL_PORT),
			HOST: '127.0.0.1',
			DATA_DIR: dataDir,
			PRESET_DIR: presetDir,
			LIBRARY_DIR: path.join(tmp, 'library'),
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

/** Separate raw client used only to prepare the test scene (the module itself stays read-only). */
async function setupClient() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
	await new Promise((resolve, reject) => {
		ws.once('open', resolve)
		ws.once('error', reject)
	})
	return { send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() }
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objitter-companion-'))
	const srv = startServer(tmp)
	const sock = new ObjitterSocket()
	const osc = new OscSender()
	let setup
	let srv2
	try {
		await waitFor(() => srv.log.includes(`Local:   http://localhost:${PORT}`) || srv.exit !== undefined, 'server start', 10000)
		assert.equal(srv.exit, undefined, `server exited:\n${srv.log}`)
		await waitFor(() => srv.log.includes(`listening for control on UDP ${CONTROL_PORT}`), 'OSC control input', 5000)

		const state = new ObjitterState()
		const self = {
			state,
			config: { feedback: true },
			logs: [],
			log: (level, msg) => self.logs.push([level, msg]),
			sendOsc: (a, args) => osc.send(a, args),
			sendWs: (m) => sock.send(m),
			parse: async (t) => t,
		}
		const statuses = []
		sock.on('status', (s) => {
			statuses.push(s.state)
			if (s.state === 'open') state.link = 'connected'
		})
		sock.on('message', (m) => state.handle(m))
		osc.configure('127.0.0.1', CONTROL_PORT)
		sock.start('127.0.0.1', PORT)
		await waitFor(() => state.ready, 'WebSocket init')
		const fb = buildFeedbacks(self)
		const isOn = (id, options = {}) => fb[id].callback({ options })
		const vars = () => state.variables()
		const act = async (id, options = {}) => {
			await buildActions(self)[id].callback({ options }, {})
		}
		assert.equal(vars().connection, 'connected')
		assert.equal(vars().running, 'off')
		assert.equal(state.slotPreset(1)?.name, 'Demo - Jitter Swarm', 'demo presets visible in slot list')
		assert.equal(buildActions(self).slot_recall.options[0].choices[0].label, '1: Demo - Jitter Swarm')

		// transport
		await act('start')
		await waitFor(() => state.master.running === true, 'running after START')
		assert.equal(isOn('running'), true)
		assert.equal(vars().running, 'on')

		// quick slot recall
		await act('slot_recall', { slot: 2, fade: '0' })
		await waitFor(() => state.lastPreset?.name === 'Demo - Slow Orbit & Drift', 'slot 2 recalled')
		assert.equal(isOn('slot_active', { slot: 2 }), true)
		assert.equal(isOn('slot_active', { slot: 1 }), false)
		assert.equal(vars().last_slot, '2')

		// preset by name
		await act('preset_recall', { preset: 'Demo - Jitter Swarm', fade: '' })
		await waitFor(() => state.lastPreset?.name === 'Demo - Jitter Swarm', 'preset recalled by name')

		// tempo
		await act('bpm_set', { bpm: 100 })
		await waitFor(() => state.bpm === 100, 'BPM 100')
		await act('bpm_nudge', { delta: 2 })
		await waitFor(() => state.bpm === 102, 'BPM nudge')
		for (let i = 0; i < 5; i++) {
			await act('tap')
			await sleep(400)
		}
		await waitFor(() => Math.abs(state.bpm - 150) < 6, 'tap tempo ≈150 BPM')
		assert.match(vars().bpm, /^1[45]\d/)
		await act('speed_set', { speed: 2, ramp: 0 })
		await waitFor(() => state.master.speed === 2, 'speed 2')

		// freeze
		await act('freeze', { mode: 'on' })
		await waitFor(() => state.master.frozen === true, 'frozen')
		assert.equal(isOn('frozen'), true)
		await act('freeze', { mode: 'toggle' })
		await waitFor(() => state.master.frozen === false, 'unfrozen via toggle')

		// show lock (WebSocket) blocks OSC object edits
		await act('show_lock', { mode: 'on' })
		await waitFor(() => state.showLock === true, 'show lock on')
		assert.equal(isOn('show_locked'), true)
		assert.equal(vars().show_lock, 'locked')
		await act('obj_mode', { targets: '1', motion: 'hold' })
		await sleep(300)
		await act('show_lock', { mode: 'toggle' })
		await waitFor(() => state.showLock === false, 'show lock off')
		await act('obj_mode', { targets: '1', motion: 'orbit' })
		await sleep(300)

		// cues + internal clock (scene prepared by a separate client)
		setup = await setupClient()
		setup.send({ type: 'hello' })
		setup.send({ type: 'tc.settings', patch: { input: 'internal', trigger: 'go', enabled: true } })
		setup.send({ type: 'tc.cue.add', cue: { tc: '00:00:01:00', action: 'stop', label: 'Cue Stop' } })
		setup.send({ type: 'tc.cue.add', cue: { tc: '00:00:02:00', action: 'start', label: 'Cue Start' } })
		setup.send({ type: 'tc.cue.add', cue: { tc: '00:00:03:00', action: 'slot', slot: 4, label: 'Cue Waypoints' } })
		await waitFor(() => state.tc.cues.length === 3 && state.tcs?.trigger === 'go' && state.standbyIndex === 1, 'cue list + standby 1')
		assert.equal(vars().cue_standby_label, 'Cue Stop')
		assert.equal(buildActions(self).cue_standby.options[0].choices.length, 3)

		await act('cue_go')
		await waitFor(() => state.currentCueIndex === 1 && state.master.running === false, 'GO fired cue 1 (stop)')
		assert.equal(vars().cue_current_label, 'Cue Stop')
		assert.equal(isOn('cue_current', { cue: 1 }), true)
		await waitFor(() => state.standbyIndex === 2, 'standby advanced to 2')
		assert.equal(isOn('cue_standby', { cue: 2 }), true)
		await act('cue_next')
		await waitFor(() => state.standbyIndex === 3, 'standby next → 3')
		await act('cue_back')
		await waitFor(() => state.standbyIndex === 2, 'back → 2')
		await act('cue_go')
		await waitFor(() => state.currentCueIndex === 2 && state.master.running === true, 'GO fired cue 2 (start)')
		await act('cue_standby', { cue: 3 })
		await waitFor(() => state.standbyIndex === 3, 'standby 3')
		await act('cue_go')
		await waitFor(() => state.lastPreset?.name === 'Demo - Linear Waypoints', 'GO fired cue 3 (slot 4)')

		await act('tc_locate', { tc: '00:10:00:00' })
		await waitFor(() => vars().timecode.startsWith('00:10:00'), 'locate 00:10:00:00')
		await act('tc_toggle')
		await waitFor(() => state.tcRunning, 'internal clock playing')
		assert.equal(isOn('tc_running'), true)
		const t0 = vars().timecode
		await waitFor(() => vars().timecode !== t0, 'timecode variable advances')
		await act('tc_pause')
		await waitFor(() => !state.tcRunning, 'internal clock paused')
		await act('tc_rewind')
		await waitFor(() => vars().timecode.startsWith('00:00:0'), 'rewind to first cue pre-roll')

		await act('stop')
		await waitFor(() => state.master.running === false, 'stopped')
		assert.equal(isOn('stopped'), true)

		// reconnect with backoff after the server goes away
		srv.proc.kill()
		await waitFor(() => statuses.includes('closed') || statuses.includes('error'), 'link closed')
		assert.ok(!sock.connected)
		state.reset()
		await sleep(1500)
		srv2 = startServer(tmp)
		await waitFor(() => state.ready, 'reconnected after server restart', 20000)
		assert.equal(state.tc.cues.length, 3, 'state re-read after reconnect')

		console.log(`ok - integration against temp Objitter on :${PORT} / OSC :${CONTROL_PORT} (${statuses.join(' → ')})`)
	} finally {
		setup?.close()
		sock.stop()
		osc.close()
		for (const s of [srv, srv2]) if (s && s.exit === undefined) s.proc.kill()
		await sleep(300)
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
