import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicAsync, readJson, isPlainObject } from './fsutil.js';
import { LocalizedError } from './i18n.js';

export const SLOT_COUNT = 32;
export const PALETTE = [
  { key: 'red', hex: '#f87171', name: { en: 'Red', ko: '빨강' } },
  { key: 'orange', hex: '#fb923c', name: { en: 'Orange', ko: '주황' } },
  { key: 'yellow', hex: '#fbbf24', name: { en: 'Yellow', ko: '노랑' } },
  { key: 'green', hex: '#4ade80', name: { en: 'Green', ko: '초록' } },
  { key: 'teal', hex: '#38e1c6', name: { en: 'Teal', ko: '청록' } },
  { key: 'blue', hex: '#60a5fa', name: { en: 'Blue', ko: '파랑' } },
  { key: 'purple', hex: '#a78bfa', name: { en: 'Purple', ko: '보라' } },
  { key: 'pink', hex: '#f472b6', name: { en: 'Pink', ko: '분홍' } },
];
const COLOR_KEYS = new Set(PALETTE.map((p) => p.key));
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** File-system safe preset name (Windows rules are the strictest, so they apply everywhere). */
export function safeName(name) {
  if (typeof name !== 'string') return '';
  let n = Array.from(name
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim())
    .slice(0, 64)
    .join('')
    .replace(/[.\s]+$/, '');
  if (RESERVED.test(n)) n = `_${n}`;
  return n;
}

/** Index key: case-insensitive (macOS/Windows file systems are) and Unicode-normalized (macOS may hand back NFD). */
export const nameKey = (name) => safeName(name).toLowerCase();

/** 1–32 from an integer or a plain digit string only ("2x", 1.5, "" → null). */
export function validSlot(v) {
  let n = null;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) n = Number(v);
  return n !== null && n >= 1 && n <= SLOT_COUNT ? n : null;
}

export const validColor = (v) => (typeof v === 'string' && COLOR_KEYS.has(v) ? v : null);
export const cleanNote = (v) => (typeof v === 'string' ? Array.from(v.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, 120).join('').trim() : '');

const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function metaOf(name, d, mtime, file) {
  const objs = Array.isArray(d?.objects) ? d.objects.filter(isPlainObject) : [];
  const ids = objs.some((o) => o.id !== undefined)
    ? [...new Set(objs.map((o) => Number(o.id)).filter((id) => Number.isInteger(id) && id >= 1 && id <= 32))].sort((a, b) => a - b)
    : objs.slice(0, 32).map((_, i) => i + 1);
  return {
    name, mtime, slot: validSlot(d?.slot), count: ids.length, ids,
    color: validColor(d?.color), note: cleanNote(d?.note), file,
  };
}

/**
 * Preset files plus an in-memory metadata index. The index is built once (or after invalidate())
 * and updated in place on every change, so slot/meta edits never rescan the directory.
 */
export class PresetStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Path of an existing preset (keeps its on-disk spelling, e.g. NFD from macOS) or of a new one. */
  file(name) {
    const n = safeName(name);
    if (!n) throw new LocalizedError('srv.preset.badName');
    const hit = this.index().get(n.toLowerCase());
    return path.join(this.dir, hit?.file ?? `${n}.json`);
  }

  invalidate() {
    this.cache = null;
  }

  index() {
    if (this.cache) return this.cache;
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('.'));
    } catch { /* missing dir */ }
    this.cache = new Map();
    for (const f of files) {
      const full = path.join(this.dir, f);
      let d = null;
      try { d = readJson(full); } catch { /* unreadable preset still listed */ }
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      const name = f.slice(0, -5).normalize('NFC');
      const key = name.toLowerCase();
      if (this.cache.has(key)) continue;
      this.cache.set(key, metaOf(name, d, mtime, f));
    }
    return this.cache;
  }

  /** Public list (sorted). `ids`/`file` stay server-side. */
  list() {
    return [...this.index().values()]
      .map(({ ids, file, ...m }) => m)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  meta(name) {
    const n = safeName(name);
    return n ? this.index().get(n.toLowerCase()) ?? null : null;
  }

  exists(name) {
    return !!this.meta(name) || fs.existsSync(this.file(name));
  }

  /** Keeps slot/color/note of an existing preset when overwriting. Resolves after the file is on disk. */
  async save(name, scene) {
    const file = this.file(name);
    const old = this.meta(name);
    const data = {
      app: 'objitter', version: 2, name: old?.name ?? safeName(name), savedAt: new Date().toISOString(),
      slot: old?.slot ?? null, color: old?.color ?? null, note: old?.note ?? '', ...scene,
    };
    await writeFileAtomicAsync(file, JSON.stringify(data, null, 2));
    this.index().set(data.name.toLowerCase(), metaOf(data.name, data, Date.now(), path.basename(file)));
    return data.name;
  }

  load(name) {
    const d = readJson(this.file(name));
    if (!isPlainObject(d) || !Array.isArray(d.objects)) throw new LocalizedError('srv.preset.invalidFile');
    return d;
  }

  remove(name) {
    const m = this.meta(name);
    fs.unlinkSync(this.file(m?.name ?? name));
    this.index().delete((m?.name ?? safeName(name)).toLowerCase());
  }

  bySlot(slot) {
    if (slot === null || slot === undefined) return null;
    for (const m of this.index().values()) if (m.slot === slot) return m;
    return null;
  }

  rewrite(name, patch) {
    const file = this.file(name);
    const d = readJson(file);
    Object.assign(d, patch);
    const m = metaOf(name, d, Date.now(), path.basename(file));
    this.index().set(name.toLowerCase(), m);
    return writeFileAtomicAsync(file, JSON.stringify(d, null, 2));
  }

  /** Index updates synchronously; the returned promise resolves when the files are written. */
  setSlot(name, slot) {
    const s = slot === null ? null : validSlot(slot);
    if (slot !== null && s === null) throw new LocalizedError('srv.slot.range', { max: SLOT_COUNT });
    const target = this.meta(name);
    if (!target) throw new LocalizedError('srv.preset.notFound', { name: safeName(name) });
    const jobs = [];
    if (s !== null) {
      const holder = this.bySlot(s);
      if (holder && !sameFile(this.file(holder.name), this.file(target.name))) jobs.push(this.rewrite(holder.name, { slot: null }));
    }
    jobs.push(this.rewrite(target.name, { slot: s }));
    return Promise.all(jobs);
  }

  setMeta(name, { color, note } = {}) {
    const target = this.meta(name);
    if (!target) throw new LocalizedError('srv.preset.notFound', { name: safeName(name) });
    const patch = {};
    if (color !== undefined) patch.color = validColor(color);
    if (note !== undefined) patch.note = cleanNote(note);
    return this.rewrite(target.name, patch);
  }

  /** Returns the name of the preset that held the slot, or null. */
  clearSlot(slot) {
    const s = validSlot(slot);
    const p = s === null ? null : this.bySlot(s);
    if (!p) return null;
    this.setSlot(p.name, null).catch(() => {});
    return p.name;
  }
}
