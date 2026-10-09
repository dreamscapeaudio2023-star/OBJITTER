// Draws the preset button icons (32x32 RGBA PNG, anti-aliased glyph on transparent) without any image library,
// writes them to src/icons/*.png and embeds them as base64 in src/icons.js (webpack-safe, no file reads at runtime).
// Run after changing a glyph or colour: node scripts/gen-icons.js
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const C = require('../src/colors')

const SIZE = 32
const SS = 4 // supersampling per axis

// ---------- geometry (coordinates in 0..32 pixel space) ----------
const poly = (pts) => (x, y) => {
	let inside = false
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i]
		const [xj, yj] = pts[j]
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}
const rect = (x0, y0, x1, y1, r = 0) => (x, y) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false
	if (!r) return true
	const cx = Math.min(Math.max(x, x0 + r), x1 - r)
	const cy = Math.min(Math.max(y, y0 + r), y1 - r)
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const ring = (cx, cy, r0, r1, keep = () => true) => (x, y) => {
	const d = (x - cx) ** 2 + (y - cy) ** 2
	return d >= r0 * r0 && d <= r1 * r1 && keep(Math.atan2(y - cy, x - cx), x, y)
}
const capsule = (ax, ay, bx, by, w) => (x, y) => {
	const dx = bx - ax
	const dy = by - ay
	const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
	return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (w / 2) ** 2
}
const union = (...fs) => (x, y) => fs.some((f) => f(x, y))
const minus = (a, ...b) => (x, y) => a(x, y) && !b.some((f) => f(x, y))

const tri = (ax, ay, bx, by, cx, cy) => poly([[ax, ay], [bx, by], [cx, cy]])

function snowflake() {
	const parts = []
	for (let k = 0; k < 6; k++) {
		const a = (k * Math.PI) / 3 - Math.PI / 2
		const px = (r) => 16 + r * Math.cos(a)
		const py = (r) => 16 + r * Math.sin(a)
		parts.push(capsule(16, 16, px(13), py(13), 2.6))
		for (const s of [-1, 1]) {
			const b = a + (s * Math.PI) / 4
			parts.push(capsule(px(8), py(8), px(8) + 4.5 * Math.cos(b), py(8) + 4.5 * Math.sin(b), 2.2))
		}
	}
	return union(...parts)
}

function resync() {
	// two arcs with arrowheads (clockwise circular arrows)
	const deg = (d) => (d * Math.PI) / 180
	const inArc = (a, from, to) => {
		let d = a - from
		while (d < 0) d += 2 * Math.PI
		return d <= to - from
	}
	const arcs = ring(16, 16, 8.5, 12, (a) => inArc(a, deg(-160), deg(-20)) || inArc(a, deg(20), deg(160)))
	const head = (angDeg, dir) => {
		const a = deg(angDeg)
		const cx = 16 + 10.25 * Math.cos(a)
		const cy = 16 + 10.25 * Math.sin(a)
		const tx = -Math.sin(a) * dir
		const ty = Math.cos(a) * dir
		const nx = Math.cos(a)
		const ny = Math.sin(a)
		return tri(cx + nx * 6, cy + ny * 6, cx - nx * 6, cy - ny * 6, cx + tx * 7, cy + ty * 7)
	}
	return union(arcs, head(-20, 1), head(160, 1))
}

const keyhole = union(circle(16, 20.5, 2.2), rect(15, 21, 17, 25))

const GLYPHS = {
	play: tri(9, 5, 9, 27, 27, 16),
	stop: rect(7, 7, 25, 25, 2),
	pause: union(rect(8, 6, 13.5, 26, 1), rect(18.5, 6, 24, 26, 1)),
	playpause: union(tri(3, 7, 3, 25, 16, 16), rect(19, 7, 22.5, 25, 0.8), rect(25.5, 7, 29, 25, 0.8)),
	playstop: union(tri(2, 7, 2, 25, 15, 16), rect(18, 9.5, 30, 22.5, 1.5)),
	rewind: union(rect(3.5, 7, 6.5, 25, 0.8), tri(17, 7, 17, 25, 7.5, 16), tri(28.5, 7, 28.5, 25, 19, 16)),
	freeze: snowflake(),
	home: poly([
		[16, 3.5],
		[29.5, 16],
		[25.5, 16],
		[25.5, 28.5],
		[19, 28.5],
		[19, 20.5],
		[13, 20.5],
		[13, 28.5],
		[6.5, 28.5],
		[6.5, 16],
		[2.5, 16],
	]),
	lock: minus(
		union(rect(6.5, 14, 25.5, 29, 2), ring(16, 12, 5.5, 9, (a) => a <= 0), rect(7, 12, 10.5, 15), rect(21.5, 12, 25, 15)),
		keyhole,
	),
	unlock: minus(
		union(rect(6.5, 14, 25.5, 29, 2), ring(16, 8, 5.5, 9, (a) => a <= 0), rect(7, 8, 10.5, 15), rect(21.5, 8, 25, 10)),
		keyhole,
	),
	resync: resync(),
}

/** Which colour variants the presets use: glyph → colour names from colors.js. */
const VARIANTS = {
	play: ['white', 'black', 'sky'],
	stop: ['white'],
	pause: ['sky'],
	playpause: ['sky', 'black'],
	playstop: ['white', 'black'],
	rewind: ['sky'],
	freeze: ['sky', 'black'],
	home: ['accent'],
	lock: ['black'],
	unlock: ['white'],
	resync: ['violet'],
}

// ---------- PNG encoder ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c
})
function crc32(buf) {
	let c = -1
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ -1) >>> 0
}
function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(td))
	return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgba) {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	const raw = Buffer.alloc((w * 4 + 1) * h)
	for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

function render(shape, color) {
	const r = (color >> 16) & 0xff
	const g = (color >> 8) & 0xff
	const b = color & 0xff
	const px = Buffer.alloc(SIZE * SIZE * 4)
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			let hits = 0
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) if (shape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++
			}
			const i = (y * SIZE + x) * 4
			px[i] = r
			px[i + 1] = g
			px[i + 2] = b
			px[i + 3] = Math.round((255 * hits) / (SS * SS))
		}
	}
	return encodePng(SIZE, SIZE, px)
}

const outDir = path.join(__dirname, '../src/icons')
fs.mkdirSync(outDir, { recursive: true })
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(outDir, f))
const lines = []
let total = 0
for (const [name, colors] of Object.entries(VARIANTS)) {
	const entries = []
	for (const color of colors) {
		const png = render(GLYPHS[name], C[color])
		fs.writeFileSync(path.join(outDir, `${name}-${color}.png`), png)
		total += png.length
		entries.push(`\t\t${color}: '${png.toString('base64')}',`)
	}
	lines.push(`\t${name}: {\n${entries.join('\n')}\n\t},`)
}
const js =
	'// Generated by scripts/gen-icons.js — do not edit. 32x32 PNG glyphs, base64 (png64) per colour.\n' +
	`module.exports = {\n${lines.join('\n')}\n}\n`
fs.writeFileSync(path.join(__dirname, '../src/icons.js'), js)
console.log(`${Object.values(VARIANTS).flat().length} icons, ${total} bytes PNG → src/icons/*.png, src/icons.js (${js.length} bytes)`)
