# Objitter macOS 설치 안내

다른 Mac 에 Objitter 를 설치하는 방법입니다. 개발 도구나 Node.js 는 필요 없습니다 — 설치 파일(.pkg) 하나로 끝납니다.

> Objitter 는 DREAMSCAPE 사내 전용 소프트웨어입니다 ([LICENSE](../LICENSE)). 무단 복제·배포 금지.

## 1. 준비

- **macOS 11 (Big Sur) 이상**
- **Apple Silicon (M1~) / Intel Mac 모두 지원** (하나의 설치 파일이 둘 다 지원)
- 관리자 계정 암호 (설치할 때 필요)
- 디스크 여유 공간 약 300 MB

## 2. 내려받기

1. 브라우저에서 릴리스 페이지를 엽니다: <https://github.com/dreamscapeaudio2023-star/OBJITTER/releases/latest>
2. **Assets** 에서 `Objitter-0.2.0.pkg` 를 눌러 내려받습니다 (보통 `다운로드` 폴더에 저장됨).
3. (선택) 파일이 손상되지 않았는지 확인: 같은 곳의 `Objitter-0.2.0.pkg.sha256` 에 적힌 값과 아래 명령 결과가 같아야 합니다.
   ```bash
   shasum -a 256 ~/Downloads/Objitter-0.2.0.pkg
   ```

## 3. 설치 — "열 수 없음" 경고 넘기기

이 설치 파일은 Apple 공증(notarization)을 받지 않았습니다. 그래서 처음 열 때 macOS(Gatekeeper)가 **"Apple 은 … 악성 코드가 없음을 확인할 수 없습니다"** 같은 경고를 띄우고 열지 않습니다. 사내에서 받은 파일이 맞다면 아래 방법 중 하나로 여세요. macOS 버전은  → `이 Mac에 관하여` 에서 확인합니다.

### macOS 15 Sequoia 이상

macOS 15 부터는 Control-클릭(우클릭) → `열기` 로 경고를 넘길 수 **없습니다**.

1. `Objitter-0.2.0.pkg` 를 더블클릭 → 경고가 뜨면 **`완료`** 를 누릅니다 (`휴지통으로 이동` 은 누르지 마세요).
2.  → **시스템 설정** → **개인정보 보호 및 보안** → 아래로 스크롤해 **보안** 항목으로 갑니다.
3. "'Objitter-0.2.0.pkg'이(가) … 차단되었습니다" 문구 옆의 **`그래도 열기`** 를 누릅니다. (버튼은 열기를 시도한 뒤 약 1시간 동안만 보입니다. 안 보이면 1번부터 다시 하세요.)
4. 관리자 암호(또는 Touch ID)를 입력 → 다시 뜨는 창에서 **`열기`**.

### macOS 11 ~ 14

1. Finder 에서 `Objitter-0.2.0.pkg` 를 **Control-클릭(또는 우클릭) → `열기`** → 뜨는 창에서 **`열기`**.
2. 이렇게 해도 안 열리면 위 Sequoia 방법처럼 시스템 설정(macOS 12 이하: 시스템 환경설정 → 보안 및 개인 정보 보호 → 일반)에서 **`그래도 열기`**(macOS 12 이하: `확인 없이 열기`)를 누릅니다.

### 터미널로 (모든 버전)

내려받은 파일의 격리 표시를 지운 뒤 더블클릭하면 경고 없이 열립니다.

```bash
xattr -d com.apple.quarantine ~/Downloads/Objitter-0.2.0.pkg
```

### 설치 진행

설치 프로그램이 열리면 `계속` → `설치` → 관리자 암호 입력. 설치 프로그램은 실행 중인 예전 Objitter 를 종료하고, 앱을 `/Applications/Objitter.app` 에 설치한 뒤 **자동으로 실행**합니다.

설치된 앱은 보통 다시 경고 없이 실행됩니다. 설치 프로그램은 내려받은 .pkg 에 붙은 격리 표시를 설치된 파일에 옮기지 않는 것이 일반적이기 때문입니다. 혹시 앱을 열 때 경고가 뜨면 위와 같은 방법으로 `그래도 열기` 를 누르거나 다음 명령을 실행하세요.

