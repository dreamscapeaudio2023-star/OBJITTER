// Speaker layout parsers (pure functions) and the stage state (background image + speaker layout).
//
// Speaker items are in metres, Objitter axes: x + = right, y + = front (stage), z + = up.
// yaw = facing direction in degrees (0 = toward the front, + = clockwise seen from above / toward +x);
// null = aim at the listening position.
import { isPlainObject } from './fsutil.js';

export const MAX_SPEAKERS = 256;
const DEG = Math.PI / 180;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const fin = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const wrapDeg = (a) => {
  const x = r4(((a + 180) % 360 + 360) % 360 - 180);
  return x === -180 ? 180 : x;
};
const cleanName = (s, max = 40) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** Azimuth (+ = right, SPAT/Objitter adapter convention), elevation, distance → x, y, z. */
export function aedToXyz(az, el, d) {
  const a = fin(az) * DEG;
  const e = fin(el) * DEG;
  const dist = fin(d);
  return { x: r4(dist * Math.cos(e) * Math.sin(a)), y: r4(dist * Math.cos(e) * Math.cos(a)), z: r4(dist * Math.sin(e)) };
}

function item(name, p, yaw, kind = 'main', group = '') {
  return {
    name: cleanName(name) || '?', x: r4(fin(p.x)), y: r4(fin(p.y)), z: r4(fin(p.z)),
    yaw: yaw === null || yaw === undefined || !Number.isFinite(Number(yaw)) ? null : wrapDeg(Number(yaw)),
    kind: kind === 'sub' ? 'sub' : 'main', group: cleanName(group, 24),
  };
}

// ---------------- SPAT Revolution (.json) ----------------
const props = (o) => Object.fromEntries((Array.isArray(o?.Properties) ? o.Properties : []).filter(isPlainObject).map((p) => [p.Name, p.Value]));

/** Returns { format: 'spat', rooms: [{ index, name, speakers: [...] }] }. */
export function parseSpat(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const rooms = d?.Studio?.Grid?.Room;
  if (!Array.isArray(rooms)) throw new Error('not a SPAT Revolution file (Studio.Grid.Room missing)');
  return {
    format: 'spat',
    rooms: rooms.filter(isPlainObject).map((r, index) => {
      const speakers = [];
      for (const s of (Array.isArray(r.Speakers) ? r.Speakers : []).filter(isPlainObject)) {
        const p = props(s);
        const ch = s.OutputConfig?.Channels?.[0] ?? s.InputConfig?.Channels?.[0] ?? {};
        const az = fin(p.Azimuth ?? ch.Azimuth);
        const el = fin(p.Elevation ?? ch.Elevation);
        const dist = fin(p.Distance ?? ch.Distance, 1);
        const yawRel = fin(p.Yaw ?? ch.Yaw);
        const name = cleanName(s.Name);
        const group = s.OutputConfig?.Groups?.[0]?.Name ?? '';
        const sub = /\b(sub|lfe)\b/i.test(name) || /\b(sub|lfe)\b/i.test(group);
        // SPAT yaw 0 = aimed at the listener; absolute facing = azimuth + 180 + yaw.
        speakers.push(item(name, aedToXyz(az, el, dist), az + 180 + yawRel, sub ? 'sub' : 'main', group));
        if (speakers.length >= MAX_SPEAKERS) break;
      }
      return { index, name: cleanName(r.Name) || `Room ${index + 1}`, speakers };
    }),
  };
}

// ---------------- L-ISA Controller (.lisa, XML) ----------------
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return out;
}

