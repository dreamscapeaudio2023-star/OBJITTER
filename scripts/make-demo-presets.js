// Regenerates the bundled demo presets and demo show: `node scripts/make-demo-presets.js [presetDir]`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeObject, MAX_OBJECTS } from '../server/engine.js';
import { PresetStore } from '../server/presets.js';
import { flushWrites } from '../server/fsutil.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new PresetStore(path.resolve(process.argv[2] || path.join(ROOT, 'presets')));
const r3 = (v) => Math.round(v * 1000) / 1000;
const ring = (i, n, r, start = 0) => {
  const a = start + (i * 2 * Math.PI) / n;
  return { x: r3(r * Math.sin(a)), y: r3(r * Math.cos(a)) };
};

async function scene(name, slot, meta, build, extra = {}) {
  const objects = Array.from({ length: MAX_OBJECTS }, (_, i) => {
    const id = i + 1;
    const o = build(id, i);
    return sanitizeObject({ name: `Obj ${id}`, ...(o || { enabled: false }) }, id);
  });
  await store.save(name, { bpm: 120, speed: 1, tempoMult: 1, ...extra, objects });
  await store.setSlot(name, slot);
  await store.setMeta(name, meta);
  console.log(`✓ ${name} (slot ${slot}, ${objects.filter((o) => o.enabled).length} active)`);
}

await scene('Demo - Jitter Swarm', 1, { color: 'orange', note: '12 objects, free-timed hops in an ellipse' }, (id, i) => i < 12 && {
  enabled: true, name: `Swarm ${id}`, mode: 'jitter',
  center: { x: r3(Math.sin(i) * 0.2), y: 0.35, z: 0.2 }, range: { x: 0.4, y: 0.35, z: 0.25 }, rangeShape: 'ellipse',
  timing: { sync: 'free', min: 0.12 + (i % 4) * 0.05, max: 0.5 + (i % 3) * 0.15 }, jumpSlew: 30, restChance: 0.15, minStep: 0.35, seed: 0,
});

await scene('Demo - Slow Orbit & Drift', 2, { color: 'blue', note: '4 orbits + 4 drifting objects' }, (id, i) => {
  if (i < 4) {
    return {
      enabled: true, name: `Orbit ${id}`, mode: 'orbit', center: { x: 0, y: 0, z: 0.15 },
      range: { x: r3(0.45 + i * 0.12), y: r3(0.45 + i * 0.12), z: 0.25 },
      timing: { sync: 'free', min: 9 + i * 3, max: 14 + i * 4 }, orbitDir: i % 2 ? 'ccw' : 'cw',
    };
  }
  if (i < 8) {
    return {
      enabled: true, name: `Drift ${id}`, mode: 'drift', center: { ...ring(i - 4, 4, 0.55, Math.PI / 4), z: 0.3 },
      range: { x: 0.35, y: 0.35, z: 0.3 }, rangeShape: 'ellipse', driftRate: r3(0.06 + (i - 4) * 0.02), driftDepth: 1,
    };
  }
  return null;
});

await scene('Demo - Tempo Glide', 3, { color: 'green', note: 'Tempo-synced glides, mixed divisions' }, (id, i) => i < 8 && {
  enabled: true, name: `Tempo ${id}`, mode: 'glide', center: { x: 0, y: 0.1, z: 0.15 },
  range: { x: 0.85, y: 0.75, z: 0.25 }, rangeShape: i % 2 ? 'ring' : 'box', innerRadius: 0.4,
  timing: {
    sync: 'tempo',
    divisions: [[1, 2], [0.5, 1], [2, 4], [1 / 3, 2 / 3], [1, 1.5], [0.75, 1.5], [4], [1, 2, 4]][i],
    tempoMode: i === 5 ? 'length' : 'grid', phaseOffset: i === 6 ? 0.5 : 0,
  },
  glide: [0.6, 0.9, 1, 0.5, 0.75, 0.8, 1, 0.4][i], easing: i % 3 ? 'inOut' : 'smooth', jumpChance: i === 7 ? 0.25 : 0.05, restChance: 0.1,
});

await scene('Demo - Linear Waypoints', 4, { color: 'teal', note: 'Fixed 6-point loops, constant speed' }, (id, i) => i < 4 && {
  enabled: true, name: `Path ${id}`, mode: 'path', center: { x: 0, y: 0, z: 0.1 }, range: { x: 0.85, y: 0.85, z: 0.2 },
  timing: { sync: 'free', min: 1.5 + i * 0.5, max: 2.5 + i * 0.5 }, glide: 1, easing: 'linear',
  pathPoints: 6, pathRegen: false, pathOrder: 'loop', pathCurve: 'linear', minStep: 0.4, seed: 101 + i,
});

await scene('Demo - Subtle Breath', 5, { color: 'purple', note: 'All 32: tiny drift around a ring' }, (id, i) => ({
  enabled: true, name: `Breath ${id}`, mode: 'drift', center: { ...ring(i, MAX_OBJECTS, i % 2 ? 0.8 : 0.6), z: i % 4 === 0 ? 0.35 : 0.1 },
  range: { x: 0.08, y: 0.08, z: 0.05 }, rangeShape: 'ellipse', driftRate: r3(0.05 + (i % 5) * 0.012), driftDepth: 0.9,
}));

