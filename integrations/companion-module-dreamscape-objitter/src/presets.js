const C = require('./colors')
const ICON = require('./icons')
const { SLOT_COUNT } = require('./state')

// Group colours: Transport = mint, Tempo = violet, Slots = white/mint, Cues = yellow, Timecode = sky.
// Every preset feedback carries an explicit style: Companion does not fall back to the feedback's defaultStyle
// for presets, and a style-less feedback turned the button black with invisible text whenever it was true.

/** Text-only button: manual line breaks, fixed size so words are never split mid-word. */
const text = (t, size, color, bgcolor = C.panel) => ({ text: t, size, color, bgcolor, alignment: 'center:center' })

/** Icon on top, one short label underneath. */
const icon = (png64, t, color, bgcolor = C.panel) => ({
	text: t,
	size: '14',
	color,
	bgcolor,
	png64,
	pngalignment: 'center:top',
	alignment: 'center:bottom',
})

function button(category, name, style, actions, feedbacks = []) {
	return {
		type: 'button',
		category,
		name,
		style: { show_topbar: true, ...style },
		steps: [{ down: actions.map(([actionId, options = {}]) => ({ actionId, options })), up: [] }],
		feedbacks: feedbacks.map(([feedbackId, options, fbStyle, isInverted]) => ({
			feedbackId,
			options: options ?? {},
			style: fbStyle,
			...(isInverted ? { isInverted: true } : {}),
		})),
	}
}

const OFFLINE = { bgcolor: C.errDark, color: C.err }

