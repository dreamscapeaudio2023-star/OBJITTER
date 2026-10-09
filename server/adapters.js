import { isValidHost } from './osc.js';
import { isPlainObject } from './fsutil.js';
import { toBool } from './engine.js';
import { L } from './i18n.js';

/** Static device texts travel as { en, ko } pairs; the browser picks its language. */
const T = (en, ko) => ({ en, ko });
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
let platform = process.platform;
/** Test hook: pretend to run on another OS (warnings only). */
export const setPlatformForTests = (p) => { platform = p; };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = (value) => ({ type: 'f', value });
const RAD = 180 / Math.PI;
const lerp = (a, b, k) => a + (b - a) * k;

const admXyz = (id, p) => [{ address: `/adm/obj/${id}/xyz`, args: [f(clamp(p.x, -1, 1)), f(clamp(p.y, -1, 1)), f(clamp(p.z, -1, 1))] }];

/** Below this horizontal radius the azimuth is undefined; the last one is held instead of snapping sideways. */
const AZ_HOLD_R = 0.03;
function heldAzimuth(x, y, st, key = 'az') {
  const az = Math.hypot(x, y) > AZ_HOLD_R || st[key] === undefined ? Math.atan2(x, y) * RAD : st[key];
  st[key] = az;
  return az;
}

/**
 * ADM-OSC AED (azimuth + = left). 'split': distance = horizontal radius, elevation = z × 90° (height stays
 * independent of distance, like L-ISA's own parameters). 'geo': true 3D polar, singular near the vertical axis.
 */
function admAed(id, p, c, st) {
  const x = clamp(p.x, -1, 1);
  const y = clamp(p.y, -1, 1);
  const z = clamp(p.z, -1, 1);
  const az = -heldAzimuth(x, y, st);
  let el;
  let d;
  if (c.admElev === 'geo') {
    d = Math.hypot(x, y, z);
    el = d > 1e-6 ? Math.asin(clamp(z / d, -1, 1)) * RAD : 0;
  } else {
    d = Math.hypot(x, y);
    el = z * 90;
  }
  return [{ address: `/adm/obj/${id}/aed`, args: [f(az), f(el), f(clamp(d, 0, 1))] }];
}

const admMessages = (id, p, c = {}, st = {}) => (c.admCoord === 'aed' ? admAed(id, p, c, st) : admXyz(id, p));
const ADM_OPTS = [
  { key: 'admCoord', label: T('ADM coordinates', 'ADM 좌표'), type: 'select', options: [['xyz', T('XYZ Cartesian (/xyz)', 'XYZ 직교 (/xyz)')], ['aed', T('AED spherical (/aed: azimuth·elevation·distance)', 'AED 구면 (/aed: 방위·고도·거리)')]] },
  { key: 'admElev', label: T('AED height', 'AED 높이 처리'), type: 'select', options: [['split', T('Split: distance = horizontal radius, elevation = Z × 90°', '분리: 거리 = 수평 반경, 고도 = Z × 90°')], ['geo', T('3D geometric: distance = 3D, elevation = true angle', '3D 기하: 거리 = 3D, 고도 = 실제 각도')]], note: T('AED only', 'AED 일 때만') },
];

const BUNDLE_OPT = { key: 'bundle', label: T('Send as OSC bundle', 'OSC 번들로 묶어 전송'), type: 'toggle' };
export const MAX_TARGETS = 8;

/**
 * Internal coordinates: normalized cube -1..1
 *   x: -1 left  .. +1 right
 *   y: -1 back  .. +1 front (stage)
 *   z: -1 below .. +1 top   (0 = ear level)
 * messages(id, p, cfg, st): st is a per-target, per-object scratch object (e.g. last azimuth).
 */
