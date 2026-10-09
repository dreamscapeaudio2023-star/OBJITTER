const SLOT_COUNT = 32
const MAX_OBJECTS = 32

const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null)
const onOff = (v) => (v ? 'on' : 'off')
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** Mirror of the Objitter server state, fed from WebSocket messages (init / state / presets / sessions / tc.delta / tcs / cue / library). */
class ObjitterState {
	constructor() {
		this.reset()
	}

	reset() {
		this.link = 'disconnected'
		this.linkError = ''
		this.version = ''
		this.master = null
		this.bpm = null
		this.liveSpeed = null
		this.showLock = false
		this.lastPreset = null
		this.session = null
		this.groups = []
		this.presets = []
		this.sessions = []
		this.library = { folders: [], items: [] }
		this.tc = { settings: null, cues: [], source: null }
		this.tcs = null
		this.currentCueId = null
	}

	get ready() {
		return this.link === 'connected' && this.master !== null
	}

	/** Returns { lists } — true when preset/session/cue/library lists changed (dropdown choices need a refresh). */
	handle(m) {
		let lists = false
		switch (m.type) {
			case 'init':
				this.version = m.static?.version ?? ''
				this.applyState(m.state)
				this.presets = Array.isArray(m.presets) ? m.presets : []
				this.sessions = Array.isArray(m.sessions) ? m.sessions : []
				if (m.library) this.library = m.library
				if (m.tc) this.tc = { settings: m.tc.settings ?? null, cues: m.tc.cues ?? [], source: m.tc.source ?? null }
				this.tcs = m.tcs ?? null
				lists = true
				break
			case 'state':
				lists = this.applyState(m.state)
				break
			case 'presets':
				this.presets = Array.isArray(m.presets) ? m.presets : []
				lists = true
				break
			case 'sessions':
				this.sessions = Array.isArray(m.sessions) ? m.sessions : []
				lists = true
				break
			case 'library':
				this.library = { folders: m.folders ?? [], items: m.items ?? [] }
				lists = true
				break
			case 'tc.delta':
				lists = this.applyTcDelta(m)
				break
			case 'tcs': {
				const { type, ...st } = m
				this.tcs = st
				break
			}
			case 'cue':
				if (m.ok !== false) this.currentCueId = m.id
				break
			case 'pos':
				if (this.master) this.master.running = !!m.running
				this.liveSpeed = typeof m.speed === 'number' ? m.speed : null
				break
			default:
				return { lists: false, ignored: true }
		}
		return { lists }
	}

	applyState(st) {
		if (!st) return false
		const groupsBefore = JSON.stringify(this.groups)
		this.master = { ...(st.master ?? {}) }
		this.bpm = st.bpm ?? this.bpm
		this.showLock = !!st.showLock
		this.lastPreset = st.lastPreset ?? null
		this.session = st.session ?? null
		this.groups = Array.isArray(st.groups) ? st.groups : []
		this.liveSpeed = null
		return JSON.stringify(this.groups) !== groupsBefore
	}

	applyTcDelta(m) {
		const tc = this.tc
		if (m.settings) tc.settings = m.settings
		if ('source' in m) tc.source = m.source
		if (!m.upsert && !m.remove && !m.order) return false
		const byId = new Map(tc.cues.map((c) => [c.id, c]))
		for (const c of m.upsert ?? []) byId.set(c.id, c)
		for (const id of m.remove ?? []) byId.delete(id)
		const order =
			m.order ??
			tc.cues
				.map((c) => c.id)
				.concat((m.upsert ?? []).map((c) => c.id).filter((id) => !tc.cues.some((c) => c.id === id)))
		tc.cues = order.map((id) => byId.get(id)).filter(Boolean)
		return true
	}

	// ---------- derived ----------
	slotPreset(n) {
		return this.presets.find((p) => p.slot === Number(n)) ?? null
	}

	slotActive(n) {
		const p = this.slotPreset(n)
		return !!p && sameName(p.name, this.lastPreset?.name)
	}

	presetActive(name) {
		return sameName(name, this.lastPreset?.name)
	}

