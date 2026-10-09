// Object library: per-object motion settings saved as JSON files in nested folders under LIBRARY_DIR.
// Items are kept in memory (small files, few hundred at most) so cues can apply them synchronously.
// Paths are "folder/sub/name" with every segment passed through safeName; no '..', no absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import { safeName } from './presets.js';
import { isPlainObject, stripBom, writeFileAtomicAsync } from './fsutil.js';
import { defaultObject, sanitizeObject, deepMerge } from './engine.js';
import { LocalizedError } from './i18n.js';

export const LIB_FORMAT = 'objitter-library';
export const LIB_VERSION = 1;
export const MAX_LIB_ITEMS = 2000;
export const MAX_LIB_DEPTH = 4;
export const MAX_LIB_BYTES = 512 * 1024;
const EXT = '.json';
const REGION_KEYS = ['center', 'range', 'rangeShape', 'innerRadius'];
const SKIP_KEYS = ['id', 'enabled', 'name', 'sourceId'];
const MOTION_KEYS = Object.keys(defaultObject(1)).filter((k) => !SKIP_KEYS.includes(k) && !REGION_KEYS.includes(k));

/** "a / b/c" → "a/b/c" (each segment safeName'd); '' for the root; null when unusable. */
export function safeLibPath(p, { allowRoot = true } = {}) {
  if (typeof p !== 'string') return null;
  const raw = p.normalize('NFC').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return allowRoot ? '' : null;
  if (raw.length > MAX_LIB_DEPTH + 1) return null;
  const segs = raw.map((s) => (s === '.' || s === '..' ? '' : safeName(s)));
  if (segs.some((s) => !s)) return null;
  return segs.join('/');
}

const keyOf = (p) => p.toLowerCase();
const splitPath = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? { folder: '', name: p } : { folder: p.slice(0, i), name: p.slice(i + 1) };
};

/** Motion settings of one object (+ region when asked), sanitized. */
export function libConfig(obj, includeRegion) {
  const s = sanitizeObject(deepMerge(defaultObject(1), isPlainObject(obj) ? obj : {}), 1);
  const out = {};
  for (const k of [...MOTION_KEYS, ...(includeRegion ? REGION_KEYS : [])]) out[k] = s[k];
  return out;
}

/** Patch to apply an item to an object (keys present in the item only). */
export function libPatch(item) {
  const s = libConfig(item.config, item.includeRegion);
  const out = {};
  for (const k of Object.keys(s)) if (Object.hasOwn(item.config, k)) out[k] = s[k];
  return out;
}

export class LibraryStore {
  constructor(dir) {
    this.dir = dir;
    this.items = new Map();
    this.folders = new Set();
  }

  abs(rel) {
    const f = path.join(this.dir, ...rel.split('/'));
    const within = path.relative(this.dir, f);
    if (within.split(/[\\/]/)[0] === '..' || path.isAbsolute(within)) throw new LocalizedError('srv.lib.badPath');
    return f;
  }

