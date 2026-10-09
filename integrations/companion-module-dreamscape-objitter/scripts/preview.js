// Renders a contact sheet of all presets (Windows: PowerShell + System.Drawing), two rows per category:
// "offline" (no feedback link, variables empty) and "live" (sample values, state feedbacks on).
// Run: node scripts/preview.js [output.png]   (default: %TEMP%\objitter-run\companion-presets.png)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildPresets } = require('../src/presets')

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'objitter-run', 'companion-presets.png'))
const LIVE = {
	connection: 'connected',
	bpm: '120',
	speed: '1',
	cue_standby_number: '3',
	cue_standby_label: 'Chorus',
	cue_current_number: '2',
	cue_current_label: 'Verse',
	tc_enabled: 'on',
	tc_input: 'mtc',
	tc_running: 'on',
	timecode: '01:02:03:04',
	slot_1: 'Demo - Jitter Swarm',
	slot_2: 'Slow Orbit',
	slot_3: 'Linear Waypoints',
}
const LIVE_TRUE = new Set(['connected', 'running', 'frozen', 'show_locked', 'tc_running', 'tc_enabled'])
const usedSlots = new Set([1, 2, 3])
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6)

function tile(p, live) {
	let style = { ...p.style }
	for (const f of p.feedbacks) {
		let on
		if (!live) on = f.feedbackId === 'disconnected'
		else if (f.feedbackId === 'slot_used') on = usedSlots.has(f.options.slot)
		else if (f.feedbackId === 'slot_active') on = f.options.slot === 2
		else if (f.feedbackId === 'cue_current') on = f.options.cue === 2
		else if (f.feedbackId === 'cue_standby') on = f.options.cue === 3
		else on = LIVE_TRUE.has(f.feedbackId)
		if (f.isInverted) on = !on
		if (on) style = { ...style, ...f.style }
	}
	const text = String(style.text ?? '')
		.replace(/\$\([^:]+:([a-z0-9_]+)\)/g, (_, id) => (live ? (LIVE[id] ?? '') : id === 'connection' ? 'disconnected' : ''))
		.replace(/\\n/g, '\n')
	return {
		text,
		size: Number(style.size),
		color: hex(style.color),
		bg: hex(style.bgcolor),
		png: style.png64 ?? '',
		align: style.alignment ?? 'center:center',
	}
}

const groups = []
for (const p of Object.values(buildPresets('objitter'))) {
	let g = groups.find((x) => x.name === p.category)
	if (!g) groups.push((g = { name: p.category, offline: [], live: [] }))
	g.offline.push(tile(p, false))
	g.live.push(tile(p, true))
}

fs.mkdirSync(path.dirname(out), { recursive: true })
const json = path.join(path.dirname(out), 'companion-presets.json')
fs.writeFileSync(json, JSON.stringify(groups))
execFileSync(
	'powershell.exe',
	['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'preview.ps1'), json, out],
	{ stdio: 'inherit' },
)
fs.unlinkSync(json)
console.log(`preview → ${out}`)
