// Setup workspace: system-level pages (Output, Timecode, Stage, OSC log, System) behind one
// tab row. Each page keeps its own toolbar; only the active page's toolbar is shown.
import { h, icon } from './core.js';
import { t } from './i18n.js';

const LS_TAB = 'objitter.setupTab';

export function createSetup(pages, { popout } = {}) {
  const byId = new Map(pages.map((p) => [p.id, { ...p, el: null, tools: null, tab: null }]));
  let cur = null;
  let shown = false;
  let tabBar = null;

  function mount(body, tools) {
    tabBar = h('div', { class: 'setup-tabs', role: 'tablist' });
    const panes = h('div', { class: 'setup-panes' });
    body.classList.add('setup-body');
    body.append(tabBar, panes);
    for (const p of byId.values()) {
      p.tab = h('button', {
        class: 'setup-tab', type: 'button', role: 'tab', 'aria-selected': 'false', id: `setup-tab-${p.id}`,
        onclick: () => select(p.id), onkeydown: tabKey,
      }, icon(p.icon), h('span', { class: 'setup-tab-l' }));
      p.el = h('div', { class: 'setup-pane', role: 'tabpanel', hidden: true, 'aria-labelledby': `setup-tab-${p.id}` });
      p.tools = h('div', { class: 'setup-tools', hidden: true });
      tabBar.append(p.tab);
      panes.append(p.el);
      tools.append(p.tools);
      p.mount(p.el, p.tools);
    }
    relabel();
    const want = new URLSearchParams(location.search).get('tab');
    select(byId.has(want) ? want : byId.has(localStorage.getItem(LS_TAB)) ? localStorage.getItem(LS_TAB) : pages[0].id);
  }

  function tabKey(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const ids = [...byId.keys()];
    const i = ids.indexOf(cur?.id);
    const n = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    select(n);
    byId.get(n).tab.focus();
  }

  function select(id) {
    const p = byId.get(id);
    if (!p || !p.el) return;
    if (cur === p) return;
    if (cur) {
      cur.el.hidden = true;
      cur.tools.hidden = true;
      cur.tab.setAttribute('aria-selected', 'false');
      cur.tab.tabIndex = -1;
      if (shown) cur.onHide?.();
    }
    cur = p;
    p.el.hidden = false;
    p.tools.hidden = false;
    p.tab.setAttribute('aria-selected', 'true');
    p.tab.tabIndex = 0;
    localStorage.setItem(LS_TAB, id);
    if (popout) history.replaceState(null, '', `?ws=setup&tab=${encodeURIComponent(id)}`);
    if (shown) p.onShow?.();
  }

  function relabel() {
    tabBar?.setAttribute('aria-label', t('ws.setup'));
    for (const p of byId.values()) {
      if (!p.tab) continue;
      p.tab.querySelector('.setup-tab-l').textContent = t(p.titleKey);
      p.tab.title = t(p.titleKey);
    }
  }

  return {
    mount,
    select,
    current: () => cur?.id ?? null,
    onShow() { shown = true; cur?.onShow?.(); },
    onHide() { shown = false; cur?.onHide?.(); },
    onKey: (e) => !!cur?.onKey?.(e),
    relang() {
      relabel();
      for (const p of byId.values()) p.relang?.();
    },
  };
}