  load() {
    this.items.clear();
    this.folders.clear();
    fs.mkdirSync(this.dir, { recursive: true });
    const walk = (dirAbs, rel, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const name = e.name.normalize('NFC');
        if (e.isDirectory()) {
          if (depth >= MAX_LIB_DEPTH || name.startsWith('.')) continue;
          const seg = safeName(name);
          if (seg !== name) continue;
          const r = rel ? `${rel}/${seg}` : seg;
          this.folders.add(r);
          walk(path.join(dirAbs, e.name), r, depth + 1);
        } else if (e.isFile() && name.toLowerCase().endsWith(EXT) && this.items.size < MAX_LIB_ITEMS) {
          const base = name.slice(0, -EXT.length);
          if (safeName(base) !== base) continue;
          try {
            const st = fs.statSync(path.join(dirAbs, e.name));
            if (st.size > MAX_LIB_BYTES) continue;
            const item = this.parse(fs.readFileSync(path.join(dirAbs, e.name), 'utf8'), rel ? `${rel}/${base}` : base);
            if (item) this.items.set(keyOf(item.path), item);
          } catch { /* skip unreadable */ }
        }
      }
    };
    walk(this.dir, '', 0);
    return this;
  }

  parse(text, rel) {
    const j = JSON.parse(stripBom(text));
    if (!isPlainObject(j) || j.format !== LIB_FORMAT || !isPlainObject(j.config)) return null;
    const includeRegion = j.includeRegion === true;
    const { folder, name } = splitPath(rel);
    return {
      path: rel, folder, name, includeRegion,
      config: libConfig(j.config, includeRegion),
      note: typeof j.note === 'string' ? j.note.slice(0, 200) : '',
      savedAt: typeof j.savedAt === 'string' ? j.savedAt.slice(0, 40) : '',
    };
  }

  get(p) {
    const rel = safeLibPath(p, { allowRoot: false });
    return rel === null ? null : this.items.get(keyOf(rel)) ?? null;
  }

  list() {
    return {
      folders: [...this.folders].sort((a, b) => a.localeCompare(b)),
      items: [...this.items.values()].map((it) => ({
        path: it.path, folder: it.folder, name: it.name, includeRegion: it.includeRegion, mode: it.config.mode, savedAt: it.savedAt, note: it.note,
      })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async save({ folder, name, obj, includeRegion, note, overwrite }) {
    const f = safeLibPath(folder ?? '');
    const n = safeName(typeof name === 'string' ? name : '');
    if (f === null || !n) throw new LocalizedError('srv.lib.badName');
    const rel = f ? `${f}/${n}` : n;
    if (rel.split('/').length > MAX_LIB_DEPTH + 1) throw new LocalizedError('srv.lib.tooDeep', { max: MAX_LIB_DEPTH });
    const exists = this.items.get(keyOf(rel));
    if (exists && !overwrite) throw new LocalizedError('srv.lib.exists', { name: exists.path });
    if (!exists && this.items.size >= MAX_LIB_ITEMS) throw new LocalizedError('srv.lib.full', { max: MAX_LIB_ITEMS });
    const item = {
      path: exists?.path ?? rel, ...splitPath(exists?.path ?? rel), includeRegion: !!includeRegion,
      config: libConfig(obj, !!includeRegion), note: typeof note === 'string' ? note.slice(0, 200) : '', savedAt: new Date().toISOString(),
    };
    await this.ensureFolder(item.folder);
    await writeFileAtomicAsync(this.abs(`${item.path}${EXT}`), JSON.stringify({
      format: LIB_FORMAT, version: LIB_VERSION, name: item.name, includeRegion: item.includeRegion, note: item.note, savedAt: item.savedAt, config: item.config,
    }, null, 2));
    this.items.set(keyOf(item.path), item);
    return item;
  }

  async ensureFolder(rel) {
    if (!rel) return;
    await fs.promises.mkdir(this.abs(rel), { recursive: true });
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) this.folders.add(segs.slice(0, i).join('/'));
  }

  async addFolder(p) {
    const rel = safeLibPath(p, { allowRoot: false });
    if (rel === null) throw new LocalizedError('srv.lib.badName');
    if (rel.split('/').length > MAX_LIB_DEPTH) throw new LocalizedError('srv.lib.tooDeep', { max: MAX_LIB_DEPTH });
    await this.ensureFolder(rel);
    return rel;
  }

  async remove(p) {
    const it = this.get(p);
    if (!it) throw new LocalizedError('srv.lib.missing', { name: String(p).slice(0, 80) });
    await fs.promises.rm(this.abs(`${it.path}${EXT}`), { force: true });
    this.items.delete(keyOf(it.path));
    return it;
  }

  async removeFolder(p) {
    const rel = safeLibPath(p, { allowRoot: false });
    if (rel === null || !this.folders.has(rel)) throw new LocalizedError('srv.lib.missing', { name: String(p).slice(0, 80) });
    await fs.promises.rm(this.abs(rel), { recursive: true, force: true });
    const pre = `${keyOf(rel)}/`;
    for (const k of [...this.items.keys()]) if (k.startsWith(pre)) this.items.delete(k);
    for (const f of [...this.folders]) if (f === rel || keyOf(f).startsWith(pre)) this.folders.delete(f);
    return rel;
  }

  async move(p, toFolder, newName) {
    const it = this.get(p);
    if (!it) throw new LocalizedError('srv.lib.missing', { name: String(p).slice(0, 80) });
    const f = safeLibPath(toFolder ?? it.folder);
    const n = newName === undefined || newName === null ? it.name : safeName(newName);
    if (f === null || !n) throw new LocalizedError('srv.lib.badName');
    const rel = f ? `${f}/${n}` : n;
    if (rel === it.path) return it;
    const clash = this.items.get(keyOf(rel));
    if (clash && clash !== it) throw new LocalizedError('srv.lib.exists', { name: clash.path });
    await this.ensureFolder(f);
    await fs.promises.rename(this.abs(`${it.path}${EXT}`), this.abs(`${rel}${EXT}`));
    this.items.delete(keyOf(it.path));
    const moved = { ...it, path: rel, folder: f, name: n };
    this.items.set(keyOf(rel), moved);
    return moved;
  }
}
