// Show workspace: cue list (tc-ui renders into #tab-cues) and the show timeline — cue blocks on top,
// one lane per object below with the clips of 'clips' cues. Edits are sent as whole clip lists
// (tc.cue.update) when a drag ends; the server validates and broadcasts.
import { h, icon, store, on, emit, send, guardEdit, toast, isLocked, clamp, objColor, parseIds, idsSpec, armButton } from './core.js';
import { t } from './i18n.js';
import { parseTc, formatTc, tcToSeconds, secondsToTc, RATE_REAL, isDf } from './tc-core.js';
import { createTimelineView, fmtTime } from './timeline-view.js';

const CUE_H = 34;
const GAP = 8;
const LANE_H = 24;
const EDGE = 6;
const MIN_BLOCK = 2;
const KIND_HUE = { motion: 168, move: 205, path: 280, preset: 36, library: 60, home: 120, transport: 330 };
const THEN_MARK = { hold: '‖', home: '⌂', revert: '↩', continue: '' };
const MOTION_PARAMS = [
  ['mode', 'enum', ['hold', 'jitter', 'glide', 'path', 'drift', 'orbit']],
  ['center.x', 'num', -1, 1, 0.01], ['center.y', 'num', -1, 1, 0.01], ['center.z', 'num', -1, 1, 0.01],
  ['range.x', 'num', 0, 1, 0.01], ['range.y', 'num', 0, 1, 0.01], ['range.z', 'num', 0, 1, 0.01],
  ['rangeShape', 'enum', ['box', 'ellipse', 'ring']],
  ['speedScale', 'num', 0.25, 4, 0.05], ['glide', 'num', 0, 1, 0.01], ['jumpChance', 'num', 0, 1, 0.01],
  ['timing.min', 'num', 0.05, 60, 0.05], ['timing.max', 'num', 0.05, 60, 0.05],
  ['orbitDir', 'enum', ['cw', 'ccw', 'random']], ['driftRate', 'num', 0.01, 10, 0.01], ['driftDepth', 'num', 0, 1.5, 0.01],
  ['pathWobble', 'num', 0, 0.5, 0.01],
];
const CAPTURE_KEYS = ['mode', 'center', 'range', 'rangeShape', 'innerRadius', 'timing', 'glide', 'easing', 'jumpChance', 'restChance', 'minStep', 'speedScale', 'orbitDir', 'driftRate', 'driftDepth', 'pathWobble'];
const LS = { snap: 'objitter.show.snap', compact: 'objitter.show.compact', follow: 'objitter.show.follow' };

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPathIn(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = { ...(cur[ks[i]] ?? {}) };
  cur[ks[ks.length - 1]] = v;
}
function delPathIn(o, p) {
  const ks = p.split('.');
  if (ks.length === 1) { delete o[p]; return; }
  const parent = o[ks[0]];
  if (!parent) return;
  delete parent[ks[1]];
  if (!Object.keys(parent).length) delete o[ks[0]];
}
const round3 = (v) => Math.round(v * 1000) / 1000;
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
const clone = (x) => JSON.parse(JSON.stringify(x));

