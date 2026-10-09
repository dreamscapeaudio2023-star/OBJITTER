const dgram = require('node:dgram')

const pad4 = (n) => (4 - (n % 4)) % 4

function encString(s) {
	const b = Buffer.from(String(s), 'utf8')
	return Buffer.concat([b, Buffer.alloc(1 + pad4(b.length + 1))])
}

/** args: string → 's', integer → 'i', other number → 'f', or { type: 'i'|'f'|'s', value }. */
function encodeMessage(address, args = []) {
	let tags = ','
	const data = []
	for (const a of args) {
		const arg =
			a !== null && typeof a === 'object'
				? a
				: { type: typeof a === 'string' ? 's' : Number.isInteger(a) ? 'i' : 'f', value: a }
		if (arg.type === 's') {
			data.push(encString(arg.value))
			tags += 's'
			continue
		}
		const b = Buffer.alloc(4)
		if (arg.type === 'i') {
			b.writeInt32BE(Math.round(Number(arg.value)) | 0)
			tags += 'i'
		} else {
			b.writeFloatBE(Number(arg.value) || 0)
			tags += 'f'
		}
		data.push(b)
	}
	return Buffer.concat([encString(address), encString(tags), ...data])
}

function readString(buf, off) {
	let end = off
	while (end < buf.length && buf[end] !== 0) end++
	if (end >= buf.length) throw new RangeError('unterminated OSC string')
	const len = end - off + 1
	return [buf.toString('utf8', off, end), off + len + pad4(len)]
}

/** Single-message decoder (used by the tests). */
function decodeMessage(buf) {
	let [address, off] = readString(buf, 0)
	let tags = ','
	if (off < buf.length && buf[off] === 0x2c) [tags, off] = readString(buf, off)
	const args = []
	const types = []
	for (const t of tags.slice(1)) {
		types.push(t)
		if (t === 'f') {
			args.push(buf.readFloatBE(off))
			off += 4
		} else if (t === 'i') {
			args.push(buf.readInt32BE(off))
			off += 4
		} else if (t === 's') {
			let s
			;[s, off] = readString(buf, off)
			args.push(s)
		} else break
	}
	return { address, args, types: types.join('') }
}

class OscSender {
	constructor() {
		this.sock = null
		this.host = '127.0.0.1'
		this.port = 9000
		this.onError = null
	}

	configure(host, port) {
		this.host = host
		this.port = port
		if (!this.sock) {
			this.sock = dgram.createSocket('udp4')
			this.sock.on('error', (err) => this.onError?.(err))
			this.sock.unref()
		}
	}

	send(address, args = []) {
		if (!this.sock) throw new Error('OSC sender not configured')
		const buf = encodeMessage(address, args)
		return new Promise((resolve, reject) => {
			this.sock.send(buf, this.port, this.host, (err) => (err ? reject(err) : resolve()))
		})
	}

	close() {
		try {
			this.sock?.close()
		} catch {
			// already closed
		}
		this.sock = null
	}
}

module.exports = { encodeMessage, decodeMessage, OscSender }
