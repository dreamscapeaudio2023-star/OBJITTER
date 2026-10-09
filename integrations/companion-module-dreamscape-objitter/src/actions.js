const { SLOT_COUNT } = require('./state')

const MODES = ['hold', 'jitter', 'glide', 'path', 'drift', 'orbit']
const TEMPO_MULTS = [0.25, 0.5, 1, 2, 4]
const ON_OFF_TOGGLE = [
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
	{ id: 'toggle', label: 'Toggle' },
]
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round3 = (v) => Math.round(v * 1000) / 1000
const enc = (s) => encodeURIComponent(String(s).trim()).replace(/%40/g, '@')

/** Optional numeric text: '' → null, otherwise a finite number (or NaN when invalid). */
function optNum(s) {
	const t = String(s ?? '').trim()
	if (!t) return null
	const n = Number(t)
	return Number.isFinite(n) ? n : NaN
}

const fadeOpt = (label = 'Fade time (s, blank = Objitter default)') => ({
	type: 'textinput',
	id: 'fade',
	label,
	default: '',
	useVariables: true,
})
const targetsOpt = {
	type: 'textinput',
	id: 'targets',
	label: 'Objects: 5 · 1-8 · 1-4,9 · @group · all',
	default: 'all',
	useVariables: true,
}
const modeOpt = { type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: ON_OFF_TOGGLE }

/**
 * Action definitions. `self` provides: state (ObjitterState), sendOsc(address, args), sendWs(msg) → bool,
 * parse(text, context) → Promise<string>, log(level, msg). No Companion import so the tests can drive it.
 */
