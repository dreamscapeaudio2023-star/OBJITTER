// Preset legibility checks at Companion's 72x72 button size (no Companion needed).
// Companion draws text with Arimo (metric-compatible with Arial) inside a 68 px wide area; with the top bar shown
// the usable height is 57 px. A line that is wider than the area gets broken mid-word, so every line must fit.
// Run: node test/presets.test.js
const assert = require('node:assert/strict')
const { buildPresets } = require('../src/presets')
const { buildFeedbacks } = require('../src/feedbacks')
const { variableDefinitions } = require('../src/variables')
const { ObjitterState } = require('../src/state')

const TEXT_WIDTH = 68
const TEXT_HEIGHT = 57
const LINE_HEIGHT = 1.2
const ICON_MAX = 32

// Arial advance widths per 1000 em (ASCII 32..126)
const ASCII = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556,
	556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778,
	722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
	500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
const EXTRA = { '×': 584, '−': 584, '—': 1000, '→': 1000 }
const charWidth = (ch) => {
	const c = ch.codePointAt(0)
	return c >= 32 && c <= 126 ? ASCII[c - 32] : (EXTRA[ch] ?? 1000)
}
const textWidth = (s, size) => ([...s].reduce((w, ch) => w + charWidth(ch), 0) * size) / 1000

// Longest realistic values (free-text names such as preset / cue labels wrap at spaces, so a short one is used)
const SAMPLE = {
	bpm: '128.5',
	speed: '1.25',
	connection: 'off',
	cue_standby_number: '12',
	cue_standby_label: 'Intro',
	cue_current_number: '12',
	cue_current_label: 'Intro',
	tc_enabled: 'off',
	tc_input: 'internal',
	timecode: '00:00:00:00',
}
for (let n = 1; n <= 32; n++) SAMPLE[`slot_${n}`] = 'Scene 1'

const fill = (s) =>
	s.replace(/\$\(objitter:([a-z0-9_]+)\)/g, (_, id) => {
		assert.ok(id in SAMPLE, `sample value for $(objitter:${id})`)
		return SAMPLE[id]
	})
const staticPart = (s) => s.replace(/\$\([^)]*\)/g, '').replace(/\\n/g, '').trim()

function pngSize(b64) {
	const buf = Buffer.from(b64, 'base64')
	assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', 'png64 is a PNG')
	return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

function checkStyle(where, style) {
	const size = Number(style.size)
	assert.ok(style.size !== 'auto' && size >= 12 && size <= 24, `${where}: fixed text size 12..24 (got ${style.size})`)
	assert.ok(String(style.text ?? '').trim() || style.png64, `${where}: has text or icon`)
	assert.notEqual(style.color, style.bgcolor, `${where}: text colour differs from background`)
	const lines = fill(String(style.text ?? '')).split('\\n')
	for (const line of lines) {
		const w = textWidth(line, size)
		assert.ok(w <= TEXT_WIDTH, `${where}: "${line}" is ${w.toFixed(1)} px wide at size ${size} (max ${TEXT_WIDTH})`)
	}
	let height = lines.length * size * LINE_HEIGHT
	if (style.png64) {
		const [w, h] = pngSize(style.png64)
		assert.ok(w <= ICON_MAX && h <= ICON_MAX, `${where}: icon ${w}x${h} <= ${ICON_MAX}`)
		assert.equal(style.pngalignment, 'center:top', `${where}: icon on top`)
		assert.equal(style.alignment, 'center:bottom', `${where}: label at the bottom`)
		assert.equal(lines.length, 1, `${where}: one label line under an icon`)
		height += h
	}
	assert.ok(height <= TEXT_HEIGHT, `${where}: content ${height.toFixed(1)} px tall (max ${TEXT_HEIGHT})`)
}

const presets = buildPresets('objitter')
const self = { state: new ObjitterState(), config: { feedback: true } }
const fbDefs = buildFeedbacks(self)
const varIds = new Set(variableDefinitions().map((d) => d.variableId))
let variants = 0

for (const [id, p] of Object.entries(presets)) {
	assert.ok(['Transport', 'Tempo', 'Slots', 'Cues', 'Timecode'].includes(p.category), `${id}: category`)
	assert.ok(staticPart(p.style.text) || p.style.png64, `${id}: label is not only variables (blank when offline)`)
	for (const m of p.style.text.matchAll(/\$\(objitter:([a-z0-9_]+)\)/g)) assert.ok(varIds.has(m[1]), `${id}: variable ${m[1]}`)
	checkStyle(id, p.style)
	for (const f of p.feedbacks) {
		assert.equal(fbDefs[f.feedbackId]?.type, 'boolean', `${id}: ${f.feedbackId} is a boolean feedback`)
		assert.ok(f.style && Object.keys(f.style).length, `${id}: feedback ${f.feedbackId} has an explicit style`)
		for (const [k, val] of Object.entries(f.style)) assert.ok(val !== undefined && val !== '', `${id}: ${f.feedbackId}.${k} set`)
		const merged = { ...p.style, ...f.style }
		if (f.style.text) assert.ok(staticPart(f.style.text), `${id}: ${f.feedbackId} text has a static part`)
		checkStyle(`${id} + ${f.feedbackId}${f.isInverted ? ' (inverted)' : ''}`, merged)
		variants++
	}
}

// slot buttons: number + preset name, dash when the slot is empty
assert.equal(presets.slot_9.style.text, 'SLOT 9\\n$(objitter:slot_9)')
assert.deepEqual(
	presets.slot_9.feedbacks.map((f) => [f.feedbackId, !!f.isInverted]),
	[
		['slot_used', true],
		['slot_used', false],
		['slot_active', false],
	],
)

console.log(`ok - ${Object.keys(presets).length} presets, ${variants} feedback styles legible at 72x72`)
