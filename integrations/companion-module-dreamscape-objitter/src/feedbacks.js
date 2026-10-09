const C = require('./colors')
const { SLOT_COUNT } = require('./state')

const slotOpt = {
	type: 'number',
	id: 'slot',
	label: 'Slot (1-32)',
	default: 1,
	min: 1,
	max: SLOT_COUNT,
}
const cueOpt = { type: 'number', id: 'cue', label: 'Cue number (list position)', default: 1, min: 1, max: 999 }

/** Boolean feedbacks; every callback reads only the mirrored state, so they are cheap to re-check. */
function buildFeedbacks(self) {
	const st = self.state
	const fb = (name, description, defaultStyle, callback, options = []) => ({
		type: 'boolean',
		name,
		description,
		defaultStyle,
		options,
		callback,
	})
	return {
		connected: fb(
			'Connection: WebSocket feedback link is up',
			'True while the module receives live state from Objitter',
			{ bgcolor: C.accentDark, color: C.white },
			() => st.ready,
		),
		disconnected: fb(
			'Connection: WebSocket feedback link is down',
			'True when feedback is enabled but Objitter is unreachable',
			{ bgcolor: C.errDark, color: C.err },
			() => self.config?.feedback !== false && !st.ready,
		),
		running: fb('Transport: running', 'Master transport is started', { bgcolor: C.accent, color: C.black }, () =>
			!!(st.ready && st.master.running),
		),
		stopped: fb('Transport: stopped', 'Master transport is stopped', { bgcolor: C.errDark, color: C.white }, () =>
			!!(st.ready && !st.master.running),
		),
		frozen: fb('Transport: frozen', 'FREEZE is on', { bgcolor: C.sky, color: C.black }, () => !!(st.ready && st.master.frozen)),
		show_locked: fb('Show Lock: locked', 'Show Lock is on', { bgcolor: C.warn, color: C.black }, () => st.ready && st.showLock),
		slot_active: fb(
			'Slot: active (last recalled)',
			'The preset in this slot is the last recalled preset',
			{ bgcolor: C.accent, color: C.black },
			({ options }) => st.slotActive(options.slot),
			[slotOpt],
		),
		slot_used: fb(
			'Slot: has a preset',
			'A preset is assigned to this slot',
			{ bgcolor: C.panel3, color: C.white },
			({ options }) => !!st.slotPreset(options.slot),
			[slotOpt],
		),
		preset_active: fb(
			'Preset: active (last recalled)',
			'The named preset is the last recalled preset',
			{ bgcolor: C.accent, color: C.black },
			({ options }) => st.presetActive(options.preset),
			[{ type: 'textinput', id: 'preset', label: 'Preset name', default: '' }],
		),
		cue_current: fb(
			'Cue: is the last fired cue',
			'The cue at this list position fired last',
			{ bgcolor: C.accent, color: C.black },
			({ options }) => st.currentCueIndex === Number(options.cue),
			[cueOpt],
		),
		cue_standby: fb(
			'Cue: is standby (GO list)',
			'The cue at this list position is standing by for GO',
			{ bgcolor: C.warn, color: C.black },
			({ options }) => st.standbyIndex === Number(options.cue),
			[cueOpt],
		),
		tc_running: fb(
			'Timecode: running',
			'Internal clock is playing, or external timecode is rolling',
			{ bgcolor: C.violet, color: C.black },
			() => st.tcRunning,
		),
		tc_enabled: fb('Timecode: cue control enabled', 'Timecode cue control is on', { bgcolor: C.violetDark, color: C.white }, () =>
			!!st.tcs?.enabled,
		),
		session_modified: fb(
			'Session: has unsaved changes',
			'The current session differs from the saved file',
			{ bgcolor: C.warn, color: C.black },
			() => !!st.session?.modified,
		),
	}
}

module.exports = { buildFeedbacks }