export const SYSTEMS = {
  spat: {
    label: 'SPAT Revolution',
    defaults: { host: '127.0.0.1', port: 8000, rate: 50, format: 'xyz', scaleX: 5, scaleY: 5, scaleZ: 3, zMode: 'sym', zOffset: 0, bundle: false },
    options: [
      { key: 'format', label: T('Coordinate format', '좌표 형식'), type: 'select', options: [['xyz', 'XYZ (Cartesian, m)'], ['aed', 'AED (Polar)']] },
      { key: 'scaleX', label: T('X half-width (m)', 'X 반폭 (m)'), type: 'number', min: 0.1, max: 200, step: 0.1 },
      { key: 'scaleY', label: T('Y half-width (m)', 'Y 반폭 (m)'), type: 'number', min: 0.1, max: 200, step: 0.1 },
      { key: 'zMode', label: T('Z mapping', 'Z 매핑'), type: 'select', options: [['sym', T('Symmetric (−Z … +Z)', '대칭 (−Z … +Z)')], ['height', T('Height (0 … Z, below = 0)', '높이 (0 … Z, 아래쪽은 0)')]] },
      { key: 'scaleZ', label: T('Z half-width (m)', 'Z 반폭 (m)'), type: 'number', min: 0, max: 100, step: 0.1, note: T('max in Height', '높이 모드에서는 최대 높이') },
      { key: 'zOffset', label: T('Z offset (m)', 'Z 오프셋 (m)'), type: 'number', min: -50, max: 50, step: 0.1 },
      BUNDLE_OPT,
    ],
    bundleable: true,
    help: T(
      'In SPAT Preferences → OSC, add an Input connection (matching port). {n} is the virtual source\'s Remote number. '
      + 'Addresses: /source/{n}/xyz (m) or /source/{n}/aed (azimuth, elevation, distance). On first connect, check the value order and azimuth sign (right = +) in the SPAT OSC log. '
      + 'Z Symmetric: z −1…+1 → −half-width…+half-width (below floor possible). Height: 0…max height. '
      + 'To receive ADM-OSC instead, switch the system to "ADM-OSC" and match SPAT\'s ADM input preset port (default 3001).',
      'SPAT Preferences → OSC 에서 Input 연결(포트 일치)을 추가하세요. {n} 은 가상 소스의 Remote 번호입니다. '
      + '주소: /source/{n}/xyz (m) 또는 /source/{n}/aed (azimuth, elevation, distance). 처음 연결 시 SPAT OSC 로그로 값 순서와 방위각 부호(오른쪽 = +)를 확인하세요. '
      + 'Z 대칭 모드: z −1…+1 → −반폭…+반폭 (바닥 아래 가능). 높이 모드: 0…최대 높이. '
      + 'ADM-OSC 로 받으려면 시스템을 "ADM-OSC" 로 바꾸고 SPAT 의 ADM 입력 프리셋 포트(기본 3001)를 맞추세요.',
    ),
    messages(id, p, c, st = {}) {
      const x = p.x * c.scaleX;
      const y = p.y * c.scaleY;
      const z = (c.zMode === 'height' ? Math.max(0, p.z) : p.z) * c.scaleZ + c.zOffset;
      if (c.format === 'aed') {
        const d = Math.hypot(x, y, z);
        const rh = Math.hypot(x, y);
        // Near the vertical axis the azimuth is undefined; hold the last one instead of snapping to 0 / ±180.
        const az = rh > 0.02 * Math.max(c.scaleX, c.scaleY) || st.az === undefined ? Math.atan2(x, y) * RAD : st.az;
        st.az = az;
        const el = d > 1e-6 ? Math.asin(clamp(z / d, -1, 1)) * RAD : 0;
        return [{ address: `/source/${id}/aed`, args: [f(az), f(el), f(d)] }];
      }
      return [{ address: `/source/${id}/xyz`, args: [f(x), f(y), f(z)] }];
    },
  },

  lisa: {
    label: 'L-ISA Controller / Studio',
    defaults: { host: '127.0.0.1', port: 8880, rate: 25, format: 'native', mapping: 'xy', panRange: 180, addrStyle: 'short', sendElevation: true, bundle: true, admCoord: 'xyz', admElev: 'split' },
    options: [
      { key: 'format', label: T('Protocol', '프로토콜'), type: 'select', options: [['native', 'L-ISA Native (pan / distance / elevation)'], ['adm', 'ADM-OSC']] },
      ...ADM_OPTS,
      { key: 'mapping', label: T('Native mapping', 'Native 매핑'), type: 'select', options: [['xy', T('Cartesian (x → pan, y → distance)', '직교 (x → pan, y → distance)')], ['polar', T('Polar (azimuth → pan, radius → distance)', '극좌표 (방위 → pan, 반경 → distance)')]] },
      { key: 'panRange', label: T('Polar pan range', '극좌표 pan 범위'), type: 'select', options: [[180, T('±90° (frontal)', '±90° (프런트)')], [360, T('360° (surround)', '360° (서라운드)')]] },
      { key: 'addrStyle', label: T('Native address style', 'Native 주소 형식'), type: 'select', options: [['short', '/ext/src/{n}/p · d · e'], ['long', T('/ext/src/{n}/pan · distance · elevation (unverified)', '/ext/src/{n}/pan · distance · elevation (미확인)')]], note: T('Long addresses are not confirmed by official docs', '긴 주소는 공식 문서로 미확인') },
      { key: 'sendElevation', label: T('Send elevation', 'Elevation 전송'), type: 'toggle' },
      BUNDLE_OPT,
    ],
    bundleable: true,
    help: T(
      'In L-ISA Settings → OSC, add a device and enable Receive (port 8880). {n} is the L-ISA OSC ID assigned to the source (may differ from the source number). '
      + 'Set the Sources → Control flags (Pan/Distance/Elevation) to ext. With bundles (on by default) p·d·e arrive in one packet, so no intermediate state is rendered. '
      + 'Cartesian mapping folds the area behind the audience (y<0) to distance 0 — use Polar mapping for 360° setups. '
      + 'For the ADM-OSC protocol, set the L-ISA OSC device format to ADM. L-ISA converts ADM XYZ with its own geometry (walls/ceiling), so '
      + 'high objects near the room center can turn into large distances — if the center must stay near distance 0, use AED + "Split" and '
      + 'set the L-ISA device to Coordinates model = Spherical, Distance mapping = Linear, Min distance = 0.',
      'L-ISA Settings → OSC 에서 장치를 추가하고 Receive 를 켜세요 (포트 8880). {n} 은 소스에 지정한 L-ISA OSC ID 입니다 (소스 번호와 다를 수 있음). '
      + 'Sources → Control 플래그(Pan/Distance/Elevation)를 ext 로 설정하세요. 번들(기본 켬)로 p·d·e 가 한 패킷에 도착해 중간 상태가 렌더링되지 않습니다. '
      + '직교 매핑은 관객 뒤(y<0)를 distance 0 으로 접습니다 — 360° 구성에서는 극좌표 매핑을 쓰세요. '
      + 'ADM-OSC 프로토콜이면 L-ISA 의 OSC 장치 포맷을 ADM 으로 맞추세요. ADM XYZ 는 L-ISA 가 자체 지오메트리(벽·천장)로 변환하므로 '
      + '방 중앙 근처의 높은 오브젝트가 큰 distance 로 바뀔 수 있습니다 — 중앙이 distance 0 에 가깝게 나와야 하면 AED + "분리" 를 쓰고 '
      + 'L-ISA 장치의 Coordinates model = Spherical, Distance mapping = Linear, Min distance = 0 으로 설정하세요.',
    ),
    messages(id, p, c, st = {}) {
      if (c.format === 'adm') return admMessages(id, p, c, st);
      const long = c.addrStyle === 'long';
      let pan;
      let dist;
      if (c.mapping === 'polar') {
        const ang = heldAzimuth(p.x, p.y, st);
        pan = clamp(0.5 + ang / Number(c.panRange || 180), 0, 1);
        dist = clamp(Math.hypot(p.x, p.y), 0, 1);
      } else {
        pan = clamp((p.x + 1) / 2, 0, 1);
        dist = clamp((p.y + 1) / 2, 0, 1);
      }
      const out = [
        { address: `/ext/src/${id}/${long ? 'pan' : 'p'}`, args: [f(pan)] },
        { address: `/ext/src/${id}/${long ? 'distance' : 'd'}`, args: [f(dist)] },
      ];
      if (c.sendElevation) out.push({ address: `/ext/src/${id}/${long ? 'elevation' : 'e'}`, args: [f(clamp(p.z, 0, 1))] });
      return out;
    },
  },

  ds100: {
    label: 'd&b Soundscape (DS100)',
    defaults: { host: '192.168.1.100', port: 50010, rate: 20, mapping: 1, posMsg: 'xy', minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
    options: [
      { key: 'mapping', label: 'Coordinate Mapping Area', type: 'select', options: [[1, '1'], [2, '2'], [3, '3'], [4, '4']] },
      { key: 'posMsg', label: T('Position message', '위치 메시지'), type: 'select', options: [['xy', 'source_position_xy (x y)'], ['xyz', 'source_position (x y z)']] },
      { key: 'minX', label: T('X min (P1 virtual)', 'X 최소 (P1 가상값)'), type: 'number', min: -1000, max: 1000, step: 0.01 },
      { key: 'maxX', label: T('X max (P3 virtual)', 'X 최대 (P3 가상값)'), type: 'number', min: -1000, max: 1000, step: 0.01 },
      { key: 'minY', label: T('Y min (P1 virtual)', 'Y 최소 (P1 가상값)'), type: 'number', min: -1000, max: 1000, step: 0.01 },
      { key: 'maxY', label: T('Y max (P3 virtual)', 'Y 최대 (P3 가상값)'), type: 'number', min: -1000, max: 1000, step: 0.01 },
      { key: 'minZ', label: T('Z min', 'Z 최소'), type: 'number', min: -1000, max: 1000, step: 0.01 },
      { key: 'maxZ', label: T('Z max', 'Z 최대'), type: 'number', min: -1000, max: 1000, step: 0.01 },
    ],
    help: T(
      'The DS100 receives on UDP 50010 (replies on 50011). Put inputs in En-Scene mode and define the Coordinate Mapping Area in R1. '
      + 'Defaults are 0–1 relative to the Mapping Area. If R1 uses custom virtual coordinates (P1/P3 virtual), enter the same min/max here. '
      + 'If you need Z, switch the position message to source_position (x y z). If the axes differ from the P1–P4 definition, fix them with the transform (flip/swap). '
      + 'Source numbers (after offset) must be 1–64 (128 with extension).',
      'DS100 은 UDP 50010 으로 수신합니다(응답은 50011). 입력을 En-Scene 모드로 두고, R1 에서 Coordinate Mapping Area 를 정의하세요. '
      + '기본값은 Mapping Area 기준 0~1 입니다. R1 에서 사용자 정의 가상 좌표(P1/P3 virtual)를 쓰면 최소/최대를 같은 값으로 맞추세요. '
      + 'Z 가 필요하면 위치 메시지를 source_position (x y z) 으로 바꾸세요. 축 방향이 P1–P4 정의와 다르면 좌표 변환(반전/교환)으로 맞추세요. '
      + '소스 번호(오프셋 적용 후)는 1–64 (확장 시 128) 범위여야 합니다.',
    ),
    messages(id, p, c) {
      const map = (v, lo, hi) => {
        const a = Math.min(lo, hi);
        const b = Math.max(lo, hi);
        return clamp(lerp(lo, hi, (clamp(v, -1, 1) + 1) / 2), a, b);
      };
      const x = map(p.x, c.minX, c.maxX);
      const y = map(p.y, c.minY, c.maxY);
      if (c.posMsg === 'xyz') {
        return [{ address: `/dbaudio1/coordinatemapping/source_position/${c.mapping}/${id}`, args: [f(x), f(y), f(map(p.z, c.minZ, c.maxZ))] }];
      }
      return [{ address: `/dbaudio1/coordinatemapping/source_position_xy/${c.mapping}/${id}`, args: [f(x), f(y)] }];
    },
  },

  adm: {
    label: 'ADM-OSC (generic)',
    defaults: { host: '127.0.0.1', port: 4001, rate: 30, bundle: false, admCoord: 'xyz', admElev: 'split' },
    options: [...ADM_OPTS, BUNDLE_OPT],
    bundleable: true,
    help: T(
      'ADM-OSC standard: /adm/obj/{n}/xyz (normalized −1…1) or /adm/obj/{n}/aed (azimuth °, + = left / elevation ° / distance 0…1). Works with SPAT (ADM input preset, default port 3001), L-ISA (OSC device format ADM), Nuendo and other ADM-OSC devices. '
      + 'AED holds the last azimuth when the horizontal radius is below 0.03 (no sideways azimuth jumps at the center). '
      + 'If L-ISA must report near distance 0 at the room center, use AED + "Split" and set the L-ISA device to Spherical / Linear / Min distance 0.',
      'ADM-OSC 표준: /adm/obj/{n}/xyz (정규화 -1~1) 또는 /adm/obj/{n}/aed (방위 °, + = 왼쪽 / 고도 ° / 거리 0~1). SPAT(ADM 입력 프리셋, 기본 포트 3001), L-ISA(OSC 장치 포맷 ADM), Nuendo 등 ADM-OSC 지원 기기 공용. '
      + 'AED 는 수평 반경이 0.03 미만이면 마지막 방위를 유지합니다 (중앙에서 방위가 옆으로 튀지 않음). '
      + 'L-ISA 에서 방 중앙이 distance 0 에 가깝게 나와야 하면 AED + "분리" 를 쓰고 L-ISA 장치를 Spherical / Linear / Min distance 0 으로.',
    ),
    messages: (id, p, c, st) => admMessages(id, p, c, st),
  },

  custom: {
    label: 'Custom OSC',
    defaults: { host: '127.0.0.1', port: 7000, rate: 30, address: '/source/{id}/xyz', args: 'xyz', scaleX: 1, scaleY: 1, scaleZ: 1, offset01: false },
    options: [
      { key: 'address', label: T('Address template ({id})', '주소 템플릿 ({id})'), type: 'text' },
      { key: 'args', label: T('Arguments', '인자'), type: 'select', options: [['xyz', 'x y z'], ['xy', 'x y']] },
      { key: 'scaleX', label: T('X scale', 'X 스케일'), type: 'number', min: -1000, max: 1000, step: 0.1 },
      { key: 'scaleY', label: T('Y scale', 'Y 스케일'), type: 'number', min: -1000, max: 1000, step: 0.1 },
      { key: 'scaleZ', label: T('Z scale', 'Z 스케일'), type: 'number', min: -1000, max: 1000, step: 0.1 },
      { key: 'offset01', label: T('Map to 0–1', '0~1 범위로 변환'), type: 'toggle' },
    ],
    help: T('For any OSC device. {id} is replaced with the source number.', '임의의 OSC 장치용. {id} 는 소스 번호로 치환됩니다.'),
    messages(id, p, c) {
      const m = (v) => (c.offset01 ? (v + 1) / 2 : v);
      const args = [f(m(p.x) * c.scaleX), f(m(p.y) * c.scaleY)];
      if (c.args === 'xyz') args.push(f(m(p.z) * c.scaleZ));
      return [{ address: String(c.address || '/source/{id}/xyz').replaceAll('{id}', String(id)), args }];
    },
  },
};

const intIn = (v, min, max, def) => {
  if (typeof v !== 'number' && typeof v !== 'string') return def;
  if (typeof v === 'string' && !v.trim()) return def;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

/**
 * Output scaling works in the normalized cube (after flip/swap, before the adapter conversion), so polar
 * adapters (SPAT AED, ADM AED, L-ISA polar) see a scaled Cartesian position. Offsets are normalized units.
 */
export const SCALE_RANGE = { min: 0, max: 4 };
export const OFFSET_RANGE = { min: -1, max: 1 };
export const SCALE_KEYS = ['scaleX', 'scaleY', 'scaleZ'];
export const OFFSET_KEYS = ['offsetX', 'offsetY', 'offsetZ'];
const TRANSFORM0 = { flipX: false, flipY: false, swapXY: false, scaleX: 1, scaleY: 1, scaleZ: 1, offsetX: 0, offsetY: 0, offsetZ: 0, clamp: true };

/** Strict: a value outside the range (or not a finite number) is rejected → def. */
function strictNum(v, { min, max }, def) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim())) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 1000) / 1000 : def;
}