function buildActions(self) {
	const st = self.state
	const osc = (address, args = []) => self.sendOsc(address, args)
	const text = async (v, ctx) => String(await self.parse(String(v ?? ''), ctx)).trim()
	const needState = (what) => {
		if (st.ready) return true
		self.log('warn', `${what} needs the WebSocket feedback link (enable it in the connection config)`)
		return false
	}
	const fadeArgs = async (opt, ctx) => {
		const f = optNum(await text(opt.fade, ctx))
		if (Number.isNaN(f)) {
			self.log('warn', `Invalid fade time "${opt.fade}"`)
			return null
		}
		return f === null ? [] : [Math.max(0, f)]
	}
	const resolveToggle = (mode, current, what) => {
		if (mode === 'on') return true
		if (mode === 'off') return false
		if (!needState(`${what} toggle`)) return null
		return !current
	}

	const slotChoices = Array.from({ length: SLOT_COUNT }, (_, i) => {
		const p = st.slotPreset(i + 1)
		return { id: i + 1, label: p ? `${i + 1}: ${p.name}` : `${i + 1}` }
	})
	const presetChoices = st.presets.map((p) => ({ id: p.name, label: p.slot ? `${p.name} (slot ${p.slot})` : p.name }))
	const sessionChoices = st.sessions.map((s) => ({ id: s.name, label: s.name }))
	const cueChoices = st.tc.cues.map((c, i) => ({
		id: i + 1,
		label: `${i + 1}: ${c.label || c.tc || c.action}${c.enabled === false ? ' (off)' : ''}`,
	}))
	const libChoices = st.library.items.map((it) => ({ id: it.path, label: it.path }))
	const textDropdown = (id, label, choices) => ({
		type: 'dropdown',
		id,
		label,
		default: choices[0]?.id ?? '',
		choices,
		allowCustom: true,
	})

	return {
		// ---------- transport ----------
		start: { name: 'Transport: START', options: [], callback: () => osc('/objitter/start') },
		stop: { name: 'Transport: STOP', options: [], callback: () => osc('/objitter/stop') },
		toggle: { name: 'Transport: START/STOP toggle', options: [], callback: () => osc('/objitter/toggle') },
		freeze: {
			name: 'Transport: FREEZE on/off/toggle',
			options: [modeOpt],
			callback: ({ options }) => {
				const v = resolveToggle(options.mode, st.master?.frozen, 'FREEZE')
				if (v !== null) return osc('/objitter/freeze', [v ? 1 : 0])
			},
		},
		home: {
			name: 'Transport: RETURN (all objects home)',
			options: [fadeOpt()],
			callback: async ({ options }, ctx) => {
				const a = await fadeArgs(options, ctx)
				if (a) return osc('/objitter/home', a)
			},
		},
		undo: { name: 'Undo (ignored under Show Lock)', options: [], callback: () => osc('/objitter/undo') },

		// ---------- tempo ----------
		tap: { name: 'Tempo: TAP', options: [], callback: () => osc('/objitter/tap') },
		resync: { name: 'Tempo: RESYNC (align to next beat)', options: [], callback: () => osc('/objitter/resync') },
		bpm_set: {
			name: 'Tempo: set BPM',
			options: [{ type: 'number', id: 'bpm', label: 'BPM (20-300)', default: 120, min: 20, max: 300, step: 0.1 }],
			callback: ({ options }) => osc('/objitter/bpm', [clamp(Number(options.bpm), 20, 300)]),
		},
		bpm_nudge: {
			name: 'Tempo: nudge BPM',
			options: [{ type: 'number', id: 'delta', label: 'Change (+/- BPM)', default: 1, min: -100, max: 100, step: 0.1 }],
			callback: ({ options }) => {
				if (!needState('BPM nudge') || typeof st.bpm !== 'number') return
				return osc('/objitter/bpm', [round3(clamp(st.bpm + Number(options.delta), 20, 300))])
			},
		},
		tempo_mult: {
			name: 'Tempo: tempo multiplier',
			options: [
				{
					type: 'dropdown',
					id: 'mult',
					label: 'Multiplier',
					default: 1,
					choices: TEMPO_MULTS.map((m) => ({ id: m, label: `×${m}` })),
				},
			],
			callback: ({ options }) => osc('/objitter/tempomult', [Number(options.mult)]),
		},
		speed_set: {
			name: 'Master: set speed',
			options: [
				{ type: 'number', id: 'speed', label: 'Speed (0-4, 1 = normal)', default: 1, min: 0, max: 4, step: 0.05 },
				{ type: 'number', id: 'ramp', label: 'Ramp time (s)', default: 0, min: 0, max: 60, step: 0.1 },
			],
			callback: ({ options }) => {
				const args = [clamp(Number(options.speed), 0, 4)]
				if (Number(options.ramp) > 0) args.push(Number(options.ramp))
				return osc('/objitter/speed', args)
			},
		},
		speed_nudge: {
			name: 'Master: nudge speed',
			options: [
				{ type: 'number', id: 'delta', label: 'Change (+/-)', default: 0.1, min: -4, max: 4, step: 0.05 },
				{ type: 'number', id: 'ramp', label: 'Ramp time (s)', default: 0, min: 0, max: 60, step: 0.1 },
			],
			callback: ({ options }) => {
				if (!needState('Speed nudge') || typeof st.master?.speed !== 'number') return
				const args = [round3(clamp((st.master.speedTarget ?? st.master.speed) + Number(options.delta), 0, 4))]
				if (Number(options.ramp) > 0) args.push(Number(options.ramp))
				return osc('/objitter/speed', args)
			},
		},
		transition: {
			name: 'Master: crossfade (transition) time',
			options: [{ type: 'number', id: 'seconds', label: 'Seconds', default: 1.5, min: 0, max: 60, step: 0.1 }],
			callback: ({ options }) => osc('/objitter/transition', [Math.max(0, Number(options.seconds))]),
		},

		// ---------- recall ----------
		slot_recall: {
			name: 'Recall: quick slot (1-32)',
			options: [{ type: 'dropdown', id: 'slot', label: 'Slot', default: 1, choices: slotChoices }, fadeOpt()],
			callback: async ({ options }, ctx) => {
				const n = Math.round(Number(options.slot))
				if (!(n >= 1 && n <= SLOT_COUNT)) return self.log('warn', `Invalid slot "${options.slot}"`)
				const a = await fadeArgs(options, ctx)
				if (a) return osc('/objitter/slot', [n, ...a])
			},
		},
		preset_recall: {
			name: 'Recall: preset by name',
			options: [textDropdown('preset', 'Preset (pick or type a name)', presetChoices), fadeOpt()],
			callback: async ({ options }, ctx) => {
				const name = await text(options.preset, ctx)
				if (!name) return self.log('warn', 'Preset name is empty')
				const a = await fadeArgs(options, ctx)
				if (a) return osc('/objitter/preset', [name, ...a])
			},
		},

		// ---------- cues (GO list) ----------
		cue_go: { name: 'Cue: GO (fire standby cue)', options: [], callback: () => osc('/objitter/go') },
		cue_back: { name: 'Cue: BACK (standby previous, no fire)', options: [], callback: () => osc('/objitter/back') },
		cue_next: {
			name: 'Cue: standby next (no fire)',
			options: [],
			callback: () => {
				if (!needState('Standby next')) return
				const cur = st.standbyIndex
				const count = st.tc.cues.length
				const n = cur === null ? 1 : cur + 1
				if (n > count) return self.log('info', 'Already at the last cue')
				return osc('/objitter/standby', [n])
			},
		},
		cue_standby: {
			name: 'Cue: set standby cue (by number)',
			options: [
				{
					type: 'dropdown',
					id: 'cue',
					label: 'Cue number (list position)',
					default: 1,
					choices: cueChoices.length ? cueChoices : [{ id: 1, label: '1' }],
					allowCustom: true,
					regex: '/^\\d+$/',
				},
			],
			callback: ({ options }) => {
				const n = Math.round(Number(options.cue))
				if (!(n >= 1)) return self.log('warn', `Invalid cue number "${options.cue}"`)
				return osc('/objitter/standby', [n])
			},
		},

		// ---------- timecode / internal clock ----------
		tc_play: { name: 'Timecode: internal clock PLAY', options: [], callback: () => osc('/objitter/tc/play') },
		tc_pause: { name: 'Timecode: internal clock PAUSE', options: [], callback: () => osc('/objitter/tc/pause') },
		tc_toggle: {
			name: 'Timecode: internal clock PLAY/PAUSE toggle',
			options: [],
			callback: () => {
				if (!needState('Clock toggle')) return
				return osc(st.tcs?.internal?.playing ? '/objitter/tc/pause' : '/objitter/tc/play')
			},
		},
		tc_rewind: {
			name: 'Timecode: internal clock REWIND (first cue pre-roll)',
			options: [],
			callback: () => osc('/objitter/tc/rewind'),
		},
		tc_locate: {
			name: 'Timecode: internal clock LOCATE',
			options: [
				{ type: 'textinput', id: 'tc', label: 'Position (hh:mm:ss:ff)', default: '00:00:00:00', useVariables: true },
			],
			callback: async ({ options }, ctx) => {
				const tc = await text(options.tc, ctx)
				if (!/^\d{1,2}:\d{1,2}:\d{1,2}[:;.]\d{1,2}$/.test(tc)) return self.log('warn', `Invalid timecode "${tc}"`)
				return osc('/objitter/tc/locate', [tc])
			},
		},
		tc_enable: {
			name: 'Timecode: cue control on/off/toggle (ignored under Show Lock)',
			options: [modeOpt],
			callback: ({ options }) => {
				const v = resolveToggle(options.mode, st.tcs?.enabled, 'Timecode enable')
				if (v !== null) return osc('/objitter/tc/enable', [v ? 1 : 0])
			},
		},

		// ---------- show lock (WebSocket only; no OSC address exists) ----------
		show_lock: {
			name: 'Show Lock on/off/toggle (needs WebSocket link)',
			options: [modeOpt],
			callback: ({ options }) => {
				if (!needState('Show Lock')) return
				const v = resolveToggle(options.mode, st.showLock, 'Show Lock')
				if (v !== null) self.sendWs({ type: 'lock.set', locked: v })
			},
		},

		// ---------- sessions ----------
		session_load: {
			name: 'Session: load (refused under Show Lock)',
			options: [
				textDropdown('session', 'Session (pick or type a name)', sessionChoices),
				{
					type: 'checkbox',
					id: 'includeOutput',
					label: 'Also load output targets / OSC control settings from the session',
					default: false,
				},
			],
			callback: async ({ options }, ctx) => {
				const name = await text(options.session, ctx)
				if (!name) return self.log('warn', 'Session name is empty')
				return osc('/objitter/session/load', [name, options.includeOutput ? 1 : 0])
			},
		},
		session_save: {
			name: 'Session: save (blank name = overwrite current session)',
			options: [{ type: 'textinput', id: 'session', label: 'Session name', default: '', useVariables: true }],
			callback: async ({ options }, ctx) => {
				const name = await text(options.session, ctx)
				return osc('/objitter/session/save', name ? [name] : [])
			},
		},

		// ---------- objects ----------
		obj_enable: {
			name: 'Objects: enable / disable',
			options: [
				targetsOpt,
				{
					type: 'dropdown',
					id: 'enabled',
					label: 'State',
					default: 'on',
					choices: ON_OFF_TOGGLE.slice(0, 2),
				},
			],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				if (!t) return self.log('warn', 'Object target is empty')
				return osc(`/objitter/obj/${enc(t)}/enable`, [options.enabled === 'on' ? 1 : 0])
			},
		},
		obj_transport: {
			name: 'Objects: play / pause (allowed under Show Lock)',
			options: [
				targetsOpt,
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Command',
					default: 'play',
					choices: [
						{ id: 'play', label: 'Play' },
						{ id: 'pause', label: 'Pause' },
					],
				},
			],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				if (!t) return self.log('warn', 'Object target is empty')
				return osc(`/objitter/obj/${enc(t)}/${options.cmd === 'pause' ? 'pause' : 'play'}`)
			},
		},
		obj_mode: {
			name: 'Objects: motion mode',
			options: [
				targetsOpt,
				{
					type: 'dropdown',
					id: 'motion',
					label: 'Mode',
					default: 'jitter',
					choices: MODES.map((m) => ({ id: m, label: m })),
				},
			],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				if (!t) return self.log('warn', 'Object target is empty')
				return osc(`/objitter/obj/${enc(t)}/mode`, [String(options.motion)])
			},
		},
		obj_home: {
			name: 'Objects: RETURN (home) selected objects',
			options: [targetsOpt, fadeOpt()],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				if (!t) return self.log('warn', 'Object target is empty')
				const a = await fadeArgs(options, ctx)
				if (a) return osc(`/objitter/obj/${enc(t)}/home`, a)
			},
		},
		obj_center: {
			name: 'Objects: set center position',
			options: [
				targetsOpt,
				{ type: 'textinput', id: 'x', label: 'X (-1…1)', default: '0', useVariables: true },
				{ type: 'textinput', id: 'y', label: 'Y (-1…1)', default: '0', useVariables: true },
				{ type: 'textinput', id: 'z', label: 'Z (blank = keep)', default: '', useVariables: true },
			],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				const x = optNum(await text(options.x, ctx))
				const y = optNum(await text(options.y, ctx))
				const z = optNum(await text(options.z, ctx))
				if (!t || x === null || y === null || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
					return self.log('warn', 'Object center: invalid target or coordinates')
				}
				const args = [{ type: 'f', value: x }, { type: 'f', value: y }]
				if (z !== null) args.push({ type: 'f', value: z })
				return osc(`/objitter/obj/${enc(t)}/center`, args)
			},
		},
		obj_set: {
			name: 'Objects: set parameter (e.g. range.x 0.5, timing.min 0.2, jumpChance 0.3)',
			options: [
				targetsOpt,
				{ type: 'textinput', id: 'path', label: 'Parameter path', default: 'range.x', useVariables: true },
				{ type: 'textinput', id: 'value', label: 'Value (number or text)', default: '0.5', useVariables: true },
			],
			callback: async ({ options }, ctx) => {
				const t = await text(options.targets, ctx)
				const p = await text(options.path, ctx)
				const raw = await text(options.value, ctx)
				if (!t || !/^[A-Za-z]+(\.[A-Za-z]+)?$/.test(p) || raw === '') {
					return self.log('warn', 'Object set: invalid target, parameter path or value')
				}
				const n = optNum(raw)
				const value = n === null || Number.isNaN(n) ? raw : { type: 'f', value: n }
				return osc(`/objitter/obj/${enc(t)}/set`, [p, value])
			},
		},

		// ---------- motion library (WebSocket only; no OSC address exists) ----------
		library_apply: {
			name: 'Library: apply motion to objects (needs WebSocket link)',
			options: [
				textDropdown('path', 'Library item (pick or type folder/name)', libChoices),
				{ ...targetsOpt, label: 'Objects: 5 · 1-8 · 1-4,9 · @group · all' },
				fadeOpt(),
			],
			callback: async ({ options }, ctx) => {
				if (!needState('Library apply')) return
				const p = await text(options.path, ctx)
				const ids = st.resolveTargets(await text(options.targets, ctx))
				if (!p || !ids.length) return self.log('warn', 'Library apply: empty item or no matching objects')
				const a = await fadeArgs(options, ctx)
				if (!a) return
				self.sendWs({ type: 'lib.apply', path: p, ids, ...(a.length ? { fade: a[0] } : {}) })
			},
		},
	}
}

module.exports = { buildActions, MODES, TEMPO_MULTS }
