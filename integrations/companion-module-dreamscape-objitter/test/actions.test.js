// Drives every action callback (no Companion needed) and checks the exact OSC packet / WS message Objitter expects.
// Run: node test/actions.test.js
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { buildActions } = require('../src/actions')
const { buildFeedbacks } = require('../src/feedbacks')
const { buildPresets } = require('../src/presets')
const { variableDefinitions } = require('../src/variables')
const { ObjitterState } = require('../src/state')
const { OscSender, decodeMessage } = require('../src/osc')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeInstance(port) {
	const self = {
		state: new ObjitterState(),
		config: { feedback: true },
		logs: [],
		ws: [],
		osc: new OscSender(),
		log: (level, msg) => self.logs.push([level, msg]),
		sendOsc: (address, args) => self.osc.send(address, args),
		sendWs: (m) => {
			self.ws.push(m)
			return true
		},
		parse: async (text) => text.replace(/\$\(test:(\w+)\)/g, (_, k) => ({ n: '7', name: 'Scene B' })[k] ?? ''),
	}
	self.osc.configure('127.0.0.1', port)
	return self
}

function liveState(st) {
	st.link = 'connected'
	st.handle({
		type: 'init',
		static: { version: '0.2.0' },
		state: {
			master: { running: false, frozen: true, speed: 1, speedTarget: 1, tempoMult: 1, transition: 1.5 },
			bpm: 120,
			showLock: false,
			lastPreset: { name: 'Scene A', modified: false },
			session: { name: 'Show', modified: true },
			groups: [{ name: 'front', ids: [1, 2, 3], color: null }],
		},
		presets: [
			{ name: 'Scene A', slot: 1 },
			{ name: 'Scene B', slot: 2 },
			{ name: 'Loose', slot: null },
		],
		sessions: [{ name: 'Show' }],
		library: { folders: [], items: [{ path: 'Moves/Wide', name: 'Wide' }] },
		tc: {
			settings: { input: 'internal' },
			cues: [
				{ id: 'a', label: 'Intro', tc: '00:00:01:00' },
				{ id: 'b', label: 'Verse', tc: '00:00:10:00' },
				{ id: 'c', label: '', tc: '00:00:20:00' },
			],
		},
		tcs: { state: 'off', enabled: true, input: 'internal', trigger: 'go', standby: { id: 'b', index: 2, label: 'Verse' }, internal: { playing: true, tc: '00:00:05:00' } },
	})
}

