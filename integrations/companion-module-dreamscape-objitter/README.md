# companion-module-dreamscape-objitter

[Bitfocus Companion](https://bitfocus.io/companion) 에서 **DREAMSCAPE Objitter** 를 제어하는 모듈입니다 (Stream Deck, 웹 버튼, 다른 쇼 컨트롤에서 쓰기).

- **피드백·변수·목록**: Objitter 웹 서버의 WebSocket(`ws://호스트:8080/ws`)으로 상태를 받습니다.
- **명령**: WebSocket 이 연결되어 있고 Objitter 가 지원하면(`static.features` 에 `control.ws`) 같은 WebSocket 으로 `{ type: 'control', address, args }` 를 보냅니다 → 피드백을 보여 주는 바로 그 Objitter 로 갑니다. 연결이 없거나(피드백 끔) 예전 Objitter 면 OSC 컨트롤 입력(UDP, 기본 `9000`)으로 보냅니다. 두 경로 모두 Objitter 의 같은 OSC 명령 처리기를 거치므로 주소·인자·쇼 잠금 규칙이 같습니다. 그 밖의 WebSocket 메시지는 OSC 주소가 없는 **쇼 잠금**(`lock.set`)과 **라이브러리 적용**(`lib.apply`) 두 가지뿐입니다.
- OSC 로 보낼 때 연결된 Objitter 의 OSC 입력이 꺼짐 / 다른 포트 / 오류(예: `UDP port 9000 is in use by another program` — 같은 PC 에 Objitter 가 두 개 떠 있는 경우)이면 연결 상태에 경고를 띄우고 로그에 남깁니다. OSC 송신 오류도 경고로 표시합니다.

> 회사 내부(UNLICENSED) 모듈입니다. Companion 공식 모듈 목록(MIT 필수)에는 올리지 않고, 아래처럼 직접 설치해서 씁니다.

## 지원 Companion 버전

`@companion-module/base` 1.11 + `node22` 런타임으로 만들었습니다 → **Companion 3.5 이상, 4.x** (4.0 ~ 4.3 포함). Companion 3.4 이하는 지원하지 않습니다.

## 설치

### 1) 패키지 만들기 (개발 PC 에서 한 번)

Node.js 22 이상이 필요합니다.

```powershell
cd integrations\companion-module-dreamscape-objitter
npm install
npm run package        # → dreamscape-objitter-1.0.2.tgz 와 pkg\ 폴더 생성
```

### 2-A) Companion 4.x — 패키지 가져오기 (권장)

1. Companion 관리 화면 → **Modules** 탭
2. **Import module package** (모듈 패키지 가져오기) → `dreamscape-objitter-1.0.2.tgz` 선택
3. **Connections** 탭 → **+ Add connection** → `DREAMSCAPE Objitter` 검색 → 추가
4. 연결 설정(아래 "연결 설정")을 입력하고 저장

업데이트할 때는 버전을 올려(`package.json` 과 `companion/manifest.json` 의 `version`) 다시 만든 `.tgz` 를 가져오고, 연결 설정에서 새 버전을 고릅니다.

### 2-B) Companion 3.5 / 4.x — 개발자 모듈 폴더

`.tgz` 가져오기가 없는 Companion 3.x, 또는 모듈을 고치면서 바로 확인하고 싶을 때:

1. 모듈들을 넣을 폴더를 하나 만듭니다. 예: `D:\companion-dev-modules`
2. 그 안에 이 모듈 폴더를 넣습니다. 둘 중 하나:
   - 빌드한 `pkg` 폴더를 `D:\companion-dev-modules\dreamscape-objitter` 로 복사 (의존성 포함, 가장 간단), 또는
   - 이 폴더 전체(`npm install` 한 상태, `node_modules` 포함)를 복사하거나 링크
3. Companion 런처(트레이 창) → 톱니바퀴(⚙ Advanced settings) → **Developer modules path** 에 `D:\companion-dev-modules` 지정 → 저장 후 Companion 재시작
4. **Connections** → `DREAMSCAPE Objitter` 추가 (개발자 모듈은 목록에 "dev" 로 표시)

개발자 모듈 폴더는 파일이 바뀌면 Companion 이 모듈을 다시 불러옵니다.

## 연결 설정

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| Objitter host | `127.0.0.1` | Objitter 를 실행하는 PC 의 IP 또는 이름 |
| OSC control port | `9000` | Objitter 의 OSC 컨트롤 포트 (Setup → 시스템, 또는 `CONTROL_PORT`) |
| Web UI / WebSocket port | `8080` | Objitter 웹 포트 (`PORT`, 트레이/메뉴 막대 앱의 `웹 UI 포트`) |
| Enable WebSocket feedback | 켬 | 끄면 OSC 명령만 보냄 (피드백·변수·목록·쇼 잠금·라이브러리 적용 없음) |

### 다른 PC 에서 접속할 때 (`ALLOWED_HOSTS`)

Objitter 웹 서버는 DNS 리바인딩 방지를 위해 **Host 헤더**를 검사합니다. Companion(Node) 클라이언트는 Origin 을 보내지 않으므로 Origin 검사는 통과하고, Host 만 맞으면 됩니다.

- **Objitter PC 의 IP 주소**(예: `192.168.0.20`)나 `localhost`, 그 PC 의 컴퓨터 이름(`이름`, `이름.local`)으로 접속하면 **추가 설정 없이** 됩니다.
- 그 밖의 DNS 이름·별칭으로 접속하거나 NAT/포트 포워딩을 거치면 Objitter 쪽 `ALLOWED_HOSTS` 에 그 이름을 넣어야 합니다 (Windows 알림 영역 앱/Mac 메뉴 막대 앱의 설정 → `허용 호스트 이름`, 또는 환경 변수 `ALLOWED_HOSTS=show-pc.lan`). 넣지 않으면 연결 상태에 `HTTP 403: host not allowed` 가 뜹니다.
- Objitter 가 `외부 기기 접속 허용` 꺼짐(`HOST=127.0.0.1`)이면 같은 PC 의 Companion 만 접속할 수 있습니다 (OSC 컨트롤도 같은 PC 에서만).
- Objitter 의 OSC `허용 IP` 를 설정했다면 Companion PC 의 IP 를 추가하세요.
- 방화벽: Objitter PC 에서 TCP 8080(웹)과 UDP 9000(OSC) 수신을 허용.

## 액션 (36)

| 분류 | 액션 |
| --- | --- |
| 트랜스포트 | START · STOP · START/STOP 토글 · FREEZE 켬/끔/토글 · RETURN(전체 홈, 페이드 선택) · 되돌리기 |
| 템포 | TAP · RESYNC · BPM 지정 · BPM 증감 · 템포 배율 · 속도 지정(램프) · 속도 증감 · 크로스페이드 시간 |
| 호출 | 퀵 슬롯 1~32 (페이드 선택) · 프리셋 이름 (목록 또는 직접 입력, 페이드 선택) |
| 큐 (GO 리스트) | GO · BACK · 다음 큐 대기 · n 번 큐 대기 |
| 타임코드 | 내부 클럭 PLAY · PAUSE · PLAY/PAUSE 토글 · REWIND · LOCATE `hh:mm:ss:ff` · TC 큐 제어 켬/끔/토글 |
| 쇼 잠금 | 켬/끔/토글 (WebSocket 필요) |
| 세션 | 불러오기 (출력 설정 포함 여부) · 저장 |
| 오브젝트 | 켜기/끄기 · 재생/멈춤 · 모션 모드 · RETURN · 중심 위치 · 파라미터 지정(`range.x 0.5` 등) |
| 라이브러리 | 모션 라이브러리 항목을 오브젝트에 적용 (WebSocket 필요) |

- 프리셋·세션·라이브러리·큐 선택 목록은 WebSocket 이 연결되면 Objitter 의 현재 목록으로 채워지고, 목록에 없으면 이름을 직접 입력할 수 있습니다 (Companion 변수 `$(...)` 사용 가능).
- 오브젝트 대상은 Objitter 와 같은 문법: `5`, `1-8`, `1-4,9`, `@그룹`, `all`.
- 상태에 따라 달라지는 액션(FREEZE/클럭/쇼 잠금 토글, BPM·속도 증감, 다음 큐 대기)은 WebSocket 연결이 필요합니다. 연결이 없으면 보내지 않고 로그에 경고를 남깁니다.
- 쇼 잠금 중 막히는 명령(오브젝트 편집, 세션 불러오기, 되돌리기, TC 켜기/끄기)은 Objitter 가 거부하고 UI 에 경고를 띄웁니다. 트랜스포트·호출·GO·내부 클럭은 잠금 중에도 됩니다.

## 피드백 (14)

연결됨 / 끊김 · 실행 중 · 정지 · FREEZE · 쇼 잠금 · 슬롯 활성(마지막 호출) · 슬롯에 프리셋 있음 · 프리셋 활성 · 마지막 실행 큐 · 대기 큐 · 타임코드 진행 중 · TC 큐 제어 켜짐 · 세션 저장 안 된 변경.

## 변수 (61)

`$(objitter:running)`, `speed`, `bpm`, `tempo_mult`, `transition`, `frozen`, `show_lock`, `last_preset`, `last_slot`, `session_name`, `session_modified`, `timecode`, `tc_input`(TC 소스), `tc_state`, `tc_running`, `tc_enabled`, `tc_trigger`, `cue_current_number`/`_label`, `cue_standby_number`/`_label`, `cue_next_number`/`_label`/`_in`, `cue_count`, `connection`, `connection_error`, `version`, `slot_1` … `slot_32` (슬롯의 프리셋 이름). (`objitter` 는 연결 이름 — 바꾸면 그 이름으로)

큐 번호는 Objitter 큐 목록의 **순서**(1 = 첫 큐)이며 `/objitter/standby n` 과 같습니다.

## 프리셋 버튼 (69)

Companion 의 **Presets** 탭 → `DREAMSCAPE Objitter`:

72×72 버튼에서 단어가 중간에 끊기지 않도록 모든 라벨은 줄바꿈을 직접 넣고 글자 크기를 고정했습니다 (아이콘 버튼은 위 아이콘 + 아래 한 줄 라벨). 색은 분류별로 통일: 트랜스포트 = 민트, 템포 = 보라, 큐 = 노랑, 타임코드 = 하늘색.

| 분류 | 버튼 (상태 표시) |
| --- | --- |
| Transport | ▶ START (실행 중 민트) · ■ STOP (정지 빨강) · ▶■ TOGGLE → `RUNNING` / `STOPPED` · ❄ FREEZE → `FROZEN` · ⌂ RETURN · 🔓 LOCK → 🔒 `LOCKED` (노랑) · `LINK ONLINE` / `LINK OFFLINE` |
| Tempo | `TAP` + BPM · ⟳ RESYNC · `BPM +1` / `BPM −1` · `BPM` 표시 · `SPEED +0.1` / `−0.1` · `SPEED → 1.0` · `TEMPO ×0.5` / `×1` / `×2` (템포 배율) |
| Slots | `SLOT n` + 프리셋 이름 (빈 슬롯은 `—` 회색, 지정됨 = 진회색, 마지막 호출 = 민트) |
| Cues | `GO → 대기 큐 번호` + 이름 · `CUE BACK` · `CUE NEXT` · `LAST CUE n` + 이름 · `CUE 1` ~ `CUE 8` 대기 (실행 = 민트, 대기 = 노랑) |
| Timecode | ⏯ CLOCK (재생/멈춤 토글) · ▶ PLAY · ⏸ PAUSE · ⏮ REWIND · `LOCATE 00:00:00` · `TC CUE` on/off + 소스 · `TIMECODE` + 현재 타임코드 |

아이콘은 `scripts/gen-icons.js` 가 이미지 라이브러리 없이 그린 32×32 PNG 이며 (`src/icons/*.png`), 패키지에는 `src/icons.js` 의 base64 로 들어갑니다 (총 약 4 KB).

> **업데이트 후 주의:** 이전 버전 프리셋으로 이미 배치한 버튼은 자동으로 바뀌지 않습니다. 프리셋을 다시 끌어다 놓거나 버튼을 직접 고치세요.

## 개발 / 테스트

```powershell
npm install
npm test              # 액션 OSC 검사 + 임시 Objitter 서버 통합 테스트
npm run check         # main.js 수명주기 (Companion 없이, 가짜 base)
npm run package       # .tgz 만들기
npm run icons         # 아이콘 PNG + src/icons.js 다시 만들기
npm run preview       # 모든 프리셋 미리보기 PNG (Windows, %TEMP%\objitter-run\companion-presets.png)
```

- `test/presets.test.js`: 모든 프리셋·피드백 상태에서 라벨이 비지 않는지, 피드백마다 스타일이 지정됐는지, 각 줄이 Arial 폭 기준 68 px 안에 들어가 단어가 중간에 끊기지 않는지, 아이콘+라벨이 버튼 높이를 넘지 않는지 확인합니다.

- `test/actions.test.js`: UDP 수신 소켓을 열고 모든 액션이 Objitter 가 기대하는 OSC 주소·인자·타입 태그를 정확히 보내는지, WebSocket 전용 액션의 메시지, 잘못된 입력·연결 없음 처리, 피드백·변수·프리셋 정의를 확인합니다.
- `test/integration.test.js`: 저장소의 `server/index.js` 를 임시 폴더(`DATA_DIR`/`PRESET_DIR`/`LIBRARY_DIR`)와 포트 `18700`(웹)/`19700`(OSC)로 띄우고(`OBJITTER_TEST_PORT`, `OBJITTER_TEST_CONTROL_PORT` 로 변경), 액션으로 START·슬롯/프리셋 호출·BPM·TAP·속도·FREEZE·쇼 잠금·GO/BACK/NEXT/대기·내부 클럭 LOCATE/PLAY/PAUSE/REWIND·STOP 을 실행한 뒤 WebSocket 상태·변수·피드백이 바뀌는지, 서버 재시작 후 자동 재접속하는지 확인합니다. 끝나면 서버를 끄고 임시 폴더를 지웁니다.
- `test/split.test.js`: Objitter 두 개(웹 `18900`/`18901`, 같은 OSC `19900`)를 띄워 두 번째가 `EADDRINUSE` 가 되는 상황을 재현합니다. OSC 만 쓰면(1.0.1 동작) `127.0.0.1`·`localhost`·LAN IP 모두 명령이 다른 인스턴스로 가는 것을 확인하고, 1.0.2 에서는 명령이 WebSocket 으로 피드백 인스턴스에 도달하며 쇼 잠금 규칙이 같고 OSC 문제·송신 오류가 보고되는지 확인합니다.
- 루트 프로젝트의 `npm test` 와는 별개입니다 (루트 테스트는 이 폴더를 읽지 않음). Mac/Windows 설치 파일에도 포함되지 않습니다 (`server/`, `public/`, `demo/` 만 복사).

## 문제 해결

| 증상 | 확인 |
| --- | --- |
| 상태가 `Connection failure` | host·웹 포트, 방화벽(TCP 8080), `HTTP 403` 이면 `ALLOWED_HOSTS`. 이 상태에서도 OSC 명령은 보냅니다 |
| 상태 경고 `Commands will not reach this Objitter` | 연결된 Objitter 의 OSC 입력이 꺼짐/다른 포트/오류. 대개 같은 PC 에 Objitter 가 두 개(예: 개발 서버 8080 + 트레이 앱 8081) 떠서 두 번째가 UDP 9000 을 못 연 경우 → 하나를 끄거나 포트를 나누고, Objitter 를 업데이트하면 명령이 WebSocket 으로 갑니다 |
| 버튼을 눌러도 반응 없음 | 연결 상태·로그 먼저 확인. 그다음 OSC 컨트롤 포트, Objitter 상단 `CTRL` 표시, OSC `허용 IP`, Setup → OSC 로그(거부된 패킷은 `거부`) |
| 슬롯·프리셋 목록이 비어 있음 | WebSocket 피드백이 꺼져 있거나 연결 안 됨 → 직접 이름 입력은 가능 |
| 토글·증감 버튼만 안 됨 | WebSocket 연결 필요 (Companion 로그에 경고) |
| 오브젝트 편집·세션 불러오기가 안 됨 | Objitter 쇼 잠금 중 (잠금 해제 후 실행) |
| 내부 클럭 버튼이 안 됨 | Objitter 타임코드 입력 소스가 `내부 클럭` 이 아님 (UI 에 경고) |

## 파일

```
companion/manifest.json   모듈 정보 (id dreamscape-objitter, runtime node22)
companion/HELP.md         Companion 안에서 보이는 도움말 (영어)
src/main.js               InstanceBase — 설정, 연결 상태, 변수/피드백 갱신
src/actions.js            액션 정의 (OSC / WebSocket 명령)
src/feedbacks.js          불리언 피드백
src/variables.js          변수 정의
src/presets.js            프리셋 버튼
src/icons.js              프리셋 아이콘 (base64, scripts/gen-icons.js 가 생성) — 원본 PNG 는 src/icons/
scripts/preview.js        프리셋 미리보기 시트 (preview.ps1, System.Drawing)
src/state.js              WebSocket 메시지 → 상태 미러, 변수 계산
src/ws-client.js          읽기 전용 WebSocket 클라이언트 (재접속 1→30 s 백오프, 40 s 무응답 감지)
src/osc.js                OSC 인코더 / UDP 송신
src/upgrades.js           업그레이드 스크립트 (현재 없음)
```

© DREAMSCAPE Inc. All rights reserved. (UNLICENSED)