/** Preset buttons; `label` is the connection label used in $(label:variable) references. */
function buildPresets(label) {
	const v = (id) => `$(${label}:${id})`
	const p = {}
	const T = 'Transport'

	// ---------- Transport ----------
	p.start = button(T, 'START', icon(ICON.play.white, 'START', C.white, C.accentDark), [['start']], [
		['running', {}, { bgcolor: C.accent, color: C.black, png64: ICON.play.black }],
		['disconnected', {}, OFFLINE],
	])
	p.stop = button(T, 'STOP', icon(ICON.stop.white, 'STOP', C.white), [['stop']], [
		['stopped', {}, { bgcolor: C.errDark, color: C.white }],
		['disconnected', {}, OFFLINE],
	])
	p.toggle = button(T, 'START/STOP toggle (shows state)', icon(ICON.playstop.white, 'TOGGLE', C.white), [['toggle']], [
		['running', {}, { text: 'RUNNING', bgcolor: C.accent, color: C.black, png64: ICON.playstop.black }],
		['stopped', {}, { text: 'STOPPED', bgcolor: C.errDark, color: C.white }],
	])
	p.freeze = button(T, 'FREEZE toggle', icon(ICON.freeze.sky, 'FREEZE', C.sky), [['freeze', { mode: 'toggle' }]], [
		['frozen', {}, { text: 'FROZEN', bgcolor: C.sky, color: C.black, png64: ICON.freeze.black }],
	])
	p.home = button(T, 'RETURN (all objects home)', icon(ICON.home.accent, 'RETURN', C.accent), [['home', { fade: '' }]])
	p.lock = button(T, 'Show Lock toggle', icon(ICON.unlock.white, 'LOCK', C.white), [['show_lock', { mode: 'toggle' }]], [
		['show_locked', {}, { text: 'LOCKED', bgcolor: C.warn, color: C.black, png64: ICON.lock.black }],
	])
	p.status = button(T, 'Connection status', text(`LINK\\n${v('connection')}`, '14', C.white), [], [
		['connected', {}, { text: 'LINK\\nONLINE', bgcolor: C.accentDark, color: C.white }],
		['disconnected', {}, { text: 'LINK\\nOFFLINE', ...OFFLINE }],
	])

	// ---------- Tempo ----------
	const TE = 'Tempo'
	p.tap = button(TE, 'TAP (shows BPM)', text(`TAP\\n${v('bpm')}`, '18', C.white, C.violetDark), [['tap']])
	p.resync = button(TE, 'RESYNC (align to next beat)', icon(ICON.resync.violet, 'RESYNC', C.violet), [['resync']])
	p.bpm_up = button(TE, 'BPM +1', text('BPM\\n+1', '18', C.violet), [['bpm_nudge', { delta: 1 }]])
	p.bpm_down = button(TE, 'BPM -1', text('BPM\\n−1', '18', C.violet), [['bpm_nudge', { delta: -1 }]])
	p.bpm_show = button(TE, 'BPM display', text(`BPM\\n${v('bpm')}`, '18', C.violet, C.bg), [])
	p.speed_up = button(TE, 'Speed +0.1', text('SPEED\\n+0.1', '18', C.violet), [['speed_nudge', { delta: 0.1, ramp: 0 }]])
	p.speed_down = button(TE, 'Speed -0.1', text('SPEED\\n−0.1', '18', C.violet), [['speed_nudge', { delta: -0.1, ramp: 0 }]])
	p.speed_1 = button(TE, 'Speed reset to 1.0', text('SPEED\\n→ 1.0', '18', C.violet), [
		['speed_set', { speed: 1, ramp: 0 }],
	])
	for (const m of [0.5, 1, 2]) {
		p[`mult_${m}`] = button(TE, `Tempo multiplier ×${m}`, text(`TEMPO\\n×${m}`, '18', C.violet), [['tempo_mult', { mult: m }]])
	}

	// ---------- Slots ----------
	for (let n = 1; n <= SLOT_COUNT; n++) {
		p[`slot_${n}`] = button(
			'Slots',
			`Slot ${n} (shows preset name)`,
			text(`SLOT ${n}\\n${v(`slot_${n}`)}`, '14', C.white, C.bg),
			[['slot_recall', { slot: n, fade: '' }]],
			[
				['slot_used', { slot: n }, { text: `SLOT ${n}\\n—`, color: C.dim, bgcolor: C.bg }, true],
				['slot_used', { slot: n }, { bgcolor: C.panel3, color: C.white }],
				['slot_active', { slot: n }, { bgcolor: C.accent, color: C.black }],
			],
		)
	}

	// ---------- Cues ----------
	const CU = 'Cues'
	p.cue_go = button(
		CU,
		'GO (shows standby cue)',
		text(`GO → ${v('cue_standby_number')}\\n${v('cue_standby_label')}`, '14', C.white, C.accentDark),
		[['cue_go']],
	)
	p.cue_back = button(CU, 'BACK (standby previous)', text('CUE\\nBACK', '18', C.warn), [['cue_back']])
	p.cue_next = button(CU, 'NEXT (standby next)', text('CUE\\nNEXT', '18', C.warn), [['cue_next']])
	p.cue_info = button(
		CU,
		'Last fired cue',
		text(`LAST\\nCUE ${v('cue_current_number')}\\n${v('cue_current_label')}`, '14', C.accent, C.bg),
		[],
	)
	for (let n = 1; n <= 8; n++) {
		p[`cue_standby_${n}`] = button(CU, `Standby cue ${n}`, text(`CUE\\n${n}`, '18', C.white), [['cue_standby', { cue: n }]], [
			['cue_current', { cue: n }, { bgcolor: C.accent, color: C.black }],
			['cue_standby', { cue: n }, { bgcolor: C.warn, color: C.black }],
		])
	}

	// ---------- Timecode ----------
	const TC = 'Timecode'
	const tcOn = { bgcolor: C.sky, color: C.black }
	p.tc_toggle = button(TC, 'Clock PLAY/PAUSE', icon(ICON.playpause.sky, 'CLOCK', C.sky), [['tc_toggle']], [
		['tc_running', {}, { ...tcOn, png64: ICON.playpause.black }],
	])
	p.tc_play = button(TC, 'Clock PLAY', icon(ICON.play.sky, 'PLAY', C.sky), [['tc_play']], [
		['tc_running', {}, { ...tcOn, png64: ICON.play.black }],
	])
	p.tc_pause = button(TC, 'Clock PAUSE', icon(ICON.pause.sky, 'PAUSE', C.sky), [['tc_pause']])
	p.tc_rewind = button(TC, 'Clock REWIND (first cue pre-roll)', icon(ICON.rewind.sky, 'REWIND', C.sky), [['tc_rewind']])
	p.tc_zero = button(TC, 'Clock LOCATE 00:00:00:00', text('LOCATE\\n00:00:00', '14', C.sky), [
		['tc_locate', { tc: '00:00:00:00' }],
	])
	p.tc_enable = button(
		TC,
		'TC cue control toggle (shows source)',
		text(`TC CUE\\n${v('tc_enabled')}\\n${v('tc_input')}`, '14', C.sky),
		[['tc_enable', { mode: 'toggle' }]],
		[['tc_enabled', {}, { text: `TC CUE\\nON\\n${v('tc_input')}`, ...tcOn }]],
	)
	p.tc_display = button(TC, 'Timecode display', text(`TIMECODE\\n${v('timecode')}`, 12, C.sky, C.bg), [], [
		['tc_running', {}, { color: C.white }],
	])

	return p
}

module.exports = { buildPresets }
