import fs from 'node:fs';
import path from 'node:path';

export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
let tmpSeq = 0;
const tmpName = (file) => `${file}.${process.pid}.${++tmpSeq}.tmp`;

/**
 * Synchronous temp file + rename, for shutdown only: retries immediately without sleeping so the
 * event loop is never blocked during a show.
 */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 3 || !RETRY_CODES.includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
    }
  }
}

const queues = new Map();

/**
 * Async temp file + rename. Writes to the same file are serialized (last one wins, in order).
 * Windows: antivirus / indexer / an open editor can briefly lock the target, so rename is retried
 * with timers instead of blocking.
 */
export function writeFileAtomicAsync(file, text) {
  const key = path.resolve(file).toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = tmpName(file);
    await fs.promises.writeFile(tmp, text);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (err) {
        if (attempt >= 6 || !RETRY_CODES.includes(err.code)) {
          await fs.promises.unlink(tmp).catch(() => {});
          throw err;
        }
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  });
  queues.set(key, job);
  job.finally(() => { if (queues.get(key) === job) queues.delete(key); }).catch(() => {});
  return job;
}

/** Resolves when every queued async write has settled. */
export async function flushWrites() {
  await Promise.allSettled([...queues.values()]);
}

export function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}
