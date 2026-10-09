const C = require('./colors')
const { SLOT_COUNT } = require('./state')

function button(category, name, text, actions, feedbacks = [], style = {}) {
	return {
		type: 'button',
		category,
		name,
		style: { text, size: 'auto', color: C.white, bgcolor: C.panel, ...style },
		steps: [{ down: actions.map(([actionId, options = {}]) => ({ actionId, options })), up: [] }],
		feedbacks: feedbacks.map(([feedbackId, options = {}, style]) => ({ feedbackId, options, ...(style ? { style } : {}) })),
	}
}

/** Preset buttons; `label` is the connection label used in $(label:variable) references. */
function buildPresets(label) {
	const v = (id) => `$(${label}:${id})`
	const p = {}
	const live = ['disconnected']

	p.start = button('Transport', 'START', 'START', [['start']], [['running'], ...live.map((f) => [f])])
	p.stop = button('Transport', 'STOP', 'STOP', [['stop']], [['stopped'], ...live.map((f) => [f])])
	p.toggle = button('Transport', 'START/STOP', `RUN\\n${v('running')}`, [['toggle']], [['running']])
	p.freeze = button('Transport', 'FREEZE toggle', 'FREEZE', [['freeze', { mode: 'toggle' }]], [['frozen']])
	p.home = button('Transport', 'RETURN (home)', 'RETURN', [['home', { fade: '' }]], [], { color: C.accent })
	p.lock = button('Transport', 'Show Lock toggle', `LOCK\\n${v('show_lock')}`, [['show_lock', { mode: 'toggle' }]], [
		['show_locked'],
	])
	p.status = button('Transport', 'Connection status', `OBJITTER\\n${v('connection')}`, [], [['connected'], ['disconnected']], {
		size: '14',
	})

	p.tap = button('Tempo', 'TAP', `TAP\\n${v('bpm')}`, [['tap']], [], { bgcolor: C.violetDark })
	p.resync = button('Tempo', 'RESYNC', 'RESYNC', [['resync']])
	p.bpm_up = button('Tempo', 'BPM +1', 'BPM\\n+1', [['bpm_nudge', { delta: 1 }]])
	p.bpm_down = button('Tempo', 'BPM -1', 'BPM\\n-1', [['bpm_nudge', { delta: -1 }]])
	p.bpm_show = button('Tempo', 'BPM display', `BPM\\n${v('bpm')}`, [], [], { bgcolor: C.bg, color: C.violet })
	p.speed_up = button('Tempo', 'Speed +0.1', 'SPEED\\n+0.1', [['speed_nudge', { delta: 0.1, ramp: 0 }]])
	p.speed_down = button('Tempo', 'Speed -0.1', 'SPEED\\n-0.1', [['speed_nudge', { delta: -0.1, ramp: 0 }]])
	p.speed_1 = button('Tempo', 'Speed 1.0', `SPEED\\n${v('speed')}`, [['speed_set', { speed: 1, ramp: 0 }]], [], {
		color: C.accent,
	})
	for (const m of [0.5, 1, 2]) {
		p[`mult_${m}`] = button('Tempo', `Tempo ×${m}`, `×${m}`, [['tempo_mult', { mult: m }]])
	}

	for (let n = 1; n <= SLOT_COUNT; n++) {
		p[`slot_${n}`] = button(
			'Slots',
			`Slot ${n}`,
			`${n}\\n${v(`slot_${n}`)}`,
			[['slot_recall', { slot: n, fade: '' }]],
			[['slot_used', { slot: n }], ['slot_active', { slot: n }]],
			{ size: '14', color: C.white, bgcolor: C.bg },
		)
	}

	p.cue_go = button('Cues', 'GO', `GO\\n${v('cue_standby_label')}`, [['cue_go']], [], {
		bgcolor: C.accentDark,
		color: C.white,
		size: '18',
	})
	p.cue_back = button('Cues', 'BACK', 'BACK', [['cue_back']])
	p.cue_next = button('Cues', 'Standby next', 'NEXT', [['cue_next']])
	p.cue_info = button('Cues', 'Last fired cue', `CUE ${v('cue_current_number')}\\n${v('cue_current_label')}`, [], [], {
		size: '14',
		bgcolor: C.bg,
		color: C.accent,
	})
	for (let n = 1; n <= 8; n++) {
		p[`cue_standby_${n}`] = button(
			'Cues',
			`Standby cue ${n}`,
			`CUE ${n}`,
			[['cue_standby', { cue: n }]],
			[['cue_current', { cue: n }], ['cue_standby', { cue: n }]],
		)
	}

	p.tc_toggle = button('Timecode', 'Clock PLAY/PAUSE', `CLOCK\\n${v('timecode')}`, [['tc_toggle']], [['tc_running']], {
		size: '14',
	})
	p.tc_play = button('Timecode', 'Clock PLAY', 'PLAY', [['tc_play']], [['tc_running']])
	p.tc_pause = button('Timecode', 'Clock PAUSE', 'PAUSE', [['tc_pause']])
	p.tc_rewind = button('Timecode', 'Clock REWIND', 'REWIND', [['tc_rewind']])
	p.tc_zero = button('Timecode', 'Clock LOCATE 00:00:00:00', 'LOCATE\\n00:00', [['tc_locate', { tc: '00:00:00:00' }]])
	p.tc_enable = button('Timecode', 'TC cue control toggle', `TC\\n${v('tc_input')}`, [['tc_enable', { mode: 'toggle' }]], [
		['tc_enabled'],
	])
	p.tc_display = button('Timecode', 'Timecode display', v('timecode'), [], [['tc_running']], {
		size: '14',
		bgcolor: C.bg,
		color: C.violet,
	})

	return p
}

module.exports = { buildPresets }
