import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicAsync, readJson, isPlainObject } from './fsutil.js';
import { safeName } from './presets.js';
import { LocalizedError } from './i18n.js';

export const SESSION_VERSION = 1;
export const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const EXT = '.objitter-session.json';

/**
 * Upgrades older session files in place (returns a new object). Version 1 is the first format;
 * future versions add steps here. Files from a newer Objitter are refused instead of half-loaded.
 */
export function migrateSession(d) {
  if (!isPlainObject(d) || d.kind !== 'session' || (d.app !== undefined && d.app !== 'objitter')) {
    throw new LocalizedError('srv.session.invalidFile');
  }
  const v = Number(d.version);
  if (!Number.isInteger(v) || v < 1) throw new LocalizedError('srv.session.invalidFile');
  if (v > SESSION_VERSION) throw new LocalizedError('srv.session.newer', { v });
  return { ...d, version: SESSION_VERSION };
}

/**
 * Session files in DATA_DIR/sessions. Names are matched case-insensitively and in Unicode NFC
 * (macOS file systems may return decomposed Hangul), but the on-disk spelling is kept.
 */
export class SessionStore {
  constructor(dir) {
    this.dir = dir;
  }

  scan() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith(EXT) && !f.startsWith('.'));
    } catch { /* no sessions yet */ }
    const out = new Map();
    for (const f of files) {
      const name = f.slice(0, -EXT.length).normalize('NFC');
      const key = name.toLowerCase();
      if (!name || out.has(key)) continue;
      let st = null;
      try { st = fs.statSync(path.join(this.dir, f)); } catch { continue; }
      out.set(key, { name, file: f, mtime: st.mtimeMs, size: st.size });
    }
    return out;
  }

  list() {
    return [...this.scan().values()]
      .map(({ name, mtime, size }) => ({ name, mtime, size }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }

  meta(name) {
    const n = safeName(name);
    return n ? this.scan().get(n.toLowerCase()) ?? null : null;
  }

  path(name) {
    const n = safeName(name);
    if (!n) throw new LocalizedError('srv.session.needName');
    const hit = this.meta(n);
    return path.join(this.dir, hit?.file ?? `${n}${EXT}`);
  }

  /** Writes atomically; an existing session keeps its file name (and spelling). Returns the stored name. */
  async save(name, data) {
    const n = safeName(name);
    if (!n) throw new LocalizedError('srv.session.needName');
    const old = this.meta(n);
    const stored = old?.name ?? n;
    const text = JSON.stringify({ ...data, name: stored }, null, 2);
    if (Buffer.byteLength(text) > MAX_SESSION_BYTES) throw new LocalizedError('srv.session.tooBig', { mb: MAX_SESSION_BYTES / 1024 / 1024 });
    await writeFileAtomicAsync(this.path(n), text);
    return stored;
  }

  load(name) {
    const meta = this.meta(name);
    if (!meta) throw new LocalizedError('srv.session.notFound', { name: safeName(name) });
    const file = path.join(this.dir, meta.file);
    if (fs.statSync(file).size > MAX_SESSION_BYTES) throw new LocalizedError('srv.session.tooBig', { mb: MAX_SESSION_BYTES / 1024 / 1024 });
    let d;
    try {
      d = readJson(file);
    } catch {
      throw new LocalizedError('srv.session.invalidFile');
    }
    return { ...migrateSession(d), name: meta.name };
  }

  remove(name) {
    const meta = this.meta(name);
    if (!meta) throw new LocalizedError('srv.session.notFound', { name: safeName(name) });
    fs.unlinkSync(path.join(this.dir, meta.file));
  }

  async rename(from, to) {
    const meta = this.meta(from);
    if (!meta) throw new LocalizedError('srv.session.notFound', { name: safeName(from) });
    const n = safeName(to);
    if (!n) throw new LocalizedError('srv.session.needName');
    const clash = this.meta(n);
    if (clash && clash.file !== meta.file) throw new LocalizedError('srv.session.renameExists', { name: clash.name });
    const src = path.join(this.dir, meta.file);
    const dst = path.join(this.dir, `${n}${EXT}`);
    const d = readJson(src);
    d.name = n;
    if (clash) {
      // Case-only rename: the file systems on Windows/macOS see one file, so rename it in place.
      await writeFileAtomicAsync(src, JSON.stringify(d, null, 2));
      await fs.promises.rename(src, dst);
    } else {
      await writeFileAtomicAsync(dst, JSON.stringify(d, null, 2));
      await fs.promises.unlink(src);
    }
    return n;
  }
}
