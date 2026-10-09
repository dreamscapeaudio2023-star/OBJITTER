// Shared by the main page and every workspace module: DOM helpers, the live state
// store, the WebSocket send path (lock-guarded) and small UI primitives.
import { t } from './i18n.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline SVG icon from public/assets/icons (mask, so it follows currentColor). */
export const icon = (name, cls = '') => h('i', { class: `ico ${cls}`.trim(), style: `--ico:url(assets/icons/${name}.svg)`, 'aria-hidden': 'true' });

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function setPath(p, v) {
  const keys = p.split('.');
  const root = {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = v;
    else cur = cur[k] = {};
  });
  return root;
}
export function mergeLocal(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeLocal(target[k], v);
    else target[k] = v;
  }
}
let uid = 0;
export const nextId = (p) => `${p}-${++uid}`;

const hue = (id) => (id * 137.508) % 360;
export const objColor = (id, a = 1) => `hsla(${hue(id)}, 78%, 62%, ${a})`;

// ---------------- live state ----------------
/**
 * Mirror of the server state, kept current by app.js. Workspace modules read from it
 * and subscribe with on('state' | 'init' | 'tc' | 'pos' | 'presets' | 'lock' | 'lang', fn).
 */
export const store = {
  ST: null, S: null, OBJ: [], PRESETS: [], TC: null, TCS: null, positions: [], running: false, stats: null, stage: null,
  AUTO: null, AUTOS: null,
  selected: new Set(),
  LIB: null,
};
const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of subs.get(evt) ?? []) {
    try { fn(data); } catch (err) { console.error(`[${evt}]`, err); }
  }
}

export const isLocked = () => !!store.S?.showLock;

export const EDIT_TYPES = new Set([
  'updateObjects', 'updateObjectsEach', 'nudgeCenter', 'setOutput', 'setControl', 'preset.save', 'preset.delete', 'preset.import',
  'preset.setSlot', 'preset.meta', 'preset.snapshot', 'slot.clear', 'undo', 'groups.save', 'groups.delete',
  'output.target.add', 'output.target.update', 'output.target.remove',
  'tc.settings', 'tc.cue.add', 'tc.cue.update', 'tc.cue.delete', 'tc.cue.move', 'tc.cues.clear', 'tc.show.import',
  'session.load', 'session.delete', 'session.rename', 'session.import',
  'stage.set', 'stage.layout', 'stage.clear',
  'auto.lane.add', 'auto.lane.update', 'auto.lane.delete', 'auto.points', 'auto.arm',
  'lib.save', 'lib.delete', 'lib.move', 'lib.folder.add', 'lib.folder.delete',
  'stage.speaker.add', 'stage.speaker.update', 'stage.speaker.delete',
]);

let ws = null;
export const setSocket = (w) => { ws = w; };
export const socketOpen = () => ws?.readyState === 1;

let lastSendFail = 0;
export function toastThrottled(text, level) {
  const now = Date.now();
  if (now - lastSendFail < 1500) return;
  lastSendFail = now;
  toast(text, level);
}

export function guardEdit() {
  if (!isLocked()) return true;
  toastThrottled(t('ui.lockedEdit'), 'warn');
  return false;
}

export function send(msg) {
  if (EDIT_TYPES.has(msg.type) && !guardEdit()) return false;
  if (!ws || ws.readyState !== 1) {
    toastThrottled(t('ui.notConnected'), 'error');
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

/** Fire-and-forget (timecode frames, recording touches): never toasts, never lock-guarded. */
export function sendRaw(msg) {
  if (ws?.readyState === 1 && ws.bufferedAmount < 64 * 1024) ws.send(JSON.stringify(msg));
}

// ---------------- toasts / confirm ----------------
let lastToast = null;
export function toast(text, level = 'info') {
  const now = Date.now();
  const dur = level === 'error' ? 5000 : 2600;
  const lt = lastToast;
  if (lt && lt.text === text && lt.level === level && now - lt.t < 1500 && lt.el.isConnected) {
    lt.n++;
    lt.t = now;
    lt.el.textContent = `${text} ×${lt.n}`;
    clearTimeout(lt.timer);
    lt.timer = setTimeout(() => lt.el.remove(), dur);
    return;
  }
  const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' }, text);
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  lastToast = { text, level, el, n: 1, t: now, timer: setTimeout(() => el.remove(), dur) };
}

export function closeConfirm() {
  const bar = $('#confirmBar');
  if (bar.hidden) return false;
  bar.hidden = true;
  bar.replaceChildren();
  return true;
}

export function askConfirm(text, yesLabel, onYes) {
  const bar = $('#confirmBar');
  const yes = h('button', { class: 'danger', onclick: () => { closeConfirm(); onYes(); } }, yesLabel);
  bar.replaceChildren(h('span', {}, text), yes, h('button', { onclick: closeConfirm }, t('common.cancel')));
  bar.hidden = false;
  yes.focus();
}

export function disarm(btn) {
  clearTimeout(btn._t);
  btn.classList.remove('confirming');
  if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
}

/** Two-step button: first click arms ("Sure?"), second click within 3 s runs the action. */
export function armButton(btn, action) {
  btn.dataset.label = btn.textContent;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('confirming')) {
      disarm(btn);
      action();
      return;
    }
    if (!guardEdit()) return;
    btn.classList.add('confirming');
    btn.textContent = t('ui.confirmQ');
    btn._t = setTimeout(() => disarm(btn), 3000);
  });
  return btn;
}

export function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------- small form widgets ----------------
export function toggleEl(id, onchange) {
  const c = h('input', { type: 'checkbox', id, role: 'switch', onchange });
  return [h('span', { class: 'toggle' }, c, h('span', { 'aria-hidden': 'true' })), c];
}
export function segEl(options, onpick) {
  const seg = h('div', { class: 'seg' });
  for (const [v, l] of options) seg.append(h('button', { 'data-v': v, onclick: () => onpick(v) }, l));
  return seg;
}
export const setSeg = (seg, v) => $$('button', seg).forEach((b) => {
  b.classList.toggle('on', b.dataset.v === String(v));
  b.setAttribute('aria-pressed', String(b.dataset.v === String(v)));
});

/** "1-4,7" / "all" → sorted unique ids in 1..32. */
export function parseIds(spec, max = 32) {
  const s = String(spec ?? '').trim().toLowerCase();
  if (!s) return [];
  if (s === 'all' || s === '*') return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[,\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** Compact "1-4,7" from ids. */
export function idsSpec(ids) {
  const s = [...new Set(ids)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.join(',');
}