```bash
xattr -dr com.apple.quarantine /Applications/Objitter.app
```

## 4. 처음 실행

- **메뉴 막대**(화면 오른쪽 위)에 DREAMSCAPE 로고 아이콘이 생깁니다. Dock 에는 나타나지 않습니다. 아이콘이 선명하면 서버가 실행 중이고, 흐리면 정지·시작 중, ⚠︎ 이면 오류입니다.
- 서버가 시작되면 브라우저가 자동으로 열립니다: <http://localhost:8080>
- **방화벽 알림** — "'node' 응용 프로그램이 들어오는 네트워크 연결을 허용하겠습니까?" 가 뜨면 **`허용`** 하세요. 거부하면 태블릿·다른 PC 브라우저 접속과 OSC 컨트롤 입력(UDP 9000)이 막힙니다. macOS 방화벽이 켜져 있을 때만 뜹니다 (기본값은 꺼짐). 나중에 바꾸려면: 시스템 설정 → 네트워크 → 방화벽 → 옵션.
- **로컬 네트워크 알림 (macOS 15 이상)** — "'Objitter'이(가) 로컬 네트워크에서 기기를 찾고 연결하도록 허용하겠습니까?" 가 뜨면 **`허용`** 하세요. 같은 네트워크의 다른 장비(렌더러, 예: SPAT Revolution 이 도는 다른 Mac/PC)로 OSC 를 **보낼 때** 처음 한 번 뜹니다. 거부하면 다른 장비로 가는 OSC 출력이 막힙니다. 같은 Mac(127.0.0.1)으로 보내거나, 다른 기기가 이 Mac 에 접속하는 것(웹 UI·OSC 입력)에는 필요 없습니다. 나중에 바꾸려면: 시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크 → `Objitter` 켜기.

## 5. 메뉴 막대 사용법

메뉴 막대 아이콘을 누르면:

| 메뉴 | 하는 일 |
| --- | --- |
| 웹 UI 열기 (`⌘O`) | 브라우저에서 Objitter 화면 열기 |
| 네트워크 주소 복사 | 태블릿·다른 PC 에서 접속할 주소(`http://<이 Mac IP>:8080`) 복사 |
| 서버 시작 / 정지 / 재시작 | 백그라운드 서버 제어 |
| 설정 | 웹 UI 포트, OSC 컨트롤 포트, 다른 기기 접속 허용, 허용 호스트 이름, 잠자기 방지, 앱 실행 시 서버 자동 시작, 서버 시작 시 브라우저 열기, 로그인 시 실행 (macOS 13 이상), 설정 초기화 |
| 로그 보기 / 데이터 폴더 열기 | 서버 로그·데이터 폴더를 Finder 등에서 열기 |
| Objitter 종료 (`⌘Q`) | 서버와 앱 모두 종료 |

서버 쪽 설정(포트 등)은 서버를 재시작하면 적용됩니다. 메뉴는 시스템 언어(한국어/영어)를 따릅니다.

## 6. 데이터 위치

| 내용 | 위치 |
| --- | --- |
| 프리셋·쇼·라이브러리 등 데이터 | `~/Library/Application Support/Objitter` (`data/`, `presets/`, `library/`) |
| 서버 로그 | `~/Library/Logs/Objitter/server.log` |
| 메뉴 설정 | `defaults` 도메인 `app.objitter` |

Finder 에서 `~/Library` 는 숨겨져 있습니다 — 메뉴 `데이터 폴더 열기` 를 쓰거나, Finder 에서 `⌘⇧G` 를 누르고 경로를 붙여 넣으세요.

## 7. 업데이트

새 버전의 .pkg 를 내려받아 위 3번과 같이 설치하면 됩니다. 실행 중인 앱은 설치 프로그램이 알아서 종료하고 바꿉니다. **데이터·설정은 그대로 유지됩니다.**

## 8. 삭제

