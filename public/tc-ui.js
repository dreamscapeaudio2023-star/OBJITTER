import { MtcParser, parseTc, formatTc, RATE_REAL } from './tc-core.js';
import { t, tm, getLang, kbd, IS_MAC } from './i18n.js';
import { emit, on, store } from './core.js';

const RATES = ['auto', '23.976', '24', '25', '29.97df', '29.97nd', '30'];
const RATE_LABEL = { '29.97df': '29.97DF', '29.97nd': '29.97ND' };
const ACTIONS = ['slot', 'library', 'start', 'stop', 'home', 'freeze', 'unfreeze', 'clips'];
const CURVES = ['inOut', 'linear', 'in', 'out', 'smooth'];
const ORDERS = ['id', 'random', 'distance'];
const srcName = (k) => (k ? t(`tc.src.${k}`) : '—');
const inputName = (k) => t(`tc.input.${k}`);
const stateName = (k) => t(`tc.state.${k}`);
const actionName = (k) => t(`tc.action.${k}`);
const curveName = (k) => t(`tc.curve.${k}`);
const orderName = (k) => t(`tc.order.${k}`);
const triggerName = (k) => t(`tc.trigger.${k}`);
const LS = {
  mtcDevice: 'objitter.tc.mtcDevice',
  ltcDevice: 'objitter.tc.ltcDevice',
  ltcChannel: 'objitter.tc.ltcChannel',
  applySlots: 'objitter.tc.applySlots',
  settingsOpen: 'objitter.tc.settingsOpen',
};
const ERR_KEYS = { NotAllowedError: 'tc.err.notAllowed', NotFoundError: 'tc.err.notFound', NotReadableError: 'tc.err.notReadable', OverconstrainedError: 'tc.err.overconstrained' };
const GO_GUARD_MS = 300;
const now = () => performance.timeOrigin + performance.now();
const secureMsg = () => t('tc.err.secure', { port: location.port || 80 });
const errText = (err) => (err?.name === 'SecurityError' ? secureMsg() : ERR_KEYS[err?.name] ? t(ERR_KEYS[err.name]) : err?.message ?? String(err));
const rateKo = (r) => (r === 'auto' ? t('tc.rate.auto') : RATE_LABEL[r] ?? (r ? String(r) : '—'));
const countOf = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : v && typeof v === 'object' ? Object.keys(v).length : 0);
const TEXT_FIELD = 'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=color]), select, textarea, [contenteditable]:not([contenteditable=false])';
const isTextField = (t) => t instanceof Element && !!t.closest(TEXT_FIELD);