export function createShow() {
  let tl = null;
  let panel = null;
  let shown = false;
  let sel = null;
  let drag = null;
  let override = null;
  let overrideTimer = null;
  let pendingSelect = null;
  let snap = localStorage.getItem(LS.snap) ?? 'frame';
  let compact = localStorage.getItem(LS.compact) !== '0';
  let follow = localStorage.getItem(LS.follow) === '1';
  let host = null;
  let lastLocate = 0;
  let layout = null;
  const els = {};

  // ---------------- model ----------------
  const TC = () => store.TC;
  const rate = () => {
    const r = store.TCS?.rate ?? TC()?.settings?.rate;
    return r && r !== 'auto' ? r : '25';
  };
  const goMode = () => TC()?.settings?.trigger === 'go';
  const cueList = () => TC()?.cues ?? [];
  const clipsOf = (cue) => (override?.cueId === cue.id ? override.clips : cue.clips ?? []);
  const span = (clips) => clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);

  function resolveIds(spec) {
    const s = String(spec ?? '').trim();
    if (!s) return Array.from({ length: 32 }, (_, i) => i + 1);
    const out = new Set();
    for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (part.startsWith('@')) {
        const g = (store.S?.groups ?? []).find((x) => x.name.toLowerCase() === part.slice(1).toLowerCase());
        for (const id of g?.ids ?? []) out.add(id);
      } else {
        for (const id of parseIds(part)) out.add(id);
      }
    }
    return [...out].sort((a, b) => a - b);
  }
  const isPlainIds = (spec) => !!spec && !/@/.test(spec);

  /** Cue x positions in seconds: TC labels, or GO order laid out back to back. */
  function computeLayout() {
    const list = cueList();
    const r = rate();
    const out = new Map();
    let goT = 0;
    for (const cue of list) {
      const clips = clipsOf(cue);
      const len = Math.max(MIN_BLOCK, span(clips));
      let t0;
      if (goMode()) {
        t0 = goT;
        goT += len + 1;
      } else {
        const p = parseTc(cue.tc);
        t0 = p ? tcToSeconds(p, r) : 0;
      }
      out.set(cue.id, { cue, t0, len, clips });
    }
    const used = new Set();
    for (const { cue, clips } of out.values()) if (cue.action === 'clips') for (const c of clips) for (const id of resolveIds(c.targets)) used.add(id);
    const lanes = [];
    for (let id = 1; id <= 32; id++) {
      const o = store.OBJ?.[id - 1];
      if (!compact || o?.enabled || used.has(id)) lanes.push(id);
    }
    const laneY = new Map(lanes.map((id, i) => [id, CUE_H + GAP + i * LANE_H]));
    layout = { cues: out, lanes, laneY };
    return layout;
  }

  const snapRel = (rel) => {
    if (snap === 'off') return round3(rel);
    const step = snap === 'frame' ? 1 / RATE_REAL[rate()] : snap === '0.1' ? 0.1 : 1;
    return round3(Math.round(rel / step) * step);
  };

  // ---------------- drawing ----------------
  function clipLabel(c) {
    if (c.label) return c.label;
    switch (c.kind) {
      case 'motion': return Object.keys(c.params).length ? [c.params.mode, ...Object.keys(c.params).filter((k) => k !== 'mode')].filter(Boolean).join(' · ') : t('show.kind.motion');
      case 'move': return `→ ${c.params.x.toFixed(2)}, ${c.params.y.toFixed(2)}`;
      case 'path': return `${t('show.kind.path')}${c.params.pathPts?.length ? ` (${c.params.pathPts.length})` : ''}`;
      case 'preset': return c.params.name || t('show.kind.preset');
      case 'library': return c.params.path?.split('/').pop() || t('show.kind.library');
      case 'transport': return c.params.play === false ? '❚❚' : '▶';
      case 'home': return t('show.kind.home');
      default: return c.kind;
    }
  }

  function selClipTargets(L) {
    if (!sel?.clipId) return new Set();
    const clip = L.cues.get(sel.cueId)?.clips.find((c) => c.id === sel.clipId);
    return new Set(clip ? resolveIds(clip.targets) : []);
  }

  function drawBody(ctx, v) {
    const L = computeLayout();
    const w = v.w;
    const selTargets = selClipTargets(L);
    // lane backgrounds
    L.lanes.forEach((id, i) => {
      const y = L.laneY.get(id);
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.035)';
      ctx.fillRect(v.headerW, y, w - v.headerW, LANE_H);
      if (store.selected?.has(id)) {
        ctx.fillStyle = 'rgba(94,234,212,.06)';
        ctx.fillRect(v.headerW, y, w - v.headerW, LANE_H);
      }
      if (selTargets.has(id)) {
        ctx.fillStyle = 'rgba(255,255,255,.07)';
        ctx.fillRect(v.headerW, y, w - v.headerW, LANE_H);
      }
    });
    ctx.fillStyle = '#121826';
    ctx.fillRect(v.headerW, 0, w - v.headerW, CUE_H);
    ctx.strokeStyle = '#2a3346';
    ctx.beginPath(); ctx.moveTo(v.headerW, CUE_H + 0.5); ctx.lineTo(w, CUE_H + 0.5); ctx.stroke();

    const runs = new Map((store.TCS?.clips ?? []).map((r) => [r.cue, r]));
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const { cue, t0, len, clips } of L.cues.values()) {
      const x0 = v.xOf(t0);
      const isClips = cue.action === 'clips';
      const x1 = isClips ? v.xOf(t0 + len) : x0 + Math.max(60, ctx.measureText(cue.label || cue.action).width + 22);
      if (x1 < v.headerW || x0 > w) continue;
      const selCue = sel?.cueId === cue.id;
      const hue = isClips ? 190 : cue.action === 'slot' ? 48 : 0;
      ctx.globalAlpha = cue.enabled ? 1 : 0.4;
      ctx.fillStyle = isClips ? `hsla(${hue}, 45%, 30%, .9)` : 'rgba(60,70,95,.85)';
      ctx.fillRect(x0, 4, x1 - x0, CUE_H - 8);
      ctx.fillStyle = isClips ? `hsl(${hue}, 70%, 62%)` : '#f5d76e';
      ctx.fillRect(x0, 4, 3, CUE_H - 8);
      if (selCue) {
        ctx.strokeStyle = '#5eead4';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, 5, x1 - x0 - 2, CUE_H - 10);
        ctx.lineWidth = 1;
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(x0 + 6, 4, Math.max(0, x1 - x0 - 10), CUE_H - 8); ctx.clip();
      ctx.fillStyle = '#e6ebf5';
      ctx.textAlign = 'left';
      const name = cue.label || (cue.action === 'slot' ? cue.preset || t('slot.n', { n: cue.slot }) : t(`tc.action.${cue.action}`));
      ctx.fillText(`${goMode() ? '' : `${cue.tc.slice(3)}  `}${name}${isClips ? `  ·  ${clips.length}` : ''}`, x0 + 8, CUE_H / 2);
      ctx.restore();
      ctx.globalAlpha = 1;
      if (isClips && (selCue || isClips)) {
        ctx.strokeStyle = 'rgba(94,234,212,.12)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, CUE_H); ctx.lineTo(Math.round(x0) + 0.5, CUE_H + GAP + L.lanes.length * LANE_H);
        ctx.stroke();
      }
      const run = runs.get(cue.id);
      if (run && isClips && (goMode() || run.clock === 'wall')) {
        const x = v.xOf(t0 + clamp(run.elapsed, 0, len));
        ctx.strokeStyle = '#ffb35d';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, CUE_H + GAP + L.lanes.length * LANE_H); ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (!isClips) continue;
      clips.forEach((c, k) => {
        const cx0 = v.xOf(t0 + c.start);
        const cx1 = v.xOf(t0 + c.start + c.dur);
        if (cx1 < v.headerW || cx0 > w) return;
        const isSel = sel?.cueId === cue.id && sel.clipId === c.id;
        const active = run?.active?.includes(c.id);
        const hueK = KIND_HUE[c.kind] ?? 200;
        for (const id of resolveIds(c.targets)) {
          const y = L.laneY.get(id);
          if (y === undefined) continue;
          const yy = y + 2;
          const hh = LANE_H - 4;
          ctx.fillStyle = `rgba(16,20,30,${cue.enabled ? 0.92 : 0.4})`;
          ctx.fillRect(cx0, yy, Math.max(2, cx1 - cx0), hh);
          ctx.fillStyle = objColor(id, (active ? 0.62 : 0.4) * (cue.enabled ? 1 : 0.45));
          ctx.fillRect(cx0, yy, Math.max(2, cx1 - cx0), hh);
          const fw = Math.min((c.fade ?? 0) * v.pps, cx1 - cx0);
          if (fw > 2) {
            ctx.fillStyle = 'rgba(0,0,0,.25)';
            ctx.beginPath(); ctx.moveTo(cx0, yy + hh); ctx.lineTo(cx0 + fw, yy); ctx.lineTo(cx0, yy); ctx.fill();
          }
          ctx.fillStyle = `hsl(${hueK}, 70%, 62%)`;
          ctx.fillRect(cx0, yy, 3, hh);
          if (isSel) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(cx0 + 1, yy + 1, Math.max(2, cx1 - cx0) - 2, hh - 2);
            ctx.lineWidth = 1;
          }
          if (cx1 - cx0 > 24) {
            ctx.save();
            ctx.beginPath(); ctx.rect(cx0 + 4, yy, cx1 - cx0 - 8, hh); ctx.clip();
            ctx.fillStyle = '#f2f5fb';
            ctx.font = '600 10.5px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(clipLabel(c), cx0 + 6, yy + hh / 2);
            ctx.restore();
          }
          const mk = THEN_MARK[c.then];
          if (mk && cx1 - cx0 > 14) {
            ctx.fillStyle = 'rgba(255,255,255,.85)';
            ctx.font = '700 10px system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(mk, cx1 - 3, yy + hh / 2);
          }
        }
      });
    }
    if (drag?.ghost) {
      ctx.strokeStyle = '#5eead4';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(drag.ghost.x, drag.ghost.y, drag.ghost.w, drag.ghost.h);
      ctx.setLineDash([]);
    }
  }

  function drawHeader(ctx, v) {
    const L = layout ?? computeLayout();
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8a95ad';
    ctx.fillText(t('show.cues').toUpperCase(), 10, CUE_H / 2);
    for (const id of L.lanes) {
      const y = L.laneY.get(id);
      const o = store.OBJ?.[id - 1];
      const selObj = store.selected?.has(id);
      ctx.fillStyle = selObj ? 'rgba(94,234,212,.12)' : 'transparent';
      ctx.fillRect(0, y, v.headerW, LANE_H);
      ctx.fillStyle = objColor(id, o?.enabled ? 1 : 0.35);
      ctx.fillRect(8, y + 6, 4, LANE_H - 12);
      ctx.fillStyle = o?.enabled ? '#e6ebf5' : '#6b7690';
      ctx.font = '700 11px ui-monospace, Consolas, monospace';
      ctx.fillText(String(id).padStart(2, ' '), 18, y + LANE_H / 2);
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.save();
      ctx.beginPath(); ctx.rect(40, y, v.headerW - 44, LANE_H); ctx.clip();
      ctx.fillText(o?.name ?? '', 40, y + LANE_H / 2);
      ctx.restore();
    }
  }

  // ---------------- hit testing ----------------
  function laneAt(cy) {
    const L = layout ?? computeLayout();
    if (cy < CUE_H + GAP) return null;
    const i = Math.floor((cy - CUE_H - GAP) / LANE_H);
    return L.lanes[i] ?? null;
  }

  function hit(p, v) {
    const L = layout ?? computeLayout();
    if (p.inHeader) {
      const id = laneAt(p.cy);
      return id ? { type: 'laneHead', id } : null;
    }
    if (p.cy < CUE_H) {
      for (const e of [...L.cues.values()].reverse()) {
        const x0 = v.xOf(e.t0);
        const x1 = e.cue.action === 'clips' ? v.xOf(e.t0 + e.len) : x0 + 80;
        if (p.x >= x0 && p.x <= x1) return { type: 'cue', cue: e.cue, e };
      }
      return null;
    }
    const id = laneAt(p.cy);
    if (!id) return null;
    for (const e of [...L.cues.values()].reverse()) {
      if (e.cue.action !== 'clips') continue;
      for (let k = e.clips.length - 1; k >= 0; k--) {
        const c = e.clips[k];
        const x0 = v.xOf(e.t0 + c.start);
        const x1 = v.xOf(e.t0 + c.start + c.dur);
        if (p.x < x0 - 2 || p.x > x1 + 2) continue;
        if (!resolveIds(c.targets).includes(id)) continue;
        const edge = x1 - x0 > 3 * EDGE ? (p.x > x1 - EDGE ? 'r' : p.x < x0 + EDGE ? 'l' : null) : (p.x > x1 - 3 ? 'r' : null);
        return { type: 'clip', cue: e.cue, e, clip: c, k, id, edge };
      }
    }
    return { type: 'lane', id };
  }

  // ---------------- editing ----------------
  function commit(cueId, clips) {
    if (!guardEdit()) { clearOverride(); return; }
    override = { cueId, clips };
    clearTimeout(overrideTimer);
    overrideTimer = setTimeout(clearOverride, 2000);
    if (!send({ type: 'tc.cue.update', id: cueId, patch: { clips } })) clearOverride();
    tl?.redraw();
    renderPanel();
  }
  function clearOverride() {
    override = null;
    clearTimeout(overrideTimer);
    tl?.redraw();
  }

  function select(next, { reveal = false } = {}) {
    sel = next;
    if (sel?.cueId) {
      for (const el of document.querySelectorAll('#tab-cues .cue.tl-sel')) el.classList.remove('tl-sel');
      const row = document.querySelector(`#tab-cues .cue[data-id="${sel.cueId}"]`);
      row?.classList.add('tl-sel');
      row?.scrollIntoView({ block: 'nearest' });
    }
    if (reveal && sel && layout) {
      const e = layout.cues.get(sel.cueId);
      const c = sel.clipId ? e?.clips.find((x) => x.id === sel.clipId) : null;
      if (e) tl.reveal(e.t0 + (c?.start ?? 0));
      const id = c ? resolveIds(c.targets)[0] : null;
      const y = id ? layout.laneY.get(id) : null;
      if (y != null) tl.revealY(y - LANE_H, y + 2 * LANE_H);
    }
    tl?.redraw();
    renderPanel();
  }

  const curClip = () => {
    if (!sel?.clipId) return null;
    const cue = cueList().find((c) => c.id === sel.cueId);
    if (!cue) return null;
    const clips = clipsOf(cue);
    const k = clips.findIndex((c) => c.id === sel.clipId);
    return k < 0 ? null : { cue, clips, k, clip: clips[k] };
  };

  function editClip(fn) {
    const cc = curClip();
    if (!cc || !guardEdit()) return;
    const clips = clone(cc.clips);
    fn(clips[cc.k], clips);
    commit(cc.cue.id, clips);
  }

  function defaultClip(kind, ids, start) {
    const o = store.OBJ?.[ids[0] - 1];
    const base = { id: newId(), kind, targets: idsSpec(ids), start, dur: 4, fade: 1, ease: 'inOut', then: 'continue', label: '' };
    if (kind === 'motion') base.params = { mode: o?.mode === 'hold' ? 'glide' : o?.mode ?? 'glide' };
    else if (kind === 'move') {
      const p = store.positions?.[ids[0] - 1];
      base.params = { x: round3(p?.[0] ?? o?.center.x ?? 0), y: round3(p?.[1] ?? o?.center.y ?? 0), z: round3(p?.[2] ?? o?.center.z ?? 0) };
    } else if (kind === 'path') base.params = o?.pathPts?.length >= 2 ? { mode: 'path', pathSource: 'custom', pathPts: clone(o.pathPts), pathCurve: o.pathCurve, pathOrder: o.pathOrder } : { mode: 'path' };
    else if (kind === 'preset') base.params = { name: store.PRESETS?.[0]?.name ?? '' };
    else if (kind === 'library') base.params = { path: store.LIB?.items?.[0]?.path ?? '' };
    else if (kind === 'transport') base.params = { play: true };
    else base.params = {};
    return base;
  }

  /** Adds a clip at show time `at`: into the clips cue covering it (or the last one before), else a new cue. */
  function addClipAt(at, ids, kind = 'motion') {
    if (!guardEdit()) return;
    if (!ids.length) { toast(t('show.needObjects'), 'warn'); return; }
    const L = layout ?? computeLayout();
    const before = [...L.cues.values()].filter((e) => e.cue.action === 'clips' && e.t0 <= at + 1e-6).sort((a, b) => b.t0 - a.t0);
    const target = before.find((e) => at <= e.t0 + e.len + 30) ?? null;
    if (target) {
      const c = defaultClip(kind, ids, Math.max(0, snapRel(at - target.t0)));
      commit(target.cue.id, [...clone(target.clips), c]);
      select({ cueId: target.cue.id, clipId: c.id });
      return;
    }
    if (goMode()) { toast(t('show.needCue'), 'warn'); return; }
    const c = defaultClip(kind, ids, 0);
    pendingSelect = { clipId: c.id };
    send({ type: 'tc.cue.add', cue: { tc: tcAt(at), action: 'clips', clips: [c] } });
  }

  function tcAt(sec) {
    const r = rate();
    return formatTc(secondsToTc(Math.max(0, sec), r), { df: isDf(r) });
  }

  function addClipsCue() {
    if (!guardEdit()) return;
    const ph = tl?.playheadNow();
    const cue = { action: 'clips', clips: [] };
    if (ph !== null && ph !== undefined && !goMode()) cue.tc = tcAt(ph);
    pendingSelect = { cue: true };
    send({ type: 'tc.cue.add', cue });
  }

  // ---------------- pointer ----------------
  const body = {
    height: () => CUE_H + GAP + (layout?.lanes.length ?? 32) * LANE_H + 40,
    draw: drawBody,
    header: drawHeader,
    hover(p, v) {
      const hh = hit(p, v);
      if (!hh) return '';
      if (hh.type === 'clip') return hh.edge ? 'ew-resize' : isLocked() ? 'pointer' : 'grab';
      if (hh.type === 'cue') return goMode() || isLocked() ? 'pointer' : 'grab';
      if (hh.type === 'laneHead') return 'pointer';
      return 'crosshair';
    },
    down(e, p, v) {
      if (e.button !== 0) return false;
      const hh = hit(p, v);
      if (!hh || hh.type === 'lane') { select(null); return false; }
      if (hh.type === 'laneHead') {
        emit('show.pickObject', { id: hh.id, add: e.shiftKey || e.ctrlKey || e.metaKey });
        return false;
      }
      if (hh.type === 'cue') {
        select({ cueId: hh.cue.id });
        if (goMode() || isLocked()) return false;
        drag = { mode: 'cue', cue: hh.cue, t0: hh.e.t0, px: p.x, moved: false };
        return true;
      }
      select({ cueId: hh.cue.id, clipId: hh.clip.id });
      if (isLocked()) return false;
      let clips = clone(hh.e.clips);
      let k = hh.k;
      if ((e.ctrlKey || e.metaKey) && !hh.edge) {
        const dup = { ...clone(hh.clip), id: newId() };
        clips.push(dup);
        k = clips.length - 1;
        sel = { cueId: hh.cue.id, clipId: dup.id };
      }
      drag = {
        mode: hh.edge === 'r' ? 'resize' : hh.edge === 'l' ? 'trim' : 'move', cueId: hh.cue.id, cueT0: hh.e.t0, clips, k,
        orig: clone(clips[k]), px: p.x, lane0: hh.id, moved: false,
      };
      override = { cueId: hh.cue.id, clips };
      return true;
    },
    move(e, p, v) {
      if (!drag) return;
      const dx = (p.x - drag.px) / v.pps;
      if (Math.abs(p.x - drag.px) > 2) drag.moved = true;
      if (drag.mode === 'cue') {
        drag.newT = Math.max(0, drag.t0 + dx);
        const r = rate();
        drag.newT = Math.round(drag.newT * RATE_REAL[r]) / RATE_REAL[r];
        drag.ghost = { x: v.xOf(drag.newT), y: 3, w: Math.max(30, v.xOf(drag.newT + (layout.cues.get(drag.cue.id)?.len ?? 2)) - v.xOf(drag.newT)), h: CUE_H - 6 };
        tl.v.marks = [{ t: drag.newT, color: '#5eead4' }];
        return;
      }
      const c = drag.clips[drag.k];
      const o = drag.orig;
      if (drag.mode === 'move') {
        c.start = Math.max(0, snapRel(o.start + dx));
        if (isPlainIds(o.targets)) {
          const lane = laneAt(p.cy);
          if (lane && lane !== drag.lane0) {
            const ids = resolveIds(o.targets);
            const L = layout.lanes;
            const di = L.indexOf(lane) - L.indexOf(drag.lane0);
            const moved = ids.map((id) => L[L.indexOf(id) + di]);
            if (moved.every(Boolean)) c.targets = idsSpec(moved);
          } else if (lane === drag.lane0) c.targets = o.targets;
        }
      } else if (drag.mode === 'resize') {
        c.dur = Math.max(0.05, snapRel(o.start + o.dur + dx) - o.start);
      } else {
        const end = o.start + o.dur;
        c.start = clamp(snapRel(o.start + dx), 0, end - 0.05);
        c.dur = round3(end - c.start);
      }
      c.start = round3(c.start);
      c.dur = round3(c.dur);
      override = { cueId: drag.cueId, clips: drag.clips };
      renderPanelTimes();
    },
    up() {
      const d = drag;
      drag = null;
      tl.v.marks = [];
      if (!d) return;
      if (d.mode === 'cue') {
        if (d.moved && d.newT !== undefined && guardEdit()) send({ type: 'tc.cue.update', id: d.cue.id, patch: { tc: tcAt(d.newT) } });
        return;
      }
      if (!d.moved && JSON.stringify(d.clips[d.k]) === JSON.stringify(d.orig) && d.clips.length === layout.cues.get(d.cueId)?.clips.length) {
        clearOverride();
        return;
      }
      commit(d.cueId, d.clips);
    },
    dbl(e, p, v) {
      const hh = hit(p, v);
      if (hh?.type === 'lane') {
        const ids = store.selected?.has(hh.id) && store.selected.size > 1 ? [...store.selected].sort((a, b) => a - b) : [hh.id];
        addClipAt(Math.max(0, p.t), ids);
        return true;
      }
      if (hh?.type === 'clip') {
        els.panel?.querySelector('select, input')?.focus();
        return true;
      }
      return false;
    },
  };

  function onLocate(sec, final) {
    tl.setPlayhead(sec, { rolling: false });
    if (!final) return;
    if (TC()?.settings?.input !== 'internal') {
      if (Date.now() - lastLocate > 4000) toast(t('show.locateInternal'), 'warn');
      lastLocate = Date.now();
      return;
    }
    send({ type: 'tc.int.locate', tc: tcAt(sec) });
  }

  function syncPlayhead() {
    if (!tl) return;
    const s = store.TCS;
    const tc = s?.internal?.tc ?? s?.tc ?? null;
    const p = tc ? parseTc(tc) : null;
    if (!p) { tl.setPlayhead(null); return; }
    const sec = tcToSeconds(p, rate());
    const rolling = !!(s.rolling || s.internal?.playing);
    tl.setPlayhead(sec, { rolling, rate: s.rolling ? s.speed || 1 : 1 });
    if (follow && rolling) tl.reveal(sec);
  }

  // ---------------- keyboard ----------------
  function onKey(e) {
    const handled = handleKey(e);
    if (handled) e.preventDefault?.();
    return handled;
  }

  function handleKey(e) {
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return false;
    const cc = curClip();
    if (!cc) {
      if (e.key === 'Escape' && sel) { select(null); return true; }
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!guardEdit()) return true;
      commit(cc.cue.id, cc.clips.filter((c) => c.id !== cc.clip.id));
      select({ cueId: cc.cue.id });
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (!guardEdit()) return true;
      const dup = { ...clone(cc.clip), id: newId(), start: round3(cc.clip.start + cc.clip.dur) };
      commit(cc.cue.id, [...clone(cc.clips), dup]);
      select({ cueId: cc.cue.id, clipId: dup.id });
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.shiftKey ? 1 : snap === 'frame' ? 1 / RATE_REAL[rate()] : 0.1;
      editClip((c) => { c.start = round3(Math.max(0, c.start + (e.key === 'ArrowLeft' ? -step : step))); });
      return true;
    }
    if (e.key === 'Escape') { select(null); return true; }
    return false;
  }

  // ---------------- properties panel ----------------
  const numIn = (value, min, max, step, onchange, attrs = {}) => {
    const el = h('input', { type: 'number', class: 'ed mono', min, max, step, value: value ?? '', ...attrs });
    el.addEventListener('change', () => {
      if (el.value === '' && attrs.placeholder) { onchange(null); return; }
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      onchange(clamp(v, min, max));
    });
    return el;
  };
  const selIn = (opts, value, onchange) => {
    const el = h('select', { class: 'ed' }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    el.addEventListener('change', () => onchange(el.value));
    return el;
  };
  const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ...ctl));

  function renderPanelTimes() {
    const cc = curClip();
    if (!cc || !els.start) return;
    if (document.activeElement !== els.start) els.start.value = cc.clip.start;
    if (document.activeElement !== els.dur) els.dur.value = cc.clip.dur;
  }

  function renderPanel() {
    if (!panel) return;
    if (panel.contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=number]')) return;
    const locked = isLocked();
    const cc = curClip();
    const cue = sel ? cueList().find((c) => c.id === sel.cueId) : null;
    if (!cue) {
      panel.replaceChildren(
        h('div', { class: 'section' }, t('show.props')),
        h('p', { class: 'hint' }, t('show.empty.hint')),
        h('ul', { class: 'show-help' },
          h('li', {}, t('show.help.dbl')), h('li', {}, t('show.help.drag')), h('li', {}, t('show.help.dup')),
          h('li', {}, t('show.help.zoom')), h('li', {}, t('show.help.ruler'))));
      return;
    }
    if (!cc) {
      const e = layout?.cues.get(cue.id);
      const kids = [
        h('div', { class: 'section' }, t('show.cue')),
        h('div', { class: 'show-cue-head' }, h('span', { class: 'mono' }, cue.tc), h('b', {}, cue.label || t(`tc.action.${cue.action}`))),
      ];
      if (cue.action === 'clips') {
        kids.push(
          h('p', { class: 'hint' }, t('show.cue.clips', { n: e?.clips.length ?? 0, len: fmtTime(e?.len ?? 0, true) })),
          h('div', { class: 'btn-row two' },
            h('button', { class: 'accent ed', disabled: locked, onclick: () => addClipAt((e?.t0 ?? 0) + (e?.clips.length ? e.len : 0), selectedIds()) }, t('show.addClip')),
            h('button', { class: 'ed', onclick: () => send({ type: 'tc.cue.fire', id: cue.id }) }, t('show.fire'))));
      } else {
        kids.push(h('p', { class: 'hint' }, t('show.cue.notClips')));
      }
      panel.replaceChildren(...kids);
      return;
    }
    const c = cc.clip;
    const upd = (fn) => editClip(fn);
    const kinds = (store.ST?.constants?.clipKinds ?? ['motion', 'move', 'path', 'preset', 'home', 'transport']).map((k) => [k, t(`show.kind.${k}`)]);
    const thens = (store.ST?.constants?.clipThen ?? ['continue', 'hold', 'home', 'revert']).map((k) => [k, t(`show.then.${k}`)]);
    const eases = ['inOut', 'linear', 'in', 'out', 'smooth'].map((k) => [k, t(`tc.curve.${k}`)]);
    const targets = h('input', { type: 'text', class: 'ed mono', value: c.targets, placeholder: t('show.targets.all'), spellcheck: false, list: 'tc-groups-dl' });
    targets.addEventListener('change', () => upd((x) => { x.targets = targets.value.trim(); }));
    const useSel = h('button', { class: 'ed', type: 'button', title: t('tc.cue.useSel.title'), onclick: () => {
      const ids = selectedIds();
      if (!ids.length) { toast(t('srv.noSelection'), 'warn'); return; }
      upd((x) => { x.targets = idsSpec(ids); });
    } }, t('tc.cue.useSel'));
    els.start = numIn(c.start, 0, 3600, 0.01, (v) => upd((x) => { x.start = round3(v); }));
    els.dur = numIn(c.dur, 0.05, 3600, 0.01, (v) => upd((x) => { x.dur = round3(v); }));
    const fade = numIn(c.fade, 0, 60, 0.1, (v) => upd((x) => { x.fade = v; }), { placeholder: t('tc.cue.fade.ph') });
    const label = h('input', { type: 'text', class: 'ed', value: c.label ?? '', maxLength: 32, placeholder: clipLabel({ ...c, label: '' }) });
    label.addEventListener('change', () => upd((x) => { x.label = label.value; }));
    const kids = [
      h('div', { class: 'section show-sec' }, h('i', { class: 'kind-sw', style: `--h:${KIND_HUE[c.kind]}` }), t('show.clip'),
        h('span', { class: 'muted mono show-in' }, `${cc.cue.label || cc.cue.tc}`)),
      row(t('show.kind'), selIn(kinds, c.kind, (k) => upd((x, all) => {
        const d = defaultClip(k, resolveIds(x.targets).slice(0, 1).length ? resolveIds(x.targets) : [1], x.start);
        x.kind = k;
        x.params = d.params;
      }))),
      row(t('show.targets'), targets, useSel),
      row(t('show.start'), els.start, h('span', { class: 'muted' }, 's')),
      row(t('show.dur'), els.dur, h('span', { class: 'muted' }, 's')),
      row(t('show.fade'), fade, selIn(eases, c.ease, (v) => upd((x) => { x.ease = v; }))),
      row(t('show.then'), selIn(thens, c.then, (v) => upd((x) => { x.then = v; }))),
      h('p', { class: 'hint' }, t(`show.then.${c.then}.hint`)),
      row(t('show.label'), label),
      h('div', { class: 'section' }, t('show.params')),
      ...paramsUi(c, upd),
      h('div', { class: 'btn-row two show-actions' },
        h('button', { class: 'ed', type: 'button', title: t('show.dup.title'), onclick: () => onKey({ key: 'd', ctrlKey: true, target: document.body }) }, t('show.dup')),
        armButton(h('button', { class: 'danger ed', type: 'button' }, t('common.delete')), () => onKey({ key: 'Delete', target: document.body }))),
    ];
    panel.replaceChildren(...kids);
    for (const el of panel.querySelectorAll('.ed')) el.disabled = locked;
  }

  function paramsUi(c, upd) {
    const firstId = resolveIds(c.targets)[0] ?? 1;
    const o = store.OBJ?.[firstId - 1];
    switch (c.kind) {
      case 'move': {
        const p = c.params;
        return [
          row('X', numIn(p.x, -1, 1, 0.01, (v) => upd((x) => { x.params.x = v; }))),
          row('Y', numIn(p.y, -1, 1, 0.01, (v) => upd((x) => { x.params.y = v; }))),
          row('Z', numIn(p.z, -1, 1, 0.01, (v) => upd((x) => { x.params.z = v; }))),
          h('div', { class: 'btn-row' }, h('button', { class: 'ed', type: 'button', onclick: () => {
            const pos = store.positions?.[firstId - 1];
            if (!pos) return;
            upd((x) => { x.params = { x: round3(pos[0]), y: round3(pos[1]), z: round3(pos[2]) }; });
          } }, t('show.move.capture', { n: firstId }))),
          h('p', { class: 'hint' }, t('show.move.hint')),
        ];
      }
      case 'preset': {
        const list = store.PRESETS ?? [];
        return [row(t('show.preset'), selIn([['', '—'], ...list.map((p) => [p.name, `${p.name}${p.slot ? ` (${t('slot.n', { n: p.slot })})` : ''}`])], c.params.name, (v) => upd((x) => { x.params.name = v; })))];
      }
      case 'library': {
        const list = store.LIB?.items ?? [];
        const opts = [['', list.length ? '—' : t('lib.none')], ...list.map((it) => [it.path, it.path])];
        if (c.params.path && !list.some((it) => it.path === c.params.path)) opts.push([c.params.path, t('tc.cue.presetMissing', { name: c.params.path })]);
        return [row(t('lib.pick'), selIn(opts, c.params.path ?? '', (v) => upd((x) => { x.params.path = v; })))];
      }
      case 'transport':
        return [row(t('show.transport'), selIn([['1', t('show.transport.play')], ['0', t('show.transport.pause')]], c.params.play === false ? '0' : '1', (v) => upd((x) => { x.params.play = v === '1'; })))];
      case 'home':
        return [h('p', { class: 'hint' }, t('show.home.hint'))];
      case 'path': {
        const n = c.params.pathPts?.length ?? 0;
        return [
          h('p', { class: 'hint' }, n ? t('show.path.pts', { n }) : t('show.path.random')),
          h('div', { class: 'btn-row' }, h('button', { class: 'ed', type: 'button', disabled: !(o?.pathPts?.length >= 2), onclick: () => upd((x) => {
            x.params = { mode: 'path', pathSource: 'custom', pathPts: clone(o.pathPts), pathCurve: o.pathCurve, pathOrder: o.pathOrder, pathTiming: o.pathTiming };
          }) }, t('show.path.capture', { n: firstId }))),
          ...motionRows(c, upd, ['speedScale', 'pathWobble', 'timing.min', 'timing.max']),
        ];
      }
      default: {
        return [
          ...motionRows(c, upd, null),
          h('div', { class: 'btn-row' }, h('button', { class: 'ed', type: 'button', title: t('show.capture.title'), onclick: () => upd((x) => {
            const src = store.OBJ?.[firstId - 1];
            if (!src) return;
            x.params = Object.fromEntries(CAPTURE_KEYS.filter((k) => k in src).map((k) => [k, clone(src[k])]));
          }) }, t('show.capture', { n: firstId }))),
        ];
      }
    }
  }

  function motionRows(c, upd, only) {
    const defs = MOTION_PARAMS.filter(([k]) => !only || only.includes(k));
    const present = defs.filter(([k]) => getPath(c.params, k) !== undefined);
    const rows = present.map(([k, type, a, b, step]) => {
      const v = getPath(c.params, k);
      const ctl = type === 'enum'
        ? selIn(a.map((x) => [x, t(`show.val.${x}`)]), v, (nv) => upd((x) => { setPathIn(x.params, k, nv); }))
        : numIn(v, a, b, step, (nv) => upd((x) => { setPathIn(x.params, k, nv); }));
      const rm = h('button', { class: 'btn-ghost ed show-rm', type: 'button', title: t('common.delete'), onclick: () => upd((x) => { delPathIn(x.params, k); }) }, '✕');
      return row(t(`show.p.${k}`), ctl, rm);
    });
    const missing = defs.filter(([k]) => getPath(c.params, k) === undefined);
    if (missing.length) {
      const add = h('select', { class: 'ed show-add' }, h('option', { value: '' }, t('show.addParam')), missing.map(([k]) => h('option', { value: k }, t(`show.p.${k}`))));
      add.addEventListener('change', () => {
        const def = missing.find(([k]) => k === add.value);
        if (!def) return;
        const o = store.OBJ?.[(resolveIds(c.targets)[0] ?? 1) - 1];
        const cur = o ? getPath(o, def[0]) : undefined;
        const v = cur ?? (def[1] === 'enum' ? def[2][0] : def[2]);
        upd((x) => { setPathIn(x.params, def[0], v); });
      });
      rows.push(h('div', { class: 'row' }, h('span', {}), h('div', { class: 'ctl' }, add)));
    }
    if (!present.length) rows.unshift(h('p', { class: 'hint' }, t('show.motion.empty')));
    return rows;
  }

  const selectedIds = () => [...(store.selected ?? [])].sort((a, b) => a - b);

  // ---------------- mount ----------------
  function build(bodyEl, tools) {
    const cuesEl = h('div', { id: 'tab-cues', class: 'ws-scroll show-cues' });
    const tlHost = h('div', { class: 'show-tl-host' });
    panel = h('aside', { class: 'show-panel ws-scroll', 'aria-label': t('show.props') });
    els.panel = panel;
    const tlCol = h('div', { class: 'show-timeline', id: 'showTimeline' }, tlHost, panel);
    bodyEl.classList.add('show-body');
    bodyEl.append(cuesEl, tlCol);
    buildTools(tools);
    tl = createTimelineView(tlHost, { body, onLocate });
    tl.canvas.setAttribute('aria-label', t('show.timeline'));
    tl.canvas.addEventListener('keydown', (e) => { if (onKey(e)) e.stopPropagation(); });
    renderPanel();
    syncPlayhead();
  }

  function buildTools(tools) {
    const snapSel = h('select', { class: 'show-snap', title: t('show.snap'), 'aria-label': t('show.snap') },
      [['frame', t('show.snap.frame')], ['0.1', '0.1 s'], ['1', '1 s'], ['off', t('show.snap.off')]].map(([v, l]) => h('option', { value: v, selected: v === snap }, l)));
    snapSel.addEventListener('change', () => { snap = snapSel.value; localStorage.setItem(LS.snap, snap); });
    const compactChk = h('input', { type: 'checkbox', checked: compact });
    compactChk.addEventListener('change', () => { compact = compactChk.checked; localStorage.setItem(LS.compact, compact ? '1' : '0'); tl.redraw(); });
    const followChk = h('input', { type: 'checkbox', checked: follow });
    followChk.addEventListener('change', () => { follow = followChk.checked; localStorage.setItem(LS.follow, follow ? '1' : '0'); });
    els.addCue = h('button', { class: 'accent ed icon-l', type: 'button', title: t('show.addCue.title'), onclick: addClipsCue }, icon('ws-show'), t('show.addCue'));
    els.addClip = h('button', { class: 'ed', type: 'button', title: t('show.addClipSel.title'), onclick: () => {
      const ph = tl.playheadNow();
      const at = sel?.cueId && layout?.cues.get(sel.cueId) ? layout.cues.get(sel.cueId).t0 + (curClip()?.clip ? curClip().clip.start + curClip().clip.dur : 0) : ph ?? 0;
      addClipAt(at, selectedIds());
    } }, t('show.addClipSel'));
    tools.append(els.addCue, els.addClip, h('span', { class: 'ws-sep' }),
      h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomOut'), onclick: () => tl.zoom(1 / 1.4) }, '−'),
      h('button', { class: 'btn-ghost', type: 'button', title: t('show.fit'), onclick: fitAll }, t('show.fitShort')),
      h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomIn'), onclick: () => tl.zoom(1.4) }, '+'),
      h('span', { class: 'ws-sep' }),
      h('label', { class: 'chk' }, h('span', { class: 'muted' }, t('show.snap')), snapSel),
      h('label', { class: 'chk', title: t('show.compact.title') }, compactChk, t('show.compact')),
      h('label', { class: 'chk' }, followChk, t('show.follow')));
    renderPanelLock();
  }

  function fitAll() {
    const L = computeLayout();
    const list = [...L.cues.values()];
    if (!list.length) { tl.fit(0, 60); return; }
    tl.fit(Math.min(...list.map((e) => e.t0)), Math.max(...list.map((e) => e.t0 + e.len)));
  }

  function mount(bodyEl, tools) {
    host = { bodyEl, tools };
    build(bodyEl, tools);
    on('tc', () => { clearOverride(); tl.redraw(); renderPanel(); });
    on('tc.delta', (m) => {
      if (override && (m.upsert ?? []).some((c) => c.id === override.cueId)) clearOverride();
      if (sel && !cueList().some((c) => c.id === sel.cueId)) sel = null;
      tl.redraw();
      renderPanel();
    });
    on('tc.cue.added', (m) => {
      if (!pendingSelect) return;
      const ps = pendingSelect;
      pendingSelect = null;
      setTimeout(() => select(ps.clipId ? { cueId: m.id, clipId: ps.clipId } : { cueId: m.id }, { reveal: true }), 80);
    });
    on('tcs', syncPlayhead);
    on('state', () => { tl.redraw(); if (!drag) renderPanelLock(); });
    on('presets', () => { if (curClip()?.clip.kind === 'preset') renderPanel(); });
    on('library', () => { if (curClip()?.clip.kind === 'library') renderPanel(); });
    on('show.focusCue', (id) => select({ cueId: id }, { reveal: true }));
    on('clip', () => tl.redraw());
  }

  function renderPanelLock() {
    const locked = isLocked();
    for (const el of panel?.querySelectorAll('.ed') ?? []) el.disabled = locked;
    if (els.addCue) els.addCue.disabled = locked;
    if (els.addClip) els.addClip.disabled = locked;
  }

  return {
    mount,
    onShow() {
      shown = true;
      tl?.setActive(true);
      if (!layout || !tl.v.w) setTimeout(fitAll, 30);
      syncPlayhead();
    },
    onHide() {
      shown = false;
      tl?.setActive(false);
    },
    onKey,
    relang() {
      if (!host) return;
      host.tools.replaceChildren();
      buildTools(host.tools);
      tl.canvas.setAttribute('aria-label', t('show.timeline'));
      panel.setAttribute('aria-label', t('show.props'));
      renderPanel();
      tl.redraw();
    },
    get timeline() { return tl; },
  };
}
