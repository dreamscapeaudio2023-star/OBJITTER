const { EventEmitter } = require('node:events')
const WebSocket = require('ws')

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000]
/** The server pings every 15 s; without a ping or a message for this long the link is considered dead. */
const IDLE_TIMEOUT_MS = 40000

/**
 * Read-mostly WebSocket link to the Objitter web server (ws://host:port/ws).
 * Events: 'status' ({ state: 'connecting'|'open'|'closed'|'error', message? }), 'message' (parsed JSON).
 */
class ObjitterSocket extends EventEmitter {
	constructor() {
		super()
		this.url = null
		this.ws = null
		this.attempt = 0
		this.retryTimer = null
		this.idleTimer = null
		this.stopped = true
		this.lastError = null
	}

	get connected() {
		return this.ws?.readyState === WebSocket.OPEN
	}

	start(host, port) {
		this.stop()
		const h = String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : host
		this.url = `ws://${h}:${port}/ws`
		this.stopped = false
		this.attempt = 0
		this.lastError = null
		this.connect()
	}

	stop() {
		this.stopped = true
		clearTimeout(this.retryTimer)
		clearTimeout(this.idleTimer)
		this.retryTimer = null
		const ws = this.ws
		this.ws = null
		if (ws) {
			ws.removeAllListeners()
			ws.on('error', () => {})
			try {
				ws.terminate()
			} catch {
				// ignore
			}
		}
	}

	send(msg) {
		if (!this.connected) return false
		this.ws.send(JSON.stringify(msg))
		return true
	}

	connect() {
		if (this.stopped) return
		this.emit('status', { state: 'connecting', url: this.url })
		const ws = new WebSocket(this.url, { handshakeTimeout: 5000, perMessageDeflate: false })
		this.ws = ws
		ws.on('open', () => {
			this.attempt = 0
			this.lastError = null
			this.touch()
			ws.send(JSON.stringify({ type: 'hello' }))
			this.emit('status', { state: 'open', url: this.url })
		})
		ws.on('ping', () => this.touch())
		ws.on('message', (raw, isBinary) => {
			this.touch()
			if (isBinary) return
			let m
			try {
				m = JSON.parse(raw)
			} catch {
				return
			}
			if (m && typeof m.type === 'string') this.emit('message', m)
		})
		ws.on('unexpected-response', (_req, res) => {
			this.lastError =
				res.statusCode === 401 || res.statusCode === 403
					? `HTTP ${res.statusCode}: host not allowed (add it to ALLOWED_HOSTS on the Objitter machine)`
					: `HTTP ${res.statusCode}`
			res.resume()
			ws.terminate()
		})
		ws.on('error', (err) => {
			this.lastError ??= err.code || err.message
		})
		ws.on('close', () => {
			if (this.ws !== ws) return
			this.ws = null
			clearTimeout(this.idleTimer)
			this.emit('status', { state: this.lastError ? 'error' : 'closed', message: this.lastError, url: this.url })
			this.scheduleRetry()
		})
	}

	touch() {
		clearTimeout(this.idleTimer)
		this.idleTimer = setTimeout(() => {
			this.lastError = 'no data from server (timeout)'
			this.ws?.terminate()
		}, IDLE_TIMEOUT_MS)
		this.idleTimer.unref?.()
	}

	scheduleRetry() {
		if (this.stopped) return
		const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
		this.attempt++
		clearTimeout(this.retryTimer)
		this.retryTimer = setTimeout(() => {
			this.lastError = null
			this.connect()
		}, ms)
		this.retryTimer.unref?.()
	}
}

module.exports = { ObjitterSocket }