async function main() {
	const sock = dgram.createSocket('udp4')
	const got = []
	sock.on('message', (b) => got.push(decodeMessage(b)))
	await new Promise((r) => sock.bind(0, '127.0.0.1', r))
	const self = fakeInstance(sock.address().port)
	liveState(self.state)
	const actions = buildActions(self)

	const cases = [
		['start', {}, '/objitter/start', [], ''],
		['stop', {}, '/objitter/stop', [], ''],
		['toggle', {}, '/objitter/toggle', [], ''],
		['freeze', { mode: 'on' }, '/objitter/freeze', [1], 'i'],
		['freeze', { mode: 'off' }, '/objitter/freeze', [0], 'i'],
		['freeze', { mode: 'toggle' }, '/objitter/freeze', [0], 'i'], // frozen → off
		['home', { fade: '' }, '/objitter/home', [], ''],
		['home', { fade: '2.5' }, '/objitter/home', [2.5], 'f'],
		['undo', {}, '/objitter/undo', [], ''],
		['tap', {}, '/objitter/tap', [], ''],
		['resync', {}, '/objitter/resync', [], ''],
		['bpm_set', { bpm: 128 }, '/objitter/bpm', [128], 'i'],
		['bpm_set', { bpm: 999 }, '/objitter/bpm', [300], 'i'],
		['bpm_nudge', { delta: -2.5 }, '/objitter/bpm', [117.5], 'f'],
		['tempo_mult', { mult: 0.5 }, '/objitter/tempomult', [0.5], 'f'],
		['speed_set', { speed: 1.5, ramp: 0 }, '/objitter/speed', [1.5], 'f'],
		['speed_set', { speed: 2, ramp: 3 }, '/objitter/speed', [2, 3], 'ii'],
		['speed_nudge', { delta: 0.25, ramp: 0 }, '/objitter/speed', [1.25], 'f'],
		['transition', { seconds: 0.75 }, '/objitter/transition', [0.75], 'f'],
		['slot_recall', { slot: 12, fade: '' }, '/objitter/slot', [12], 'i'],
		['slot_recall', { slot: 32, fade: '4' }, '/objitter/slot', [32, 4], 'ii'],
		['preset_recall', { preset: 'Scene B', fade: '' }, '/objitter/preset', ['Scene B'], 's'],
		['preset_recall', { preset: '$(test:name)', fade: '1.5' }, '/objitter/preset', ['Scene B', 1.5], 'sf'],
		['cue_go', {}, '/objitter/go', [], ''],
		['cue_back', {}, '/objitter/back', [], ''],
		['cue_next', {}, '/objitter/standby', [3], 'i'], // standby 2 → 3
		['cue_standby', { cue: 1 }, '/objitter/standby', [1], 'i'],
		['cue_standby', { cue: '3' }, '/objitter/standby', [3], 'i'],
		['tc_play', {}, '/objitter/tc/play', [], ''],
		['tc_pause', {}, '/objitter/tc/pause', [], ''],
		['tc_toggle', {}, '/objitter/tc/pause', [], ''], // internal clock playing → pause
		['tc_rewind', {}, '/objitter/tc/rewind', [], ''],
		['tc_locate', { tc: '01:00:20:12' }, '/objitter/tc/locate', ['01:00:20:12'], 's'],
		['tc_enable', { mode: 'off' }, '/objitter/tc/enable', [0], 'i'],
		['tc_enable', { mode: 'toggle' }, '/objitter/tc/enable', [0], 'i'],
		['session_load', { session: 'Show', includeOutput: false }, '/objitter/session/load', ['Show', 0], 'si'],
		['session_load', { session: 'Show', includeOutput: true }, '/objitter/session/load', ['Show', 1], 'si'],
		['session_save', { session: '' }, '/objitter/session/save', [], ''],
		['session_save', { session: 'Show 2' }, '/objitter/session/save', ['Show 2'], 's'],
		['obj_enable', { targets: '1-4,9', enabled: 'off' }, '/objitter/obj/1-4%2C9/enable', [0], 'i'],
		['obj_enable', { targets: '@front', enabled: 'on' }, '/objitter/obj/@front/enable', [1], 'i'],
		['obj_transport', { targets: 'all', cmd: 'pause' }, '/objitter/obj/all/pause', [], ''],
		['obj_transport', { targets: '$(test:n)', cmd: 'play' }, '/objitter/obj/7/play', [], ''],
		['obj_mode', { targets: '5', motion: 'orbit' }, '/objitter/obj/5/mode', ['orbit'], 's'],
		['obj_home', { targets: '*', fade: '' }, '/objitter/obj/*/home', [], ''],
		['obj_center', { targets: '3', x: '0.5', y: '-0.25', z: '' }, '/objitter/obj/3/center', [0.5, -0.25], 'ff'],
		['obj_center', { targets: '3', x: '0', y: '1', z: '0.2' }, '/objitter/obj/3/center', [0, 1, 0.2], 'fff'],
		['obj_set', { targets: '1-8', path: 'range.x', value: '0.5' }, '/objitter/obj/1-8/set', ['range.x', 0.5], 'sf'],
		['obj_set', { targets: '2', path: 'pathTiming', value: 'even' }, '/objitter/obj/2/set', ['pathTiming', 'even'], 'ss'],
	]

	const covered = new Set()
	for (const [id, options, address, args, types] of cases) {
		covered.add(id)
		const before = got.length
		await actions[id].callback({ options }, {})
		for (let i = 0; i < 50 && got.length === before; i++) await sleep(5)
		assert.equal(got.length, before + 1, `${id}: exactly one packet`)
		const m = got[got.length - 1]
		assert.equal(m.address, address, `${id}: address`)
		assert.equal(m.types, types, `${id}: type tags`)
		m.args.forEach((a, i) => {
			if (typeof a === 'number') assert.ok(Math.abs(a - args[i]) < 1e-6, `${id}: arg ${i} ${a} ≈ ${args[i]}`)
			else assert.equal(a, args[i], `${id}: arg ${i}`)
		})
		assert.equal(m.args.length, args.length, `${id}: arg count`)
	}

	// WebSocket-only actions
	await actions.show_lock.callback({ options: { mode: 'toggle' } }, {})
	await actions.show_lock.callback({ options: { mode: 'off' } }, {})
	await actions.library_apply.callback({ options: { path: 'Moves/Wide', targets: '@front', fade: '2' } }, {})
	await actions.library_apply.callback({ options: { path: 'Moves/Wide', targets: '1-2,30', fade: '' } }, {})
	covered.add('show_lock').add('library_apply')
	assert.deepEqual(self.ws, [
		{ type: 'lock.set', locked: true },
		{ type: 'lock.set', locked: false },
		{ type: 'lib.apply', path: 'Moves/Wide', ids: [1, 2, 3], fade: 2 },
		{ type: 'lib.apply', path: 'Moves/Wide', ids: [1, 2, 30] },
	])

	// invalid input sends nothing
	const before = got.length
	await actions.tc_locate.callback({ options: { tc: 'soon' } }, {})
	await actions.preset_recall.callback({ options: { preset: '  ', fade: '' } }, {})
	await actions.home.callback({ options: { fade: 'abc' } }, {})
	await actions.obj_set.callback({ options: { targets: '1', path: 'pathPts[0]', value: '1' } }, {})
	await sleep(50)
	assert.equal(got.length, before, 'invalid options send nothing')

	// state-dependent actions without the feedback link: warn, send nothing
	const offline = fakeInstance(sock.address().port)
	const offActions = buildActions(offline)
	for (const id of ['bpm_nudge', 'speed_nudge', 'tc_toggle', 'cue_next']) await offActions[id].callback({ options: { delta: 1 } }, {})
	await offActions.freeze.callback({ options: { mode: 'toggle' } }, {})
	await offActions.show_lock.callback({ options: { mode: 'on' } }, {})
	await sleep(50)
	assert.equal(got.length, before, 'offline toggles/nudges send nothing')
	assert.equal(offline.ws.length, 0)
	assert.equal(offline.logs.filter(([l]) => l === 'warn').length, 6)

	const missing = Object.keys(actions).filter((id) => !covered.has(id))
	assert.deepEqual(missing, [], 'every action is covered by this test')

	// dropdowns are filled from live state
	assert.deepEqual(actions.preset_recall.options[0].choices.map((c) => c.id), ['Scene A', 'Scene B', 'Loose'])
	assert.equal(actions.slot_recall.options[0].choices[1].label, '2: Scene B')
	assert.deepEqual(actions.cue_standby.options[0].choices.map((c) => c.label), ['1: Intro', '2: Verse', '3: 00:00:20:00'])
	assert.equal(actions.session_load.options[0].allowCustom, true)

	// feedbacks + variables
	const fb = buildFeedbacks(self)
	const on = (id, options = {}) => fb[id].callback({ options })
	assert.equal(on('frozen'), true)
	assert.equal(on('running'), false)
	assert.equal(on('slot_active', { slot: 1 }), true)
	assert.equal(on('slot_active', { slot: 2 }), false)
	assert.equal(on('slot_used', { slot: 2 }), true)
	assert.equal(on('slot_used', { slot: 3 }), false)
	assert.equal(on('cue_standby', { cue: 2 }), true)
	assert.equal(on('tc_running'), true)
	assert.equal(on('session_modified'), true)
	self.state.handle({ type: 'cue', id: 'a', how: 'go', ok: true })
	assert.equal(on('cue_current', { cue: 1 }), true)
	const vars = self.state.variables()
	const defIds = new Set(variableDefinitions().map((d) => d.variableId))
	for (const k of Object.keys(vars)) assert.ok(defIds.has(k), `variable ${k} is defined`)
	assert.equal(vars.cue_current_label, 'Intro')
	assert.equal(vars.cue_standby_number, '2')
	assert.equal(vars.slot_2, 'Scene B')
	assert.equal(vars.timecode, '00:00:05:00')
	assert.equal(vars.bpm, '120')

	// presets only reference existing actions/feedbacks
	const presets = buildPresets('objitter')
	for (const [pid, p] of Object.entries(presets)) {
		for (const a of p.steps[0].down) assert.ok(actions[a.actionId], `preset ${pid}: action ${a.actionId}`)
		for (const f of p.feedbacks) assert.ok(fb[f.feedbackId], `preset ${pid}: feedback ${f.feedbackId}`)
	}

	self.osc.close()
	offline.osc.close()
	sock.close()
	console.log(
		`ok - ${cases.length} OSC cases, ${Object.keys(actions).length} actions, ${Object.keys(fb).length} feedbacks, ` +
			`${variableDefinitions().length} variables, ${Object.keys(presets).length} presets`,
	)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