/** Returns { format: 'lisa', rooms: [{ index: 0, name, speakers }] }. */
export function parseLisa(xml) {
  const text = String(xml);
  const bus = text.match(/<Bus\s+Name="Speakers"[^>]*>([\s\S]*?)<\/Bus>/);
  if (!bus) throw new Error('not an L-ISA session (Speakers bus missing)');
  const subIds = new Set();
  const groupOf = new Map();
  for (const g of text.matchAll(/<SpeakerGroup\s([^>]*)>([\s\S]*?)<\/SpeakerGroup>/g)) {
    const ga = attrs(g[1]);
    const isSub = /\bsub\b/i.test(ga.Name ?? '') || ga.Usage === '10';
    for (const s of g[2].matchAll(/<Speaker\s([^>]*)\/?>/g)) {
      const id = attrs(s[1]).Speaker;
      if (!id) continue;
      if (isSub) subIds.add(id);
      if (!groupOf.has(id)) groupOf.set(id, ga.Name ?? '');
    }
  }
  const speakers = [];
  for (const c of bus[1].matchAll(/<Channel\s([^>]*?)\/?>/g)) {
    const a = attrs(c[1]);
    if (a.Enabled === '0') continue;
    const yaw = a.Azimuth !== undefined ? fin(a.Azimuth) / DEG : null;
    const sub = subIds.has(a.UUID) || /\b(sub|subwoofer|lfe)\b/i.test(a.Name ?? '');
    speakers.push(item(a.Name, { x: a.X, y: a.Y, z: a.Z }, yaw, sub ? 'sub' : 'main', groupOf.get(a.UUID) ?? ''));
    if (speakers.length >= MAX_SPEAKERS) break;
  }
  const name = text.match(/<Space\s[^>]*Name="([^"]*)"/)?.[1] ?? 'L-ISA';
  return { format: 'lisa', rooms: [{ index: 0, name: cleanName(name) || 'L-ISA', speakers }] };
}

// ---------------- CSV / TSV (QLab exports, spreadsheets) ----------------
/**
 * Header row decides the columns: name + (x, y, z) or (az|azimuth, el|elevation, dist|distance),
 * optional yaw, kind/type, group. Without a header: name,x,y,z[,yaw].
 */
