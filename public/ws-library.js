// Object library: saved motion settings in folders (server library/). Lives in the side panel's
// Library tab — in the main window it applies to the selection, in the object window to that object.
import { h, icon, store, on, send, guardEdit, toast, isLocked, armButton, objColor } from './core.js';
import { t } from './i18n.js';

const LS_OPEN = 'objitter.libOpen';

export function createLibrary({ openModal, selectedIds, modeName }) {
  let root = null;
  let query = '';
  const open = new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '[]'));
  const lib = () => store.LIB ?? { folders: [], items: [] };
  const saveOpen = () => localStorage.setItem(LS_OPEN, JSON.stringify([...open]));

  function mount(el) {
    root = el;
    on('library', render);
    on('init', render);
    on('lang', render);
    on('selection', renderHead);
    let wasLocked = isLocked();
    on('state', () => {
      if (isLocked() !== wasLocked) { wasLocked = isLocked(); render(); } else renderHead();
    });
    render();
  }

  // ---------------- save dialog ----------------
  function openSave(preset = {}) {
    if (!guardEdit()) return;
    const ids = selectedIds();
    if (ids.length !== 1) { toast(t('lib.pickOne'), 'warn'); return; }
    const id = ids[0];
    const o = store.OBJ?.[id - 1];
    const name = h('input', { type: 'text', maxLength: 64, value: preset.name ?? `${o?.name ?? `Obj ${id}`} ${modeName(o?.mode)}`.trim(), 'aria-label': t('lib.name') });
    const folder = h('select', { 'aria-label': t('lib.folder') },
      h('option', { value: '' }, t('lib.root')),
      ...lib().folders.map((f) => h('option', { value: f, selected: f === preset.folder }, f)));
    const newFolder = h('input', { type: 'text', maxLength: 64, placeholder: t('lib.newFolder.ph'), 'aria-label': t('lib.newFolder') });
    const region = h('input', { type: 'checkbox' });
    const note = h('input', { type: 'text', maxLength: 200, placeholder: t('lib.note.ph'), 'aria-label': t('lib.note') });
    const save = () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      const nf = newFolder.value.trim();
      const f = nf ? (folder.value ? `${folder.value}/${nf}` : nf) : folder.value;
      if (send({ type: 'lib.save', id, name: n, folder: f, includeRegion: region.checked, note: note.value.trim() })) m.close();
    };
    for (const el of [name, newFolder, note]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(); });
    const m = openModal({
      title: t('lib.saveTitle', { id }),
      cls: 'lib-modal',
      body: [
        h('div', { class: 'lib-from', style: `--c:${objColor(id, 1)}` }, h('i', { class: 'objwin-dot' }), `#${id} ${o?.name ?? ''} · ${modeName(o?.mode)}`),
        h('label', { class: 'lib-field' }, h('span', {}, t('lib.name')), name),
        h('label', { class: 'lib-field' }, h('span', {}, t('lib.folder')), folder),
        h('label', { class: 'lib-field' }, h('span', {}, t('lib.newFolder')), newFolder),
        h('label', { class: 'chk' }, region, t('lib.includeRegion')),
        h('p', { class: 'hint' }, t('lib.includeRegion.hint')),
        h('label', { class: 'lib-field' }, h('span', {}, t('lib.note')), note),
      ],
      actions: [
        h('button', { type: 'button', onclick: () => m.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'accent', onclick: save }, t('lib.save')),
      ],
    });
    name.focus();
    name.select();
  }

  function openMove(it) {
    if (!guardEdit()) return;
    const name = h('input', { type: 'text', maxLength: 64, value: it.name, 'aria-label': t('lib.name') });
    const folder = h('select', { 'aria-label': t('lib.folder') },
      h('option', { value: '' }, t('lib.root')),
      ...lib().folders.map((f) => h('option', { value: f, selected: f === it.folder }, f)));
    const go = () => {
      if (send({ type: 'lib.move', path: it.path, folder: folder.value, name: name.value.trim() || it.name })) m.close();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    const m = openModal({
      title: t('lib.moveTitle', { name: it.name }),
      cls: 'lib-modal',
      body: [h('label', { class: 'lib-field' }, h('span', {}, t('lib.name')), name), h('label', { class: 'lib-field' }, h('span', {}, t('lib.folder')), folder)],
      actions: [h('button', { type: 'button', onclick: () => m.close() }, t('common.cancel')), h('button', { type: 'button', class: 'accent', onclick: go }, t('common.ok'))],
    });
    name.focus();
  }

  function openNewFolder(parent = '') {
    if (!guardEdit()) return;
    const name = h('input', { type: 'text', maxLength: 64, 'aria-label': t('lib.folderName') });
    const go = () => {
      const n = name.value.trim();
      if (!n) return;
      const p = parent ? `${parent}/${n}` : n;
      open.add(p);
      if (parent) open.add(parent);
      saveOpen();
      if (send({ type: 'lib.folder.add', path: p })) m.close();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    const m = openModal({
      title: parent ? t('lib.subfolderTitle', { name: parent }) : t('lib.newFolder'),
      cls: 'lib-modal',
      body: [h('label', { class: 'lib-field' }, h('span', {}, t('lib.folderName')), name)],
      actions: [h('button', { type: 'button', onclick: () => m.close() }, t('common.cancel')), h('button', { type: 'button', class: 'accent', onclick: go }, t('lib.create'))],
    });
    name.focus();
  }

  // ---------------- list ----------------
  function apply(it) {
    const ids = selectedIds();
    if (!ids.length) { toast(t('srv.noSelection'), 'warn'); return; }
    send({ type: 'lib.apply', path: it.path, ids });
  }

  function itemRow(it) {
    const del = armButton(h('button', { type: 'button', class: 'danger btn-ghost lib-del ed', title: t('common.delete'), 'aria-label': t('lib.deleteAria', { name: it.name }) }, '✕'),
      () => send({ type: 'lib.delete', path: it.path }));
    return h('div', { class: 'lib-item', title: [it.path, it.note].filter(Boolean).join(' — ') },
      h('button', { type: 'button', class: 'lib-apply', onclick: () => apply(it), title: t('lib.apply.title') },
        h('span', { class: 'lib-name' }, it.name),
        h('span', { class: 'lib-badges' }, h('span', { class: 'badge note' }, modeName(it.mode)), it.includeRegion ? h('span', { class: 'badge note' }, t('lib.regionBadge')) : null)),
      h('button', { type: 'button', class: 'btn-ghost lib-mv ed', title: t('lib.move'), 'aria-label': t('lib.move'), onclick: () => openMove(it) }, '⋯'),
      del);
  }

  function folderNode(path, depth, items, folders) {
    const name = path.split('/').pop();
    const isOpen = open.has(path) || !!query;
    const kids = folders.filter((f) => f.startsWith(`${path}/`) && f.split('/').length === depth + 2);
    const mine = items.filter((it) => it.folder === path);
    const count = items.filter((it) => it.folder === path || it.folder.startsWith(`${path}/`)).length;
    if (query && !count) return null;
    const toggle = () => {
      if (open.has(path)) open.delete(path); else open.add(path);
      saveOpen();
      render();
    };
    const del = armButton(h('button', { type: 'button', class: 'danger btn-ghost lib-del ed', title: t('lib.deleteFolder'), 'aria-label': t('lib.deleteFolder') }, '✕'),
      () => send({ type: 'lib.folder.delete', path }));
    return h('div', { class: 'lib-folder', style: `--d:${depth}` },
      h('div', { class: 'lib-folder-row' },
        h('button', { type: 'button', class: 'lib-folder-btn', 'aria-expanded': String(isOpen), onclick: toggle },
          h('span', { class: 'lib-caret', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'), h('span', { class: 'lib-folder-name' }, name), h('span', { class: 'muted' }, String(count))),
        h('button', { type: 'button', class: 'btn-ghost lib-mv ed', title: t('lib.subfolder'), 'aria-label': t('lib.subfolder'), onclick: () => openNewFolder(path) }, '+'),
        del),
      isOpen ? h('div', { class: 'lib-children' }, ...kids.map((k) => folderNode(k, depth + 1, items, folders)).filter(Boolean), ...mine.map(itemRow)) : null);
  }

  function renderHead() {
    if (!root) return;
    const head = root.querySelector('.lib-head-target');
    if (!head) return;
    const ids = selectedIds();
    head.textContent = ids.length ? t('lib.target', { ids: ids.length > 6 ? `${ids.slice(0, 6).join(', ')}…` : ids.join(', ') }) : t('lib.noTarget');
    const saveBtn = root.querySelector('.lib-save-btn');
    if (saveBtn) saveBtn.disabled = ids.length !== 1 || isLocked();
  }

  function render() {
    if (!root) return;
    const { folders, items } = lib();
    const q = query.toLowerCase();
    const vis = q ? items.filter((it) => it.path.toLowerCase().includes(q) || (it.note ?? '').toLowerCase().includes(q)) : items;
    const search = h('input', { type: 'search', class: 'lib-search', placeholder: t('lib.search'), 'aria-label': t('lib.search'), value: query });
    search.addEventListener('input', () => {
      query = search.value.trim();
      const pos = search.selectionStart;
      render();
      const s = root.querySelector('.lib-search');
      s.focus();
      s.setSelectionRange(pos, pos);
    });
    const tops = folders.filter((f) => !f.includes('/'));
    const tree = [...tops.map((f) => folderNode(f, 0, vis, folders)).filter(Boolean), ...vis.filter((it) => !it.folder).map(itemRow)];
    root.replaceChildren(
      h('div', { class: 'lib-head' },
        h('span', { class: 'lib-head-target muted' }),
        h('div', { class: 'btn-row two' },
          h('button', { type: 'button', class: 'accent icon-l lib-save-btn ed', title: t('lib.saveBtn.title'), onclick: () => openSave() }, icon('library'), t('lib.saveBtn')),
          h('button', { type: 'button', class: 'ed', onclick: () => openNewFolder('') }, t('lib.newFolder')))),
      search,
      h('div', { class: 'lib-tree', role: 'tree' }, ...(tree.length ? tree : [h('p', { class: 'empty' }, items.length ? t('lib.noMatch') : t('lib.empty'))])),
      h('p', { class: 'hint' }, t('lib.hint')));
    renderHead();
    if (isLocked()) for (const el of root.querySelectorAll('.ed')) el.disabled = true;
  }

  return { mount, render, openSave };
}
