// Stage Setup workspace: background image (plan / photo) and speaker layout (SPAT, L-ISA, CSV/QLab)
// placed under the objects. Preview on the left, controls on the right.
import { $, h, icon, store, on, send, guardEdit, toast, isLocked, clamp, objColor, toggleEl, segEl, setSeg, armButton } from './core.js';
import { t, tm } from './i18n.js';
import { drawBackground, drawSpeakers, speakerToStage, layoutExtent, onImageLoad, groupColor } from './stage-draw.js';

const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_LAYOUT = 64 * 1024 * 1024;
const r2 = (v) => Math.round(v * 100) / 100;

/** Inverse of speakerToStage: normalized stage point → layout metres. */
function stageToMeters(sx, sy, tf) {
  const k = tf.metersPerUnit || 1;
  let x = (sx - tf.offsetX) * k;
  let y = (sy - tf.offsetY) * k;
  const a = ((tf.rotation || 0) * Math.PI) / 180;
  if (a) [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  if (tf.mirrorX) x = -x;
  return { x, y };
}

export function createStageSetup() {
  const els = {};
  let canvas = null;
  let dirty = true;
  let raf = 0;
  let shown = false;
  let zoom = 1.3;
  let dragMode = 'image';
  let drag = null;
  let pending = null;
  let sendTimer = null;
  let importText = null;
  let hoverIdx = null;
  let selSp = null;
  let spTimer = null;
  let spPending = null;

  const stg = () => store.stage;

  // ---------------- sending (throttled while dragging sliders) ----------------
  function queue(patch) {
    if (!guardEdit()) return;
    pending = merge(pending ?? {}, patch);
    if (sendTimer) return;
    sendTimer = setTimeout(flush, 60);
  }
  function flush() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!pending) return;
    send({ type: 'stage.set', patch: pending });
    pending = null;
  }
  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v;
    return out;
  }
  /** Local echo so the preview follows the pointer before the server answers. */
  function applyLocal(patch) {
    const s = stg();
    if (!s) return;
    if (patch.background) Object.assign(s.background, patch.background);
    if (patch.speakers?.transform) Object.assign(s.speakers.transform, patch.speakers.transform);
    if (patch.speakers && 'labels' in patch.speakers) s.speakers.labels = patch.speakers.labels;
    dirty = true;
    emitMainRedraw();
  }
  const emitMainRedraw = () => window.dispatchEvent(new CustomEvent('objitter:stage-local'));
  const edit = (patch) => {
    if (!guardEdit()) return;
    applyLocal(patch);
    queue(patch);
  };

  // ---------------- controls ----------------
  function rangeRow(id, label, min, max, step, get, set, fmt = (v) => v.toFixed(2)) {
    const r = h('input', { type: 'range', id, min, max, step, class: 'ed' });
    const n = h('input', { type: 'number', min, max, step, class: 'ed num', 'aria-label': label });
    const upd = (v) => {
      const x = clamp(Number(v), Number(min), Number(max));
      if (!Number.isFinite(x)) return;
      set(x);
    };
    r.addEventListener('input', () => { n.value = fmt(Number(r.value)); upd(r.value); });
    n.addEventListener('change', () => upd(n.value));
    const row = h('div', { class: 'row' }, h('label', { for: id }, label), h('div', { class: 'ctl' }, r, n));
    row._sync = () => {
      const v = get();
      if (v === undefined || v === null) return;
      if (document.activeElement !== r) r.value = v;
      if (document.activeElement !== n) n.value = fmt(Number(v));
    };
    return row;
  }

  let host = null;
  let ro = null;
  function mount(body, tools) {
    host = { body, tools };
    body.classList.add('stage-body');
    build(body, tools);
    on('stage', () => { render(); dirty = true; });
    on('init', () => { render(); dirty = true; });
    on('state', renderLock);
    on('stage.speaker.added', (m) => { selSp = m.index; listSig = ''; renderList(); dirty = true; });
    on('pos', () => { if (shown) dirty = true; });
    onImageLoad(() => { dirty = true; render(); });
    render();
  }

  function relang() {
    if (!host) return;
    host.body.replaceChildren();
    host.tools.replaceChildren();
    listSig = '';
    build(host.body, host.tools);
    render();
    dirty = true;
  }

  function build(body, tools) {
    canvas = h('canvas', { class: 'stage-preview', 'aria-label': t('stg.preview') });
    const dragSeg = segEl([['image', t('stg.drag.image')], ['speakers', t('stg.drag.speakers')]], (v) => { dragMode = v; setSeg(dragSeg, v); });
    setSeg(dragSeg, dragMode);
    els.dragSeg = dragSeg;
    const zoomOut = h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomOut'), onclick: () => setZoom(zoom * 1.25) }, '−');
    const zoomIn = h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomIn'), onclick: () => setZoom(zoom / 1.25) }, '+');
    const zoomFit = h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomFit'), onclick: () => setZoom(1.3) }, '1:1');
    tools.append(h('span', { class: 'muted ws-tool-l' }, t('stg.drag')), dragSeg, h('span', { class: 'ws-sep' }), zoomOut, zoomFit, zoomIn);

    const preview = h('div', { class: 'stage-prev-wrap' }, canvas, h('div', { class: 'stage-prev-hint muted' }, t('stg.preview.hint')));

    // background
    const imgFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => upload(imgFile) });
    const imgBtn = h('button', { class: 'accent ed icon-l', type: 'button', onclick: () => { if (guardEdit()) imgFile.click(); } }, icon('image'), t('stg.bg.load'));
    const imgName = h('span', { class: 'stage-file muted' });
    const imgDel = armButton(h('button', { class: 'danger ed', type: 'button' }, t('common.delete')), () => send({ type: 'stage.clear', what: 'background' }));
    const bgP = (k) => () => stg()?.background[k];
    const bgSet = (k) => (v) => edit({ background: { [k]: v } });
    const bgRows = [
      rangeRow('stg-bg-scale', t('stg.bg.scale'), 0.1, 6, 0.01, bgP('scale'), bgSet('scale')),
      rangeRow('stg-bg-x', t('stg.bg.x'), -2, 2, 0.01, bgP('x'), bgSet('x')),
      rangeRow('stg-bg-y', t('stg.bg.y'), -2, 2, 0.01, bgP('y'), bgSet('y')),
      rangeRow('stg-bg-rot', t('stg.bg.rot'), -180, 180, 0.5, bgP('rotation'), bgSet('rotation'), (v) => v.toFixed(1)),
      rangeRow('stg-bg-op', t('stg.bg.opacity'), 0, 1, 0.01, bgP('opacity'), bgSet('opacity')),
    ];
    const bgReset = h('button', { class: 'ed', type: 'button', onclick: () => edit({ background: { x: 0, y: 0, scale: 1, rotation: 0 } }) }, t('stg.bg.reset'));
    els.bgBox = h('div', { class: 'stage-sub' }, ...bgRows, h('div', { class: 'btn-row' }, bgReset));

    // speakers
    const layFile = h('input', { type: 'file', accept: '.json,.lisa,.csv,.tsv,.txt,application/json,text/csv,text/xml', hidden: true, onchange: () => pickLayout(layFile) });
    const layBtn = h('button', { class: 'accent ed icon-l', type: 'button', onclick: () => { if (guardEdit()) layFile.click(); } }, icon('layout-import'), t('stg.sp.import'));
    const layName = h('span', { class: 'stage-file muted' });
    const layDel = armButton(h('button', { class: 'danger ed', type: 'button' }, t('common.delete')), () => send({ type: 'stage.clear', what: 'speakers' }));
    const addSp = (kind) => {
      if (!guardEdit()) return;
      const s = stg();
      const tf = s?.speakers.transform;
      const n = s?.speakers.items.length ?? 0;
      const p = n ? stageToMeters(((n % 5) - 2) * 0.15, kind === 'sub' ? 0.6 : 0.4, tf) : { x: 0, y: 2 };
      if (!send({ type: 'stage.speaker.add', kind, x: r2(p.x), y: r2(p.y), z: 0 })) return;
      dragMode = 'speakers';
      setSeg(els.dragSeg, dragMode);
    };
    const addMain = h('button', { class: 'ed icon-l', type: 'button', title: t('stg.sp.add.title'), onclick: () => addSp('main') }, icon('speaker'), t('stg.sp.add'));
    const addSub = h('button', { class: 'ed icon-l', type: 'button', title: t('stg.sp.addSub.title'), onclick: () => addSp('sub') }, icon('sub'), t('stg.sp.addSub'));
    const tfP = (k) => () => stg()?.speakers.transform[k];
    const tfSet = (k) => (v) => edit({ speakers: { transform: { [k]: v } } });
    const spRows = [
      rangeRow('stg-sp-mpu', t('stg.sp.mpu'), 0.2, 60, 0.05, tfP('metersPerUnit'), tfSet('metersPerUnit'), (v) => v.toFixed(2)),
      rangeRow('stg-sp-x', t('stg.sp.x'), -2, 2, 0.01, tfP('offsetX'), tfSet('offsetX')),
      rangeRow('stg-sp-y', t('stg.sp.y'), -2, 2, 0.01, tfP('offsetY'), tfSet('offsetY')),
      rangeRow('stg-sp-rot', t('stg.sp.rot'), -180, 180, 0.5, tfP('rotation'), tfSet('rotation'), (v) => v.toFixed(1)),
    ];
    const [mirT, mir] = toggleEl('stg-sp-mirror', (e) => edit({ speakers: { transform: { mirrorX: e.target.checked } } }));
    const [labT, lab] = toggleEl('stg-sp-labels', (e) => edit({ speakers: { labels: e.target.checked } }));
    mir.classList.add('ed');
    lab.classList.add('ed');
    const fit = h('button', { class: 'ed', type: 'button', title: t('stg.sp.fit.title'), onclick: fitLayout }, t('stg.sp.fit'));
    const spList = h('div', { class: 'stage-sp-list' });
    els.spBox = h('div', { class: 'stage-sub' }, spRows[0],
      h('p', { class: 'hint' }, t('stg.sp.mpu.hint')),
      ...spRows.slice(1),
      h('div', { class: 'row' }, h('label', { for: 'stg-sp-mirror' }, t('stg.sp.mirror')), h('div', { class: 'ctl' }, mirT)),
      h('div', { class: 'row' }, h('label', { for: 'stg-sp-labels' }, t('stg.sp.labels')), h('div', { class: 'ctl' }, labT)),
      h('div', { class: 'btn-row' }, fit),
      spList);
    const roomPick = h('div', { class: 'card stage-rooms', hidden: true });

    const panel = h('div', { class: 'stage-panel ws-scroll' },
      h('div', { class: 'section' }, icon('image', 'sec-ico'), t('stg.bg')),
      h('div', { class: 'stage-file-row' }, imgBtn, imgDel, imgFile),
      imgName,
      h('p', { class: 'hint' }, t('stg.bg.hint')),
      els.bgBox,
      h('div', { class: 'section' }, icon('speaker', 'sec-ico'), t('stg.sp')),
      h('div', { class: 'stage-file-row' }, layBtn, layDel, layFile),
      layName,
      h('div', { class: 'btn-row two' }, addMain, addSub),
      roomPick,
      h('p', { class: 'hint' }, t('stg.sp.hint')),
      els.spBox,
      h('div', { class: 'stage-legend' },
        h('span', {}, icon('speaker'), t('stg.legend.main')),
        h('span', {}, icon('sub'), t('stg.legend.sub')),
        h('span', { class: 'muted' }, t('stg.legend.elev'))));
    body.append(preview, panel);
    Object.assign(els, { imgName, imgDel, layName, layDel, bgRows, spRows, mir, lab, spList, roomPick, panel, imgBtn, layBtn, fit });

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (hoverIdx !== null) { hoverIdx = null; dirty = true; } });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
    ro?.disconnect();
    ro = new ResizeObserver(() => { dirty = true; });
    ro.observe(canvas);
  }

  function setZoom(z) {
    zoom = clamp(z, 0.4, 12);
    dirty = true;
  }

  // ---------------- background upload ----------------
  async function upload(input) {
    const f = input.files?.[0];
    input.value = '';
    if (!f || !guardEdit()) return;
    if (f.size > MAX_UPLOAD) { toast(t('stg.bg.tooBig', { mb: 10 }), 'error'); return; }
    els.imgBtn.disabled = true;
    try {
      const res = await fetch('api/assets', { method: 'POST', headers: { 'X-Objitter': '1', 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(res.status === 415 ? t('stg.bg.badType') : res.status === 413 ? t('stg.bg.tooBig', { mb: 10 }) : res.status === 423 ? t('ui.lockedEdit') : t('stg.bg.failed', { code: res.status }), 'error');
        return;
      }
      send({ type: 'stage.set', patch: { background: { asset: j.id, name: f.name, x: 0, y: 0, scale: 1, rotation: 0, visible: true } } });
    } catch (err) {
      toast(t('stg.bg.failed', { code: err.message }), 'error');
    } finally {
      els.imgBtn.disabled = isLocked();
    }
  }

  // ---------------- layout import ----------------
  async function pickLayout(input) {
    const f = input.files?.[0];
    input.value = '';
    if (!f || !guardEdit()) return;
    if (f.size > MAX_LAYOUT) { toast(t('stg.sp.tooBig'), 'error'); return; }
    els.layBtn.disabled = true;
    try {
      const res = await fetch(`api/layout?filename=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-Objitter': '1', 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(res.status === 413 ? t('stg.sp.tooBig') : res.status === 423 ? t('ui.lockedEdit') : j.key || j.text ? tm(j) : t('stg.sp.failed', { code: res.status }), 'error');
        return;
      }
      importText = { token: j.token };
      onParsed(j);
    } catch (err) {
      toast(t('stg.sp.failed', { code: err.message }), 'error');
    } finally {
      els.layBtn.disabled = isLocked();
    }
  }

  function onParsed(m) {
    if (!importText) return;
    if (m.rooms.length === 1) {
      send({ type: 'stage.layout', ...importText, room: m.rooms[0].index });
      importText = null;
      els.roomPick.hidden = true;
      return;
    }
    let pick = m.rooms.reduce((a, r) => (r.count > a.count ? r : a), m.rooms[0]).index;
    const list = h('div', { class: 'room-list', role: 'radiogroup' }, m.rooms.map((r) => {
      const b = h('button', { type: 'button', class: 'room', role: 'radio', 'aria-checked': String(r.index === pick), onclick: () => {
        pick = r.index;
        for (const x of list.children) x.setAttribute('aria-checked', String(x === b));
      } },
      h('span', { class: 'room-n' }, r.name), h('span', { class: 'muted mono' }, t('stg.sp.roomCount', { n: r.count, subs: r.subs })));
      return b;
    }));
    els.roomPick.replaceChildren(
      h('div', { class: 'room-head' }, t('stg.sp.pickRoom', { file: m.filename, format: m.format.toUpperCase() })),
      list,
      h('div', { class: 'btn-row' },
        h('button', { class: 'accent', type: 'button', onclick: () => {
          send({ type: 'stage.layout', ...importText, room: pick });
          importText = null;
          els.roomPick.hidden = true;
        } }, t('stg.sp.importRoom')),
        h('button', { type: 'button', onclick: () => { importText = null; els.roomPick.hidden = true; } }, t('common.cancel'))));
    els.roomPick.hidden = false;
  }

  function fitLayout() {
    const s = stg();
    if (!s?.speakers.items.length) return;
    edit({ speakers: { transform: { metersPerUnit: Math.round(layoutExtent(s.speakers.items) * 1000) / 1000, offsetX: 0, offsetY: 0 } } });
  }

  // ---------------- render ----------------
  function render() {
    const s = stg();
    if (!s || !els.bgRows) return;
    const bg = s.background;
    els.imgName.textContent = bg.asset ? (bg.name || bg.asset) : t('stg.bg.none');
    els.imgDel.hidden = !bg.asset;
    els.bgBox.hidden = !bg.asset;
    for (const r of els.bgRows) r._sync();
    const sp = s.speakers;
    els.layName.textContent = sp.items.length ? t('stg.sp.loaded', { name: sp.name || '—', n: sp.items.length, src: (sp.source || '').toUpperCase() }) : t('stg.sp.none');
    els.layDel.hidden = !sp.items.length;
    els.spBox.hidden = !sp.items.length;
    for (const r of els.spRows) r._sync();
    els.mir.checked = !!sp.transform.mirrorX;
    els.lab.checked = sp.labels !== false;
    renderList();
    renderLock();
  }

  let listSig = '';
  function renderList() {
    const sp = stg()?.speakers;
    const items = sp?.items ?? [];
    if (selSp !== null && selSp >= items.length) selSp = null;
    const sig = JSON.stringify([items, selSp, isLocked()]);
    if (sig === listSig) return;
    if (els.spList.contains(document.activeElement) && document.activeElement.matches('input')) return;
    listSig = sig;
    if (!items.length) { els.spList.replaceChildren(); return; }
    const f = (v) => (Math.round(v * 100) / 100).toFixed(2);
    els.spList.replaceChildren(
      h('div', { class: 'sp-row sp-head' }, h('span', {}, '#'), h('span', {}, t('stg.sp.col.name')), h('span', {}, 'X'), h('span', {}, 'Y'), h('span', {}, 'Z'), h('span', {}, t('stg.sp.col.facing'))),
      ...items.flatMap((it, i) => {
        const row = h('div', {
          class: `sp-row${i === selSp ? ' on' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(i === selSp),
          onpointerenter: () => { hoverIdx = i; dirty = true; }, onpointerleave: () => { if (hoverIdx === i) { hoverIdx = null; dirty = true; } },
          onclick: () => selectSp(i === selSp ? null : i),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSp(i === selSp ? null : i); } },
        },
        h('span', { class: 'muted' }, String(i + 1)),
        h('span', { class: 'sp-name' }, h('i', { class: 'sp-sw', style: `--c:${groupColor(it)}` }), it.name, it.kind === 'sub' ? h('span', { class: 'badge' }, 'SUB') : null),
        h('span', { class: 'mono' }, f(it.x)), h('span', { class: 'mono' }, f(it.y)), h('span', { class: 'mono' }, f(it.z)),
        h('span', { class: 'mono muted' }, it.yaw === null ? t('stg.sp.facing.center') : `${Math.round(it.yaw)}°`));
        return i === selSp ? [row, spEditor(it, i)] : [row];
      }));
  }

  function selectSp(i) {
    selSp = i;
    listSig = '';
    renderList();
    dirty = true;
  }

  function spEditor(it, i) {
    const dis = isLocked();
    const upd = (patch) => { if (guardEdit()) send({ type: 'stage.speaker.update', index: i, patch }); };
    const numIn = (k, label) => {
      const el = h('input', { type: 'number', class: 'ed mono', step: 0.01, min: -1000, max: 1000, value: it[k], disabled: dis, 'aria-label': label });
      el.addEventListener('change', () => {
        const v = Number(el.value);
        if (el.value === '' || !Number.isFinite(v)) { el.value = it[k]; return; }
        upd({ [k]: r2(v) });
      });
      return h('label', { class: 'sp-ed-f' }, h('span', {}, label), el);
    };
    const name = h('input', { type: 'text', class: 'ed', maxLength: 40, value: it.name, disabled: dis, 'aria-label': t('stg.sp.col.name') });
    name.addEventListener('change', () => { if (name.value.trim()) upd({ name: name.value.trim() }); else name.value = it.name; });
    const kind = h('select', { class: 'ed', disabled: dis, 'aria-label': t('stg.sp.kind') },
      h('option', { value: 'main', selected: it.kind !== 'sub' }, t('stg.legend.main')), h('option', { value: 'sub', selected: it.kind === 'sub' }, t('stg.legend.sub')));
    kind.addEventListener('change', () => upd({ kind: kind.value }));
    const yaw = h('input', { type: 'number', class: 'ed mono', step: 1, min: -180, max: 180, value: it.yaw ?? '', placeholder: t('stg.sp.facing.center'), disabled: dis, 'aria-label': t('stg.sp.col.facing') });
    yaw.addEventListener('change', () => {
      if (yaw.value === '') { upd({ yaw: null }); return; }
      const v = Number(yaw.value);
      if (Number.isFinite(v)) upd({ yaw: v }); else yaw.value = it.yaw ?? '';
    });
    for (const el of [name, yaw]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) el.blur(); });
    const del = armButton(h('button', { type: 'button', class: 'danger ed', disabled: dis }, t('common.delete')), () => {
      selSp = null;
      send({ type: 'stage.speaker.delete', index: i });
    });
    const box = h('div', { class: 'sp-edit' },
      h('label', { class: 'sp-ed-f wide' }, h('span', {}, t('stg.sp.col.name')), name),
      h('label', { class: 'sp-ed-f' }, h('span', {}, t('stg.sp.kind')), kind),
      numIn('x', 'X (m)'), numIn('y', 'Y (m)'), numIn('z', 'Z (m)'),
      h('label', { class: 'sp-ed-f' }, h('span', {}, t('stg.sp.col.facing')), yaw),
      h('div', { class: 'sp-ed-act' }, h('span', { class: 'hint' }, t('stg.sp.edit.hint')), del));
    box.addEventListener('click', (e) => e.stopPropagation());
    return box;
  }

  /** Moves one speaker locally while dragging; the server gets throttled updates. */
  function dragSpeaker(i, x, y) {
    const it = stg()?.speakers.items[i];
    if (!it) return;
    it.x = r2(x);
    it.y = r2(y);
    dirty = true;
    emitMainRedraw();
    spPending = { index: i, patch: { x: it.x, y: it.y } };
    if (!spTimer) spTimer = setTimeout(flushSp, 80);
  }
  function flushSp() {
    clearTimeout(spTimer);
    spTimer = null;
    if (spPending) send({ type: 'stage.speaker.update', ...spPending });
    spPending = null;
  }

  function renderLock() {
    if (!els.panel) return;
    const lk = isLocked();
    for (const el of els.panel.querySelectorAll('.ed')) el.disabled = lk;
    els.panel.classList.toggle('locked', lk);
  }

  // ---------------- preview canvas ----------------
  function mapping() {
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    const size = (Math.max(10, Math.min(w, hh) - 40)) / zoom;
    const cx = w / 2;
    const cy = hh / 2;
    return { size, cx, cy, w, h: hh, toPx: (x, y) => [cx + (x * size) / 2, cy - (y * size) / 2], fromPx: (px, py) => [((px - cx) * 2) / size, (-(py - cy) * 2) / size] };
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!dirty || !canvas || !shown) return;
    dirty = false;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (!w || !hh) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const m = mapping();
    const [x0, y0] = m.toPx(-1, 1);
    ctx.fillStyle = '#0d1119';
    ctx.fillRect(x0, y0, m.size, m.size);
    const s = stg();
    if (s) drawBackground(ctx, m, s.background);
    ctx.strokeStyle = 'rgba(42,51,70,.9)';
    ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i++) {
      const [a] = m.toPx(i / 4, 0);
      const [, b] = m.toPx(0, i / 4);
      ctx.globalAlpha = i === 0 ? 0.9 : 0.35;
      ctx.beginPath(); ctx.moveTo(a, y0); ctx.lineTo(a, y0 + m.size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, b); ctx.lineTo(x0 + m.size, b); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#3a4460';
    ctx.strokeRect(x0, y0, m.size, m.size);
    ctx.beginPath(); ctx.arc(m.cx, m.cy, m.size / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#8a95ad';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t('stg.front'), m.cx, y0 - 8);
    if (s) {
      const tf = s.speakers.transform;
      if (s.speakers.items.length) {
        const [ox, oy] = m.toPx(tf.offsetX, tf.offsetY);
        ctx.strokeStyle = 'rgba(245,215,110,.6)';
        ctx.beginPath(); ctx.moveTo(ox - 7, oy); ctx.lineTo(ox + 7, oy); ctx.moveTo(ox, oy - 7); ctx.lineTo(ox, oy + 7); ctx.stroke();
      }
      drawSpeakers(ctx, m, s.speakers, { font: '600 10px system-ui, sans-serif', highlight: hoverIdx ?? selSp, scale: 1.1 });
    }
    const pos = store.positions;
    store.OBJ.forEach((o, i) => {
      if (!o?.enabled) return;
      const p = pos[i] ?? [o.center.x, o.center.y];
      const [px, py] = m.toPx(p[0], p[1]);
      ctx.fillStyle = objColor(o.id, 0.85);
      ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  function hitSpeaker(px, py) {
    const s = stg();
    if (!s) return null;
    const m = mapping();
    let best = null;
    let bd = 12;
    s.speakers.items.forEach((it, i) => {
      const p = speakerToStage(it, s.speakers.transform);
      const [x, y] = m.toPx(p.x, p.y);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function down(e) {
    const s = stg();
    if (!s || e.button !== 0) return;
    if (dragMode === 'image' && !s.background.asset) return;
    if (dragMode === 'speakers' && !s.speakers.items.length) return;
    if (!guardEdit()) return;
    const m = mapping();
    const r = canvas.getBoundingClientRect();
    const [nx, ny] = m.fromPx(e.clientX - r.left, e.clientY - r.top);
    const hit = dragMode === 'speakers' ? hitSpeaker(e.clientX - r.left, e.clientY - r.top) : null;
    if (hit !== null) {
      if (hit !== selSp) selectSp(hit);
      drag = { sp: hit };
    } else {
      const start = dragMode === 'image' ? { x: s.background.x, y: s.background.y } : { x: s.speakers.transform.offsetX, y: s.speakers.transform.offsetY };
      drag = { nx, ny, start };
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  }

  function move(e) {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (!drag) {
      const hi = hitSpeaker(px, py);
      if (hi !== hoverIdx) {
        hoverIdx = hi;
        dirty = true;
        canvas.title = hi !== null ? stg().speakers.items[hi].name : '';
      }
      return;
    }
    const m = mapping();
    const [nx, ny] = m.fromPx(px, py);
    if ('sp' in drag) {
      const p = stageToMeters(nx, ny, stg().speakers.transform);
      dragSpeaker(drag.sp, clamp(p.x, -1000, 1000), clamp(p.y, -1000, 1000));
      showSpInfo(drag.sp);
      return;
    }
    const x = Math.round(clamp(drag.start.x + nx - drag.nx, -4, 4) * 1000) / 1000;
    const y = Math.round(clamp(drag.start.y + ny - drag.ny, -4, 4) * 1000) / 1000;
    if (dragMode === 'image') edit({ background: { x, y } });
    else edit({ speakers: { transform: { offsetX: x, offsetY: y } } });
    for (const row of [...els.bgRows, ...els.spRows]) row._sync();
  }

  function up() {
    if (!drag) return;
    const wasSp = 'sp' in drag;
    drag = null;
    canvas.classList.remove('dragging');
    if (wasSp) {
      flushSp();
      canvas.title = '';
      listSig = '';
      renderList();
    }
    flush();
  }

  function showSpInfo(i) {
    const it = stg()?.speakers.items[i];
    if (it) canvas.title = `${it.name}  X ${it.x.toFixed(2)} m · Y ${it.y.toFixed(2)} m`;
  }

  return {
    mount,
    relang,
    onShow() {
      shown = true;
      dirty = true;
      render();
      if (!raf) raf = requestAnimationFrame(draw);
    },
    onHide() {
      shown = false;
      flush();
      flushSp();
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
