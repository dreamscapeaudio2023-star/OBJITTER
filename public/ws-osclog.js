// Setup → OSC log: incoming control messages and outgoing renderer traffic. The server only
// collects while this page is visible and samples each address to a few lines per second.
import { h, on, send, segEl, setSeg } from './core.js';
import { t } from './i18n.js';

const MAX_ROWS = 500;

export function createOscLog() {
  let shown = false;
  let paused = false;
  let dir = 'all';
  let query = '';
  let entries = [];
  let held = [];
  const els = {};

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const clock = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  const matches = (e) => (dir === 'all' || e.dir === dir || (dir === 'in' && e.dir === 'deny'))
    && (!query || e.addr.toLowerCase().includes(query) || e.peer.includes(query) || e.args.toLowerCase().includes(query));

  function row(e) {
    return h('div', { class: `olog-row olog-${e.dir}` },
      h('span', { class: 'olog-t mono' }, clock(e.t)),
      h('span', { class: 'olog-dir' }, t(`log.dir.${e.dir}`)),
      h('span', { class: 'olog-peer mono', title: e.peer }, e.peer),
      h('span', { class: 'olog-addr mono', title: e.addr }, e.addr),
      h('span', { class: 'olog-args mono', title: e.args }, e.args),
      h('span', { class: 'olog-skip mono', title: e.skip ? t('log.skip.title', { n: e.skip }) : '' }, e.skip ? `+${e.skip}` : ''));
  }

  function renderAll() {
    if (!els.list) return;
    const vis = entries.filter(matches);
    els.list.replaceChildren(...vis.slice(-MAX_ROWS).map(row));
    els.empty.hidden = vis.length > 0;
    els.count.textContent = t('log.count', { n: vis.length });
    stick();
  }

  function append(list) {
    const atBottom = nearBottom();
    const vis = list.filter(matches);
    if (vis.length) {
      els.list.append(...vis.map(row));
      while (els.list.childElementCount > MAX_ROWS) els.list.firstElementChild.remove();
      els.empty.hidden = true;
    }
    els.count.textContent = t('log.count', { n: entries.filter(matches).length });
    if (atBottom) stick();
  }

  const nearBottom = () => !els.scroll || els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 40;
  const stick = () => { if (els.scroll) els.scroll.scrollTop = els.scroll.scrollHeight; };

  function onLog(m) {
    if (m.reset) entries = [];
    const add = m.entries ?? [];
    if (paused) { held.push(...add); return; }
    entries.push(...add);
    if (entries.length > MAX_ROWS) entries.splice(0, entries.length - MAX_ROWS);
    if (m.reset) renderAll();
    else if (els.list) append(add);
  }

  function setPaused(p) {
    paused = p;
    els.pause.setAttribute('aria-pressed', String(p));
    els.pause.textContent = p ? t('log.resume') : t('log.pause');
    if (!p && held.length) {
      entries.push(...held);
      held = [];
      if (entries.length > MAX_ROWS) entries.splice(0, entries.length - MAX_ROWS);
      renderAll();
    }
  }

  function buildTools(tools) {
    els.dirSeg = segEl([['all', t('log.all')], ['in', t('log.dir.in')], ['out', t('log.dir.out')]], (v) => { dir = v; setSeg(els.dirSeg, v); renderAll(); });
    setSeg(els.dirSeg, dir);
    els.search = h('input', { type: 'search', class: 'olog-search', placeholder: t('log.search'), 'aria-label': t('log.search'), value: query });
    els.search.addEventListener('input', () => { query = els.search.value.trim().toLowerCase(); renderAll(); });
    els.pause = h('button', { type: 'button', class: 'btn-ghost', 'aria-pressed': String(paused), onclick: () => setPaused(!paused) }, paused ? t('log.resume') : t('log.pause'));
    const clear = h('button', { type: 'button', class: 'btn-ghost', onclick: () => { entries = []; held = []; renderAll(); } }, t('log.clear'));
    els.count = h('span', { class: 'muted olog-count' });
    tools.append(els.dirSeg, els.search, els.pause, clear, els.count);
  }

  function mount(body, tools) {
    els.tools = tools;
    els.list = h('div', { class: 'olog-list', role: 'log', 'aria-live': 'off' });
    els.empty = h('p', { class: 'empty olog-empty' }, t('log.empty'));
    els.hint = h('p', { class: 'hint olog-hint' }, t('log.hint'));
    els.head = h('div', { class: 'olog-row olog-head' },
      ...['log.col.time', 'log.col.dir', 'log.col.peer', 'log.col.addr', 'log.col.args', 'log.col.skip'].map((k) => h('span', {}, t(k))));
    els.scroll = h('div', { class: 'ws-scroll olog-scroll' }, els.hint, els.head, els.empty, els.list);
    body.append(els.scroll);
    buildTools(tools);
    on('osclog', onLog);
    on('init', () => { if (shown) send({ type: 'osclog.sub', on: true }); });
    renderAll();
  }

  return {
    mount,
    onShow() {
      shown = true;
      send({ type: 'osclog.sub', on: true });
    },
    onHide() {
      shown = false;
      send({ type: 'osclog.sub', on: false });
    },
    relang() {
      if (!els.tools) return;
      els.tools.replaceChildren();
      buildTools(els.tools);
      els.empty.textContent = t('log.empty');
      els.hint.textContent = t('log.hint');
      ['log.col.time', 'log.col.dir', 'log.col.peer', 'log.col.addr', 'log.col.args', 'log.col.skip'].forEach((k, i) => { els.head.children[i].textContent = t(k); });
      renderAll();
    },
  };
}
