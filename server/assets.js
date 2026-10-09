// Uploaded stage images (PNG / JPEG / WebP). Files are named by content hash, so the same image
// uploaded twice is stored once and a session can refer to it by id alone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomicAsync } from './fsutil.js';
import { ASSET_ID_RE } from './layouts.js';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const ASSET_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Image type from the first bytes (the Content-Type header is not trusted). */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export class AssetStore {
  constructor(dir) {
    this.dir = dir;
  }

  file(id) {
    if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return null;
    return path.join(this.dir, id);
  }

  has(id) {
    const f = this.file(id);
    return !!f && fs.existsSync(f);
  }

  /** Stores the image; returns { id, bytes, type }. Throws { code: 'type' | 'size' }. */
  async save(buf) {
    if (buf.length > MAX_ASSET_BYTES) throw Object.assign(new Error('too large'), { code: 'size' });
    const type = sniffImage(buf);
    if (!type) throw Object.assign(new Error('unsupported image type'), { code: 'type' });
    const id = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${type}`;
    const f = this.file(id);
    if (!fs.existsSync(f)) {
      fs.mkdirSync(this.dir, { recursive: true });
      await writeFileAtomicAsync(f, buf);
    }
    return { id, bytes: buf.length, type };
  }

  read(id) {
    const f = this.file(id);
    return f ? fs.readFileSync(f) : null;
  }

  /** Restores an embedded asset (from a session file) if it is missing and the bytes match the id. */
  async restore(id, base64) {
    if (this.has(id) || typeof base64 !== 'string') return false;
    const buf = Buffer.from(base64, 'base64');
    const r = await this.save(buf);
    return r.id === id;
  }
}
