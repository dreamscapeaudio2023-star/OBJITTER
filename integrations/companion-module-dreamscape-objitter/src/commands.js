/** OSC-style args ('i'/'f'/'s' objects or plain values) → plain JSON values for the WebSocket 'control' message. */
function plainArgs(args) {
	return args.map((a) => {
		if (a === null || typeof a !== 'object') return a
		if (a.type === 's') return String(a.value)
		const n = Number(a.value)
		return a.type === 'i' ? Math.round(n) : n
	})
}

/**
 * Routes action commands to the Objitter the feedback link is connected to.
 * Over the WebSocket when that server supports it ('control.ws'), so commands and feedback can never
 * reach two different Objitter instances; otherwise as OSC to host:controlPort.
 * Both paths run the same server-side handler, so Show Lock rules are identical.
 */
class CommandRouter {
	constructor({ osc, sock, state, log, onOscResult = null }) {
		this.osc = osc
		this.sock = sock
		this.state = state
		this.log = log
		this.onOscResult = onOscResult
	}

	get viaWs() {
		return this.sock.connected && this.state.ready && this.state.wsControl
	}

	/** Resolves to 'ws' | 'osc' | null (failed; already logged). Never rejects. */
	async send(address, args = []) {
		if (this.viaWs && this.sock.send({ type: 'control', address, args: plainArgs(args) })) return 'ws'
		try {
			await this.osc.send(address, args)
			this.onOscResult?.(null)
			return 'osc'
		} catch (err) {
			this.log('warn', `OSC ${address} → ${this.osc.host}:${this.osc.port} failed: ${err.code || err.message}`)
			this.onOscResult?.(err)
			return null
		}
	}
}

module.exports = { CommandRouter, plainArgs }
