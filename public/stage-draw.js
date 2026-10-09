// Background image + speaker layout drawing, shared by the main stage and the Stage Setup preview.
// m = mapping from topMapping(): { toPx(x, y), size, cx, cy } in normalized stage units.

const DEG = Math.PI / 180;
const images = new Map();
const loadSubs = new Set();

/** Called when a background image finishes loading (so canvases can redraw). */
export function onImageLoad(fn) {
  loadSubs.add(fn);
  return () => loadSubs.delete(fn);
}

export function imageFor(asset) {
  if (!asset) return null;
  let e = images.get(asset);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, err: false };
    img.onload = () => { e.ok = true; for (const fn of loadSubs) fn(); };
    img.onerror = () => { e.err = true; for (const fn of loadSubs) fn(); };
    img.src = `assets/${asset}`;
    images.set(asset, e);
  }
  return e;
}

/** Width/height of the background in normalized units (scale 1 = full stage width). */
export function backgroundSize(bg) {
  const e = imageFor(bg?.asset);
  if (!e?.ok) return null;
  const w = 2 * bg.scale;
  return { w, h: (w * e.img.naturalHeight) / Math.max(1, e.img.naturalWidth) };
}

export function drawBackground(ctx, m, bg, { opacityScale = 1 } = {}) {
  if (!bg?.asset) return false;
  const e = imageFor(bg.asset);
  if (!e.ok) return false;
  const sz = backgroundSize(bg);
  const [px, py] = m.toPx(bg.x, bg.y);
  const wpx = (sz.w * m.size) / 2;
  const hpx = (sz.h * m.size) / 2;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, bg.opacity * opacityScale));
  ctx.translate(px, py);
  ctx.rotate((bg.rotation || 0) * DEG);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(e.img, -wpx / 2, -hpx / 2, wpx, hpx);
  ctx.restore();
  return true;
}

/** Speaker position in normalized stage units; mirrors server/layouts.js speakerToStage. */
export function speakerToStage(it, tf) {
  let x = tf.mirrorX ? -it.x : it.x;
  let y = it.y;
  const a = (tf.rotation || 0) * DEG;
  if (a) [x, y] = [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
  const k = tf.metersPerUnit || 1;
  return { x: x / k + tf.offsetX, y: y / k + tf.offsetY, z: it.z / k };
}

/** Facing angle on screen (deg clockwise from "up" = front) after the layout transform. */
export function speakerFacing(it, tf, p) {
  if (it.yaw === null || it.yaw === undefined) {
    const lx = tf.offsetX - p.x;
    const ly = tf.offsetY - p.y;
    return Math.atan2(lx, ly) / DEG;
  }
  return (tf.mirrorX ? -it.yaw : it.yaw) + (tf.rotation || 0);
}

const hueOf = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h * 137.508) % 360;
};
export const groupColor = (it, a = 1) => (it.kind === 'sub' ? `hsla(36, 92%, 60%, ${a})` : `hsla(${it.group ? hueOf(it.group) : 205}, 30%, 78%, ${a})`);

/**
 * Speakers as boxes seen from above: the front face (bright edge) shows where the cabinet points.
 * Subs are squares with a cone. Elevated speakers (above ear level) are drawn hollow.
 */
export function drawSpeakers(ctx, m, sp, { labels = sp?.labels, font = '10px system-ui', alpha = 1, scale = 1, highlight = null } = {}) {
  const items = sp?.items ?? [];
  if (!items.length) return;
  const tf = sp.transform;
  const pts = items.map((it) => speakerToStage(it, tf));
  const bw = 15 * scale;
  const bd = 10 * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  items.forEach((it, i) => {
    const p = pts[i];
    const [px, py] = m.toPx(p.x, p.y);
    const col = groupColor(it);
    const elevated = p.z > 0.12;
    const hi = highlight === i;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(speakerFacing(it, tf, p) * DEG);
    ctx.lineWidth = hi ? 2 : 1.2;
    if (it.kind === 'sub') {
      const s = 16 * scale;
      ctx.fillStyle = groupColor(it, 0.28);
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.rect(-s / 2, -s / 2, s, s); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = elevated ? 'rgba(13,17,25,.85)' : groupColor(it, 0.32);
      ctx.strokeStyle = col;
      if (elevated) ctx.setLineDash([2.5, 2]);
      ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2.6 * scale;
      ctx.beginPath(); ctx.moveTo(-bw / 2 + 1, -bd / 2); ctx.lineTo(bw / 2 - 1, -bd / 2); ctx.stroke();
    }
    if (hi) {
      ctx.strokeStyle = '#f5d76e';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, 13 * scale, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  });
  if (labels) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    items.forEach((it, i) => {
      const [px, py] = m.toPx(pts[i].x, pts[i].y);
      ctx.fillStyle = 'rgba(11,14,20,.75)';
      const tw = ctx.measureText(it.name).width;
      ctx.fillRect(px - tw / 2 - 2, py + 10 * scale, tw + 4, 12);
      ctx.fillStyle = groupColor(it, 0.95);
      ctx.fillText(it.name, px, py + 10 * scale + 1);
    });
  }
  ctx.restore();
}

/** Front view (x, z): small markers so the height of the layout is visible next to the objects. */
export function drawSpeakersSide(ctx, m, sp, { alpha = 0.9 } = {}) {
  const items = sp?.items ?? [];
  if (!items.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const it of items) {
    const p = speakerToStage(it, sp.transform);
    const [px, pz] = m.toPx(p.x, Math.max(-1, Math.min(1, p.z)));
    ctx.fillStyle = groupColor(it, 0.35);
    ctx.strokeStyle = groupColor(it);
    ctx.lineWidth = 1;
    const s = it.kind === 'sub' ? 8 : 7;
    ctx.beginPath(); ctx.rect(px - s / 2, pz - s / 2, s, s); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

/** Largest horizontal speaker distance (m) — "fit to layout" puts it at 1.0. */
export function layoutExtent(items) {
  let mx = 0;
  for (const s of items ?? []) mx = Math.max(mx, Math.abs(s.x), Math.abs(s.y));
  return mx || 1;
}
