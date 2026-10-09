const { SLOT_COUNT } = require('./state')

const DEFS = [
	['connection', 'Feedback link: connected / connecting / disconnected / error / off'],
	['connection_error', 'Feedback link: last error'],
	['version', 'Objitter version'],
	['running', 'Transport running (on/off)'],
	['frozen', 'FREEZE (on/off)'],
	['speed', 'Master speed'],
	['bpm', 'BPM'],
	['tempo_mult', 'Tempo multiplier'],
	['transition', 'Crossfade (transition) time, s'],
	['show_lock', 'Show Lock (locked/unlocked)'],
	['last_preset', 'Last recalled preset'],
	['last_preset_modified', 'Last preset edited since recall (on/off)'],
	['last_slot', 'Slot of the last recalled preset'],
	['session_name', 'Current session name'],
	['session_modified', 'Session has unsaved changes (on/off)'],
	['tc_enabled', 'Timecode cue control (on/off)'],
	['tc_input', 'Timecode source (mtc / ltc / osc / internal)'],
	['tc_trigger', 'Cue trigger (tc / go)'],
	['tc_state', 'Timecode input state'],
	['tc_running', 'Timecode running (on/off)'],
	['timecode', 'Current timecode'],
	['cue_count', 'Number of cues'],
	['cue_current_number', 'Last fired cue number'],
	['cue_current_label', 'Last fired cue label'],
	['cue_standby_number', 'Standby cue number (GO list)'],
	['cue_standby_label', 'Standby cue label (GO list)'],
	['cue_next_number', 'Next timecode cue number'],
	['cue_next_label', 'Next timecode cue label'],
	['cue_next_in', 'Seconds until the next timecode cue'],
]

function variableDefinitions() {
	const defs = DEFS.map(([variableId, name]) => ({ variableId, name }))
	for (let n = 1; n <= SLOT_COUNT; n++) defs.push({ variableId: `slot_${n}`, name: `Slot ${n} preset name` })
	return defs
}

module.exports = { variableDefinitions }
