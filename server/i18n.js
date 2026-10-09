import { L, tr, isL } from '../public/i18n.js';

export { L, isL };

/** English text of a fragment (server console / fallback `text` field). */
export const en = (v) => (isL(v) ? tr('en', v.$t, v.p) : String(v ?? ''));

/** Error with a translatable message; `message` is English for logs. */
export class LocalizedError extends Error {
  constructor(key, params) {
    super(tr('en', key, params));
    this.key = key;
    this.params = params;
  }
}

/** Fragment for any error: LocalizedError → its key, others → their (English, OS) message. */
export const errMsg = (err) => (err?.key ? L(err.key, err.params) : String(err?.message ?? err));

/** Wire format of a user-facing message: key + params for the client, English `text` as fallback. */
export function wire(msg) {
  if (isL(msg)) return { key: msg.$t, params: msg.p, text: en(msg) };
  return { text: String(msg ?? '') };
}