export function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('empty file');
  const sep = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? '\t' : (lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
  const split = (l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const head = split(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = head.some((c) => /^(name|x|y|z|az|azimuth|el|elevation|dist|distance|label)$/.test(c));
  const col = (...names) => head.findIndex((c) => names.includes(c));
  const ix = hasHeader ? {
    name: col('name', 'label', 'speaker'), x: col('x'), y: col('y'), z: col('z'),
    az: col('az', 'azimuth'), el: col('el', 'elevation'), d: col('dist', 'distance', 'd'),
    yaw: col('yaw', 'facing'), kind: col('kind', 'type'), group: col('group'),
  } : { name: 0, x: 1, y: 2, z: 3, az: -1, el: -1, d: -1, yaw: 4, kind: -1, group: -1 };
  const polar = ix.x < 0 && ix.az >= 0;
  if (!polar && (ix.x < 0 || ix.y < 0)) throw new Error('CSV needs x,y[,z] or az,el,dist columns');
  const speakers = [];
  for (const l of lines.slice(hasHeader ? 1 : 0)) {
    const c = split(l);
    const get = (i) => (i >= 0 ? c[i] : undefined);
    const p = polar ? aedToXyz(get(ix.az), get(ix.el) ?? 0, get(ix.d) ?? 1) : { x: get(ix.x), y: get(ix.y), z: get(ix.z) ?? 0 };
    if (![p.x, p.y].every((v) => Number.isFinite(Number(v)))) continue;
    const yawRaw = get(ix.yaw);
    const name = get(ix.name) ?? `${speakers.length + 1}`;
    const kind = /sub|lfe/i.test(get(ix.kind) ?? '') || /\b(sub|lfe)\b/i.test(name) ? 'sub' : 'main';
    speakers.push(item(name, p, yawRaw === undefined || yawRaw === '' ? null : Number(yawRaw), kind, get(ix.group) ?? ''));
    if (speakers.length >= MAX_SPEAKERS) break;
  }
  if (!speakers.length) throw new Error('no speaker rows found');
  return { format: 'csv', rooms: [{ index: 0, name: 'CSV', speakers }] };
}

/** Plain JSON list: [{ name, x, y, z, yaw?, kind?, group? }] or { speakers: [...] }. */
function parseJsonList(d) {
  const list = Array.isArray(d) ? d : d?.speakers;
  if (!Array.isArray(list)) return null;
  const speakers = list.filter(isPlainObject).slice(0, MAX_SPEAKERS).map((s, i) => {
    const p = Number.isFinite(Number(s.x)) ? s : aedToXyz(s.az ?? s.azimuth, s.el ?? s.elevation ?? 0, s.dist ?? s.distance ?? 1);
    return item(s.name ?? `${i + 1}`, p, s.yaw ?? null, s.kind, s.group);
  });
  if (!speakers.length) return null;
  return { format: 'json', rooms: [{ index: 0, name: cleanName(d?.name) || 'JSON', speakers }] };
}

/** Detects the format from the content (file name only breaks ties). */
export function parseLayout(text, filename = '') {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  const head = s.trimStart().slice(0, 1);
  if (head === '<') return parseLisa(s);
  if (head === '{' || head === '[') {
    const d = JSON.parse(s);
    if (d?.Studio?.Grid) return parseSpat(d);
    const j = parseJsonList(d);
    if (j) return j;
    throw new Error('unknown JSON layout');
  }
  if (/\.lisa$/i.test(filename)) return parseLisa(s);
  return parseCsv(s);
}

/** Metres per normalized unit so the farthest speaker (horizontal) sits at 1.0. */
export function fitScale(items) {
  let m = 0;
  for (const s of items) m = Math.max(m, Math.abs(s.x), Math.abs(s.y));
  return m > 0 ? r4(m) : 1;
}

// ---------------- stage state ----------------
export const ASSET_ID_RE = /^[a-f0-9]{32}\.(png|jpg|webp)$/;

export function defaultStage() {
  return {
    background: { asset: null, name: '', x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5, visible: true },
    speakers: {
      name: '', source: '', items: [],
      transform: { metersPerUnit: 1, offsetX: 0, offsetY: 0, rotation: 0, mirrorX: false },
      visible: true, labels: true,
    },
  };
}

const numIn = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.min(b, Math.max(a, Number(v))) : d);
const boolOr = (v, d) => (typeof v === 'boolean' ? v : d);

/** Merges a (possibly partial) stage patch over `prev`; unknown fields are dropped. */
export function sanitizeStage(src, prev = defaultStage()) {
  const s = isPlainObject(src) ? src : {};
  const bIn = isPlainObject(s.background) ? s.background : {};
  const pb = prev.background;
  const asset = bIn.asset === null ? null : (typeof bIn.asset === 'string' && ASSET_ID_RE.test(bIn.asset) ? bIn.asset : pb.asset);
  const background = {
    asset,
    name: typeof bIn.name === 'string' ? cleanName(bIn.name, 80) : (asset === pb.asset ? pb.name : ''),
    x: r4(numIn(bIn.x, -4, 4, pb.x)),
    y: r4(numIn(bIn.y, -4, 4, pb.y)),
    scale: r4(numIn(bIn.scale, 0.05, 20, pb.scale)),
    rotation: r4(numIn(bIn.rotation, -360, 360, pb.rotation)),
    opacity: r4(numIn(bIn.opacity, 0, 1, pb.opacity)),
    visible: boolOr(bIn.visible, pb.visible),
  };
  const spIn = isPlainObject(s.speakers) ? s.speakers : {};
  const ps = prev.speakers;
  const tIn = isPlainObject(spIn.transform) ? spIn.transform : {};
  const pt = ps.transform;
  const items = Array.isArray(spIn.items)
    ? spIn.items.filter(isPlainObject).slice(0, MAX_SPEAKERS).map((it) => item(it.name, { x: numIn(it.x, -1000, 1000, 0), y: numIn(it.y, -1000, 1000, 0), z: numIn(it.z, -1000, 1000, 0) }, it.yaw, it.kind, it.group))
    : ps.items;
  const speakers = {
    name: typeof spIn.name === 'string' ? cleanName(spIn.name, 80) : ps.name,
    source: typeof spIn.source === 'string' ? cleanName(spIn.source, 16) : ps.source,
    items,
    transform: {
      metersPerUnit: r4(numIn(tIn.metersPerUnit, 0.01, 1000, pt.metersPerUnit)),
      offsetX: r4(numIn(tIn.offsetX, -4, 4, pt.offsetX)),
      offsetY: r4(numIn(tIn.offsetY, -4, 4, pt.offsetY)),
      rotation: r4(numIn(tIn.rotation, -360, 360, pt.rotation)),
      mirrorX: boolOr(tIn.mirrorX, pt.mirrorX),
    },
    visible: boolOr(spIn.visible, ps.visible),
    labels: boolOr(spIn.labels, ps.labels),
  };
  return { background, speakers };
}

/** Speaker position in normalized stage units (what the canvas draws). */
export function speakerToStage(it, tf) {
  let x = tf.mirrorX ? -it.x : it.x;
  let y = it.y;
  const a = (tf.rotation || 0) * DEG;
  if (a) [x, y] = [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
  const k = tf.metersPerUnit || 1;
  return { x: x / k + tf.offsetX, y: y / k + tf.offsetY, z: it.z / k };
}
