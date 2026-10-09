// Automation workspace: one row per lane on the shared timeline. The header column carries the lane
// name, record-arm (R) and the mode badge; the body is a curve editor. Points are sent as a whole list
// (auto.points) when an edit ends; recording itself runs on the server (Touch / Latch / Write).
import { h, store, on, send, guardEdit, toast, isLocked, clamp, objColor, armButton } from './core.js';
import { t } from './i18n.js';
import { parseTc, tcToSeconds, secondsToTc, formatTc, isDf } from './tc-core.js';
import { createTimelineView, fmtTime } from './timeline-view.js';

const ROW_H = 76;
const PAD = 9;
const HEADER_W = 210;
const HIT = 7;
const MARKER_GAP = 6;
const MODES = ['off', 'read', 'touch', 'latch', 'write'];
const MODE_COLOR = { off: '#5b6680', read: '#4fd1a5', touch: '#f5b04a', latch: '#f08a4b', write: '#ff5d6c' };
const POS_COLORS = ['#ff8a7a', '#7ee08f', '#79b8ff'];
const LS_FOLLOW = 'objitter.auto.follow';
const LS_PARAM = 'objitter.auto.param';

const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;
const clone = (x) => JSON.parse(JSON.stringify(x));
const lerpV = (a, b, k) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * k) : a + (b - a) * k);

/** Same rule as the server: hold outside the points, the left point's curve shapes each segment. */
function valueAt(points, tt) {
  const n = points.length;
  if (!n) return null;
  if (tt <= points[0][0]) return points[0][1];
  if (tt >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= tt) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const curve = a[2] ?? 'linear';
  if (curve === 'step') return a[1];
  let k = (tt - a[0]) / (b[0] - a[0]);
  if (curve === 'smooth') k = k * k * (3 - 2 * k);
  return lerpV(a[1], b[1], k);
}

