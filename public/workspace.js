// Workspace manager: wide editors (Output, Timecode, Show, Automation, Stage) open as a
// full-screen layer under the top bar, or pop out into their own browser window (?ws=<id>).
// Pop-out windows load the same page, so connection, state and the top-bar transport are shared.
import { $, h, icon, toast } from './core.js';
import { t } from './i18n.js';

const LS_POPOUT = 'objitter.wsPopout';

export function createWorkspaces() {
  const popout = new URLSearchParams(location.search).get('ws') || null;
  const defs = new Map();
  const aliases = new Map();
  let cur = null;

  const switcher = h('div', { class: 'ws-switch', role: 'tablist' });
  const toolsHost = h('div', { class: 'ws-tools' });
  const popBtn = h('button', { class: 'btn-ghost ws-pop', type: 'button', onclick: () => cur && popOut(cur.id, cur.page?.() ? `&tab=${encodeURIComponent(cur.page())}` : '') }, icon('popout'));
  const closeBtn = h('button', { class: 'btn-ghost ws-close', type: 'button', onclick: () => close() }, '✕');
  const layer = h('div', { class: 'ws-layer', id: 'wsLayer', hidden: true },
    h('header', { class: 'ws-head' }, switcher, toolsHost, popout ? null : popBtn, popout ? null : closeBtn));
  document.body.append(layer);
  const launchBar = $('#wsLaunch');
  if (popout) document.body.classList.add('ws-only');

  function register(id, def) {
    const body = h('div', { class: 'ws-body', id: `ws-body-${id}` });
    const tools = h('div', { class: 'ws-tools-set', hidden: true });
    toolsHost.append(tools);
    const pane = h('section', { class: 'ws-pane', 'data-ws': id, hidden: true, role: 'tabpanel' }, body);
    layer.append(pane);
    const btn = h('button', { class: 'ws-btn', type: 'button', 'data-ws': id, onclick: (e) => launch(id, e) }, icon(def.icon), h('span', { class: 'ws-btn-l' }));
    launchBar?.append(btn);
    const tab = h('button', { class: 'ws-tab', type: 'button', role: 'tab', 'data-ws': id, 'aria-selected': 'false', onclick: () => open(id) },
      icon(def.icon), h('span', { class: 'ws-tab-l' }));
    switcher.append(tab);
    const d = { ...def, id, pane, body, tools, btn, tab, built: false };
    defs.set(id, d);
    relabel(d);
    if (def.prebuild) ensureBuilt(d);
    return d;
  }

  function relabel(d) {
    const name = t(d.titleKey);
    d.pane.setAttribute('aria-label', name);
    d.btn.querySelector('.ws-btn-l').textContent = name;
    d.btn.title = t(!popout && popoutDefault() ? 'ws.openWin' : 'ws.open', { name });
    d.btn.setAttribute('aria-label', name);
    d.tab.querySelector('.ws-tab-l').textContent = name;
    d.tab.title = name;
  }

  function relabelChrome() {
    popBtn.title = t('ws.popout');
    popBtn.setAttribute('aria-label', t('ws.popout'));
    closeBtn.title = t('ws.close');
    closeBtn.setAttribute('aria-label', t('ws.close'));
    switcher.setAttribute('aria-label', t('ws.group'));
  }
  relabelChrome();

  function ensureBuilt(d) {
    if (d.built) return;
    d.built = true;
    d.mount?.(d.body, d.tools);
  }

  /** A launcher that only ever opens its own window (e.g. the read-only monitor), never a pane. */
  const links = [];
  function link(id, def) {
    const btn = h('button', { class: 'ws-btn', type: 'button', 'data-ws': id, onclick: () => {
      const w = window.open(`${location.pathname}?ws=${encodeURIComponent(id)}`, `objitter-ws-${id}`, 'popup=yes,width=1280,height=860');
      if (!w) toast(t('ws.popBlockedLink'), 'warn');
    } }, icon(def.icon), h('span', { class: 'ws-btn-l' }));
    launchBar?.append(btn);
    const l = { id, btn, titleKey: def.titleKey };
    links.push(l);
    relabelLink(l);
  }
  function relabelLink(l) {
    const name = t(l.titleKey);
    l.btn.querySelector('.ws-btn-l').textContent = name;
    l.btn.title = t('ws.openWinOnly', { name });
    l.btn.setAttribute('aria-label', name);
  }

  /** Old workspace ids (output, tc, stage) now live as pages inside another workspace. */
  function alias(id, to, page) {
    aliases.set(id, { to, page });
  }

  function open(id) {
    const a = aliases.get(id);
    if (a) {
      const ok = open(a.to);
      if (ok) defs.get(a.to).select?.(a.page);
      return ok;
    }
    const d = defs.get(id);
    if (!d) return false;
    if (cur === d) return true;
    if (cur) hidePane(cur);
    ensureBuilt(d);
    cur = d;
    layer.hidden = false;
    d.pane.hidden = false;
    d.tools.hidden = false;
    document.body.classList.add('ws-open');
    for (const x of defs.values()) {
      x.btn.classList.toggle('on', x === d);
      x.tab.setAttribute('aria-selected', String(x === d));
    }
    if (popout) {
      document.title = `${t(d.titleKey)} — Objitter`;
      const keep = new URLSearchParams(location.search);
      keep.set('ws', id);
      history.replaceState(null, '', `?${keep}`);
    }
    d.onShow?.();
    return true;
  }

  function hidePane(d) {
    d.pane.hidden = true;
    d.tools.hidden = true;
    d.onHide?.();
  }

  function close() {
    if (!cur || popout) return false;
    hidePane(cur);
    cur.btn.classList.remove('on');
    cur.tab.setAttribute('aria-selected', 'false');
    const was = cur;
    cur = null;
    layer.hidden = true;
    document.body.classList.remove('ws-open');
    if (!document.activeElement || document.activeElement === document.body || layer.contains(document.activeElement)) was.btn.focus();
    return true;
  }

  const popoutDefault = () => localStorage.getItem(LS_POPOUT) !== '0';
  function setPopoutDefault(on) {
    localStorage.setItem(LS_POPOUT, on ? '1' : '0');
    relabelAll();
  }

  /** Launcher click: own window by default (Shift = inside this window); falls back in-app when blocked. */
  function launch(id, e) {
    if (popout || e?.shiftKey || !popoutDefault()) { toggle(id); return; }
    if (popOut(id)) return;
    toast(t('ws.popBlocked'), 'warn');
    open(id);
  }

  function relabelAll() {
    for (const d of defs.values()) relabel(d);
  }

  function toggle(id) {
    if (cur?.id === id && !popout) close();
    else open(id);
  }

  function popOut(id, extra = '') {
    const a = aliases.get(id);
    if (a) return popOut(a.to, `&tab=${encodeURIComponent(a.page)}`);
    const w = window.open(`${location.pathname}?ws=${encodeURIComponent(id)}${extra}`, `objitter-ws-${id}`, 'popup=yes,width=1440,height=900');
    if (!w) return false;
    if (cur?.id === id) close();
    return true;
  }

  function relang() {
    relabelChrome();
    for (const l of links) relabelLink(l);
    for (const d of defs.values()) {
      relabel(d);
      if (d.built && d.relang) d.relang();
    }
    if (popout && cur) document.title = `${t(cur.titleKey)} — Objitter`;
  }

  /** Keys go to the open workspace first; returns true when it consumed the key. */
  function onKey(e) {
    return !!cur?.onKey?.(e);
  }

  function boot() {
    if (popout && (defs.has(popout) || aliases.has(popout))) open(popout);
    else if (popout) document.body.classList.remove('ws-only');
  }

  return {
    register, link, alias, open, close, toggle, launch, popOut, relang, onKey, boot, popoutDefault, setPopoutDefault,
    current: () => cur?.id ?? null,
    isOpen: (id) => cur?.id === id,
    popout,
    get: (id) => defs.get(id),
  };
}
