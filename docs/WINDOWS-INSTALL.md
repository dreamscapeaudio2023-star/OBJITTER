# Objitter Windows 설치 안내

다른 Windows PC 에 Objitter 를 설치하는 방법입니다. 개발 도구나 Node.js 는 필요 없습니다 — 설치 파일(`Setup.exe`) 하나로 끝납니다. macOS 는 [`MAC-INSTALL.md`](MAC-INSTALL.md) 를 보세요.

> Objitter 는 DREAMSCAPE 사내 전용 소프트웨어입니다 ([LICENSE](../LICENSE)). 무단 복제·배포 금지.

## 1. 준비

- **Windows 10 / 11 (64비트, x64)** — ARM 버전 Windows 도 x64 에뮬레이션으로 동작하지만 확인하지 않았습니다.
- 관리자 권한은 **필요 없습니다** (사용자별 설치). 방화벽 허용 창에서만 관리자 확인이 뜰 수 있습니다.
- 디스크 여유 공간 약 150 MB

## 2. 내려받기

1. 브라우저에서 릴리스 페이지를 엽니다: <https://github.com/dreamscapeaudio2023-star/OBJITTER/releases/latest>
2. **Assets** 에서 `Objitter-0.2.0-Setup.exe` 를 눌러 내려받습니다 (보통 `다운로드` 폴더에 저장됨).
   - Edge 가 "일반적으로 다운로드되지 않는 파일" 이라고 막으면: 다운로드 목록에서 `…` → **`유지`** → `자세히 표시` → **`그래도 계속`**.
3. (선택) 파일이 손상되지 않았는지 확인: 같은 곳의 `Objitter-0.2.0-Setup.exe.sha256` 에 적힌 값과 아래 명령 결과가 같아야 합니다 (PowerShell).
   ```powershell
   (Get-FileHash "$env:USERPROFILE\Downloads\Objitter-0.2.0-Setup.exe").Hash.ToLower()
   ```

## 3. 설치 — "Windows의 PC 보호" 경고 넘기기

이 설치 파일은 코드 서명이 되어 있지 않습니다. 그래서 처음 실행할 때 Microsoft Defender SmartScreen 이 **"Windows의 PC 보호 — 인식할 수 없는 앱의 시작을 차단했습니다"** 창을 띄웁니다. 사내에서 받은 파일이 맞다면:

1. `Objitter-0.2.0-Setup.exe` 를 더블클릭 → 파란 경고 창에서 **`추가 정보`** 를 누릅니다.
2. 아래에 생기는 **`실행`** 버튼을 누릅니다. (게시자: `알 수 없는 게시자`)

PowerShell 로 내려받은 파일의 차단 표시를 미리 지워도 됩니다.

```powershell
Unblock-File "$env:USERPROFILE\Downloads\Objitter-0.2.0-Setup.exe"
```

### 설치 진행

설치 프로그램은 Windows 표시 언어(한국어/영어)를 따릅니다. 라이선스 동의 → (선택) `바탕 화면에 아이콘 만들기`, `Windows 로그인 시 Objitter 실행` → `설치`. 설치 프로그램은 실행 중인 예전 Objitter 를 종료(서버 상태 저장 후)하고, `%LOCALAPPDATA%\Programs\Objitter` 에 설치한 뒤 마지막 화면에서 **Objitter 실행** 을 누르면 바로 시작합니다.

- 시작 메뉴에 `Objitter` 와 `Objitter (콘솔, 문제 해결용)` 이 생깁니다.
- 처음 실행 화면에서 `사용자 선택` 창이 뜨면 **나만을 위해 설치**(권장)를 고르세요. `모든 사용자` 는 관리자 권한으로 `C:\Program Files\Objitter` 에 설치합니다.
- 여러 대에 한꺼번에 설치(조용히 설치): `Objitter-0.2.0-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES` — 끝나면 Objitter 가 자동으로 실행됩니다.

## 4. 처음 실행