export function createAutomation() {
  let tl = null;
  let panel = null;
  let host = null;
  let shown = false;
  let selLane = null;
  let selPts = new Set();
  let range = null;
  let drag = null;
  let override = null;
  let follow = localStorage.getItem(LS_FOLLOW) === '1';
  let addParam = localStorage.getItem(LS_PARAM) || 'center.x';
  let pendingSelect = false;
  const trails = new Map();
  const els = {};

  // ---------------- model ----------------
  const lanes = () => store.AUTO?.lanes ?? [];
  const global = () => store.AUTO?.global ?? 'read';
  const lane = (id) => lanes().find((l) => l.id === id) ?? null;
  const pointsOf = (l) => (override?.id === l.id ? override.points : l.points);
  const constants = () => store.ST?.constants ?? {};
  const rangeOf = (l) => {
    if (l.param === 'pos') return [-1, 1];
    const r = l.target === 'master' ? constants().masterAutoParams?.[l.param] : constants().autoParams?.[l.param];
    return r ?? [0, 1];
  };
  const objName = (target) => (target === 'master' ? t('auto.master') : store.OBJ?.[target - 1]?.name ?? `#${target}`);
  const paramLabel = (p) => t(`auto.param.${p}`);
  const laneTitle = (l) => l.label || `${objName(l.target)} · ${paramLabel(l.param)}`;
  const rate = () => {
    const r = store.TCS?.rate ?? store.TC?.settings?.rate;
    return r && r !== 'auto' ? r : '25';
  };
  const cueList = () => store.TC?.cues ?? [];
  /** Cue-owned lanes are drawn at the cue's TC; their points are relative to the cue. */
  function offsetOf(l) {
    if (l.owner === 'show') return 0;
    const cue = cueList().find((c) => c.id === l.owner);
    const p = cue ? parseTc(cue.tc) : null;
    return p && store.TC?.settings?.trigger !== 'go' ? tcToSeconds(p, rate()) : 0;
  }
  const ownerMissing = (l) => l.owner !== 'show' && !cueList().some((c) => c.id === l.owner);
  const rowY = (i) => i * ROW_H;
  const yOfV = (l, v, y0) => {
    const [lo, hi] = rangeOf(l);
    return y0 + PAD + (1 - (v - lo) / (hi - lo || 1)) * (ROW_H - 2 * PAD);
  };
  const vOfY = (l, y, y0) => {
    const [lo, hi] = rangeOf(l);
    return clamp(lo + (1 - (y - y0 - PAD) / (ROW_H - 2 * PAD)) * (hi - lo), lo, hi);
  };
  const fmtV = (l, v) => {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) return v.map((x) => x.toFixed(2)).join(', ');
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  };

  function currentValue(l) {
    if (l.target === 'master') return store.S?.master?.speed ?? 1;
    if (l.param === 'pos') {
      const p = store.positions?.[l.target - 1];
      return p ? [round4(p[0]), round4(p[1]), round4(p[2] ?? 0)] : [0, 0, 0];
    }
    const o = store.OBJ?.[l.target - 1];
    const v = o ? l.param.split('.').reduce((a, k) => (a == null ? a : a[k]), o) : null;
    return typeof v === 'number' ? v : rangeOf(l)[0];
  }

  // ---------------- drawing ----------------
  /** On-screen points as [index, x]; markers only while they stay apart (dense recorded passes show just the curve). */
  function visiblePoints(v, l) {
    const off = offsetOf(l);
    const vis = [];
    let gap = Infinity;
    pointsOf(l).forEach((p, k) => {
      const x = v.xOf(off + p[0]);
      if (x < v.headerW - 6 || x > v.w + 6) return;
      if (vis.length) gap = Math.min(gap, x - vis[vis.length - 1][1]);
      vis.push([k, x]);
    });
    return { vis, markers: gap >= MARKER_GAP };
  }

  function drawLane(ctx, v, l, i) {
    const y0 = rowY(i);
    const pts = pointsOf(l);
    const off = offsetOf(l);
    const sel = l.id === selLane;
    ctx.fillStyle = sel ? 'rgba(79,209,165,.06)' : i % 2 ? 'rgba(255,255,255,.015)' : 'transparent';
    ctx.fillRect(v.headerW, y0, v.w - v.headerW, ROW_H);
    ctx.strokeStyle = '#1f2738';
    ctx.beginPath(); ctx.moveTo(v.headerW, y0 + ROW_H - 0.5); ctx.lineTo(v.w, y0 + ROW_H - 0.5); ctx.stroke();
    const [lo, hi] = rangeOf(l);
    if (lo < 0 && hi > 0) {
      const yz = Math.round(yOfV(l, 0, y0)) + 0.5;
      ctx.strokeStyle = 'rgba(90,102,128,.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(v.headerW, yz); ctx.lineTo(v.w, yz); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (range && range.id === l.id) {
      const a = v.xOf(off + Math.min(range.a, range.b));
      const b = v.xOf(off + Math.max(range.a, range.b));
      ctx.fillStyle = 'rgba(121,184,255,.14)';
      ctx.fillRect(a, y0 + 1, Math.max(1, b - a), ROW_H - 2);
    }
    const dim = l.mode === 'off' || ownerMissing(l);
    const comps = l.param === 'pos' ? [0, 1, 2] : [null];
    for (const c of comps) {
      if (!pts.length) break;
      const val = (p) => (c === null ? p[1] : p[1][c]);
      const lineCol = c === null ? (dim ? '#59627a' : MODE_COLOR[l.mode === 'off' ? 'off' : 'read']) : POS_COLORS[c];
      ctx.strokeStyle = lineCol;
      ctx.globalAlpha = dim ? 0.5 : 1;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const toY = (vv) => (c === null ? yOfV(l, vv, y0) : yOfV({ ...l, param: 'pos' }, vv, y0));
      ctx.moveTo(v.headerW, toY(val(pts[0])));
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const x = v.xOf(off + p[0]);
        const prev = pts[k - 1];
        if (prev && (prev[2] ?? 'linear') === 'step') ctx.lineTo(x, toY(val(prev)));
        else if (prev && prev[2] === 'smooth') {
          const x0 = v.xOf(off + prev[0]);
          for (let s = 1; s <= 12; s++) {
            const kk = s / 12;
            const e = kk * kk * (3 - 2 * kk);
            ctx.lineTo(x0 + (x - x0) * kk, toY(val(prev) + (val(p) - val(prev)) * e));
          }
          continue;
        }
        ctx.lineTo(x, toY(val(p)));
      }
      ctx.lineTo(v.w, toY(val(pts[pts.length - 1])));
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
    }
    const { vis, markers } = visiblePoints(v, l);
    for (const [k, x] of vis) {
      const on = sel && selPts.has(k);
      if (!on && !markers) continue;
      const p = pts[k];
      if (on && l.param === 'pos') {
        ctx.strokeStyle = 'rgba(79,209,165,.45)';
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0 + 2); ctx.lineTo(Math.round(x) + 0.5, y0 + ROW_H - 2); ctx.stroke();
      }
      for (const c of comps) {
        const y = c === null ? yOfV(l, p[1], y0) : yOfV(l, p[1][c], y0);
        ctx.beginPath();
        ctx.arc(x, y, on ? 4 : c === null ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = on ? '#ffffff' : '#0d1119';
        ctx.fill();
        ctx.strokeStyle = on ? '#4fd1a5' : c === null ? MODE_COLOR[dim ? 'off' : 'read'] : POS_COLORS[c];
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    // recording trail
    const tr = trails.get(l.id);
    if (tr?.length > 1) {
      ctx.strokeStyle = '#ff5d6c';
      ctx.lineWidth = 2;
      for (const c of comps) {
        ctx.beginPath();
        tr.forEach(([tt, vv], k) => {
          const val = c === null ? vv : vv[c];
          const x = v.xOf(off + tt);
          const y = c === null ? yOfV(l, val, y0) : yOfV({ ...l, param: 'pos' }, val, y0);
          if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      const a = v.xOf(off + tr[0][0]);
      const b = v.xOf(off + tr[tr.length - 1][0]);
      ctx.fillStyle = 'rgba(255,93,108,.10)';
      ctx.fillRect(a, y0 + 1, Math.max(1, b - a), ROW_H - 2);
    }
    // live value at the playhead
    const live = store.AUTOS?.vals?.[l.id];
    const ph = tl?.playheadNow();
    if (live !== undefined && live !== null && ph !== null) {
      const x = v.xOf(ph);
      ctx.fillStyle = '#ff5d6c';
      for (const c of comps) {
        const lv = c === null ? live : live[c];
        if (typeof lv !== 'number') continue;
        ctx.beginPath(); ctx.arc(x, yOfV(l, lv, y0), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!pts.length && !tr) {
      ctx.fillStyle = '#5b6680';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(t('auto.lane.empty'), v.headerW + 12, y0 + ROW_H / 2);
    }
  }

  /** Header hit zones (x within the header column). */
  const HB = { arm: [HEADER_W - 64, HEADER_W - 42], mode: [HEADER_W - 38, HEADER_W - 6] };

  function drawHeader(ctx, v) {
    lanes().forEach((l, i) => {
      const y0 = rowY(i);
      const sel = l.id === selLane;
      ctx.fillStyle = sel ? '#1a2335' : '#121826';
      ctx.fillRect(0, y0, HEADER_W, ROW_H);
      ctx.strokeStyle = '#1f2738';
      ctx.beginPath(); ctx.moveTo(0, y0 + ROW_H - 0.5); ctx.lineTo(HEADER_W, y0 + ROW_H - 0.5); ctx.stroke();
      ctx.fillStyle = l.target === 'master' ? '#c7cfe0' : objColor(l.target);
      ctx.fillRect(0, y0 + 6, 3, ROW_H - 12);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = sel ? '#ffffff' : '#d4dbea';
      const title = l.label || objName(l.target);
      ctx.fillText(title.length > 18 ? `${title.slice(0, 17)}…` : title, 10, y0 + 16);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#8a95ad';
      ctx.fillText(paramLabel(l.param), 10, y0 + 33);
      if (l.param === 'pos') {
        let lx = 10 + ctx.measureText(paramLabel(l.param)).width + 8;
        ctx.font = '700 10px system-ui, sans-serif';
        ['X', 'Y', 'Z'].forEach((s, c) => {
          ctx.fillStyle = POS_COLORS[c];
          ctx.fillText(s, lx, y0 + 33);
          lx += 11;
        });
        ctx.font = '11px system-ui, sans-serif';
      }
      ctx.fillStyle = ownerMissing(l) ? '#f5b04a' : '#5b6680';
      const ownerTxt = l.owner === 'show' ? t('auto.owner.show') : ownerMissing(l) ? t('auto.owner.missing') : t('auto.owner.cueShort', { cue: cueLabel(l.owner) });
      ctx.fillText(ownerTxt.length > 22 ? `${ownerTxt.slice(0, 21)}…` : ownerTxt, 10, y0 + 50);
      const live = store.AUTOS?.vals?.[l.id];
      if (live !== undefined) {
        ctx.fillStyle = '#4fd1a5';
        ctx.font = '600 10.5px ui-monospace, Consolas, monospace';
        ctx.fillText(fmtV(l, live), 10, y0 + 65);
      }
      // arm
      const recNow = !!store.AUTOS?.rec?.[l.id];
      const [ax0, ax1] = HB.arm;
      const cy = y0 + 18;
      ctx.beginPath();
      ctx.arc((ax0 + ax1) / 2, cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = l.armed ? (recNow ? '#ff5d6c' : 'rgba(255,93,108,.25)') : '#1b2233';
      ctx.fill();
      ctx.strokeStyle = l.armed ? '#ff5d6c' : '#3a4460';
      ctx.stroke();
      ctx.fillStyle = l.armed ? '#fff' : '#8a95ad';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('R', (ax0 + ax1) / 2, cy + 0.5);
      // mode badge
      const [mx0, mx1] = HB.mode;
      ctx.fillStyle = '#1b2233';
      ctx.strokeStyle = MODE_COLOR[l.mode];
      ctx.beginPath();
      ctx.roundRect(mx0, cy - 9, mx1 - mx0, 18, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = MODE_COLOR[l.mode];
      ctx.font = '700 9.5px system-ui, sans-serif';
      ctx.fillText(t(`auto.mode.short.${l.mode}`), (mx0 + mx1) / 2, cy + 0.5);
      ctx.textAlign = 'left';
    });
  }

  function cueLabel(id) {
    const c = cueList().find((x) => x.id === id);
    return c ? (c.label || c.tc) : id;
  }

  // ---------------- hit testing ----------------
  function hitAt(p) {
    const i = Math.floor(p.cy / ROW_H);
    const l = lanes()[i];
    if (!l || p.cy < 0) return null;
    const y0 = rowY(i);
    if (p.inHeader) {
      const cy = y0 + 18;
      if (Math.abs(p.cy - cy) <= 11) {
        if (p.x >= HB.arm[0] - 2 && p.x <= HB.arm[1] + 2) return { type: 'arm', l, i };
        if (p.x >= HB.mode[0] && p.x <= HB.mode[1]) return { type: 'mode', l, i };
      }
      return { type: 'header', l, i };
    }
    const pts = pointsOf(l);
    const off = offsetOf(l);
    const markers = visiblePoints(tl.v, l).markers;
    let best = -1;
    let bestD = HIT;
    pts.forEach((pt, k) => {
      if (!markers && !(l.id === selLane && selPts.has(k))) return;
      const dx = Math.abs(tl.v.xOf(off + pt[0]) - p.x);
      const d = l.param === 'pos' ? dx : Math.hypot(dx, yOfV(l, pt[1], y0) - p.cy);
      if (d <= bestD) { bestD = d; best = k; }
    });
    if (best >= 0) return { type: 'point', l, i, k: best };
    return { type: 'lane', l, i, rel: p.t - off };
  }

  // ---------------- editing ----------------
  function commitPoints(l, pts) {
    if (!guardEdit()) return;
    const sorted = pts.map((p) => [round3(Math.max(0, p[0])), Array.isArray(p[1]) ? p[1].map(round4) : round4(p[1]), ...(p[2] && p[2] !== 'linear' ? [p[2]] : [])])
      .sort((a, b) => a[0] - b[0]);
    const selTimes = new Set([...selPts].map((k) => pts[k]?.[0]).filter((x) => x !== undefined).map(round3));
    override = { id: l.id, points: sorted };
    selPts = new Set(sorted.map((p, k) => (selTimes.has(p[0]) ? k : -1)).filter((k) => k >= 0));
    send({ type: 'auto.points', id: l.id, points: sorted });
    tl.redraw();
    renderPanel();
  }

  function selectLane(id, { keepPts = false } = {}) {
    if (selLane !== id) {
      selLane = id;
      if (!keepPts) selPts = new Set();
      range = null;
    }
    tl?.redraw();
    renderPanel();
  }

  function cycleMode(l) {
    if (!guardEdit()) return;
    const next = MODES[(MODES.indexOf(l.mode) + 1) % MODES.length];
    send({ type: 'auto.lane.update', id: l.id, patch: { mode: next } });
  }

  function toggleArm(l) {
    if (!guardEdit()) return;
    send({ type: 'auto.arm', id: l.id, armed: !l.armed });
  }

  function addLanes(ids, param, owner = 'show') {
    if (!guardEdit()) return;
    const targets = ids.length ? ids : [];
    if (!targets.length) {
      toast(t('auto.needObjects'), 'warn');
      return;
    }
    const ph = tl?.playheadNow() ?? 0;
    for (const target of targets) {
      const l = { target, param, owner };
      if (lanes().some((x) => x.owner === owner && x.target === target && x.param === param)) {
        toast(t('auto.err.dup'), 'warn');
        continue;
      }
      const tt = round3(Math.max(0, ph - (owner === 'show' ? 0 : offsetOf(l))));
      send({ type: 'auto.lane.add', lane: { ...l, mode: 'read', points: [[tt, currentValue(l)]] } });
    }
    pendingSelect = true;
  }

  function eraseRange(l, a, b) {
    const pts = pointsOf(l);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const outside = pts.filter((p) => p[0] < lo || p[0] > hi);
    if (!outside.length) { commitPoints(l, []); return; }
    const out = [...outside];
    if (pts.some((p) => p[0] < lo)) out.push([lo, valueAt(pts, lo)]);
    if (pts.some((p) => p[0] > hi)) out.push([hi, valueAt(pts, hi)]);
    selPts = new Set();
    range = null;
    commitPoints(l, out);
  }

  function deleteSelected() {
    const l = lane(selLane);
    if (!l) return false;
    if (selPts.size) {
      const pts = pointsOf(l).filter((_, k) => !selPts.has(k));
      selPts = new Set();
      commitPoints(l, pts);
      return true;
    }
    if (range) {
      eraseRange(l, range.a, range.b);
      return true;
    }
    return false;
  }

  const body = {
    height: () => Math.max(lanes().length * ROW_H, 10),
    draw(ctx, v) {
      lanes().forEach((l, i) => drawLane(ctx, v, l, i));
      if (!lanes().length) {
        ctx.fillStyle = '#5b6680';
        ctx.font = '13px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(t('auto.empty'), v.headerW + 16, 28);
      }
    },
    header: drawHeader,
    down(e, p) {
      const hit = hitAt(p);
      if (!hit) { selectLane(null); return false; }
      if (hit.type === 'arm') { selectLane(hit.l.id); toggleArm(hit.l); return false; }
      if (hit.type === 'mode') { selectLane(hit.l.id); cycleMode(hit.l); return false; }
      if (hit.type === 'header') { selectLane(hit.l.id); return false; }
      selectLane(hit.l.id, { keepPts: true });
      if (hit.type === 'point') {
        if (e.shiftKey) {
          if (selPts.has(hit.k)) selPts.delete(hit.k); else selPts.add(hit.k);
        } else if (!selPts.has(hit.k)) {
          selPts = new Set([hit.k]);
        }
        range = null;
        renderPanel();
        if (isLocked()) return false;
        drag = { kind: 'move', l: hit.l, y0: rowY(hit.i), t0: p.t, cy0: p.cy, orig: clone(pointsOf(hit.l)), moved: false };
        return true;
      }
      selPts = new Set();
      range = { id: hit.l.id, a: hit.rel, b: hit.rel };
      drag = { kind: 'range', l: hit.l, off: offsetOf(hit.l) };
      renderPanel();
      return true;
    },
    move(e, p) {
      if (!drag) return;
      if (drag.kind === 'range') {
        range.b = Math.max(0, p.t - drag.off);
        const lo = Math.min(range.a, range.b);
        const hi = Math.max(range.a, range.b);
        selPts = new Set(pointsOf(drag.l).map((pt, k) => (pt[0] >= lo && pt[0] <= hi ? k : -1)).filter((k) => k >= 0));
        return;
      }
      const dt = p.t - drag.t0;
      const [lo, hi] = rangeOf(drag.l);
      const dv = drag.l.param === 'pos' || e.altKey ? 0 : -((p.cy - drag.cy0) / (ROW_H - 2 * PAD)) * (hi - lo);
      const lockT = e.ctrlKey || e.metaKey;
      drag.moved = drag.moved || Math.abs(dt) * tl.v.pps > 2 || Math.abs(p.cy - drag.cy0) > 2;
      const pts = drag.orig.map((pt, k) => {
        if (!selPts.has(k)) return pt;
        const nt = lockT ? pt[0] : Math.max(0, pt[0] + dt);
        const nv = drag.l.param === 'pos' ? pt[1] : clamp(pt[1] + dv, lo, hi);
        return [nt, nv, ...(pt[2] ? [pt[2]] : [])];
      });
      override = { id: drag.l.id, points: pts };
      renderPanelValues();
    },
    up() {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.kind === 'range') {
        if (Math.abs(range.b - range.a) * tl.v.pps < 3) range = null;
        renderPanel();
        return;
      }
      if (d.moved && override?.id === d.l.id) commitPoints(d.l, override.points);
      else if (override?.id === d.l.id && !d.moved) override = null;
    },
    dbl(e, p) {
      const hit = hitAt(p);
      if (!hit || hit.type === 'header' || hit.type === 'arm' || hit.type === 'mode') return false;
      if (!guardEdit()) return false;
      const l = hit.l;
      const pts = pointsOf(l);
      if (hit.type === 'point') {
        commitPoints(l, pts.filter((_, k) => k !== hit.k));
        selPts = new Set();
        return true;
      }
      const tt = Math.max(0, hit.rel);
      const val = l.param === 'pos' ? (valueAt(pts, tt) ?? currentValue(l)) : vOfY(l, p.cy, rowY(hit.i));
      const next = [...pts, [tt, val]];
      selPts = new Set();
      commitPoints(l, next);
      const k = override.points.findIndex((pt) => pt[0] === round3(tt));
      if (k >= 0) selPts = new Set([k]);
      renderPanel();
      return true;
    },
    hover(p) {
      const hit = hitAt(p);
      if (!hit) return '';
      if (hit.type === 'arm' || hit.type === 'mode') return 'pointer';
      if (hit.type === 'point') return isLocked() ? 'default' : hit.l.param === 'pos' ? 'ew-resize' : 'grab';
      if (hit.type === 'lane') return 'crosshair';
      return 'default';
    },
  };

  // ---------------- playhead ----------------
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

  let lastLocateWarn = 0;
  function onLocate(sec, final) {
    tl.setPlayhead(sec, { rolling: false });
    if (!final) return;
    if (store.TC?.settings?.input !== 'internal') {
      if (Date.now() - lastLocateWarn > 4000) toast(t('show.locateInternal'), 'warn');
      lastLocateWarn = Date.now();
      return;
    }
    const r = rate();
    send({ type: 'tc.int.locate', tc: formatTc(secondsToTc(Math.max(0, sec), r), { df: isDf(r) }) });
  }

  // ---------------- keyboard ----------------
  function onKey(e) {
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return false;
    let handled = false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handled = selLane ? (guardEdit() ? deleteSelected() || true : true) : false;
    } else if (e.key === 'Escape') {
      if (selPts.size || range) { selPts = new Set(); range = null; handled = true; }
      else if (selLane) { selLane = null; handled = true; }
      tl?.redraw();
      renderPanel();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selLane && selPts.size) {
      const l = lane(selLane);
      if (l && guardEdit()) {
        const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
        commitPoints(l, pointsOf(l).map((p, k) => (selPts.has(k) ? [Math.max(0, p[0] + step), p[1], ...(p[2] ? [p[2]] : [])] : p)));
      }
      handled = true;
    }
    if (handled) e.preventDefault?.();
    return handled;
  }

  // ---------------- panel ----------------
  const row = (label, ...ctl) => h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ...ctl));
  const numIn = (value, min, max, step, onchange) => {
    const el = h('input', { type: 'number', class: 'ed', value: value ?? '', min, max, step });
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) onchange(clamp(v, min, max));
    });
    return el;
  };
  const selIn = (opts, value, onchange, cls = 'ed') => {
    const el = h('select', { class: cls }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    el.addEventListener('change', () => onchange(el.value));
    return el;
  };

  function paramOptions(target) {
    if (target === 'master') return Object.keys(constants().masterAutoParams ?? { speed: 1 }).map((p) => [p, paramLabel(p)]);
    return ['pos', ...Object.keys(constants().autoParams ?? {})].map((p) => [p, paramLabel(p)]);
  }
  const ownerOptions = () => [['show', t('auto.owner.show')], ...cueList().map((c) => [c.id, t('auto.owner.cue', { cue: c.label ? `${c.tc} · ${c.label}` : c.tc })])];

  function renderPanelValues() {
    const l = lane(selLane);
    if (!l || !els.ptTime) return;
    const pts = pointsOf(l);
    const k = [...selPts][0];
    const p = pts[k];
    if (!p) return;
    if (document.activeElement !== els.ptTime) els.ptTime.value = round3(p[0]);
    if (els.ptVal && document.activeElement !== els.ptVal && !Array.isArray(p[1])) els.ptVal.value = round4(p[1]);
  }

  function renderPanel() {
    if (!panel) return;
    if (panel.contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=number]')) return;
    const locked = isLocked();
    const l = lane(selLane);
    els.ptTime = null;
    els.ptVal = null;
    if (!l) {
      panel.replaceChildren(...addLaneForm(), ...helpBlock());
      for (const el of panel.querySelectorAll('.ed')) el.disabled = locked;
      return;
    }
    const pts = pointsOf(l);
    const kids = [
      h('div', { class: 'section show-sec' }, h('i', { class: 'kind-sw', style: `--h:${l.target === 'master' ? 220 : (l.target * 137.508) % 360}` }), laneTitle(l)),
      h('p', { class: 'hint' }, `${objName(l.target)} · ${paramLabel(l.param)} · ${t('auto.points', { n: pts.length })}`),
      row(t('auto.mode'), modeSeg(l)),
      h('p', { class: 'hint' }, t(`auto.mode.${l.mode}.hint`)),
      row(t('auto.arm'), h('button', {
        class: `ed auto-arm${l.armed ? ' on' : ''}`, type: 'button', 'aria-pressed': String(l.armed), title: t('auto.arm.title'),
        onclick: () => toggleArm(l),
      }, l.armed ? t('auto.armed') : t('auto.disarmed'))),
      row(t('auto.owner'), selIn(ownerOptions(), l.owner, (v) => { if (guardEdit()) send({ type: 'auto.lane.update', id: l.id, patch: { owner: v } }); })),
    ];
    if (ownerMissing(l)) kids.push(h('p', { class: 'hint warn' }, t('auto.owner.missingHint')));
    const label = h('input', { type: 'text', class: 'ed', value: l.label ?? '', maxLength: 32, placeholder: `${objName(l.target)} · ${paramLabel(l.param)}` });
    label.addEventListener('change', () => { if (guardEdit()) send({ type: 'auto.lane.update', id: l.id, patch: { label: label.value } }); });
    kids.push(row(t('show.label'), label));

    kids.push(h('div', { class: 'section' }, t('auto.pointsSec')));
    const k = selPts.size ? [...selPts][0] : -1;
    const p = pts[k];
    if (p) {
      const upd = (fn) => commitPoints(l, pointsOf(l).map((pt, i) => (selPts.has(i) ? fn([...pt]) : pt)));
      els.ptTime = numIn(round3(p[0]), 0, 86400, 0.01, (v) => {
        const d = v - p[0];
        upd((pt) => { pt[0] = Math.max(0, pt[0] + d); return pt; });
      });
      kids.push(h('p', { class: 'hint' }, t('auto.sel', { n: selPts.size })));
      kids.push(row(t('auto.time'), els.ptTime, h('span', { class: 'muted' }, 's')));
      if (Array.isArray(p[1])) {
        ['X', 'Y', 'Z'].forEach((ax, c) => {
          kids.push(row(ax, numIn(round4(p[1][c]), -1, 1, 0.01, (v) => upd((pt) => { pt[1] = pt[1].map((x, i) => (i === c ? v : x)); return pt; }))));
        });
      } else {
        const [lo, hi] = rangeOf(l);
        els.ptVal = numIn(round4(p[1]), lo, hi, (hi - lo) / 100, (v) => upd((pt) => { pt[1] = v; return pt; }));
        kids.push(row(t('auto.value'), els.ptVal, h('span', { class: 'muted' }, `${lo} – ${hi}`)));
      }
      const curves = (constants().autoCurves ?? ['linear', 'step', 'smooth']).map((c) => [c, t(`auto.curve.${c}`)]);
      kids.push(row(t('auto.curve'), selIn(curves, p[2] ?? 'linear', (v) => upd((pt) => [pt[0], pt[1], ...(v !== 'linear' ? [v] : [])]))));
      kids.push(h('div', { class: 'btn-row' }, h('button', { class: 'ed', type: 'button', onclick: () => deleteSelected() }, t('auto.delPoints', { n: selPts.size }))));
    } else {
      kids.push(h('p', { class: 'hint' }, t('auto.noSel')));
    }
    const actions = [
      h('button', { class: 'ed', type: 'button', title: t('auto.addHere.title'), onclick: () => {
        if (!guardEdit()) return;
        const ph = tl.playheadNow() ?? 0;
        const tt = Math.max(0, ph - offsetOf(l));
        commitPoints(l, [...pointsOf(l).filter((x) => Math.abs(x[0] - tt) > 1e-3), [tt, currentValue(l)]]);
      } }, t('auto.addHere')),
    ];
    if (range && range.id === l.id) {
      actions.push(h('button', { class: 'ed', type: 'button', onclick: () => eraseRange(l, range.a, range.b) },
        t('auto.eraseRange', { a: fmtTime(Math.min(range.a, range.b), true), b: fmtTime(Math.max(range.a, range.b), true) })));
    }
    kids.push(h('div', { class: 'btn-row two' }, ...actions));
    kids.push(h('div', { class: 'btn-row two show-actions' },
      armButton(h('button', { class: 'ed', type: 'button' }, t('auto.clear')), () => commitPoints(l, [])),
      armButton(h('button', { class: 'danger ed', type: 'button' }, t('auto.deleteLane')), () => {
        send({ type: 'auto.lane.delete', id: l.id });
        selLane = null;
        renderPanel();
      })));
    kids.push(h('div', { class: 'section' }, t('auto.addSec')), ...addLaneForm(true));
    panel.replaceChildren(...kids);
    for (const el of panel.querySelectorAll('.ed')) el.disabled = locked;
  }

  function modeSeg(l) {
    const seg = h('div', { class: 'seg auto-modes', role: 'radiogroup', 'aria-label': t('auto.mode') });
    for (const m of MODES) {
      seg.append(h('button', {
        class: `ed${l.mode === m ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(l.mode === m), style: `--mc:${MODE_COLOR[m]}`,
        title: t(`auto.mode.${m}.hint`),
        onclick: () => { if (guardEdit() && l.mode !== m) send({ type: 'auto.lane.update', id: l.id, patch: { mode: m } }); },
      }, t(`auto.mode.${m}`)));
    }
    return seg;
  }

  function addLaneForm(compactForm = false) {
    const first = [...(store.selected ?? [])].sort((a, b) => a - b)[0] ?? 1;
    const tSel = selIn([['sel', t('auto.target.sel')], ...Array.from({ length: 32 }, (_, i) => [i + 1, `${i + 1} · ${store.OBJ?.[i]?.name ?? ''}`]), ['master', t('auto.master')]],
      store.selected?.size ? 'sel' : first, () => fillParams());
    const pSel = h('select', { class: 'ed' });
    const fillParams = () => {
      const opts = paramOptions(tSel.value === 'master' ? 'master' : 1);
      const keep = opts.some(([v]) => v === addParam) ? addParam : opts[0][0];
      pSel.replaceChildren(...opts.map(([v, lbl]) => h('option', { value: v, selected: v === keep }, lbl)));
    };
    fillParams();
    pSel.addEventListener('change', () => { addParam = pSel.value; localStorage.setItem(LS_PARAM, addParam); });
    const oSel = selIn(ownerOptions(), 'show', () => {});
    const go = () => {
      const v = tSel.value;
      const ids = v === 'sel' ? [...(store.selected ?? [])].sort((a, b) => a - b) : v === 'master' ? ['master'] : [Number(v)];
      addLanes(ids, pSel.value, oSel.value);
    };
    const out = [];
    if (!compactForm) out.push(h('div', { class: 'section' }, t('auto.addSec')));
    out.push(row(t('auto.target'), tSel), row(t('auto.param'), pSel), row(t('auto.owner'), oSel),
      h('div', { class: 'btn-row' }, h('button', { class: 'accent ed', type: 'button', onclick: go }, t('auto.addLane'))));
    return out;
  }

  function helpBlock() {
    return [
      h('div', { class: 'section' }, t('auto.help')),
      h('ul', { class: 'show-help' },
        h('li', {}, t('auto.help.rec')), h('li', {}, t('auto.help.modes')), h('li', {}, t('auto.help.edit')),
        h('li', {}, t('auto.help.range')), h('li', {}, t('auto.help.stop'))),
    ];
  }

  // ---------------- tools ----------------
  function buildTools(tools) {
    const seg = h('div', { class: 'seg auto-global', role: 'radiogroup', 'aria-label': t('auto.global') });
    for (const m of ['off', 'read', 'write']) {
      seg.append(h('button', {
        type: 'button', 'data-v': m, role: 'radio', title: t(`auto.global.${m}.title`),
        onclick: () => {
          if (m === 'write' && isLocked()) { toast(t('auto.lockedWrite'), 'warn'); return; }
          send({ type: 'auto.global', mode: m });
        },
      }, t(`auto.global.${m}`)));
    }
    els.globalSeg = seg;
    const pSel = selIn(paramOptions(1), addParam, (v) => { addParam = v; localStorage.setItem(LS_PARAM, v); }, 'auto-param');
    pSel.title = t('auto.param');
    els.addSel = h('button', { class: 'accent ed', type: 'button', title: t('auto.addSel.title'), onclick: () => addLanes([...(store.selected ?? [])].sort((a, b) => a - b), pSel.value) }, t('auto.addSel'));
    const followChk = h('input', { type: 'checkbox', checked: follow });
    followChk.addEventListener('change', () => { follow = followChk.checked; localStorage.setItem(LS_FOLLOW, follow ? '1' : '0'); });
    tools.append(h('span', { class: 'muted auto-gl' }, t('auto.global')), seg, h('span', { class: 'ws-sep' }),
      pSel, els.addSel, h('span', { class: 'ws-sep' }),
      h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomOut'), onclick: () => tl.zoom(1 / 1.4) }, '−'),
      h('button', { class: 'btn-ghost', type: 'button', title: t('show.fit'), onclick: fitAll }, t('show.fitShort')),
      h('button', { class: 'btn-ghost', type: 'button', title: t('stg.zoomIn'), onclick: () => tl.zoom(1.4) }, '+'),
      h('span', { class: 'ws-sep' }),
      h('label', { class: 'chk' }, followChk, t('show.follow')));
    renderGlobal();
  }

  function renderGlobal() {
    if (!els.globalSeg) return;
    for (const b of els.globalSeg.querySelectorAll('button')) {
      const on = b.dataset.v === global();
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = b.dataset.v === 'write' && isLocked();
    }
    els.globalSeg.dataset.mode = global();
    if (els.addSel) els.addSel.disabled = isLocked();
  }

  function fitAll() {
    let a = Infinity;
    let b = -Infinity;
    for (const l of lanes()) {
      const off = offsetOf(l);
      for (const p of pointsOf(l)) {
        a = Math.min(a, off + p[0]);
        b = Math.max(b, off + p[0]);
      }
    }
    if (!Number.isFinite(a)) {
      const ph = tl.playheadNow() ?? 0;
      tl.fit(Math.max(0, ph - 10), ph + 50);
      return;
    }
    tl.fit(a, Math.max(b, a + 10));
  }

  function onAutos(m) {
    const rec = m.rec ?? {};
    for (const [id, r] of Object.entries(rec)) {
      const tr = trails.get(id) ?? [];
      if (!tr.length || r.t > tr[tr.length - 1][0]) tr.push([r.t, r.v]);
      if (tr.length > 20000) tr.shift();
      trails.set(id, tr);
    }
    for (const id of [...trails.keys()]) if (!rec[id]) trails.delete(id);
    if (shown) tl?.redraw();
  }

  // ---------------- mount ----------------
  function mount(bodyEl, tools) {
    host = { bodyEl, tools };
    const tlHost = h('div', { class: 'show-tl-host' });
    panel = h('aside', { class: 'show-panel ws-scroll', 'aria-label': t('show.props') });
    bodyEl.classList.add('auto-body');
    bodyEl.append(h('div', { class: 'show-timeline auto-timeline' }, tlHost, panel));
    buildTools(tools);
    tl = createTimelineView(tlHost, { body, onLocate, headerW: HEADER_W });
    tl.canvas.setAttribute('aria-label', t('ws.auto'));
    tl.canvas.addEventListener('keydown', (e) => { if (onKey(e)) e.stopPropagation(); });
    renderPanel();
    syncPlayhead();
    on('auto', () => {
      override = null;
      if (selLane && !lane(selLane)) { selLane = null; selPts = new Set(); range = null; }
      const n = selLane ? pointsOf(lane(selLane)).length : 0;
      selPts = new Set([...selPts].filter((k) => k < n));
      renderGlobal();
      renderPanel();
      tl.redraw();
    });
    on('auto.lane.added', (m) => {
      if (!pendingSelect) return;
      pendingSelect = false;
      setTimeout(() => {
        selectLane(m.id);
        const i = lanes().findIndex((l) => l.id === m.id);
        if (i >= 0) tl.revealY(rowY(i), rowY(i) + ROW_H);
      }, 60);
    });
    on('autos', onAutos);
    on('tcs', syncPlayhead);
    on('tc', () => { tl.redraw(); renderPanel(); });
    on('tc.delta', () => { tl.redraw(); });
    on('state', () => { renderGlobal(); if (shown) tl.redraw(); });
  }

  return {
    mount,
    onShow() {
      shown = true;
      tl?.setActive(true);
      if (!tl.v.w) setTimeout(fitAll, 30);
      syncPlayhead();
      renderGlobal();
      renderPanel();
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
      tl.canvas.setAttribute('aria-label', t('ws.auto'));
      panel.setAttribute('aria-label', t('show.props'));
      renderPanel();
      tl.redraw();
    },
  };
}
