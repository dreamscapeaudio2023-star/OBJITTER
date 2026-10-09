const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const { buildActions } = require('./actions')
const { buildFeedbacks } = require('./feedbacks')
const { variableDefinitions } = require('./variables')
const { buildPresets } = require('./presets')
const { ObjitterState } = require('./state')
const { OscSender } = require('./osc')
const { ObjitterSocket } = require('./ws-client')

const REFRESH_MS = 50
const CHOICES_MS = 400

class ObjitterInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.state = new ObjitterState()
		this.oscOut = new OscSender()
		this.oscOut.onError = (err) => this.log('warn', `OSC send error: ${err.code || err.message}`)
		this.sock = new ObjitterSocket()
		this.sock.on('status', (s) => this.onLinkStatus(s))
		this.sock.on('message', (m) => this.onMessage(m))
		this.lastVars = {}
		this.lastFbKey = ''
		this.refreshTimer = null
		this.choicesTimer = null
	}

	async init(config) {
		this.config = config
		this.setVariableDefinitions(variableDefinitions())
		this.updateDefinitions()
		this.applyConfig()
	}

	async configUpdated(config) {
		this.config = config
		this.setPresetDefinitions(buildPresets(this.label))
		this.applyConfig()
	}

	async destroy() {
		clearTimeout(this.refreshTimer)
		clearTimeout(this.choicesTimer)
		this.sock.stop()
		this.oscOut.close()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'DREAMSCAPE Objitter',
				value:
					'Commands are sent as OSC to the Objitter control input (Objitter ??Setup ??System ??OSC control). ' +
					'Live feedback, variables and dropdown lists come from the Objitter web server (WebSocket, read-only). ' +
					'Show Lock and Library apply need the WebSocket link.',
			},
			{ type: 'textinput', id: 'host', label: 'Objitter host (IP or name)', width: 6, default: '127.0.0.1' },
			{
				type: 'number',
				id: 'controlPort',
				label: 'OSC control port (UDP)',
				width: 3,
				default: 9000,
				min: 1,
				max: 65535,
			},
			{
				type: 'number',
				id: 'webPort',
				label: 'Web UI / WebSocket port (TCP)',
				width: 3,
				default: 8080,
				min: 1,
				max: 65535,
			},
			{
				type: 'checkbox',
				id: 'feedback',
				label: 'Enable WebSocket feedback (live state, variables, dropdowns)',
				width: 6,
				default: true,
			},
		]
	}

	// ---------- plumbing used by actions ----------
	sendOsc(address, args = []) {
		return this.oscOut.send(address, args).catch((err) => this.log('warn', `OSC ${address} failed: ${err.code || err.message}`))
	}

	sendWs(msg) {
		if (this.sock.send(msg)) return true
		this.log('warn', `Not connected to the Objitter web server: "${msg.type}" not sent`)
		return false
	}

	async parse(text, context) {
		if (!text.includes('$(')) return text
		if (context?.parseVariablesInString) return context.parseVariablesInString(text)
		return this.parseVariablesInString(text)
	}

	// ---------- setup ----------
	applyConfig() {
		const host = String(this.config.host ?? '').trim()
		const controlPort = Number(this.config.controlPort)
		const webPort = Number(this.config.webPort)
		this.sock.stop()
		this.state.reset()
		if (!host || !(controlPort >= 1 && controlPort <= 65535) || !(webPort >= 1 && webPort <= 65535)) {
			this.state.link = 'off'
			this.updateStatus(InstanceStatus.BadConfig, 'Set host and ports')
			this.refreshNow(true)
			return
		}
		this.oscOut.configure(host, controlPort)
		if (this.config.feedback === false) {
			this.state.link = 'off'
			this.updateStatus(InstanceStatus.Ok, 'OSC only (feedback off)')
		} else {
			this.sock.start(host, webPort)
		}
		this.refreshNow(true)
	}

	updateDefinitions() {
		this.setActionDefinitions(buildActions(this))
		this.setFeedbackDefinitions(buildFeedbacks(this))
		this.setPresetDefinitions(buildPresets(this.label))
	}

	onLinkStatus(s) {
		if (s.state === 'open') {
			this.state.link = 'connected'
			this.state.linkError = ''
			this.updateStatus(InstanceStatus.Ok)
		} else if (s.state === 'connecting') {
			if (this.state.link !== 'error') this.state.link = 'connecting'
			if (this.state.link === 'connecting') this.updateStatus(InstanceStatus.Connecting)
		} else {
			const wasReady = this.state.ready
			this.state.reset()
			this.state.link = s.state === 'error' ? 'error' : 'disconnected'
			this.state.linkError = s.message ?? ''
			this.updateStatus(InstanceStatus.ConnectionFailure, s.message || 'Disconnected (OSC commands still sent)')
			if (wasReady) this.log('warn', `Feedback link lost: ${s.message || 'closed'}; retrying`)
			this.scheduleChoices()
		}
		this.refreshNow(true)
	}

	onMessage(m) {
		const r = this.state.handle(m)
		if (r.ignored) return
		if (r.lists) this.scheduleChoices()
		if (m.type === 'init') this.log('info', `Connected to Objitter ${this.state.version}`)
		if (!this.refreshTimer) this.refreshTimer = setTimeout(() => this.refreshNow(), REFRESH_MS)
	}

	scheduleChoices() {
		clearTimeout(this.choicesTimer)
		this.choicesTimer = setTimeout(() => this.setActionDefinitions(buildActions(this)), CHOICES_MS)
	}

	feedbackKey() {
		const s = this.state
		return JSON.stringify([
			s.link,
			s.ready,
			s.master?.running,
			s.master?.frozen,
			s.showLock,
			s.lastPreset?.name,
			s.presets.map((p) => `${p.slot}:${p.name}`),
			s.currentCueIndex,
			s.standbyIndex,
			s.tcRunning,
			s.tcs?.enabled,
			s.session?.modified,
			this.config?.feedback,
		])
	}

	refreshNow(force = false) {
		clearTimeout(this.refreshTimer)
		this.refreshTimer = null
		const vars = this.state.variables()
		const changed = {}
		for (const [k, v] of Object.entries(vars)) {
			if (force || this.lastVars[k] !== v) changed[k] = v
		}
		this.lastVars = vars
		if (Object.keys(changed).length) this.setVariableValues(changed)
		const key = this.feedbackKey()
		if (force || key !== this.lastFbKey) {
			this.lastFbKey = key
			this.checkFeedbacks()
		}
	}
}

runEntrypoint(ObjitterInstance, UpgradeScripts)