function fmtCountdown(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `-${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function compressIds(ids) {
  const s = [...new Set(ids.map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(',');
}

/** Timecode tab, top-bar TC display / internal transport / GO box and the browser-side MTC (Web MIDI) / LTC (Web Audio) inputs. */
export function createTimecode(ctx) {
  const { h, $, $$, send, sendRaw, toast, guardEdit, armButton, downloadJson } = ctx;
  const isLocked = () => !!ctx.isLocked?.();
  const C = () => ctx.constants?.() ?? {};
  const presets = () => ctx.presets?.() ?? [];
  const hexOf = (key) => (key ? ctx.palette?.()?.find((p) => p.key === key)?.hex ?? null : null);
  const findPreset = (name) => {
    const n = String(name || '').toLowerCase();
    return n ? presets().find((p) => p.name.toLowerCase() === n) ?? null : null;
  };
  const slotPreset = (slot) => (slot ? presets().find((p) => p.slot === slot) ?? null : null);
  let TC = null;
  let TCS = null;
  let you = null;
  let built = false;
  let stale = false;
  const els = {};

  // ---------------- local input (this browser as TC source) ----------------
  let active = null;
  let starting = false;
  let midi = null;
  let sysex = false;
  let boundPort = null;
  const parsers = new Map();
  let audio = null;
  let level = { peak: 0, rms: 0, locked: false };
  let localLocked = false;
  let lastLocal = null;
  let lastSent = 0;
  let wakeLock = null;
  const srcErr = { mtc: null, ltc: null };

  const isSource = () => !!TC?.source && TC.source.cid === you;

  function emitFrame(kind, tc, rate, dir, sub, at) {
    lastLocal = { tc, rate, dir, t: performance.now() };
    localLocked = true;
    if (!isSource() || kind !== active) return;
    const t = performance.now();
    if (dir !== 0 && t - lastSent < 30) return;
    lastSent = t;
    sendRaw({ type: 'tc.frame', kind, tc: formatTc(tc), rate: rate ?? undefined, dir, sub, at });
  }

  async function midiAccess() {
    if (!navigator.requestMIDIAccess) throw new Error(t('tc.err.noMidi'));
    if (midi) return midi;
    try {
      midi = await navigator.requestMIDIAccess({ sysex: true });
      sysex = true;
    } catch {
      midi = await navigator.requestMIDIAccess();
      sysex = false;
      toast(t('tc.err.noSysex'), 'warn');
    }
    midi.onstatechange = (e) => {
      if (e.port && e.port.type !== 'input') return;
      bindMidi();
      renderDevices();
      renderLocal();
    };
    return midi;
  }

  const midiInputs = () => (midi ? [...midi.inputs.values()].filter((p) => p.state !== 'disconnected') : []);
  function midiPortId() {
    const ids = midiInputs().map((p) => p.id);
    const saved = localStorage.getItem(LS.mtcDevice) || '';
    return ids.includes(saved) ? saved : ids[0] ?? null;
  }

  function unbindMidi() {
    if (!boundPort) return;
    const port = boundPort;
    boundPort = null;
    port.onmidimessage = null;
    port.close?.().catch(() => {});
  }

  function bindMidi() {
    const want = active === 'mtc' ? midiPortId() : null;
    if (boundPort && boundPort.id === want && boundPort.state !== 'disconnected') return;
    unbindMidi();
    localLocked = false;
    if (!want) return;
    const port = midi.inputs.get(want);
    let parser = parsers.get(want);
    if (!parser) {
      parser = new MtcParser();
      parsers.set(want, parser);
    }
    parser.reset();
    port.onmidimessage = (e) => onMidi(e, parser);
    port.open?.().catch((err) => {
      srcErr.mtc = t('tc.err.midiOpen', { msg: errText(err) });
      render();
    });
    boundPort = port;
  }

  function onMidi(e, parser) {
    const r = parser.feed(e.data);
    if (!r) return;
    if (r.kind === 'unlock') {
      localLocked = false;
      return;
    }
    const ts = e.timeStamp > 0 ? e.timeStamp : performance.now();
    // a busy main thread delivers MIDI late: extrapolate quarter-frame positions over the handler delay
    const delay = r.kind === 'qf' ? r.dir * (Math.max(0, performance.now() - ts) / 1000) * (RATE_REAL[r.rate] ?? 30) : 0;
    // `sub` already covers the handler delay, so the position is stamped with the send time
    emitFrame('mtc', r.tc, r.rate, r.dir, (r.sub || 0) + delay, now());
  }

  const getAudio = (deviceId) => navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 },
    },
  });

  async function startLtc() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error(t('tc.err.noAudio'));
    const deviceId = localStorage.getItem(LS.ltcDevice) || '';
    let stream;
    try {
      stream = await getAudio(deviceId);
    } catch (err) {
      if (!deviceId || (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError')) throw err;
      toast(t('tc.err.overconstrained'), 'warn');
      stream = await getAudio('');
    }
    const channel = Number(localStorage.getItem(LS.ltcChannel) || 0);
    let ac = null;
    try {
      ac = new AudioContext({ latencyHint: 'interactive' });
      await ac.audioWorklet.addModule('ltc-worklet.js');
      const src = ac.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ac, 'objitter-ltc', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
        processorOptions: { channel },
      });
      const mute = ac.createGain();
      mute.gain.value = 0;
      src.connect(node).connect(mute).connect(ac.destination);
      node.port.onmessage = (e) => onLtc(e.data);
      await ac.resume();
      audio = { ac, stream, node };
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      await ac?.close().catch(() => {});
      throw err;
    }
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (audio?.stream !== stream) return;
      srcErr.ltc = t('tc.err.audioEnded');
      toast(srcErr.ltc, 'error');
      render();
    });
    renderDevices();
  }

  function stopLtc() {
    if (!audio) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ac.close().catch(() => {});
    audio = null;
    level = { peak: 0, rms: 0, locked: false };
  }

  function onLtc(d) {
    if (d.type === 'level') {
      level = d;
      localLocked = d.locked;
      renderMeter();
      return;
    }
    if (d.type !== 'frame' || !audio) return;
    const age = Math.max(0, audio.ac.currentTime - d.time);
    const fps = RATE_REAL[d.rate] ?? d.fps ?? 30;
    // forward: the label belongs to the frame that just ended (one frame old); reverse labels are not
    const sub = d.dir > 0 ? 1 + age * fps : -(age * fps);
    emitFrame('ltc', d.tc, d.rate ?? undefined, d.dir, sub, now());
  }

  async function startLocal(kind) {
    if (starting) return;
    const wasSource = isSource();
    starting = true;
    await stopLocal(false);
    try {
      if (!window.isSecureContext) throw Object.assign(new Error(secureMsg()), { name: 'SecurityError' });
      if (kind === 'mtc') {
        await midiAccess();
        active = 'mtc';
        bindMidi();
      } else {
        await startLtc();
        active = 'ltc';
      }
    } catch (err) {
      active = null;
      unbindMidi();
      starting = false;
      srcErr[kind] = t('tc.err.startFailed', { src: srcName(kind), msg: errText(err) });
      toast(srcErr[kind], 'error');
      if (wasSource) sendRaw({ type: 'tc.release' });
      render();
      return;
    }
    starting = false;
    srcErr[kind] = null;
    send({ type: 'tc.claim', kind });
    requestWakeLock();
    renderDevices();
    render();
  }

  async function stopLocal(release = true) {
    const was = active;
    active = null;
    localLocked = false;
    lastLocal = null;
    unbindMidi();
    stopLtc();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    if (release && was && isSource()) sendRaw({ type: 'tc.release' });
    render();
  }

  async function requestWakeLock() {
    try {
      if (active && navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not allowed (e.g. battery saver) */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) requestWakeLock();
  });

  async function renderDevices() {
    if (!built) return;
    const msel = els.mtcDev;
    const mopts = [];
    if (!midi) mopts.push(h('option', { value: '' }, t('tc.dev.startFirst')));
    else if (!midiInputs().length) mopts.push(h('option', { value: '' }, t('tc.dev.noMidi')));
    for (const p of midiInputs()) mopts.push(h('option', { value: p.id }, p.name || p.id));
    msel.replaceChildren(...mopts);
    msel.value = midiPortId() ?? '';
    els.mtcNone.hidden = !midi || midiInputs().length > 0;
    const asel = els.ltcDev;
    const acur = localStorage.getItem(LS.ltcDevice) || '';
    const aopts = [h('option', { value: '' }, t('tc.dev.defaultAudio'))];
    try {
      const devs = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
      devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
        .forEach((d, i) => aopts.push(h('option', { value: d.deviceId }, d.label || t('tc.dev.audioN', { n: i + 1 }))));
    } catch { /* no permission yet */ }
    asel.replaceChildren(...aopts);
    asel.value = [...asel.options].some((o) => o.value === acur) ? acur : '';
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => renderDevices());

  // ---------------- shared controls (top bar + tab) ----------------
  const transports = [];
  const goUis = [];
  let lastGo = 0;
  const goCmd = (type) => {
    const t = performance.now();
    if (t - lastGo < GO_GUARD_MS) return;
    lastGo = t;
    send({ type });
  };

  function transportUi() {
    const rew = h('button', { class: 'tc-int-btn', title: t('tc.int.rewind.title'), 'aria-label': t('tc.int.rewind'), onclick: () => send({ type: 'tc.int.rewind' }) }, '⏮');
    const play = h('button', { class: 'tc-int-btn tc-int-play', 'aria-label': t('tc.int.play'), title: t('tc.int.play.title'), onclick: () => send({ type: 'tc.int.toggle' }) }, '▶');
    const loc = h('input', { type: 'text', class: 'tc-int-loc mono', placeholder: '00:00:00:00', spellcheck: false, 'aria-label': t('tc.int.locate'), title: t('tc.int.locate.title') });
    loc.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      const p = parseTc(loc.value);
      if (!p || p.neg) { toast(t('tc.fmt'), 'error'); return; }
      if (send({ type: 'tc.int.locate', tc: formatTc(p) })) {
        loc.value = '';
        loc.blur();
      }
    });
    transports.push({ play });
    return [rew, play, loc];
  }

  function goUi() {
    const sb = h('span', { class: 'tc-go-sb' }, t('tc.noStandby'));
    const go = h('button', { class: 'tc-go', title: t('tc.go.title'), onclick: () => goCmd('tc.go') }, h('span', { class: 'tc-go-l' }, 'GO'), sb);
    const back = h('button', { class: 'tc-back', title: t('tc.back.title'), onclick: () => goCmd('tc.back') }, 'BACK');
    goUis.push({ go, sb });
    return [go, back];
  }

  // ---------------- tab ----------------
  const setTc = (patch) => {
    if (!send({ type: 'tc.settings', patch })) renderSettings();
  };
  const segEl = (options, onpick, ed = true) => {
    const seg = h('div', { class: 'seg' });
    for (const [v, l] of options) seg.append(h('button', { 'data-v': v, class: ed ? 'ed' : null, onclick: () => onpick(v) }, l));
    return seg;
  };
  const setSeg = (seg, v) => $$('button', seg).forEach((b) => {
    b.classList.toggle('on', b.dataset.v === String(v));
    b.setAttribute('aria-pressed', String(b.dataset.v === String(v)));
  });
  const toggleEl = (id, onchange) => {
    const c = h('input', { type: 'checkbox', id, role: 'switch', class: 'ed', onchange });
    return [h('span', { class: 'toggle' }, c, h('span', { 'aria-hidden': 'true' })), c];
  };
  const row = (label, input, id) => h('div', { class: 'row' }, id ? h('label', { for: id }, label) : h('span', { class: 'lbl' }, label), h('div', { class: 'ctl' }, input));
  const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };

  function settingNum(id, key, label, min, max, step) {
    const el = h('input', { type: 'number', id, class: 'ed', min, max, step });
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (el.value === '' || !Number.isFinite(v) || v < min || v > max) {
        toast(`${label}: ${min} – ${max}`, 'error');
        el.value = TC.settings[key] ?? '';
        return;
      }
      setTc({ [key]: v });
    });
    els.nums[key] = el;
    return row(label, el, id);
  }

  function build() {
    const root = $('#tab-tc');
    els.root = root;
    els.nums = {};
    const k = C();
    const [enT, en] = toggleEl('tc-enabled', (e) => {
      if (!send({ type: 'tc.settings', patch: { enabled: e.target.checked } })) e.target.checked = !!TC?.settings.enabled;
    });
    const inputSeg = segEl((k.tcInputs ?? ['mtc', 'ltc', 'osc', 'internal']).map((v) => [v, inputName(v)]), (v) => setTc({ input: v }));
    const rateSeg = segEl((k.tcRates ?? RATES).map((r) => [r, rateKo(r)]), (v) => setTc({ rate: v }));
    const lossSeg = segEl([['hold', t('tc.loss.hold')], ['stop', t('tc.loss.stop')]], (v) => setTc({ onLoss: v }));
    const trigSeg = segEl((k.tcTriggers ?? ['tc', 'go']).map((v) => [v, triggerName(v)]), (v) => setTc({ trigger: v }));
    const offset = h('input', { type: 'text', id: 'tc-offset', class: 'mono ed', spellcheck: false, placeholder: '+00:00:00:00' });
    offset.addEventListener('change', () => {
      const v = offset.value.trim();
      const p = parseTc(/^[+-]/.test(v) ? v : `+${v}`);
      if (!p) { toast(t('tc.offsetFmt'), 'error'); offset.value = TC.settings.offset; return; }
      setTc({ offset: formatTc(p, { sign: true }) });
    });
    const [chaseT, chase] = toggleEl('tc-chase', (e) => setTc({ chase: e.target.checked }));
    const [ffireT, ffire] = toggleEl('tc-ffire', (e) => setTc({ freewheelFire: e.target.checked }));
    const [autoT, auto] = toggleEl('tc-auto', (e) => setTc({ autoStart: e.target.checked }));

    const mtcDev = h('select', { id: 'tc-mtc-dev', class: 'ed', onchange: (e) => { localStorage.setItem(LS.mtcDevice, e.target.value); bindMidi(); renderLocal(); } });
    const ltcDev = h('select', {
      id: 'tc-ltc-dev',
      class: 'ed',
      onchange: (e) => {
        localStorage.setItem(LS.ltcDevice, e.target.value);
        if (active === 'ltc') startLocal('ltc');
      },
    });
    const chSeg = segEl([['0', '1 (L)'], ['1', '2 (R)']], (v) => {
      localStorage.setItem(LS.ltcChannel, v);
      audio?.node.port.postMessage({ channel: Number(v) });
      setSeg(chSeg, v);
    });
    const stopOrStart = (kind) => {
      if (active === kind) { if (guardEdit()) stopLocal(); } else startLocal(kind);
    };
    const mtcBtn = h('button', { class: 'accent', onclick: () => stopOrStart('mtc') });
    const ltcBtn = h('button', { class: 'accent', onclick: () => stopOrStart('ltc') });
    const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': t('tc.ltc.level') }, h('i'));
    const lamp = h('span', { class: 'lamp', title: t('tc.ltc.locked') });
    const meterTxt = h('span', { class: 'mono muted' }, '—');
    const errEl = () => h('p', { class: 'warn-text tc-src-err', role: 'alert', hidden: true });
    const errs = { mtc: errEl(), ltc: errEl() };
    const mtcNone = h('p', { class: 'warn-text', hidden: true }, t('tc.mtc.none'));

    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    file.addEventListener('change', () => pickShow(file));

    const panels = {
      mtc: h('div', { class: 'card tc-panel' },
        row(t('tc.mtc.input'), mtcDev, 'tc-mtc-dev'),
        mtcNone,
        h('div', { class: 'tc-panel-act' }, mtcBtn, h('span', { class: 'mono muted', id: 'tc-mtc-st' })),
        errs.mtc,
        h('p', {}, t('tc.mtc.help')),
        navigator.requestMIDIAccess ? null : h('p', { class: 'warn-text' }, t('tc.mtc.noWebMidi')),
        ctx.platform?.() === 'win32' ? h('p', {}, t('tc.mtc.win')) : null,
        ctx.platform?.() === 'darwin' ? h('p', {}, t('tc.mtc.mac')) : null),
      ltc: h('div', { class: 'card tc-panel' },
        row(t('tc.ltc.input'), ltcDev, 'tc-ltc-dev'),
        row(t('tc.ltc.channel'), chSeg),
        h('div', { class: 'tc-panel-act' }, ltcBtn, lamp, meter, meterTxt),
        h('div', { class: 'mono muted', id: 'tc-ltc-st' }),
        errs.ltc,
        h('p', {}, t('tc.ltc.help'))),
      osc: h('div', { class: 'card tc-panel' },
        h('p', {}, h('code', {}, '/objitter/tc <hh> <mm> <ss> <ff> [fps]')),
        h('p', {}, h('code', {}, '/objitter/tc "hh:mm:ss:ff" [fps]'), ' (";" = 29.97DF)'),
        h('p', {}, h('code', {}, '/objitter/tc/stop'), ' · ', h('code', {}, '/objitter/tc/enable <0|1>')),
        h('p', {}, t('tc.osc.help'))),
      internal: h('div', { class: 'card tc-panel' },
        h('p', {}, t('tc.int.help')),
        h('p', {}, h('code', {}, '/objitter/tc/play'), ' · ', h('code', {}, '/objitter/tc/pause'), ' · ', h('code', {}, '/objitter/tc/locate "hh:mm:ss:ff"'))),
    };

    const big = h('div', { class: 'tc-big mono', id: 'tc-big' }, '--:--:--:--');
    const intRow = h('div', { class: 'tc-int-row', hidden: true }, ...transportUi());
    const goRow = h('div', { class: 'tc-go-row', hidden: true }, ...goUi());
    const sbLbl = h('span', { hidden: true }, t('tc.st.standby'));
    const sbVal = h('span', { id: 'tc-st-sb', hidden: true }, '—');
    const cueList = h('div', { class: 'cue-list', id: 'cueList' });
    cueList.addEventListener('focusout', () => setTimeout(renderCues, 0));
    const groupsDl = h('datalist', { id: 'tc-groups-dl' });
    const preview = h('div', { class: 'card tc-preview', hidden: true });

    const settings = h('details', { class: 'card tc-settings', open: localStorage.getItem(LS.settingsOpen) !== '0' },
      h('summary', {}, t('tc.settings')),
      h('div', { class: 'section' }, t('tc.source')),
      inputSeg,
      h('p', { class: 'hint', id: 'tc-src-line' }),
      panels.mtc, panels.ltc, panels.osc, panels.internal,
      h('div', { class: 'section' }, t('tc.sync')),
      row(t('tc.rate'), rateSeg),
      row(t('tc.offset'), offset, 'tc-offset'),
      settingNum('tc-latency', 'latencyMs', t('tc.latency'), -500, 500, 1),
      row(t('tc.chase'), chaseT, 'tc-chase'),
      h('p', { class: 'hint' }, t('tc.chase.hint')),
      settingNum('tc-chasefade', 'chaseFade', t('tc.chaseFade'), 0, 10, 0.1),
      settingNum('tc-locate', 'locateThreshold', t('tc.locateThreshold'), 0.1, 60, 0.1),
      settingNum('tc-freewheel', 'freewheel', t('tc.freewheel'), 0.1, 10, 0.1),
      row(t('tc.ffire'), ffireT, 'tc-ffire'),
      h('p', { class: 'hint' }, t('tc.ffire.hint')),
      row(t('tc.autoStart'), autoT, 'tc-auto'),
      row(t('tc.onLoss'), lossSeg),
      settingNum('tc-preroll', 'preroll', t('tc.preroll'), 0, 30, 0.5),
      h('div', { class: 'section' }, t('tc.exec')),
      row(t('tc.trigger'), trigSeg),
      h('p', { class: 'hint' }, t('tc.trigger.hint')));
    settings.addEventListener('toggle', () => localStorage.setItem(LS.settingsOpen, settings.open ? '1' : '0'));
    settings.addEventListener('focusout', () => setTimeout(renderSettings, 0));

    const cueRoot = $('#tab-cues');
    els.cueRoot = cueRoot;
    els.offBanner = h('div', { class: 'tc-off-banner', role: 'status', hidden: true },
      h('span', {}, t('tc.offBanner')),
      h('button', { class: 'accent ed', type: 'button', onclick: () => send({ type: 'tc.settings', patch: { enabled: true } }) }, t('tc.offBanner.on')));
    cueRoot.replaceChildren(
      h('div', { class: 'section' }, h('span', { id: 'tc-cue-title' }, t('tc.cues'))),
      els.offBanner,
      h('div', { class: 'btn-row two' },
        h('button', { class: 'accent ed', id: 'tc-add-now', title: t('tc.addNow.title', { key: IS_MAC ? kbd('mod', 'I') : 'Insert' }), onclick: () => send({ type: 'tc.cue.add', atCurrent: true }) }, t('tc.addNow')),
        h('button', { class: 'ed', title: t('tc.add.title'), onclick: () => send({ type: 'tc.cue.add' }) }, t('tc.add'))),
      h('p', { class: 'hint' }, t('tc.cues.hint', { key: IS_MAC ? kbd('mod', 'I') : 'Insert' })),
      cueList,
      groupsDl,
      h('div', { class: 'section' }, t('tc.show')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'ed', onclick: () => { if (guardEdit()) file.click(); } }, t('tc.show.import')),
        h('button', { onclick: () => send({ type: 'tc.show.get' }) }, t('tc.show.export')),
        armButton(h('button', { class: 'danger ed' }, t('tc.cues.clear')), () => send({ type: 'tc.cues.clear' }))),
      preview,
      file,
      h('p', { class: 'hint' }, t('tc.show.hint')),
    );
    root.replaceChildren(
      h('div', { class: 'section' }, t('tc.status')),
      row(t('tc.enabled'), enT, 'tc-enabled'),
      h('div', { class: 'tc-status card' },
        big,
        h('div', { class: 'status-grid' },
          h('span', {}, t('tc.st.state')), h('span', { id: 'tc-st-state' }, '—'),
          h('span', {}, t('tc.st.source')), h('span', { id: 'tc-st-src' }, '—'),
          h('span', {}, t('tc.st.frames')), h('span', { class: 'mono', id: 'tc-st-fps' }, '—'),
          h('span', {}, t('tc.st.raw')), h('span', { class: 'mono', id: 'tc-st-raw' }, '—'),
          h('span', { id: 'tc-st-next-l' }, t('tc.st.next')), h('span', { id: 'tc-st-next' }, '—'),
          sbLbl, sbVal),
        intRow, goRow),
      h('p', { class: 'hint' }, t('tc.enabled.hint')),
      settings,
    );
    Object.assign(els, {
      en, inputSeg, rateSeg, lossSeg, trigSeg, offset, chase, ffire, auto, mtcDev, ltcDev, chSeg, mtcBtn, ltcBtn, meter, lamp, meterTxt,
      panels, errs, mtcNone, big, intRow, goRow, sbLbl, sbVal, cueList, groupsDl, preview,
    });
    setSeg(chSeg, localStorage.getItem(LS.ltcChannel) || '0');
    if (!built) on('library', () => renderCues());
    built = true;
    lockedShown = null;
    renderDevices();
    renderGroups();
  }

  // ---------------- show import ----------------
  let pendingImport = null;

  async function pickShow(file) {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    const max = C().maxShowBytes ?? 2097152;
    const tooBig = () => toast(t('tc.show.tooBig', { mb: Math.round((max / 1048576) * 10) / 10 }), 'error');
    if (f.size > max) { tooBig(); return; }
    const text = await f.text();
    if (text.length > max) { tooBig(); return; }
    let data;
    try { data = JSON.parse(text); } catch { toast(t('ui.jsonFailed', { file: f.name }), 'error'); return; }
    if (!send({ type: 'tc.show.preview', data })) return;
    pendingImport = { name: f.name, data };
    lastPreview = null;
    renderPreview(null);
  }

  function renderPreview(m) {
    const box = els.preview;
    if (!box) return;
    if (!pendingImport) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    const cancel = h('button', { onclick: () => { pendingImport = null; renderPreview(); } }, t('common.cancel'));
    if (!m) {
      box.replaceChildren(h('p', {}, t('tc.pv.checking', { name: pendingImport.name })), h('div', { class: 'tc-pv-act' }, cancel));
      return;
    }
    const errors = Array.isArray(m.errors) ? m.errors : [];
    const missing = Array.isArray(m.missing) ? m.missing : [];
    const nSlots = countOf(m.slots);
    const ok = m.ok !== false && !errors.length;
    const applySlots = h('input', { type: 'checkbox', checked: localStorage.getItem(LS.applySlots) === '1', onchange: (e) => localStorage.setItem(LS.applySlots, e.target.checked ? '1' : '0') });
    const st = m.settings;
    const doImport = () => {
      if (!pendingImport) return;
      if (send({ type: 'tc.show.import', data: pendingImport.data, applySlots: nSlots > 0 && applySlots.checked })) {
        pendingImport = null;
        renderPreview();
      }
    };
    box.replaceChildren(
      h('div', { class: 'tc-pv-head' }, t('tc.pv.head', { name: m.name || pendingImport.name })),
      h('p', {}, t('tc.pv.replace', { n: countOf(m.cues), cur: TC?.cues.length ?? 0 })),
      st ? h('p', {}, t('tc.pv.settings', { input: st.input ? inputName(st.input) : '—', rate: rateKo(st.rate), trigger: triggerName(st.trigger ?? 'tc') })) : null,
      errors.length ? h('p', { class: 'err-text', role: 'alert' }, t('tc.pv.errors', { n: errors.length })) : null,
      errors.length ? h('ul', { class: 'tc-pv-errs' }, errors.slice(0, 10).map((e) => h('li', {}, Number.isInteger(e?.index) && e.index > 0 ? `${t('tc.cueN', { n: e.index })}: ${tm(e.message)}` : tm(e?.message ?? e))),
        errors.length > 10 ? h('li', { class: 'muted' }, t('tc.pv.more', { n: errors.length - 10 })) : null) : null,
      !ok && !errors.length ? h('p', { class: 'err-text', role: 'alert' }, m.error ? tm(m.error) : t('tc.pv.unreadable')) : null,
      missing.length ? h('p', { class: 'warn-text' }, t('tc.pv.missing', { n: missing.length, names: missing.join(', ') })) : null,
      nSlots > 0 ? h('label', { class: 'chk' }, applySlots, t('tc.pv.applySlots', { n: nSlots })) : null,
      h('div', { class: 'tc-pv-act' },
        h('button', { class: 'accent', disabled: !ok || isLocked(), onclick: doImport }, t('common.import')),
        cancel),
    );
  }

  // ---------------- cue list ----------------
  const rowsById = new Map();
  const expanded = new Set();
  const flashes = new Map();
  let pendingFocus = null;

  function markStale(id) {
    const sig = rowsById.get(id)?.sig;
    setTimeout(() => {
      const cur = rowsById.get(id);
      if (!cur || cur.sig !== sig) return;
      cur.sig = '';
      renderCues();
    }, 600);
  }

  const cueWhat = (c) => {
    if (c.action === 'library') return c.lib ? c.lib.split('/').pop() : actionName(c.action);
    if (c.action !== 'slot') return actionName(c.action);
    if (c.preset) return `${c.preset}${c.slot ? ` (${t('slot.n', { n: c.slot })})` : ''}`;
    return c.slot ? t('slot.n', { n: c.slot }) : t('tc.noPreset');
  };
  const cueName = (c) => c.label || cueWhat(c);

  function cueRow(cue, i, env) {
    const n = i + 1;
    const dis = env.locked;
    const upd = (patch, revert) => {
      if (send({ type: 'tc.cue.update', id: cue.id, patch })) markStale(cue.id);
      else revert();
    };
    const num = (key, label, min, max, step, { nullable = false, placeholder, cls = '' } = {}) => {
      const el = h('input', { type: 'number', class: `ed mono ${cls}`, min, max, step, value: cue[key] ?? '', placeholder, disabled: dis, title: label, 'aria-label': label });
      el.addEventListener('change', () => {
        const revert = () => { el.value = cue[key] ?? ''; };
        if (el.value === '') {
          if (nullable) upd({ [key]: null }, revert); else revert();
          return;
        }
        const v = Number(el.value);
        if (!Number.isFinite(v) || v < min || v > max) { toast(`${label}: ${min} – ${max}`, 'error'); revert(); return; }
        upd({ [key]: v }, revert);
      });
      return el;
    };
    const blurOnEnter = (el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) el.blur(); });

    const en = h('input', { type: 'checkbox', class: 'ed', checked: cue.enabled, disabled: dis, title: t('tc.cue.enabled'), 'aria-label': t('tc.cue.enabled.aria', { n }) });
    en.addEventListener('change', () => upd({ enabled: en.checked }, () => { en.checked = cue.enabled; }));
    const no = env.go
      ? h('button', { class: 'cue-no mono', title: t('tc.cue.standby.title'), 'aria-label': t('tc.cue.standby.aria', { n }), onclick: () => send({ type: 'tc.standby', index: n }) }, n)
      : h('span', { class: 'cue-no mono' }, n);
    const tc = h('input', { type: 'text', class: 'cue-tc mono ed', value: cue.tc, spellcheck: false, disabled: dis, 'aria-label': t('tc.cue.tc.aria', { n }) });
    tc.addEventListener('change', () => {
      const p = parseTc(tc.value);
      const revert = () => { tc.value = cue.tc; };
      if (!p || p.neg) { toast(t('tc.fmt'), 'error'); revert(); return; }
      upd({ tc: formatTc(p) }, revert);
    });
    blurOnEnter(tc);
    const action = h('select', { class: 'cue-act ed', disabled: dis, 'aria-label': t('tc.cue.action.aria', { n }) },
      (C().cueActions ?? ACTIONS).map((a) => h('option', { value: a, selected: cue.action === a }, actionName(a))));
    action.addEventListener('change', () => upd({ action: action.value }, () => { action.value = cue.action; }));
    const cd = h('span', { class: 'cue-cd mono', 'aria-hidden': 'true' });
    const fire = h('button', { class: 'cue-btn', title: t('tc.cue.fire.title'), 'aria-label': t('tc.cue.fire.aria', { n }), onclick: () => send({ type: 'tc.cue.fire', id: cue.id }) }, '▶');
    const from = h('button', {
      class: 'cue-btn',
      disabled: !env.internal,
      title: env.internal ? t('tc.cue.from.title', { s: env.preroll }) : t('tc.cue.from.disabled'),
      'aria-label': t('tc.cue.from.aria', { n }),
      onclick: () => send({ type: 'tc.cue.playFrom', id: cue.id }),
    }, '⇥');
    const up = i > 0 && TC.cues[i - 1].tc === cue.tc
      ? h('button', { class: 'cue-btn ed', disabled: dis, title: t('tc.cue.up.title'), 'aria-label': t('tc.cue.up.aria', { n }), onclick: () => send({ type: 'tc.cue.move', id: cue.id, delta: -1 }) }, '↑')
      : null;
    const del = armButton(h('button', { class: 'danger cue-del ed', disabled: dis, title: t('common.delete'), 'aria-label': t('tc.cue.del.aria', { n }) }, '✕'), () => send({ type: 'tc.cue.delete', id: cue.id }));

    const isSlot = cue.action === 'slot';
    const isLib = cue.action === 'library';
    const usesFade = isSlot || isLib || cue.action === 'home';
    const cur = findPreset(cue.preset);
    const viaSlot = slotPreset(cue.slot);
    const line2 = [];
    if (isSlot) {
      const opts = [];
      if (!cur) {
        const txt = cue.preset ? t('tc.cue.presetMissing', { name: cue.preset }) : cue.slot ? `${t('slot.n', { n: cue.slot })}${viaSlot ? ` · ${viaSlot.name}` : ` (${t('tc.cue.slotEmpty')})`}` : t('tc.cue.pickPreset');
        opts.push(h('option', { value: '', selected: true }, txt));
      }
      for (const p of env.sorted) {
        const hex = hexOf(p.color);
        opts.push(h('option', { value: p.name, selected: p === cur, style: hex ? `color:${hex}` : null }, `${hex ? '●' : '○'} ${p.name}${p.slot ? ` (${t('slot.n', { n: p.slot })})` : ''}`));
      }
      const sel = h('select', { class: 'cue-preset ed', disabled: dis, 'aria-label': t('tc.cue.preset.aria', { n }) }, opts);
      sel.addEventListener('change', () => {
        const p = presets().find((x) => x.name === sel.value);
        const revert = () => { sel.value = cur ? cur.name : ''; };
        if (!p) { revert(); return; }
        upd({ preset: p.name, slot: p.slot ?? null }, revert);
      });
      line2.push(sel);
      if (!cur && !viaSlot) {
        line2.push(h('span', { class: 'cue-badge miss', title: cue.preset ? t('tc.cue.miss.title', { name: cue.preset }) : t('tc.cue.miss.none') }, t('tc.cue.miss')));
      } else if (!cur && cue.preset) {
        line2.push(h('span', { class: 'cue-badge alt', title: t('tc.cue.alt.title', { name: cue.preset, slot: cue.slot, via: viaSlot.name }) }, t('tc.cue.alt')));
      }
    }
    if (isLib) {
      const has = env.lib.includes(cue.lib);
      const opts = [];
      if (!has) opts.push(h('option', { value: '', selected: true }, cue.lib ? t('tc.cue.presetMissing', { name: cue.lib }) : env.lib.length ? t('lib.pick') : t('lib.none')));
      for (const p of env.lib) opts.push(h('option', { value: p, selected: p === cue.lib }, p));
      const sel = h('select', { class: 'cue-preset ed', disabled: dis, 'aria-label': t('cue.field.lib') }, opts);
      sel.addEventListener('change', () => {
        if (!sel.value) { sel.value = has ? cue.lib : ''; return; }
        upd({ lib: sel.value }, () => { sel.value = has ? cue.lib : ''; });
      });
      line2.push(sel);
      if (!has) line2.push(h('span', { class: 'cue-badge miss', title: cue.lib ? t('srv.cue.libMissing', { name: cue.lib }) : t('cue.err.needLib') }, t('tc.cue.miss')));
    }
    if (cue.action === 'clips') {
      const n = cue.clips?.length ?? 0;
      const len = (cue.clips ?? []).reduce((m, c) => Math.max(m, c.start + c.dur), 0);
      line2.push(h('button', {
        class: 'cue-clips', type: 'button', title: t('tc.cue.clips.title'),
        onclick: () => emit('show.focusCue', cue.id),
      }, n ? t('tc.cue.clips', { n, len: len.toFixed(1) }) : t('tc.cue.clipsNone')));
    }
    if (usesFade) line2.push(num('fade', t('tc.cue.fade'), 0, 60, 0.1, { nullable: true, placeholder: t('tc.cue.fade.ph'), cls: 'cue-fade' }));
    const label = h('input', { type: 'text', class: 'cue-label ed', value: cue.label, maxLength: 48, placeholder: t('tc.cue.label'), disabled: dis, 'aria-label': t('tc.cue.label.aria', { n }) });
    label.addEventListener('change', () => upd({ label: label.value }, () => { label.value = cue.label; }));
    blurOnEnter(label);
    line2.push(label);

    const l3items = [];
    const l3 = (lbl, ...ctl) => l3items.push(h('span', { class: 'lbl' }, lbl), h('div', { class: 'ctl' }, ...ctl));
    if (usesFade) {
      const targets = h('input', { type: 'text', class: 'ed mono', value: cue.targets ?? '', list: 'tc-groups-dl', placeholder: t('tc.cue.targets.ph'), spellcheck: false, disabled: dis, 'aria-label': t('tc.cue.targets.aria', { n }) });
      const revertT = () => { targets.value = cue.targets ?? ''; };
      targets.addEventListener('change', () => upd({ targets: targets.value.trim() }, revertT));
      blurOnEnter(targets);
      const useSel = h('button', {
        class: 'ed', disabled: dis, title: t('tc.cue.useSel.title'),
        onclick: () => {
          const ids = ctx.selectedIds?.() ?? [];
          if (!ids.length) { toast(t('srv.noSelection'), 'warn'); return; }
          targets.value = compressIds(ids);
          upd({ targets: targets.value }, revertT);
        },
      }, t('tc.cue.useSel'));
      l3(t('tc.cue.targets'), targets, useSel);
      const curve = h('select', { class: 'ed', disabled: dis, 'aria-label': t('tc.cue.curve.aria') },
        (C().cueCurves ?? CURVES).map((v) => h('option', { value: v, selected: cue.curve === v }, curveName(v))));
      curve.addEventListener('change', () => upd({ curve: curve.value }, () => { curve.value = cue.curve; }));
      l3(t('tc.cue.curve'), curve);
      const order = h('select', { class: 'ed', disabled: dis, 'aria-label': t('tc.cue.order.aria') },
        (C().staggerOrders ?? ORDERS).map((v) => h('option', { value: v, selected: cue.staggerOrder === v }, orderName(v))));
      order.addEventListener('change', () => upd({ staggerOrder: order.value }, () => { order.value = cue.staggerOrder; }));
      l3(t('tc.cue.stagger'), num('stagger', t('tc.cue.stagger'), 0, 10, 0.1), order);
    }
    if (isSlot) {
      l3('BPM', num('bpm', 'BPM', 20, 300, 0.1, { nullable: true, placeholder: t('tc.cue.keep') }));
      const globals = h('input', { type: 'checkbox', class: 'ed', checked: cue.globals === 'preset', disabled: dis });
      globals.addEventListener('change', () => upd({ globals: globals.checked ? 'preset' : 'keep' }, () => { globals.checked = cue.globals === 'preset'; }));
      l3('', h('label', { class: 'chk' }, globals, t('tc.cue.globals')));
      l3(t('tc.cue.seed'), num('seedOffset', t('tc.cue.seed'), 0, 999, 1));
    }
    if (isSlot || cue.action === 'start') {
      const anchor = h('input', { type: 'checkbox', class: 'ed', checked: !!cue.anchorBeat, disabled: dis });
      anchor.addEventListener('change', () => upd({ anchorBeat: anchor.checked }, () => { anchor.checked = !!cue.anchorBeat; }));
      l3('', h('label', { class: 'chk' }, anchor, t('tc.cue.anchor')));
    }
    l3(t('tc.cue.follow'), num('follow', t('tc.cue.follow.s'), 0, 600, 0.1, { nullable: true, placeholder: t('common.none') }), h('span', { class: 'muted' }, t('tc.cue.follow.after')));
    const details = h('div', { class: 'cue-l3', hidden: !expanded.has(cue.id) }, ...l3items);
    const more = h('button', {
      class: 'cue-btn cue-more', title: t('tc.cue.more'), 'aria-label': t('tc.cue.more.aria', { n }), 'aria-expanded': String(expanded.has(cue.id)),
      onclick: () => {
        const open = details.hidden;
        details.hidden = !open;
        more.setAttribute('aria-expanded', String(open));
        if (open) expanded.add(cue.id); else expanded.delete(cue.id);
      },
    }, '⋯');
    line2.push(more);

    const hex = isSlot ? hexOf((cur ?? viaSlot)?.color) : null;
    const el = h('div', { class: `cue${cue.enabled ? '' : ' off'}`, 'data-id': cue.id, style: hex ? `--cue-c:${hex}` : null },
      h('div', { class: 'cue-l1' }, en, no, tc, action, cd, fire, from, up, del),
      h('div', { class: 'cue-l2' }, ...line2),
      details);
    return { el, cd };
  }

  function renderCues() {
    if (!built || !TC) return;
    const list = els.cueList;
    $('#tc-cue-title').textContent = `${t('tc.cues')} (${TC.cues.length})`;
    if (els.offBanner) {
      els.offBanner.hidden = !!TC.settings.enabled || !TC.cues.length;
      els.offBanner.querySelector('button').disabled = isLocked();
    }
    if (!TC.cues.length) {
      rowsById.clear();
      const key = IS_MAC ? kbd('mod', 'I') : 'Insert';
      list.replaceChildren(h('div', { class: 'empty empty-card' },
        h('p', {}, t('tc.cues.empty')),
        h('button', {
          type: 'button', class: 'accent ed', disabled: isLocked(), title: t('tc.addNow.title', { key }),
          onclick: () => { if (guardEdit()) send({ type: 'tc.cue.add', atCurrent: true }); },
        }, t('tc.cues.emptyAdd')),
        h('p', { class: 'hint' }, t('tc.cues.emptyHint', { key }))));
      renderCueStates(true);
      return;
    }
    const s = TC.settings;
    const env = {
      locked: isLocked(),
      internal: s.input === 'internal',
      go: s.trigger === 'go',
      preroll: s.preroll ?? 0,
      sorted: [...presets()].sort((a, b) => a.name.localeCompare(b.name, getLang())),
      lib: (store.LIB?.items ?? []).map((it) => it.path),
    };
    const envSig = JSON.stringify([env.locked, env.internal, env.go, env.preroll, env.sorted.map((p) => [p.name, p.slot, p.color]), env.lib]);
    const ae = document.activeElement;
    const focusRow = list.contains(ae) ? ae.closest('.cue')?.dataset.id : null;
    const next = new Map();
    TC.cues.forEach((cue, i) => {
      const sig = JSON.stringify([cue, i, i > 0 ? TC.cues[i - 1].tc : null, envSig]);
      const old = rowsById.get(cue.id);
      if (old && (old.sig === sig || focusRow === String(cue.id))) {
        next.set(cue.id, old);
        return;
      }
      const r = cueRow(cue, i, env);
      r.sig = sig;
      next.set(cue.id, r);
    });
    rowsById.clear();
    for (const [k, v] of next) rowsById.set(k, v);
    if (list.querySelector(':scope > .empty')) list.replaceChildren();
    let k = 0;
    for (const r of next.values()) {
      const at = list.children[k];
      if (at !== r.el) list.insertBefore(r.el, at ?? null);
      k++;
    }
    while (list.children.length > k) list.lastChild.remove();
    if (ae && ae !== document.activeElement && list.contains(ae)) ae.focus({ preventScroll: true });
    if (pendingFocus !== null && rowsById.has(pendingFocus)) {
      const inp = $('.cue-tc', rowsById.get(pendingFocus).el);
      if (!inp.disabled) {
        inp.focus();
        inp.select();
      }
      inp.scrollIntoView({ block: 'nearest' });
      pendingFocus = null;
    }
    renderCueStates(true);
  }

  let passIdx = -1;
  let stateKey = '';
  let cdRow = null;
  let lastScrollId;

  function renderCueStates(force = false) {
    if (!built || !TC) return;
    const st = TCS;
    const go = TC.settings.trigger === 'go';
    const state = st?.state ?? 'off';
    const nextId = go ? null : st?.next?.id ?? null;
    const sbId = go ? st?.standby?.id ?? null : null;
    if (go) passIdx = st?.standby ? st.standby.index - 1 : -1;
    else if ((state === 'locked' || state === 'freewheel') && st?.tc) {
      const i = nextId !== null ? TC.cues.findIndex((c) => c.id === nextId) : -1;
      passIdx = i >= 0 ? i : TC.cues.length;
    } else if (state !== 'lost') passIdx = -1;
    const key = `${nextId}|${sbId}|${passIdx}|${[...flashes].join(',')}`;
    if (force || key !== stateKey) {
      stateKey = key;
      TC.cues.forEach((c, i) => {
        const r = rowsById.get(c.id);
        if (!r) return;
        r.el.classList.toggle('next', c.id === nextId);
        r.el.classList.toggle('standby', c.id === sbId);
        r.el.classList.toggle('passed', i < passIdx);
        r.el.classList.toggle('fired', flashes.get(c.id) === true);
        r.el.classList.toggle('fired-bad', flashes.get(c.id) === false);
      });
    }
    const r = nextId !== null ? rowsById.get(nextId) : null;
    if (cdRow && cdRow !== r) cdRow.cd.textContent = '';
    cdRow = r ?? null;
    if (r) {
      r.cd.textContent = fmtCountdown(st.next.in ?? 0);
      r.cd.classList.toggle('paused', !st.rolling);
    }
    const scrollId = nextId ?? sbId;
    if (scrollId !== lastScrollId && els.cueList.offsetParent !== null) {
      lastScrollId = scrollId;
      const sr = scrollId !== null ? rowsById.get(scrollId) : null;
      if (sr && !els.cueList.contains(document.activeElement)) sr.el.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------------- rendering ----------------
  let lockedShown = null;
  function applyLock() {
    if (!built) return;
    const locked = isLocked();
    if (locked === lockedShown) return;
    lockedShown = locked;
    for (const r of [els.root, els.cueRoot]) {
      r.classList.toggle('tc-locked', locked);
      for (const el of $$('.ed', r)) el.disabled = locked;
    }
    if (pendingImport) renderPreview(lastPreview);
  }

  function renderGroups() {
    if (!built) return;
    const gs = ctx.groups?.() ?? [];
    els.groupsDl.replaceChildren(...gs.map((g) => h('option', { value: `@${g.name}` })));
  }

  function renderSettings() {
    if (!built || !TC) return;
    const s = TC.settings;
    els.en.checked = !!s.enabled;
    setSeg(els.inputSeg, s.input);
    setSeg(els.rateSeg, s.rate);
    setSeg(els.lossSeg, s.onLoss);
    setSeg(els.trigSeg, s.trigger ?? 'tc');
    setVal(els.offset, s.offset);
    els.chase.checked = !!s.chase;
    els.ffire.checked = s.freewheelFire !== false;
    els.auto.checked = !!s.autoStart;
    for (const [k, el] of Object.entries(els.nums)) setVal(el, s[k] ?? '');
    for (const [k, p] of Object.entries(els.panels)) p.hidden = k !== s.input;
  }

  function renderSource() {
    if (!built) return;
    const s = TC.settings;
    els.mtcBtn.textContent = active === 'mtc' ? t('tc.recv.stop', { src: 'MTC' }) : t('tc.recv.start', { src: 'MTC' });
    els.ltcBtn.textContent = active === 'ltc' ? t('tc.recv.stop', { src: 'LTC' }) : t('tc.recv.start', { src: 'LTC' });
    els.mtcBtn.setAttribute('aria-pressed', String(active === 'mtc'));
    els.ltcBtn.setAttribute('aria-pressed', String(active === 'ltc'));
    els.mtcBtn.disabled = starting;
    els.ltcBtn.disabled = starting;
    for (const k of ['mtc', 'ltc']) {
      els.errs[k].hidden = !srcErr[k];
      els.errs[k].textContent = srcErr[k] ?? '';
    }
    const src = TC.source;
    let line;
    if (s.input === 'osc') line = t('tc.line.osc');
    else if (s.input === 'internal') line = t('tc.line.internal');
    else if (!src) line = t('tc.line.none', { src: srcName(s.input) });
    else if (src.cid === you) line = t('tc.line.self', { src: srcName(src.kind) });
    else line = t('tc.line.other', { label: src.label, src: srcName(src.kind) });
    const el = $('#tc-src-line');
    el.textContent = line;
    el.classList.toggle('warn-text', (s.input === 'mtc' || s.input === 'ltc') && !src);
    renderLocal();
  }

  function renderTopExtras() {
    const s = TC.settings;
    const tBox = $('#tcTransport');
    if (tBox && !tBox.dataset.built) {
      tBox.dataset.built = '1';
      tBox.replaceChildren(...transportUi());
    }
    if (tBox) tBox.hidden = s.input !== 'internal';
    const gBox = $('#goBox');
    if (gBox && !gBox.dataset.built) {
      gBox.dataset.built = '1';
      gBox.replaceChildren(...goUi());
    }
    if (gBox) gBox.hidden = s.trigger !== 'go';
    if (built) {
      els.intRow.hidden = s.input !== 'internal';
      els.goRow.hidden = s.trigger !== 'go';
    }
  }

  function render() {
    if (!TC) return;
    if (!built) build();
    renderSettings();
    renderSource();
    renderTopExtras();
    applyLock();
    renderStatus();
    renderCues();
  }

  function renderMeter() {
    if (!built) return;
    const db = level.peak > 0 ? 20 * Math.log10(level.peak) : -Infinity;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    els.meter.firstChild.style.width = `${active === 'ltc' ? pct : 0}%`;
    els.meter.classList.toggle('hot', db > -3);
    els.meter.classList.toggle('low', db < -40);
    els.meterTxt.textContent = active === 'ltc' && Number.isFinite(db) ? `${db.toFixed(0)} dBFS` : '—';
    els.lamp.classList.toggle('on', active === 'ltc' && level.locked);
  }

  function renderLocal() {
    if (!built) return;
    const lk = localLocked && lastLocal ? t('tc.local.locked', { tc: formatTc(lastLocal.tc), rate: rateKo(lastLocal.rate) }) : null;
    let m = '';
    if (active === 'mtc') m = `${boundPort ? boundPort.name || boundPort.id : t('tc.dev.noMidi')} · ${lk ?? t('tc.local.waiting', { src: 'MTC' })}${sysex ? '' : ` · ${t('tc.local.noSysex')}`}`;
    $('#tc-mtc-st').textContent = m;
    $('#tc-ltc-st').textContent = active === 'ltc' ? (lk ?? t('tc.local.waiting', { src: 'LTC' })) : '';
  }

  const stateClass = (st) => (st === 'locked' ? 'ok' : st === 'freewheel' ? 'warn' : st === 'lost' ? 'err' : '');
  const cueIndex = (id) => (TC ? TC.cues.findIndex((c) => c.id === id) : -1);

  function renderStatus() {
    if (!TC) return;
    const st = TCS;
    const s = TC.settings;
    const enabled = !!s.enabled;
    const go = s.trigger === 'go';
    const state = st?.state ?? 'off';
    const shown = st?.tc ?? st?.lastTc ?? null;
    const dim = stale || !st?.tc;
    const time = shown ?? '--:--:--:--';
    const srcKo = srcName(st?.src ?? s.input);
    const rate = rateKo(st?.rate);
    const nx = st?.next;
    const sb = st?.standby;
    const nxCount = nx ? (st.rolling ? fmtCountdown(nx.in ?? 0) : nx.tc) : '';
    const sbTxt = sb ? `STANDBY ${sb.index} · ${cueName(sb)}` : t('tc.noStandby');
    const top = $('#tcTop');
    if (top) {
      top.classList.toggle('disabled', !enabled);
      top.classList.toggle('stale', dim);
      top.dataset.state = state;
      $('#tcTime').textContent = time;
      $('#tcMeta').replaceChildren(
        h('span', {}, srcKo), ' · ', h('span', {}, rate), ' · ',
        h('span', { class: `tcst ${stateClass(state)}` }, stateName(state)),
        go ? h('span', {}, ' · GO') : '',
        enabled ? '' : h('span', { class: 'muted' }, ` · ${t('tc.ctlOff')}`));
      let nextTxt = '';
      if (go) nextTxt = $('#goBox') ? '' : sb ? `▸ ${sbTxt}` : '';
      else if (nx) nextTxt = `▸ ${nxCount} ${cueName(nx)}`;
      $('#tcNext').textContent = nextTxt;
      top.title = t(enabled ? 'tc.top.on' : 'tc.top.off');
      const aria = [t('tc.aria.tc', { tc: shown ?? t('common.none') }), stateName(state), enabled ? '' : t('tc.ctlOff'),
        go ? (sb ? t('tc.aria.standby', { n: sb.index, name: cueName(sb) }) : '') : nx ? t('tc.aria.next', { name: cueName(nx), at: nxCount }) : '', t('tc.aria.open')].filter(Boolean).join(', ');
      if (top.getAttribute('aria-label') !== aria) top.setAttribute('aria-label', aria);
    }
    const playing = !!st?.internal?.playing;
    for (const tp of transports) {
      tp.play.textContent = playing ? '⏸' : '▶';
      tp.play.setAttribute('aria-pressed', String(playing));
      tp.play.setAttribute('aria-label', playing ? t('tc.int.pause') : t('tc.int.play'));
    }
    for (const g of goUis) {
      g.sb.textContent = sbTxt;
      g.go.disabled = !sb;
    }
    if (!built) return;
    els.big.textContent = time;
    els.big.dataset.state = state;
    els.big.classList.toggle('stale', dim);
    const stEl = $('#tc-st-state');
    stEl.textContent = `${stateName(state)}${st?.rolling ? ` · ${t('tc.st.rolling')}` : st?.dir < 0 ? ` · ${t('tc.st.reverse')}` : ''}${st?.chasePending ? ` · ${t('tc.st.chasePending')}` : ''}${stale ? ` · ${t('tc.st.stale')}` : ''}`;
    stEl.className = `tcst ${stateClass(state)}`;
    $('#tc-st-src').textContent = srcKo;
    $('#tc-st-fps').textContent = st ? `${rate}${s.rate === 'auto' ? ` (${t('tc.rate.auto')}${st.detected ? ` · ${t('tc.st.detected', { rate: rateKo(st.detected) })}` : ''})` : ''}` : '—';
    $('#tc-st-raw').textContent = st?.raw ? `${st.raw}${st.offset ? ` (${t('tc.st.offset', { offset: s.offset })})` : ''}` : '—';
    $('#tc-st-next-l').textContent = go ? t('tc.st.nextGo') : t('tc.st.next');
    if (go) {
      const i = sb ? sb.index : 0;
      const after = i > 0 && i < TC.cues.length ? TC.cues[i] : null;
      $('#tc-st-next').textContent = after ? `${t('tc.cueN', { n: i + 1 })} · ${cueName(after)}` : '—';
    } else {
      const i = nx ? cueIndex(nx.id) : -1;
      $('#tc-st-next').textContent = nx ? `${i >= 0 ? `${t('tc.cueN', { n: i + 1 })} · ` : ''}${cueName(nx)} · ${nx.tc}${st.rolling ? ` · ${fmtCountdown(nx.in ?? 0)}` : ''}` : '—';
    }
    els.sbLbl.hidden = !go;
    els.sbVal.hidden = !go;
    els.sbVal.textContent = sb ? `${sb.index} · ${cueName(sb)} · ${sb.tc}` : t('tc.st.sbNone');
    renderCueStates();
  }

  setInterval(() => {
    if (active === 'mtc' && lastLocal && performance.now() - lastLocal.t > 500) localLocked = false;
    if (active) renderLocal();
  }, 250);

  // ---------------- queries for app.js ----------------
  function nextCueSlot() {
    if (!TCS) return null;
    const go = TC?.settings.trigger === 'go';
    if (!go && (TCS.state === 'lost' || TCS.state === 'off')) return null;
    const nx = go ? TCS.standby : TCS.next;
    if (!nx || nx.action !== 'slot') return null;
    const p = findPreset(nx.preset);
    if (p) return p.slot ?? null;
    return nx.slot ?? null;
  }

  function warnings() {
    const out = [];
    if (!TC?.settings.enabled) return out;
    const s = TC.settings;
    if (TCS?.state === 'lost') out.push(t('tc.warn.lost', { mode: t(s.onLoss === 'stop' ? 'tc.loss.stop' : 'tc.loss.hold') }));
    if ((s.input === 'mtc' || s.input === 'ltc') && s.trigger !== 'go' && !TC.source) out.push(t('tc.warn.noSource', { src: srcName(s.input) }));
    return out;
  }

  let warnSig = '';
  function syncWarnings() {
    const sig = warnings().join('|');
    if (sig === warnSig) return;
    warnSig = sig;
    ctx.renderWarnings?.();
  }

  let lastNextSlot = null;
  function syncNextSlot(forceRender = false) {
    const ns = nextCueSlot();
    if (ns === lastNextSlot && !forceRender) return;
    lastNextSlot = ns;
    ctx.renderSlots?.();
  }

  let lastPreview = null;

  return {
    init(tc, tcs, youId) {
      TC = tc;
      TCS = tcs;
      you = youId;
      stale = false;
      if (active) sendRaw({ type: 'tc.claim', kind: active, resume: true });
      render();
      syncWarnings();
      syncNextSlot(true);
    },
    onTc(tc) {
      TC = tc;
      render();
      syncWarnings();
      syncNextSlot(true);
    },
    onTcDelta(m) {
      if (!TC) return;
      if ('settings' in m) TC.settings = m.settings;
      if ('source' in m) TC.source = m.source;
      let cues = TC.cues;
      if (m.remove?.length) {
        const rm = new Set(m.remove);
        cues = cues.filter((c) => !rm.has(c.id));
      }
      if (m.upsert?.length) {
        cues = [...cues];
        const at = new Map(cues.map((c, i) => [c.id, i]));
        for (const c of m.upsert) {
          if (at.has(c.id)) cues[at.get(c.id)] = c;
          else {
            at.set(c.id, cues.length);
            cues.push(c);
          }
        }
      }
      if (m.order) {
        const by = new Map(cues.map((c) => [c.id, c]));
        cues = m.order.map((id) => by.get(id)).filter(Boolean);
      }
      TC.cues = cues;
      render();
      syncWarnings();
      syncNextSlot(true);
    },
    onTcs(m) {
      TCS = m;
      stale = false;
      renderStatus();
      syncWarnings();
      syncNextSlot();
    },
    onCue(m) {
      flashes.set(m.id, m.ok !== false);
      renderCueStates();
      setTimeout(() => { flashes.delete(m.id); renderCueStates(); }, 1200);
    },
    onCueAdded(id) {
      pendingFocus = id;
      renderCues();
    },
    onShowData(data) {
      downloadJson(`objitter-show-${new Date().toISOString().slice(0, 10)}.json`, data);
    },
    onShowPreview(m) {
      if (!pendingImport) return;
      lastPreview = m;
      renderPreview(m);
    },
    onSourceLost(m) {
      const was = active;
      if (was) {
        srcErr[was] = `${t('tc.lost.self')}${m?.reason ? ` — ${tm(m.reason)}` : ''}`;
        stopLocal(false);
      }
      toast(m?.reason ? tm(m.reason) : t('tc.lost.closed'), 'warn');
    },
    onPresets() {
      renderCues();
      syncNextSlot(true);
    },
    onState() {
      applyLock();
      renderGroups();
      renderCues();
    },
    onDisconnect() {
      stale = true;
      renderStatus();
    },
    relang() {
      transports.length = 0;
      goUis.length = 0;
      for (const id of ['#tcTransport', '#goBox']) { const b = $(id); if (b) delete b.dataset.built; }
      rowsById.clear();
      stateKey = '';
      built = false;
      warnSig = '';
      render();
      syncWarnings();
    },
    nextCueSlot,
    cuesUsing(name) {
      const n = String(name || '').toLowerCase();
      if (!TC || !n) return [];
      const out = [];
      TC.cues.forEach((c, i) => { if (String(c.preset || '').toLowerCase() === n) out.push(i + 1); });
      return out;
    },
    warnings,
    onKey(e) {
      if (!TC || e.isComposing || e.altKey) return false;
      if (isTextField(e.target)) return false;
      const macInsert = IS_MAC && e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyI';
      if (!macInsert && (e.ctrlKey || e.metaKey)) return false;
      if (e.code === 'Insert' || macInsert) {
        e.preventDefault();
        if (!e.repeat && guardEdit()) send({ type: 'tc.cue.add', atCurrent: true });
        return true;
      }
      if (TC.settings.trigger !== 'go') return false;
      const ae = document.activeElement;
      const onButton = !!ae && ae !== document.body && !!ae.closest?.('button, a[href], summary, [role=button], [role=tab], [role=menuitem], [role=menuitemradio]');
      if (e.code === 'PageDown' || e.code === 'NumpadEnter' || (e.code === 'Enter' && !onButton)) {
        e.preventDefault();
        if (!e.repeat) goCmd('tc.go');
        return true;
      }
      if (e.code === 'PageUp') {
        e.preventDefault();
        if (!e.repeat) goCmd('tc.back');
        return true;
      }
      return false;
    },
  };
}