- 작업 표시줄 오른쪽 아래 **알림 영역**에 DREAMSCAPE 로고 아이콘이 생깁니다. 창은 없습니다. 아이콘이 안 보이면 `^`(숨겨진 아이콘 표시)를 누르세요 — 아이콘을 작업 표시줄로 끌어다 놓으면 항상 보입니다. 아이콘이 선명하면 서버가 실행 중, 흐리면 정지·시작 중, ⚠ 표시가 붙으면 오류입니다.
- 서버가 시작되면 브라우저가 자동으로 열립니다: <http://localhost:8080>
- **방화벽 알림** — "Windows 보안 경고: Windows Defender 방화벽이 이 앱의 일부 기능을 차단했습니다 (Node.js JavaScript Runtime)" 가 뜨면 **`개인 네트워크`** 에 체크하고 **`액세스 허용`** 을 누르세요. 거부하면 태블릿·다른 PC 브라우저 접속과 OSC 컨트롤 입력(UDP 9000)이 막힙니다. 공연장 네트워크가 `공용` 으로 잡혀 있으면 `공용 네트워크` 도 체크하거나, 설정 → 네트워크 및 인터넷 → 해당 연결 → 네트워크 프로필을 `개인` 으로 바꾸세요. 나중에 바꾸려면: 제어판 → Windows Defender 방화벽 → `Windows Defender 방화벽을 통해 앱 또는 기능 허용` → `Node.js JavaScript Runtime`.
- 렌더러(SPAT Revolution 등)로 보내는 OSC 출력에는 별도 권한이 필요 없습니다.

## 5. 알림 영역 아이콘 사용법

아이콘을 클릭(왼쪽·오른쪽 모두)하면:

| 메뉴 | 하는 일 |
| --- | --- |
| 웹 UI 열기 | 브라우저에서 Objitter 화면 열기 |
| 네트워크 주소 복사 | 태블릿·다른 PC 에서 접속할 주소(`http://<이 PC IP>:8080`) 복사 |
| 서버 시작 / 정지 / 재시작 | 백그라운드 서버 제어 (정지할 때 상태를 저장) |
| 설정 | 웹 UI 포트, OSC 컨트롤 포트, 다른 기기 접속 허용, 허용 호스트 이름, 절전 모드 방지, 앱 실행 시 서버 자동 시작, 서버 시작 시 브라우저 열기, Windows 로그인 시 실행, 설정 초기화 |
| 로그 보기 / 데이터 폴더 열기 | 서버 로그(메모장 등)·데이터 폴더(탐색기) 열기 |
| Objitter 종료 | 서버와 앱 모두 종료 |

서버 쪽 설정(포트 등)은 서버를 재시작하면 적용됩니다. 메뉴는 Windows 표시 언어(한국어/영어)를 따릅니다. 이미 실행 중일 때 시작 메뉴에서 Objitter 를 다시 누르면 웹 UI 가 열립니다.

## 6. 데이터 위치