1. 메뉴 `설정` 에서 `로그인 시 Objitter 실행` 을 켰다면 먼저 끕니다. 그다음 `Objitter 종료`.
2. `/Applications/Objitter.app` 을 휴지통으로 옮깁니다.
3. (선택) 데이터·설정까지 지우기 — **프리셋·쇼가 모두 지워지니 필요하면 먼저 백업하세요.**
   ```bash
   rm -rf ~/Library/Application\ Support/Objitter ~/Library/Logs/Objitter
   defaults delete app.objitter
   sudo pkgutil --forget app.objitter.pkg     # 설치 기록 지우기
   ```

## 9. 문제 해결

| 증상 | 해결 |
| --- | --- |
| 아이콘이 ⚠︎ 이고 서버가 시작되지 않음 / "포트 사용 중" | 다른 프로그램이 8080 을 쓰고 있습니다. 메뉴 `설정` → `웹 UI 포트` 를 바꾸거나(예: 8081), 누가 쓰는지 확인: `lsof -nP -iTCP:8080 -sTCP:LISTEN`. OSC 입력 포트는 `lsof -nP -iUDP:9000` |
| 태블릿·다른 PC 에서 접속 안 됨 | 같은 Wi-Fi/네트워크인지, 메뉴 `설정` → `같은 네트워크의 다른 기기 접속 허용` 이 켜져 있는지, 방화벽에서 `node` 가 허용인지 확인. 주소는 메뉴 `네트워크 주소 복사` 로 |
| 다른 장비의 렌더러로 OSC 가 안 감 (macOS 15+) | 시스템 설정 → 개인정보 보호 및 보안 → 로컬 네트워크 → `Objitter` 켜기 |
| 메뉴 막대에 아이콘이 안 보임 | 메뉴 막대가 꽉 차서 가려졌을 수 있습니다 (노치 있는 MacBook). 다른 메뉴 막대 아이콘을 줄이거나 Launchpad/응용 프로그램에서 Objitter 를 다시 실행 |
| Finder·Launchpad 아이콘이 예전 그대로 | `touch /Applications/Objitter.app && killall Finder Dock` — 그래도 안 바뀌면 재로그인 |
| 그 밖의 오류 | 메뉴 `로그 보기` 또는 `~/Library/Logs/Objitter/server.log` 내용을 담당자에게 보내 주세요 |

## 10. Apple 공증(notarization)을 받으면

위 3번의 경고는 Apple Developer ID 서명과 공증이 없어서 생깁니다. **Apple Developer Program**(연 US$99)에 가입하면 경고 없이 더블클릭으로 설치되는 .pkg 를 만들 수 있습니다. 빌드하는 Mac 에서:

1. Apple Developer 계정에서 **Developer ID Application**, **Developer ID Installer** 인증서를 만들어 키체인에 설치하고, [appleid.apple.com](https://appleid.apple.com) 에서 **앱 암호**를 만듭니다.
2. 공증용 자격 증명을 키체인에 한 번 저장합니다 (`objitter-notary` 는 원하는 이름):
   ```bash
   xcrun notarytool store-credentials objitter-notary \
     --apple-id "<Apple ID 이메일>" --team-id "<팀 ID>" --password "<앱 암호>"
   ```
3. 서명해서 빌드 → 공증 제출 → 공증 결과를 .pkg 에 붙이기(staple):
   ```bash
   SIGN_APP="Developer ID Application: <이름> (<팀 ID>)" \
   SIGN_PKG="Developer ID Installer: <이름> (<팀 ID>)" \
   bash scripts/make-mac-pkg.sh
   xcrun notarytool submit dist/Objitter-0.2.0.pkg --keychain-profile objitter-notary --wait
   xcrun stapler staple dist/Objitter-0.2.0.pkg
   ```
   설치된 인증서 이름은 `security find-identity -v` 로 확인합니다. 공증이 실패하면 `xcrun notarytool log <제출 ID> --keychain-profile objitter-notary` 로 이유를 봅니다.
4. 확인: `spctl -a -vv -t install dist/Objitter-0.2.0.pkg` → `accepted` / `source=Notarized Developer ID`.
