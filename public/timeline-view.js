// Shared time axis for the Show timeline and the Automation editor: ruler, zoom / pan, playhead,
// a sticky header column and a vertically scrolling body drawn by the owner.
//
// body = {
//   height(): content height (px) below the ruler,
//   draw(ctx, v), header(ctx, v),        // body area / left column, already translated for scrollY
//   down(e, p, v) → true if handled, move(e, p, v), up(e, p, v), dbl(e, p, v), hover(p, v) → cursor
// }
// p = { x, y, t, row y in content coords, inHeader }
import { h } from './core.js';

const NICE = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function fmtTime(sec, withFrac = false) {
  const s = Math.max(0, sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const sec2 = withFrac ? ss.toFixed(1).padStart(4, '0') : String(Math.floor(ss)).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${sec2}` : `${mm}:${sec2}`;
}

export function createTimelineView(host, { headerW = 132, rulerH = 26, body, onLocate = null, minPps = 0.5, maxPps = 600 } = {}) {
  const canvas = h('canvas', { class: 'tl-canvas', tabindex: '0' });
  const wrap = h('div', { class: 'tl-wrap' }, canvas);
  host.append(wrap);
  const v = {
    t0: 0, pps: 40, scrollY: 0, headerW, rulerH, w: 0, h: 0,
    playhead: null, playheadRolling: false, playheadRate: 1, playheadAt: 0,
    marks: [], loop: null,
  };
  let dirty = true;
  let raf = 0;
  let active = true;
  let drag = null;

  v.xOf = (t) => headerW + (t - v.t0) * v.pps;
  v.tOf = (x) => v.t0 + (x - headerW) / v.pps;
  v.bodyH = () => v.h - rulerH;

  function point(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, t: v.tOf(x), cy: y - rulerH + v.scrollY, inHeader: x < headerW, inRuler: y < rulerH };
  }

  function clampScroll() {
    const max = Math.max(0, body.height() - v.bodyH());
    v.scrollY = Math.min(Math.max(0, v.scrollY), max);
    v.t0 = Math.max(-2, v.t0);
  }

  function zoomAt(x, factor) {
    const t = v.tOf(x);
    v.pps = Math.min(maxPps, Math.max(minPps, v.pps * factor));
    v.t0 = t - (x - headerW) / v.pps;
    clampScroll();
    dirty = true;
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = point(e);
    if (e.ctrlKey || e.metaKey) zoomAt(Math.max(headerW, p.x), e.deltaY > 0 ? 1 / 1.15 : 1.15);
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) v.t0 += ((e.shiftKey ? e.deltaY : e.deltaX) / v.pps) * 0.9;
    else v.scrollY += e.deltaY;
    clampScroll();
    dirty = true;
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    const p = point(e);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag = { pan: true, x: e.clientX, y: e.clientY, t0: v.t0, sy: v.scrollY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (p.inRuler && !p.inHeader) {
      drag = { ruler: true };
      canvas.setPointerCapture(e.pointerId);
      onLocate?.(Math.max(0, p.t), false);
      return;
    }
    if (body.down?.(e, p, v)) {
      drag = { body: true };
      canvas.setPointerCapture(e.pointerId);
      dirty = true;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = point(e);
    if (drag?.pan) {
      v.t0 = drag.t0 - (e.clientX - drag.x) / v.pps;
      v.scrollY = drag.sy - (e.clientY - drag.y);
      clampScroll();
      dirty = true;
      return;
    }
    if (drag?.ruler) { onLocate?.(Math.max(0, p.t), false); return; }
    if (drag?.body) { body.move?.(e, p, v); dirty = true; return; }
    canvas.style.cursor = p.inRuler && !p.inHeader && onLocate ? 'col-resize' : body.hover?.(p, v) ?? '';
  });
  const end = (e) => {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (was.ruler) onLocate?.(Math.max(0, point(e).t), true);
    if (was.body) body.up?.(e, point(e), v);
    dirty = true;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => { if (body.dbl?.(e, point(e), v)) dirty = true; });
  new ResizeObserver(() => { dirty = true; }).observe(wrap);

  function niceStep() {
    const want = 90 / v.pps;
    return NICE.find((s) => s >= want) ?? 3600;
  }

  function playheadNow() {
    if (v.playhead === null) return null;
    if (!v.playheadRolling) return v.playhead;
    return v.playhead + ((performance.now() - v.playheadAt) / 1000) * v.playheadRate;
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!active) return;
    if (v.playheadRolling) dirty = true;
    if (!dirty) return;
    dirty = false;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const hh = wrap.clientHeight;
    if (!w || !hh) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hh}px`;
    }
    v.w = w;
    v.h = hh;
    clampScroll();
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = '#0d1119';
    ctx.fillRect(0, 0, w, hh);

    const step = niceStep();
    const tStart = Math.floor(v.t0 / step) * step;
    const tEnd = v.tOf(w);
    // grid
    ctx.save();
    ctx.beginPath();
    ctx.rect(headerW, rulerH, w - headerW, hh - rulerH);
    ctx.clip();
    for (let t = tStart; t <= tEnd; t += step) {
      const x = Math.round(v.xOf(t)) + 0.5;
      ctx.strokeStyle = Math.abs(t % (step * 5)) < 1e-6 ? 'rgba(58,68,96,.55)' : 'rgba(42,51,70,.45)';
      ctx.beginPath(); ctx.moveTo(x, rulerH); ctx.lineTo(x, hh); ctx.stroke();
    }
    ctx.translate(0, rulerH - v.scrollY);
    body.draw(ctx, v);
    ctx.restore();

    // header column
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rulerH, headerW, hh - rulerH);
    ctx.clip();
    ctx.fillStyle = '#121826';
    ctx.fillRect(0, rulerH, headerW, hh - rulerH);
    ctx.translate(0, rulerH - v.scrollY);
    body.header?.(ctx, v);
    ctx.restore();
    ctx.strokeStyle = '#2a3346';
    ctx.beginPath(); ctx.moveTo(headerW + 0.5, 0); ctx.lineTo(headerW + 0.5, hh); ctx.stroke();

    // ruler
    ctx.fillStyle = '#151c2b';
    ctx.fillRect(headerW, 0, w - headerW, rulerH);
    ctx.strokeStyle = '#2a3346';
    ctx.beginPath(); ctx.moveTo(0, rulerH + 0.5); ctx.lineTo(w, rulerH + 0.5); ctx.stroke();
    ctx.font = '600 10.5px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let t = Math.max(0, tStart); t <= tEnd; t += step) {
      const x = Math.round(v.xOf(t)) + 0.5;
      if (x < headerW) continue;
      ctx.strokeStyle = '#4a5572';
      ctx.beginPath(); ctx.moveTo(x, rulerH - 7); ctx.lineTo(x, rulerH); ctx.stroke();
      ctx.fillStyle = '#8a95ad';
      ctx.fillText(fmtTime(t, step < 1), x + 4, rulerH / 2);
      for (let k = 1; k < 5; k++) {
        const xs = Math.round(v.xOf(t + (k * step) / 5)) + 0.5;
        ctx.strokeStyle = '#2f384d';
        ctx.beginPath(); ctx.moveTo(xs, rulerH - 3); ctx.lineTo(xs, rulerH); ctx.stroke();
      }
    }
    for (const mk of v.marks) {
      const x = v.xOf(mk.t);
      if (x < headerW || x > w) continue;
      ctx.fillStyle = mk.color ?? '#f5d76e';
      ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.fill();
    }
    ctx.fillStyle = '#121826';
    ctx.fillRect(0, 0, headerW, rulerH);

    // playhead
    const ph = playheadNow();
    if (ph !== null) {
      const x = Math.round(v.xOf(ph)) + 0.5;
      if (x >= headerW && x <= w) {
        ctx.strokeStyle = '#ff5d6c';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hh); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#ff5d6c';
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.fill();
      }
      v.onPlayhead?.(ph);
    }
  }
  raf = requestAnimationFrame(draw);

  return {
    v, canvas, el: wrap,
    redraw() { dirty = true; },
    setActive(on) { active = on; dirty = true; },
    setPlayhead(t, { rolling = false, rate = 1 } = {}) {
      v.playhead = t;
      v.playheadRolling = rolling && t !== null;
      v.playheadRate = rate;
      v.playheadAt = performance.now();
      dirty = true;
    },
    playheadNow,
    fit(a, b) {
      const span = Math.max(1, b - a);
      const avail = Math.max(100, (wrap.clientWidth || 800) - headerW - 40);
      v.pps = Math.min(maxPps, Math.max(minPps, avail / span));
      v.t0 = a - 20 / v.pps;
      dirty = true;
    },
    zoom(factor) { zoomAt(headerW + ((wrap.clientWidth || 800) - headerW) / 2, factor); },
    reveal(t) {
      const x = v.xOf(t);
      if (x < headerW + 20 || x > (wrap.clientWidth || 800) - 40) {
        v.t0 = t - ((wrap.clientWidth || 800) - headerW) * 0.25 / v.pps;
        dirty = true;
      }
    },
    revealY(y0, y1) {
      if (y0 < v.scrollY) v.scrollY = y0;
      else if (y1 > v.scrollY + v.bodyH()) v.scrollY = y1 - v.bodyH();
      dirty = true;
    },
    destroy() { cancelAnimationFrame(raf); wrap.remove(); },
  };
}