| 내용 | 위치 |
| --- | --- |
| 프리셋·쇼·라이브러리 등 데이터 | `%APPDATA%\Objitter` (`data\`, `presets\`, `library\`) — 첫 실행 때 데모 프리셋·데모 쇼 복사 |
| 서버 로그 | `%LOCALAPPDATA%\Objitter\Logs\server.log` (직전 실행은 `server.log.1`) |
| 메뉴 설정 | 레지스트리 `HKCU\Software\DREAMSCAPE\Objitter` |
| 로그인 시 실행 | 레지스트리 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 의 `Objitter` (작업 관리자 → 시작 앱에도 보임) |
| 프로그램 | `%LOCALAPPDATA%\Programs\Objitter` (`Objitter.exe`, `node\`, `app\`) |

탐색기 주소 표시줄에 `%APPDATA%\Objitter` 를 붙여 넣거나 메뉴 `데이터 폴더 열기` 를 쓰세요.

## 7. 업데이트

새 버전의 `Setup.exe` 를 내려받아 위 3번과 같이 설치하면 됩니다. 실행 중인 Objitter 는 설치 프로그램이 알아서 종료하고 바꿉니다. **데이터·설정은 그대로 유지됩니다.**

## 8. 삭제

1. 설정 → 앱 → 설치된 앱(또는 앱 및 기능) → **Objitter** → `제거`. (실행 중이면 제거 프로그램이 종료시킵니다. 로그인 시 실행 항목도 함께 지웁니다.)
2. (선택) 데이터·설정까지 지우기 — **프리셋·쇼가 모두 지워지니 필요하면 먼저 백업하세요.** PowerShell:
   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\Objitter", "$env:LOCALAPPDATA\Objitter"
   Remove-Item -Recurse "HKCU:\Software\DREAMSCAPE\Objitter"
   ```

## 9. 문제 해결

| 증상 | 해결 |
| --- | --- |
| 아이콘에 ⚠ 표시, "포트 사용 중" | 다른 프로그램(또는 `start-windows.bat` 로 띄운 Objitter)이 8080 을 쓰고 있습니다. 오류 창의 `포트 변경…` 또는 메뉴 `설정` → `웹 UI 포트` 를 바꾸거나(예: 8081), 누가 쓰는지 확인: PowerShell `Get-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess`. OSC 입력 포트는 `Get-NetUDPEndpoint -LocalPort 9000` |
| 태블릿·다른 PC 에서 접속 안 됨 | 같은 Wi-Fi/네트워크인지, 메뉴 `설정` → `같은 네트워크의 다른 기기 접속 허용` 이 켜져 있는지, 방화벽에서 `Node.js JavaScript Runtime` 이 현재 네트워크 프로필(개인/공용)에 허용인지 확인. 주소는 메뉴 `네트워크 주소 복사` 로 |
| 알림 영역에 아이콘이 안 보임 | `^` 를 눌러 숨겨진 아이콘 확인. 설정 → 개인 설정 → 작업 표시줄 → 기타 시스템 트레이 아이콘(Windows 11) / 작업 표시줄에 표시할 아이콘 선택(Windows 10) 에서 Objitter 켜기 |
| 서버가 바로 꺼짐 / 원인을 모름 | 메뉴 `로그 보기`. 그래도 모르면 Objitter 를 종료한 뒤 시작 메뉴 `Objitter (콘솔, 문제 해결용)` 으로 실행하면 서버 출력이 창에 그대로 보입니다 |
| 공연 중 PC 가 절전 모드로 들어감 | 메뉴 `설정` → `실행 중 절전 모드 방지` 가 켜져 있는지 (기본 켜짐, 서버 재시작 후 적용). 화면 꺼짐은 막지 않으므로 TC 소스 브라우저가 있는 PC 는 화면 끄기 시간도 길게 잡으세요. 확인(관리자 PowerShell): `powercfg /requests` 의 `SYSTEM` 항목에 `Objitter.exe` |
| 그 밖의 오류 | `%LOCALAPPDATA%\Objitter\Logs\server.log` 내용을 담당자에게 보내 주세요 |

## 10. 코드 서명을 하면

위 3번의 SmartScreen 경고는 코드 서명이 없어서 생깁니다. 회사 이름으로 발급받은 **코드 서명 인증서**(OV 또는 EV, 연 수십만 원대 — 또는 Azure Trusted Signing)로 `Objitter.exe` 와 `Setup.exe` 에 서명하면 게시자가 `DREAMSCAPE Inc.` 로 표시됩니다. OV 인증서는 다운로드 수가 쌓여 평판이 생길 때까지 경고가 남을 수 있고, EV·Trusted Signing 은 바로 경고가 줄어듭니다. 서명은 Windows SDK 의 `signtool.exe` 로 하며, 빌드 스크립트에는 아직 넣지 않았습니다 (인증서 종류가 정해지면 추가).

## 설치 파일 만들기 (개발 PC)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-windows-installer.ps1        # → dist\Objitter-<버전>-Setup.exe (+ .sha256)
powershell -ExecutionPolicy Bypass -File scripts\make-windows-installer.ps1 -Zip   # 휴대용 zip 도 함께
```

- 필요한 것: Windows PowerShell 5.1, `npm`, .NET Framework 4.x 의 `csc.exe`(Windows 기본 포함), [Inno Setup 6.3+](https://jrsoftware.org/isinfo.php) (없으면 휴대용 zip 만 만듦).
- Node.js(win-x64, 기본 `v24.21.0` — Mac 설치 파일과 같은 버전)를 처음 한 번 내려받아 `build\cache\` 에 보관합니다 (`-NodeVersion v24.x.y` 로 지정 가능).
- 트레이 앱 소스는 `scripts\windows\ObjitterTray.cs` (Mac 메뉴 막대 앱 `scripts/mac/ObjitterMenuBar.swift` 와 같은 기능), 설치 프로그램 스크립트는 `scripts\windows\Objitter.iss` 입니다. 아이콘(`Objitter.ico`)은 `public\assets` 의 DREAMSCAPE 로고 PNG 로 빌드할 때 만듭니다.
- 휴대용 zip: 아무 폴더에 풀고 `Objitter\Objitter.exe` 를 실행하면 설치판과 똑같이 동작합니다 (데이터 위치도 같음).