export function sanitizeTransform(src, prev = TRANSFORM0) {
  const tf = isPlainObject(src) ? src : {};
  const base = { ...TRANSFORM0, ...(isPlainObject(prev) ? prev : {}) };
  const out = {
    flipX: toBool(tf.flipX, base.flipX),
    flipY: toBool(tf.flipY, base.flipY),
    swapXY: toBool(tf.swapXY, base.swapXY),
  };
  for (const k of SCALE_KEYS) out[k] = strictNum(tf[k], SCALE_RANGE, base[k]);
  for (const k of OFFSET_KEYS) out[k] = strictNum(tf[k], OFFSET_RANGE, base[k]);
  out.clamp = toBool(tf.clamp, base.clamp);
  return out;
}

export const isIdentityScale = (s) => s.scaleX === 1 && s.scaleY === 1 && s.scaleZ === 1 && s.offsetX === 0 && s.offsetY === 0 && s.offsetZ === 0;

export function defaultTarget(system = 'spat', id = 't1') {
  const { host, port, rate, ...cfg } = SYSTEMS[system].defaults;
  return { id, name: SYSTEMS[system].label, enabled: true, system, host, port, rate, idOffset: 0, cfg, transform: { ...TRANSFORM0 } };
}

export function defaultOutputConfig() {
  return { precise: false, targets: [defaultTarget('spat', 't1')] };
}

