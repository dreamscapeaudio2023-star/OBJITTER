import en from './lang/en.js';
import ko from './lang/ko.js';

/*
 * Tiny i18n layer shared by the browser UI and the server.
 *  - t(key, params)          → string in the current UI language ({name} placeholders).
 *  - L(key, params)          → { $t, p } fragment; the server sends these, the client translates them.
 *  - tm(value)               → translates anything the server may send: plain string, fragment,
 *                              { en, ko } pair or a { key, params, text } message.
 * Param values may themselves be fragments, { en, ko } pairs or arrays (joined with " · ").
 * Dictionary values are strings or (params, fmt) => string for the few grammar-dependent cases.
 */
export const LANGS = ['en', 'ko'];
export const DICTS = { en, ko };
const STORE_KEY = 'objitter.lang';
let current = 'en';

export const getLang = () => current;
export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'en';
  return current;
}

export const L = (key, params) => (params === undefined ? { $t: key } : { $t: key, p: params });
export const isL = (v) => v !== null && typeof v === 'object' && typeof v.$t === 'string';
const isPair = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (typeof v.en === 'string' || typeof v.ko === 'string');

export const pick = (v, lang = current) => (isPair(v) ? v[lang] ?? v.en ?? '' : v ?? '');

function fmtVal(lang, v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => fmtVal(lang, x)).filter((s) => s !== '').join(' · ');
  if (isL(v)) return tr(lang, v.$t, v.p);
  if (isPair(v)) return pick(v, lang);
  if (typeof v === 'object' && typeof v.key === 'string') return tr(lang, v.key, v.params, v.text);
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return String(v);
}

export function tr(lang, key, params, fallback) {
  const d = DICTS[lang] ?? en;
  const s = d[key] ?? en[key];
  if (s === undefined) return fallback ?? key;
  if (typeof s === 'function') return s(params ?? {}, (v) => fmtVal(lang, v));
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? fmtVal(lang, params[k]) : m));
}

export const t = (key, params) => tr(current, key, params);
export const tm = (v, lang = current) => fmtVal(lang, v);

/** True on macOS / iPadOS browsers (Cmd instead of Ctrl, ⌥ instead of Alt). */
export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');

export function storedLang() {
  try { return localStorage.getItem(STORE_KEY) || 'en'; } catch { return 'en'; }
}
export function storeLang(lang) {
  try { localStorage.setItem(STORE_KEY, lang); } catch { /* private mode */ }
}

/** Placeholders available to static HTML strings (platform-specific key names). */
export const staticParams = IS_MAC
  ? { mod: '⌘', alt: '⌥', shift: '⇧', modKey: '⌘', altKey: '⌥', shiftKey: '⇧' }
  : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', modKey: 'Ctrl+', altKey: 'Alt+', shiftKey: 'Shift+' };

/** Shortcut label for the current platform, e.g. kbd('mod', 'S') → "⌘S" or "Ctrl+S". */
export const kbd = (...parts) => (IS_MAC
  ? parts.map((p) => ({ mod: '⌘', alt: '⌥', shift: '⇧' }[p] ?? p)).join('')
  : parts.map((p) => ({ mod: 'Ctrl', alt: 'Alt', shift: 'Shift' }[p] ?? p)).join('+'));

/** Applies data-i18n* attributes below `root` (static HTML). */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, staticParams);
  for (const [attr, prop] of [['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label']]) {
    for (const el of root.querySelectorAll(`[${attr}]`)) el.setAttribute(prop, t(el.getAttribute(attr), staticParams));
  }
  if (root === document) {
    document.documentElement.lang = current;
    document.title = t('app.title');
  }
}