	cueIndexById(id) {
		const i = this.tc.cues.findIndex((c) => c.id === id)
		return i < 0 ? null : i + 1
	}

	get currentCueIndex() {
		return this.currentCueId ? this.cueIndexById(this.currentCueId) : null
	}

	get standbyIndex() {
		return this.tcs?.standby?.index ?? null
	}

	get speed() {
		return this.liveSpeed ?? this.master?.speed ?? null
	}

	get tcRunning() {
		if (!this.tcs) return false
		if (this.tcs.internal) return !!this.tcs.internal.playing
		return !!this.tcs.rolling
	}

	get timecode() {
		return this.tcs?.internal?.tc ?? this.tcs?.tc ?? this.tcs?.lastTc ?? ''
	}

	/** Objitter target syntax → ids: "5", "1-8", "1-4,9", "@group", "all" / "*". Unknown → []. */
	resolveTargets(spec) {
		const s = String(spec ?? '').trim()
		if (!s) return []
		if (s === 'all' || s === '*') return Array.from({ length: MAX_OBJECTS }, (_, i) => i + 1)
		if (s.startsWith('@')) {
			const g = this.groups.find((x) => sameName(x.name, s.slice(1)))
			return g ? [...g.ids] : []
		}
		const set = new Set()
		for (const part of s.split(',')) {
			const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
			if (!m) return []
			let a = Number(m[1])
			let b = m[2] ? Number(m[2]) : a
			if (a > b) [a, b] = [b, a]
			for (let id = Math.max(1, a); id <= Math.min(MAX_OBJECTS, b); id++) set.add(id)
		}
		return [...set].sort((a, b) => a - b)
	}

	variables() {
		const m = this.master ?? {}
		const ready = this.ready
		const cueAt = (i) => (i ? this.tc.cues[i - 1] : null)
		const cur = cueAt(this.currentCueIndex)
		const sb = this.tcs?.standby ?? null
		const next = this.tcs?.next ?? null
		const v = {
			connection: this.link,
			connection_error: this.linkError,
			version: this.version,
			running: ready ? onOff(m.running) : '',
			frozen: ready ? onOff(m.frozen) : '',
			speed: ready ? String(round(this.speed)) : '',
			bpm: ready ? String(round(this.bpm, 1)) : '',
			tempo_mult: ready ? String(m.tempoMult ?? '') : '',
			transition: ready ? String(round(m.transition)) : '',
			show_lock: ready ? (this.showLock ? 'locked' : 'unlocked') : '',
			last_preset: this.lastPreset?.name ?? '',
			last_preset_modified: this.lastPreset ? onOff(this.lastPreset.modified) : '',
			last_slot: String(this.presets.find((p) => sameName(p.name, this.lastPreset?.name))?.slot ?? ''),
			session_name: this.session?.name ?? '',
			session_modified: this.session ? onOff(this.session.modified) : '',
			tc_enabled: this.tcs ? onOff(this.tcs.enabled) : '',
			tc_input: this.tcs?.input ?? this.tc.settings?.input ?? '',
			tc_trigger: this.tcs?.trigger ?? '',
			tc_state: this.tcs?.state ?? '',
			tc_running: this.tcs ? onOff(this.tcRunning) : '',
			timecode: this.timecode,
			cue_count: String(this.tc.cues.length),
			cue_current_number: String(this.currentCueIndex ?? ''),
			cue_current_label: cur ? cur.label || cur.tc || '' : '',
			cue_standby_number: String(sb?.index ?? ''),
			cue_standby_label: sb ? sb.label || sb.tc || '' : '',
			cue_next_number: String(next ? (this.cueIndexById(next.id) ?? '') : ''),
			cue_next_label: next ? next.label || next.tc || '' : '',
			cue_next_in: next && typeof next.in === 'number' ? String(round(next.in, 1)) : '',
		}
		for (let n = 1; n <= SLOT_COUNT; n++) v[`slot_${n}`] = this.slotPreset(n)?.name ?? ''
		return v
	}
}

module.exports = { ObjitterState, SLOT_COUNT, MAX_OBJECTS, sameName }