await scene('Demo - Half-time & Double-time', 6, { color: 'yellow', note: '110 BPM: ½×, 1×, 2× groups' }, (id, i) => {
  if (i >= 12) return null;
  const group = Math.floor(i / 4);
  return {
    enabled: true,
    name: ['Half', 'Beat', 'Double'][group] + ` ${id}`,
    mode: group === 1 ? 'orbit' : 'glide',
    center: { x: [-0.45, 0, 0.45][group], y: 0.2, z: 0.15 },
    range: { x: 0.35, y: 0.5, z: 0.15 },
    timing: { sync: 'tempo', divisions: group === 1 ? [4] : [1], phaseOffset: r3((i % 4) * 0.25) },
    speedScale: [0.5, 1, 2][group], glide: 0.85, orbitDir: i % 2 ? 'ccw' : 'cw',
  };
}, { bpm: 110 });

await scene('Demo - Jump vs Slide', 7, { color: 'red', note: 'Left: hard jumps (no slew) · Right: slides on the same beat' }, (id, i) => {
  if (i >= 8) return null;
  const jump = i < 4;
  return {
    enabled: true, name: `${jump ? 'Jump' : 'Slide'} ${id}`, mode: jump ? 'jitter' : 'glide',
    center: { x: jump ? -0.5 : 0.5, y: 0.1, z: 0.1 }, range: { x: 0.35, y: 0.6, z: 0.1 },
    timing: { sync: 'tempo', divisions: [1], phaseOffset: r3((i % 4) * 0.25) },
    jumpSlew: 0, minStep: 0.4, glide: 0.9, easing: 'inOut', seed: 700 + i,
  };
});

await scene('Demo - Stab & Hold', 8, { color: 'pink', note: 'Beat-synced hard hops that often rest (hold) for a beat' }, (id, i) => i < 8 && {
  enabled: true, name: `Stab ${id}`, mode: 'jitter', center: { ...ring(i, 8, 0.45), z: 0.15 },
  range: { x: 0.3, y: 0.3, z: 0.1 }, rangeShape: 'ellipse',
  timing: { sync: 'tempo', divisions: [0.5, 1] }, jumpSlew: 0, restChance: 0.55, minStep: 0.3, seed: 800 + i,
}, { bpm: 124 });

await flushWrites();

const cue = (tc, label, fields) => ({ tc, label, enabled: true, ...fields });
const show = {
  app: 'objitter',
  kind: 'show',
  version: 2,
  name: 'Demo Show (internal clock)',
  timecode: {
    settings: { rate: '25', offset: '+00:00:00:00', chase: true, chaseFade: 0.3, freewheel: 0.5, autoStart: false, onLoss: 'hold', preroll: 2, trigger: 'tc' },
    cues: [
      cue('00:00:02:00', 'Intro breath', { action: 'slot', preset: 'Demo - Subtle Breath', fade: 2 }),
      cue('00:00:04:00', 'Run', { action: 'start' }),
      cue('00:00:08:00', 'Swarm front', { action: 'slot', preset: 'Demo - Jitter Swarm', fade: 1.5, targets: '1-12', curve: 'out', stagger: 0.6, staggerOrder: 'id' }),
      cue('00:00:14:00', 'Orbits', { action: 'slot', preset: 'Demo - Slow Orbit & Drift', fade: 3, targets: '1-8', curve: 'smooth' }),
      cue('00:00:20:00', 'Tempo 120', { action: 'slot', preset: 'Demo - Tempo Glide', fade: 1, bpm: 120, anchorBeat: true }),
      cue('00:00:26:00', 'Jump vs slide', { action: 'slot', preset: 'Demo - Jump vs Slide', fade: 0, anchorBeat: true }),
      cue('00:00:32:00', 'Stabs', { action: 'slot', preset: 'Demo - Stab & Hold', fade: 0.5, globals: 'preset', seedOffset: 1 }),
      cue('00:00:38:00', 'Freeze', { action: 'freeze' }),
      cue('00:00:40:00', 'Release', { action: 'unfreeze' }),
      cue('00:00:44:00', 'Home 1-4', { action: 'home', fade: 2, targets: '1-4', stagger: 0.4, staggerOrder: 'distance' }),
      cue('00:00:48:00', 'Waypoints', { action: 'slot', preset: 'Demo - Linear Waypoints', fade: 2 }),
      cue('00:00:56:00', 'Stop', { action: 'stop' }),
    ],
  },
  groups: [],
  slots: [],
};
const showDir = path.join(ROOT, 'demo');
fs.mkdirSync(showDir, { recursive: true });
fs.writeFileSync(path.join(showDir, 'Demo Show.objitter-show.json'), `${JSON.stringify(show, null, 2)}\n`);
console.log(`✓ demo/Demo Show.objitter-show.json (${show.timecode.cues.length} cues)`);
