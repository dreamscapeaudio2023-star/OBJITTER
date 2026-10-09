import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const pad4 = (n) => (4 - (n % 4)) % 4;
const MAX_BUNDLE_DEPTH = 4;
const MAX_MESSAGES_PER_PACKET = 512;

function encString(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([b, Buffer.alloc(1 + pad4(b.length + 1))]);
}

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new RangeError('unterminated OSC string');
  const s = buf.toString('utf8', off, end);
  const len = end - off + 1;
  return [s, off + len + pad4(len)];
}

/** args: number (float32) | string | { type: 'f'|'i'|'s', value } */
export function encodeMessage(address, args = []) {
  let tags = ',';
  const data = [];
  for (const a of args) {
    const arg = a !== null && typeof a === 'object' ? a : { type: typeof a === 'string' ? 's' : 'f', value: a };
    if (arg.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Math.round(Number(arg.value)) | 0);
      data.push(b);
      tags += 'i';
    } else if (arg.type === 's') {
      data.push(encString(arg.value));
      tags += 's';
    } else {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number(arg.value) || 0);
      data.push(b);
      tags += 'f';
    }
  }
  return Buffer.concat([encString(address), encString(tags), ...data]);
}

function bundleOf(parts) {
  const head = Buffer.alloc(16);
  head.write('#bundle\0', 0, 'ascii');
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(1, 12); // timetag 1 = "immediately"
  const chunks = [head];
  for (const p of parts) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(p.length);
    chunks.push(len, p);
  }
  return Buffer.concat(chunks);
}

/** Packs messages into as few bundles as possible, each at most maxSize bytes (MTU-safe). */
export function encodeBundles(msgs, maxSize = 1400) {
  const out = [];
  let parts = [];
  let size = 16;
  for (const m of msgs) {
    const b = encodeMessage(m.address, m.args);
    if (parts.length && size + 4 + b.length > maxSize) {
      out.push(bundleOf(parts));
      parts = [];
      size = 16;
    }
    parts.push(b);
    size += 4 + b.length;
  }
  if (parts.length) out.push(bundleOf(parts));
  return out;
}

/** Throws RangeError on malformed input. */
export function decodePacket(buf, out = [], depth = 0) {
  if (out.length >= MAX_MESSAGES_PER_PACKET) return out;
  if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
    if (depth >= MAX_BUNDLE_DEPTH) throw new RangeError('OSC bundle nesting too deep');
    let off = 16;
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || off + size > buf.length) throw new RangeError('bad OSC bundle element size');
      decodePacket(buf.subarray(off, off + size), out, depth + 1);
      off += size;
    }
    return out;
  }
  let [address, off] = readString(buf, 0);
  if (!address.startsWith('/')) throw new RangeError('OSC address must start with /');
  let tags = ',';
  if (off < buf.length && buf[off] === 0x2c) [tags, off] = readString(buf, off);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(off))); off += 8; }
    else if (t === 's' || t === 'S') { let s; [s, off] = readString(buf, off); args.push(s); }
    else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else if (t === 'N' || t === 'I') args.push(null);
    else break;
  }
  out.push({ address, args });
  return out;
}

export function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim();
  if (!h || h.length > 253) return false;
  if (net.isIPv4(h)) return true;
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/.test(h);
}

/**
 * Resolves the output host once per change (not per packet) and refreshes it periodically.
 * status: 'ok' | 'resolving' | error code (e.g. 'ENOTFOUND')
 */
export class HostResolver extends EventEmitter {
  constructor({ refreshMs = 30000, lookup = (h) => dns.promises.lookup(h, { family: 4 }) } = {}) {
    super();
    this.refreshMs = refreshMs;
    this.lookup = lookup;
    this.host = null;
    this.ip = null;
    this.status = 'idle';
    this.gen = 0;
    this.timer = null;
    this.backoff = 1000;
  }

  set(host) {
    if (host === this.host) return;
    this.host = host;
    this.gen++;
    clearTimeout(this.timer);
    this.ip = null;
    this.backoff = 1000;
    if (net.isIPv4(host)) {
      this.ip = host;
      this.status = 'ok';
      this.emit('change');
      return;
    }
    this.status = 'resolving';
    this.emit('change');
    this.resolve();
  }

  async resolve() {
    const gen = this.gen;
    try {
      const { address } = await this.lookup(this.host);
      if (gen !== this.gen) return;
      const changed = this.ip !== address || this.status !== 'ok';
      this.ip = address;
      this.status = 'ok';
      this.backoff = 1000;
      this.schedule(this.refreshMs);
      if (changed) this.emit('change');
    } catch (err) {
      if (gen !== this.gen) return;
      // A failed refresh keeps the last good address; a failed first lookup sends nothing.
      this.status = this.ip ? 'ok' : err.code || 'ERROR';
      this.schedule(this.ip ? this.refreshMs : this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.emit('change');
    }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.resolve(), ms);
    this.timer.unref?.();
  }

  close() {
    this.gen++;
    clearTimeout(this.timer);
  }
}

export class OscOutput extends EventEmitter {
  constructor() {
    super();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.bind(0, () => {
      try { this.socket.setBroadcast(true); } catch { /* ignore */ }
    });
  }

  sendBuffer(buf, port, ip, onError = null) {
    this.socket.send(buf, port, ip, (err) => {
      if (!err) return;
      if (onError) onError(err);
      else this.emit('error', err);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* ignore */ }
  }
}

/** Control input. No reuseAddr: on Windows that would silently share the port with another app. */
export class OscInput extends EventEmitter {
  constructor({ host } = {}) {
    super();
    this.host = host;
    this.socket = null;
    this.gen = 0;
    this.status = { state: 'disabled', port: null, message: '' };
  }

  setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  closeSocket() {
    const s = this.socket;
    this.socket = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.once('close', resolve);
      try { s.close(); } catch { resolve(); }
    });
  }

  async listen(port) {
    const gen = ++this.gen;
    await this.closeSocket();
    if (gen !== this.gen) return;
    if (!port) {
      this.setStatus({ state: 'disabled', port: null, message: '' });
      return;
    }
    const sock = dgram.createSocket('udp4');
    this.socket = sock;
    sock.on('message', (buf, rinfo) => {
      let msgs;
      try {
        msgs = decodePacket(buf);
      } catch (err) {
        this.emit('malformed', err, rinfo);
        return;
      }
      for (const m of msgs) this.emit('message', m, rinfo);
    });
    sock.on('error', (err) => {
      if (this.socket === sock) {
        this.socket = null;
        const message = err.code === 'EADDRINUSE'
          ? `UDP port ${port} is in use by another program`
          : err.code === 'EACCES' ? `No permission to open UDP port ${port}` : err.message;
        this.setStatus({ state: 'error', port, message, code: err.code ?? '' });
      }
      try { sock.close(); } catch { /* ignore */ }
    });
    sock.bind({ port, address: this.host }, () => {
      if (this.socket === sock) this.setStatus({ state: 'listening', port, message: '' });
    });
  }

  async close() {
    ++this.gen;
    await this.closeSocket();
    this.setStatus({ state: 'disabled', port: null, message: '' });
  }
}