function sanitizeCfg(sys, src, prev) {
  const out = {};
  let s0 = isPlainObject(src) ? src : {};
  if (Object.hasOwn(s0, 'scaleXY') && !Object.hasOwn(s0, 'scaleX')) s0 = { ...s0, scaleX: s0.scaleXY, scaleY: s0.scaleXY };
  for (const opt of SYSTEMS[sys].options) {
    const v = s0[opt.key];
    const def = prev[opt.key] ?? SYSTEMS[sys].defaults[opt.key];
    if (opt.type === 'number') {
      const n = typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
      out[opt.key] = Number.isFinite(n) ? clamp(n, opt.min, opt.max) : def;
    } else if (opt.type === 'toggle') {
      out[opt.key] = toBool(v, def);
    } else if (opt.type === 'select') {
      const match = v === undefined ? null : opt.options.find(([val]) => String(val) === String(v));
      out[opt.key] = match ? match[0] : def;
    } else {
      out[opt.key] = typeof v === 'string' && v.trim() ? v.slice(0, 256) : def;
    }
  }
  return out;
}

const cleanName = (v, def) => (typeof v === 'string' && v.trim()
  ? Array.from(v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, 32).join('')
  : def);

/** Invalid fields keep `prev`. Changing the system starts from that system's defaults. */
export function sanitizeTarget(src, prev) {
  const s = isPlainObject(src) ? src : {};
  const system = typeof s.system === 'string' && Object.hasOwn(SYSTEMS, s.system) ? s.system : prev.system;
  const base = system === prev.system ? prev : { ...defaultTarget(system, prev.id), name: prev.name === SYSTEMS[prev.system].label ? SYSTEMS[system].label : prev.name, enabled: prev.enabled, idOffset: prev.idOffset, transform: prev.transform };
  return {
    id: base.id,
    name: cleanName(s.name, base.name),
    enabled: toBool(s.enabled, base.enabled),
    system,
    host: isValidHost(s.host) ? s.host.trim() : base.host,
    port: intIn(s.port, 1, 65535, base.port),
    rate: intIn(s.rate, 1, 120, base.rate),
    idOffset: intIn(s.idOffset, -999, 999, base.idOffset),
    cfg: sanitizeCfg(system, s.cfg, base.cfg),
    transform: sanitizeTransform(s.transform, base.transform),
  };
}

