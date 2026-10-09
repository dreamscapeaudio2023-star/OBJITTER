// OSC traffic log for the Setup → OSC log page. Only collects while someone is watching.
// Each (direction, peer host, address) is sampled to at most RATE_HZ lines per second; the number of
// messages folded into a line is reported as `skip`, so a 25 Hz × 32 position stream stays readable.

export const LOG_RING = 500;
export const RATE_HZ = 5;
const MIN_GAP_MS = 1000 / RATE_HZ;
const MAX_ARGS_LEN = 160;
const FLUSH_MS = 100;

function fmtArg(x) {
  const v = x !== null && typeof x === 'object' && 'value' in x ? x.value : x;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);
  return String(v);
}

export function fmtArgs(args) {
  const s = (args ?? []).map(fmtArg).join(' ');
  return s.length > MAX_ARGS_LEN ? `${s.slice(0, MAX_ARGS_LEN)}…` : s;
}

export class OscLog {
  /** push(ws, msg) delivers a batch to one subscriber. */
  constructor(push, { now = Date.now } = {}) {
    this.push = push;
    this.now = now;
    this.subs = new Set();
    this.ring = [];
    this.pending = [];
    this.last = new Map();
    this.seq = 0;
    this.timer = null;
  }

  get active() { return this.subs.size > 0; }

  subscribe(ws, on) {
    if (on) {
      this.subs.add(ws);
      this.push(ws, { type: 'osclog', reset: true, entries: this.ring });
      if (!this.timer) {
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        this.timer.unref?.();
      }
    } else this.drop(ws);
  }

  drop(ws) {
    this.subs.delete(ws);
    if (!this.subs.size) {
      clearInterval(this.timer);
      this.timer = null;
      this.ring = [];
      this.pending = [];
      this.last.clear();
    }
  }

  add(dir, peer, address, args) {
    if (!this.subs.size) return;
    const t = this.now();
    // per host, not host:port — some senders open a new socket (new source port) for every message
    const key = `${dir}|${String(peer).replace(/:\d+$/, '')}|${address}`;
    const prev = this.last.get(key);
    if (prev && t - prev.t < MIN_GAP_MS) {
      prev.skip++;
      return;
    }
    const e = { id: ++this.seq, t, dir, peer, addr: String(address).slice(0, 120), args: fmtArgs(args), skip: prev?.skip ?? 0 };
    this.last.set(key, { t, skip: 0 });
    if (this.last.size > 4000) this.last.clear();
    this.pending.push(e);
    this.ring.push(e);
    if (this.ring.length > LOG_RING) this.ring.splice(0, this.ring.length - LOG_RING);
  }

  flush() {
    if (!this.pending.length) return;
    const entries = this.pending;
    this.pending = [];
    for (const ws of this.subs) this.push(ws, { type: 'osclog', entries });
  }
}
