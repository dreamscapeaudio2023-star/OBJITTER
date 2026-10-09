// Output workspace: targets, timing, stop behaviour, OSC control input. Mounted into the container it is given.
import { $, h, store, send, guardEdit, armButton, toggleEl, segEl, setSeg, isLocked } from './core.js';
import { t, tm, pick, getLang } from './i18n.js';

export const sysLabel = (k) => pick(store.ST?.systems[k]?.label) || k;

export function createOutput({ statOf, ctlErrText, stats }) {
  let root = null;
  let sysRoot = null;
  let outAllow = false;
  let targetSig = '';
  const outEls = {};
  const targetEls = new Map();

  function outRow(label, input, id, note) {
    return h('div', { class: 'row' },
      h('label', { for: id }, label, note ? h('span', { class: 'badge note' }, note) : null),
      h('div', { class: 'ctl' }, input));
  }

  const setMaster = (patch) => { if (guardEdit()) send({ type: 'master', ...patch }); };
  const optValue = (v) => (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);

  function buildTargetCard(tg) {
    const id = tg.id;
    const sys = store.ST.systems[tg.system] ?? { label: tg.system, options: [], help: '' };
    const upd = (patch) => send({ type: 'output.target.update', id, patch });
    const fid = (k) => `o-${id}-${k}`;
    const name = h('input', {
      type: 'text', id: fid('name'), class: 'tname', maxLength: 32, spellcheck: false, 'aria-label': t('out.t.name'),
      onchange: (e) => upd({ name: e.target.value.trim() }),
    });
    const [enT, en] = toggleEl(fid('en'), (e) => upd({ enabled: e.target.checked }));
    enT.title = t('out.t.enable');
    en.setAttribute('aria-label', t('out.t.enable'));
    const dot = h('i', { class: 'tdot', 'aria-hidden': 'true' });
    const sysSel = h('select', { id: fid('sys'), onchange: (e) => upd({ system: e.target.value }) },
      Object.keys(store.ST.systems).map((k) => h('option', { value: k }, sysLabel(k))));
    const host = h('input', { type: 'text', id: fid('host'), spellcheck: false, onchange: (e) => upd({ host: e.target.value.trim() }) });
    const port = h('input', { type: 'number', id: fid('port'), min: 1, max: 65535, onchange: (e) => upd({ port: Number(e.target.value) }) });
    const rate = h('input', { type: 'number', id: fid('rate'), min: 1, max: 120, onchange: (e) => upd({ rate: Number(e.target.value) }) });
    const idOff = h('input', { type: 'number', id: fid('idoff'), min: -999, max: 999, step: 1, onchange: (e) => upd({ idOffset: Math.trunc(Number(e.target.value)) || 0 }) });
    const opts = (sys.options ?? []).map((opt) => {
      const oid = fid(`opt-${opt.key}`);
      const set = (v) => upd({ cfg: { [opt.key]: v } });
      let input;
      let el;
      if (opt.type === 'select') {
        el = h('select', { id: oid, onchange: (e) => set(optValue(e.target.value)) }, (opt.options ?? []).map(([v, l]) => h('option', { value: v }, pick(l))));
        input = el;
      } else if (opt.type === 'toggle') {
        [input, el] = toggleEl(oid, (e) => set(e.target.checked));
      } else if (opt.type === 'number') {
        el = h('input', { type: 'number', id: oid, min: opt.min, max: opt.max, step: opt.step, onchange: (e) => set(Number(e.target.value)) });
        input = el;
      } else {
        el = h('input', { type: 'text', id: oid, spellcheck: false, onchange: (e) => set(e.target.value) });
        input = el;
      }
      return { opt, el, row: outRow(pick(opt.label), input, oid, opt.note ? pick(opt.note) : null) };
    });
    const tf = {};
    const tfRow = (key, label) => {
      const [tgl, c] = toggleEl(fid(`tf-${key}`), (e) => upd({ transform: { [key]: e.target.checked } }));
      tf[key] = c;
      return outRow(label, tgl, fid(`tf-${key}`));
    };
    const sr = store.ST.constants.outScale ?? { min: 0, max: 4 };
    const or = store.ST.constants.outOffset ?? { min: -1, max: 1 };
    const scl = {};
    let link = ['scaleY', 'scaleZ'].every((k) => (tg.transform?.[k] ?? 1) === (tg.transform?.scaleX ?? 1));
    const sclRow = (key, range, step) => {
      const iid = fid(`tf-${key}`);
      scl[key] = h('input', {
        type: 'number', id: iid, min: range.min, max: range.max, step,
        onchange: (e) => {
          const v = e.target.value.trim() === '' ? NaN : Number(e.target.value);
          if (link && key.startsWith('scale')) upd({ transform: { scaleX: v, scaleY: v, scaleZ: v } });
          else upd({ transform: { [key]: v } });
        },
      });
      return outRow(t(`out.t.${key}`), scl[key], iid);
    };
    const [linkT, linkC] = toggleEl(fid('tf-link'), (e) => { link = e.target.checked; });
    linkC.checked = link;
    const [clampT, clampC] = toggleEl(fid('tf-clamp'), (e) => upd({ transform: { clamp: e.target.checked } }));
    scl.clamp = clampC;
    const sclBadge = h('span', { class: 'badge note', hidden: true }, t('out.t.scaleActive'));
    const sclReset = h('button', {
      type: 'button',
      onclick: () => upd({ transform: { scaleX: 1, scaleY: 1, scaleZ: 1, offsetX: 0, offsetY: 0, offsetZ: 0 } }),
    }, t('out.t.scaleReset'));
    const st = {};
    const stCell = (key, mono = true) => { st[key] = h('span', { class: mono ? 'mono' : '' }, '—'); return st[key]; };
    const statusGrid = h('div', { class: 'status-grid' },
      h('span', {}, t('out.st.target')), stCell('target'),
      h('span', {}, t('out.st.ip')), stCell('ip'),
      h('span', {}, t('out.st.state')), stCell('state', false),
      h('span', {}, t('out.st.hz')), stCell('hz'),
      h('span', {}, t('out.st.rate')), stCell('rate'),
      h('span', {}, t('out.st.p95')), stCell('p95'),
      h('span', {}, t('out.st.fb')), stCell('fb', false));
    const warn = h('div', { class: 'twarn' });
    const sample = h('div', { class: 'sample' }, '—');
    const delBtn = armButton(h('button', { class: 'danger', title: t('out.t.delete') }, t('common.delete')), () => send({ type: 'output.target.remove', id }));
    const help = pick(sys.help);
    const card = h('div', { class: 'tcard', 'data-id': id },
      h('div', { class: 'thead' }, dot, name, enT),
      h('div', { class: 'row' }, h('label', { for: fid('sys') }, t('out.t.system')), h('div', { class: 'ctl' }, sysSel)),
      outRow(t('out.t.host'), host, fid('host')),
      outRow(t('out.t.port'), port, fid('port')),
      outRow(t('out.t.rate'), rate, fid('rate')),
      h('div', { class: 'row', title: t('out.t.idOffset.title') },
        h('label', { for: fid('idoff') }, t('out.t.idOffset')), h('div', { class: 'ctl' }, idOff)),
      ...opts.map((o) => o.row),
      h('details', { class: 'tsub' }, h('summary', {}, t('out.t.transform')),
        tfRow('flipX', t('out.t.flipX')),
        tfRow('flipY', t('out.t.flipY')),
        tfRow('swapXY', t('out.t.swapXY'))),
      h('details', { class: 'tsub' }, h('summary', {}, t('out.t.scale'), ' ', sclBadge),
        outRow(t('out.t.scaleLink'), linkT, fid('tf-link')),
        sclRow('scaleX', sr, 0.05),
        sclRow('scaleY', sr, 0.05),
        sclRow('scaleZ', sr, 0.05),
        sclRow('offsetX', or, 0.01),
        sclRow('offsetY', or, 0.01),
        sclRow('offsetZ', or, 0.01),
        outRow(t('out.t.scaleClamp'), clampT, fid('tf-clamp')),
        h('div', { class: 'tact' }, sclReset),
        h('p', { class: 'hint' }, t('out.t.scale.hint', { smax: sr.max, omin: or.min, omax: or.max }))),
      h('div', { class: 'tstatus' }, statusGrid, warn, h('p', { class: 'muted tsmall' }, t('out.t.lastMsg')), sample),
      help ? h('details', { class: 'tsub' }, h('summary', {}, t('out.t.help', { system: sysLabel(tg.system) })), h('p', { class: 'hint' }, help)) : null,
      h('div', { class: 'tact' },
        h('button', { title: t('out.t.dup.title'), onclick: () => send({ type: 'output.target.add', copyOf: id, suffix: t('out.t.copySuffix') }) }, t('out.t.dup')),
        h('button', { title: t('out.t.mirror.title'), onclick: () => send({ type: 'output.target.add', copyOf: id, mirror: true, suffix: t('out.t.backupSuffix') }) }, t('out.t.mirror')),
        delBtn));
    targetEls.set(id, { card, name, en, dot, sysSel, host, port, rate, idOff, opts, tf, scl, sclBadge, st, warn, warnSig: '', sample, delBtn });
    return card;
  }

  function buildOutput() {
    for (const k of Object.keys(outEls)) delete outEls[k];
    targetEls.clear();
    targetSig = '';

    const addSys = h('select', { id: 'o-add-sys', 'aria-label': t('out.addSys') },
      Object.keys(store.ST.systems).map((k) => h('option', { value: k }, sysLabel(k))));
    const addBtn = h('button', { class: 'accent', onclick: () => send({ type: 'output.target.add', system: addSys.value }) }, t('out.add'));
    const [preciseT, precise] = toggleEl('o-precise', (e) => send({ type: 'setOutput', patch: { precise: e.target.checked } }));

    const notice = h('div', { class: 'notice', id: 'outNotice' }, h('span', {}, t('out.lockedRunning')),
      h('button', { onclick: () => { outAllow = true; updateOutputValues(); } }, t('out.allowChange')));

    const stopSeg = segEl([['freeze', t('out.stop.freeze')], ['center', t('out.stop.center')], ['release', t('out.stop.release')]], (v) => setMaster({ stopMode: v }));
    const disSeg = segEl([['release', t('out.stop.release')], ['center', t('out.dis.center')]], (v) => setMaster({ disableMode: v }));
    const vmaxVal = h('span', { class: 'val' });
    const vmax = h('input', { type: 'range', id: 'o-vmax', min: 0, max: 5, step: 0.05 });
    vmax.addEventListener('input', () => {
      vmaxVal.textContent = Number(vmax.value) === 0 ? t('common.off') : `${Number(vmax.value).toFixed(2)}/s`;
      setMaster({ maxVelocity: Number(vmax.value) });
    });
    const [exceptT, except] = toggleEl('o-vmax-except', (e) => setMaster({ vmaxExceptJumps: e.target.checked }));
    const [reseedT, reseed] = toggleEl('o-reseed', (e) => setMaster({ reseedOnStart: e.target.checked }));

    const [ctlOnT, ctlOn] = toggleEl('o-ctl-on', (e) => send({ type: 'setControl', patch: { enabled: e.target.checked } }));
    const ctlPort = h('input', { type: 'number', id: 'o-ctl-port', min: 1, max: 65535, onchange: (e) => send({ type: 'setControl', patch: { port: Number(e.target.value) } }) });
    const ctlAllow = h('input', {
      type: 'text', id: 'o-ctl-allow', spellcheck: false, placeholder: t('out.ctl.allow.ph'),
      onchange: (e) => send({ type: 'setControl', patch: { allow: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).join(', ') } }),
    });

    const lan = store.ST.network.lan;
    const targetList = h('div', { class: 'target-list', id: 'targetList' });
    targetList.addEventListener('focusout', () => setTimeout(() => { if (!targetList.contains(document.activeElement)) updateOutputValues(); }, 300));
    root.replaceChildren(
      notice,
      h('fieldset', { id: 'outFs' },
        h('div', { class: 'section' }, t('out.targets')),
        targetList,
        h('div', { class: 'target-add' }, h('span', { class: 'muted' }, t('out.newTarget')), addSys, addBtn),
        h('div', { class: 'section' }, t('out.timing')),
        outRow(t('out.precise'), preciseT, 'o-precise'),
        h('p', { class: 'hint', id: 'o-precise-hint' })),
      h('div', { class: 'lockable' },
        h('div', { class: 'section' }, t('out.stopSection')),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('out.onStop')), h('div', { class: 'ctl' }, stopSeg)),
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, t('out.onDisable')), h('div', { class: 'ctl' }, disSeg)),
        h('div', { class: 'row', title: t('out.vmax.title') },
          h('label', { for: 'o-vmax' }, t('out.vmax')), h('div', { class: 'ctl' }, vmax, vmaxVal)),
        outRow(t('out.vmaxExcept'), exceptT, 'o-vmax-except'),
        h('p', { class: 'hint' }, t('out.vmax.hint')),
        outRow(t('out.reseed'), reseedT, 'o-reseed')),
    );
    const sysKids = [
      h('div', { class: 'lockable' },
        h('div', { class: 'section' }, t('out.ctl.section')),
        outRow(t('out.ctl.enable'), ctlOnT, 'o-ctl-on'),
        outRow(t('out.ctl.port'), ctlPort, 'o-ctl-port'),
        outRow(t('out.ctl.allow'), ctlAllow, 'o-ctl-allow'),
        h('p', { class: 'hint', id: 'ctlLine' })),
      h('div', { class: 'card' },
        ...[
          '/objitter/start · /stop · /toggle · /run <0|1>',
          '/objitter/tap · /bpm <f> · /resync · /tempomult <0.25..4>',
          t('osc.speed'),
          t('osc.transition'),
          t('osc.preset', { max: store.ST.constants.slots }),
          t('osc.go'),
          t('osc.tcPlay'),
          '/objitter/tc <hh> <mm> <ss> <ff> [fps] · /tc "hh:mm:ss:ff" · /tc/stop · /tc/enable <0|1>',
          t('osc.session'),
          t('osc.objEnable'),
          t('osc.objMode'),
          t('osc.objCenter'),
          t('osc.objSet'),
          t('osc.objHome'),
        ].map((line) => h('p', {}, h('code', {}, line))),
        h('p', {}, t('osc.groupHint'))),
      h('div', { class: 'section' }, t('out.remote')),
      h('div', { class: 'card' }, ...(lan.length ? lan.map((u) => h('p', {}, h('code', {}, u))) : [h('p', {}, t('out.noLan'))]),
        h('p', {}, t('out.remote.hint'))),
    ];
    if (sysRoot) sysRoot.replaceChildren(...sysKids);
    else root.append(...sysKids);
    Object.assign(outEls, { addBtn, precise, stopSeg, disSeg, vmax, vmaxVal, except, reseed, ctlOn, ctlPort, ctlAllow });
  }

  function renderOutput() {
    if (!store.S || !store.ST || !outEls.precise) return;
    if (!store.running) outAllow = false;
    updateOutputValues();
  }

  function setVal(el, v) {
    if (document.activeElement !== el) el.value = v ?? '';
  }

  function renderTargets() {
    const targets = store.S.output?.targets ?? [];
    const sig = targets.map((tg) => `${tg.id}:${tg.system}`).join('|');
    if (sig !== targetSig) {
      targetSig = sig;
      targetEls.clear();
      $('#targetList').replaceChildren(...(targets.length ? targets.map(buildTargetCard) : [h('div', { class: 'empty', style: 'padding:16px' }, t('out.noTargets'))]));
    }
    for (const tg of targets) {
      const e = targetEls.get(tg.id);
      if (!e) continue;
      setVal(e.name, tg.name);
      e.en.checked = !!tg.enabled;
      setVal(e.sysSel, tg.system);
      setVal(e.host, tg.host);
      setVal(e.port, tg.port);
      setVal(e.rate, tg.rate);
      setVal(e.idOff, tg.idOffset ?? 0);
      const cfg = tg.cfg ?? {};
      for (const { opt, el } of e.opts) {
        if (opt.type === 'toggle') el.checked = !!cfg[opt.key];
        else setVal(el, cfg[opt.key]);
      }
      for (const k of ['flipX', 'flipY', 'swapXY']) e.tf[k].checked = !!tg.transform?.[k];
      const tfv = tg.transform ?? {};
      for (const k of ['scaleX', 'scaleY', 'scaleZ']) setVal(e.scl[k], tfv[k] ?? 1);
      for (const k of ['offsetX', 'offsetY', 'offsetZ']) setVal(e.scl[k], tfv[k] ?? 0);
      e.scl.clamp.checked = tfv.clamp !== false;
      e.sclBadge.hidden = ['scaleX', 'scaleY', 'scaleZ'].every((k) => (tfv[k] ?? 1) === 1)
        && ['offsetX', 'offsetY', 'offsetZ'].every((k) => !tfv[k]);
      e.card.classList.toggle('off', !tg.enabled);
      e.delBtn.disabled = targets.length <= 1;
      e.delBtn.title = targets.length <= 1 ? t('out.t.lastTarget') : t('out.t.delete');
    }
  }

  function updateOutputValues() {
    if (!outEls.precise || !store.S) return;
    renderTargets();
    const out = store.S.output;
    const m = store.S.master;
    outEls.precise.checked = !!out.precise;
    outEls.addBtn.disabled = (out.targets?.length ?? 0) >= (store.ST.constants.maxTargets ?? 8);
    setSeg(outEls.stopSeg, m.stopMode);
    setSeg(outEls.disSeg, m.disableMode);
    setVal(outEls.vmax, m.maxVelocity);
    outEls.vmaxVal.textContent = !m.maxVelocity ? t('common.off') : `${Number(m.maxVelocity).toFixed(2)}/s`;
    outEls.except.checked = m.vmaxExceptJumps !== false;
    outEls.reseed.checked = !!m.reseedOnStart;
    outEls.ctlOn.checked = !!store.S.control.enabled;
    setVal(outEls.ctlPort, store.S.control.port);
    setVal(outEls.ctlAllow, store.S.control.allow ?? '');
    const cs = store.S.controlStatus;
    $('#ctlLine').textContent = (cs.state === 'listening' ? t('out.ctl.listening', { port: cs.port }) : cs.state === 'error' ? t('out.ctl.error', { msg: ctlErrText(cs) }) : t('common.off'))
      + (store.S.control.enabled && store.S.control.allow ? ` · ${t('out.ctl.allowed', { allow: store.S.control.allow })}` : store.S.control.enabled ? ` · ${t('out.ctl.allowAll')}` : '');
    const lockOut = store.running && !outAllow;
    $('#outFs').disabled = lockOut || isLocked();
    $('#outNotice').hidden = !lockOut || isLocked();
    updateOutputStatus();
  }

  function updateOutputStatus() {
    if (!store.S || !outEls.precise) return;
    for (const tg of store.S.output?.targets ?? []) {
      const e = targetEls.get(tg.id);
      if (!e) continue;
      const st = statOf(tg.id);
      let state = '—';
      let cls = '';
      if (!tg.enabled) { state = t('out.state.off'); cls = 'off'; }
      else if (st) {
        if (st.resolve === 'resolving') { state = t('out.resolving'); cls = 'warn'; }
        else if (st.resolve === 'idle') { state = t('out.state.idle'); }
        else if (st.resolve !== 'ok') { state = t('out.state.resolveFailed', { code: st.resolve }); cls = 'err'; }
        else if (st.error) { state = t('out.sendError', { code: st.error }); cls = 'err'; }
        else { state = t(st.warn?.length ? 'out.state.okWarn' : 'out.state.ok'); cls = st.warn?.length ? 'warn' : 'ok'; }
      }
      e.st.target.textContent = st?.target ?? `${tg.host}:${tg.port}`;
      e.st.ip.textContent = st?.ip ?? '—';
      e.st.state.textContent = state;
      e.st.state.className = `tcst ${cls}`;
      e.dot.className = `tdot ${cls}`;
      e.st.hz.textContent = st ? t('out.st.hzVal', { hz: st.frameHz, rate: tg.rate }) : '—';
      e.st.rate.textContent = st ? `${st.msgRate} msg/s` : '—';
      e.st.p95.textContent = st?.p95Ms != null ? t('out.st.p95Val', { p95: st.p95Ms, period: st.periodMs ?? '—' }) : '—';
      e.st.fb.textContent = st?.feedback ? t(`out.fb.${st.feedback}`) : '—';
      const warns = st?.warn ?? [];
      const wsig = JSON.stringify(warns) + getLang();
      if (wsig !== e.warnSig) {
        e.warnSig = wsig;
        e.warn.replaceChildren(...warns.map((w) => h('p', { class: 'warn-text' }, `⚠ ${tm(w)}`)));
      }
      if (st?.sample) e.sample.textContent = st.sample;
    }
    const p95 = stats()?.intervalP95Ms;
    $('#o-precise-hint').textContent = t(store.ST.network?.platform === 'win32' ? 'out.precise.hintWin' : 'out.precise.hint')
      + (p95 != null ? ' ' + t('out.precise.now', { p95, period: stats().periodMs ?? '—' }) + (stats().jitterWarn ? t('out.precise.jitter') : '') + '.' : '');
  }

  return {
    mount(el, sysEl) { root = el; sysRoot = sysEl ?? null; },
    build: buildOutput,
    render: renderOutput,
    updateStatus: updateOutputStatus,
  };
}