export function newTargetId(targets) {
  for (let i = 1; ; i++) if (!targets.some((t) => t.id === `t${i}`)) return `t${i}`;
}

/** Accepts the current { precise, targets[] } or the old single-output { system, systems, transform } shape. */
export function sanitizeOutput(cfg, prev = defaultOutputConfig()) {
  const src = isPlainObject(cfg) ? cfg : {};
  let list = null;
  if (Array.isArray(src.targets)) {
    list = src.targets.filter(isPlainObject);
  } else if (typeof src.system === 'string' && Object.hasOwn(SYSTEMS, src.system)) {
    const old = isPlainObject(src.systems?.[src.system]) ? src.systems[src.system] : {};
    const { host, port, rate, ...cfgOld } = old;
    list = [{ system: src.system, host, port, rate, cfg: cfgOld, transform: src.transform }];
  }
  let targets = prev.targets;
  if (list) {
    targets = [];
    for (const t of list.slice(0, MAX_TARGETS)) {
      const id = typeof t.id === 'string' && /^t\d{1,3}$/.test(t.id) && !targets.some((x) => x.id === t.id) ? t.id : newTargetId(targets);
      const system = Object.hasOwn(SYSTEMS, t.system) ? t.system : 'spat';
      const before = prev.targets.find((x) => x.id === id && x.system === system) ?? defaultTarget(system, id);
      targets.push(sanitizeTarget({ ...t, system }, before));
    }
    if (!targets.length) targets = [defaultTarget('spat', 't1')];
  }
  return { precise: toBool(src.precise, prev.precise), targets };
}

/**
 * flip/swap, then scale + offset (from `scl`, defaults to `t`; the server passes a ramped copy so live
 * changes glide). Clamp keeps the result inside -1..1, i.e. inside the target's configured range.
 * Identity scale skips the arithmetic entirely, so default output is unchanged.
 */
export function applyTransform(p, t, scl = t) {
  let { x, y, z } = p;
  if (t.swapXY) [x, y] = [y, x];
  if (t.flipX) x = -x;
  if (t.flipY) y = -y;
  if (scl.scaleX === undefined || isIdentityScale(scl)) return { x, y, z };
  x = x * scl.scaleX + scl.offsetX;
  y = y * scl.scaleY + scl.offsetY;
  z = z * scl.scaleZ + scl.offsetZ;
  if (t.clamp !== false) {
    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);
    z = clamp(z, -1, 1);
  }
  return { x, y, z };
}

/** Linear ramp between two scale sets (k 0..1); k ≥ 1 returns `to` exactly. */
export function lerpScale(from, to, k) {
  if (k >= 1) return to;
  const out = {};
  for (const key of [...SCALE_KEYS, ...OFFSET_KEYS]) out[key] = lerp(from[key], to[key], Math.max(0, k));
  return out;
}

export const pickScale = (t) => Object.fromEntries([...SCALE_KEYS, ...OFFSET_KEYS].map((k) => [k, t[k] ?? TRANSFORM0[k]]));

/** Static, user-facing warnings for a target given the enabled objects' source ids. */
export function targetWarnings(t, sourceIds) {
  const w = [];
  const ids = sourceIds.map((n) => n + t.idOffset);
  if (ids.some((n) => n < 1)) w.push(L('srv.warn.idBelow1'));
  if (t.system === 'ds100' && ids.some((n) => n > 128)) w.push(L('srv.warn.ds100Range'));
  if (t.system === 'lisa' && t.cfg.format === 'native' && t.cfg.addrStyle === 'long') w.push(L('srv.warn.lisaLong'));
  if (platform === 'darwin' && (t.port === 5000 || t.port === 7000) && LOCAL_HOSTS.has(String(t.host).toLowerCase())) {
    w.push(L('srv.warn.macAirPlay', { port: t.port }));
  }
  return w;
}

export function describeSystems() {
  return Object.fromEntries(
    Object.entries(SYSTEMS).map(([k, s]) => [k, { label: s.label, options: s.options, help: s.help, defaults: s.defaults, bundleable: !!s.bundleable, feedback: false }]),
  );
}
