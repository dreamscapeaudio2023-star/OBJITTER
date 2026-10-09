# Mac 업데이트 안내 (5c7ed01 이후 변경)

Mac 에서 마지막으로 빌드한 커밋 `5c7ed01` (macOS 설치 파일·메뉴 막대 앱 추가) 이후 Windows 에서 올린 변경을 Mac 쪽에 반영하는 방법입니다.

## 요약

| 커밋 | 내용 |
| --- | --- |
| `816e060` | DREAMSCAPE 브랜드 로고 v3 적용 — 앱 아이콘(`icon-source.png` 가 `icon-source.jpg` 대체), 파비콘·웹 상단 바·스플래시·About, 메뉴 막대 템플릿 아이콘(`scripts/mac/assets/MenuBarIcon*.png`), Info.plist 저작권, 메뉴 막대 앱 About 문구 |
| `89cee8f` | 라이선스를 사내 전용(`UNLICENSED`)으로 변경 — `LICENSE` 파일 추가, Info.plist `Internal use only.`, About 문구에 사내 전용 표시 |
| (이 문서) | Mac 업데이트 안내 추가 |

- **서버 코드(`server/`)는 바뀌지 않았습니다.** 환경 변수·포트·데이터 위치 모두 그대로입니다.
- `package.json` 버전은 그대로 `0.2.0` 이라 .pkg 파일 이름도 `dist/Objitter-0.2.0.pkg` 로 같습니다 (기존 파일을 덮어씀).

## 맥에서 할 일

1. **코드 받기**
   ```bash
   cd <Objitter 프로젝트 폴더>
   git pull origin main
   git log --oneline -4        # 맨 위에 docs 커밋, 그 아래 89cee8f, 816e060, 5c7ed01 이 보여야 함
   ls scripts/mac/assets       # MenuBarIcon.png, MenuBarIcon@2x.png
   ls public/assets/icon-source.png
   ```
2. **준비물 확인** (5c7ed01 때와 같음)
   ```bash
   swiftc --version            # Xcode 또는 Command Line Tools (없으면: xcode-select --install)
   node -v && npm -v           # 빌드하는 Mac 에만 필요 (스크립트가 앱 안에서 npm ci 실행)
   ```
   설치할 Mac 에는 Node 가 필요 없습니다 (universal Node 를 앱에 넣음, `build/cache/` 에 캐시된 것 재사용).
3. **설치 파일 만들기**
   ```bash
   bash scripts/make-mac-pkg.sh 2>&1 | tee build-mac.log     # → dist/Objitter-0.2.0.pkg
   ```
   - 새로 하는 일: `scripts/mac/assets/MenuBarIcon*.png` 를 `Objitter.app/Contents/Resources/` 로 복사, `.icns` 를 `sips`·`iconutil` 로 `icon-source.png` (1024px PNG)에서 생성.
   - (선택) 터미널 실행형 앱: `bash scripts/make-mac-app.sh` — 이것도 `icon-source.png` 와 새 저작권 문구를 씁니다.
4. **설치**: `dist/Objitter-0.2.0.pkg` 를 열어 설치 (또는 `sudo installer -pkg dist/Objitter-0.2.0.pkg -target /`).
   - 설치 프로그램이 실행 중인 Objitter·서버를 종료하고 기존 `/Applications/Objitter.app` 을 지운 뒤 설치하고, 끝나면 앱을 실행합니다.
   - **설정·데이터는 그대로입니다.** 번들 ID 가 `app.objitter` 로 같아서 메뉴 `설정`(`defaults` 도메인 `app.objitter`)과 로그인 시 실행이 유지되고, `~/Library/Application Support/Objitter` (`data/`, `presets/`, `library/`)와 `~/Library/Logs/Objitter/server.log` 는 건드리지 않습니다.

## 확인 체크리스트

- [ ] `make-mac-pkg.sh` 가 `swiftc` 경고/오류 없이 끝남 (`compiling menu bar app…` 다음에 오류가 없어야 함)
- [ ] 앱 번들에 메뉴 막대 아이콘이 들어감
  ```bash
  ls /Applications/Objitter.app/Contents/Resources/MenuBarIcon*.png
  ```
- [ ] Finder·Launchpad 아이콘이 DREAMSCAPE 로고로 바뀜. 예전 아이콘이 계속 보이면 (아이콘 캐시):
  ```bash
  touch /Applications/Objitter.app && killall Finder Dock
  ```
  그래도 안 바뀌면 재로그인/재부팅. (최후의 수단: `sudo rm -rf /Library/Caches/com.apple.iconservices.store` 후 재부팅)
- [ ] 메뉴 막대 아이콘이 DREAMSCAPE 로고
  - 밝은/어두운 모드 모두에서 메뉴 막대 색에 맞춰 보임 (템플릿 이미지)
  - 서버 실행 중 = 선명, 정지·시작 중 = 흐리게, 오류 = ⚠︎ (SF Symbol)
  - 로고 파일이 없으면 예전 SF Symbol 아이콘(파형 원)으로 자동 대체 — 이게 보이면 위 `MenuBarIcon*.png` 복사가 안 된 것
- [ ] 메뉴 `Objitter 정보`: "DREAMSCAPE 제작 / 이머시브 오디오 오브젝트 모션 컨트롤러 / 사내 전용 · 무단 복제·배포 금지" (영어 시스템이면 "Made by DREAMSCAPE …"), 아래에 저작권 `© 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.`
- [ ] Info.plist 저작권
  ```bash
  defaults read /Applications/Objitter.app/Contents/Info NSHumanReadableCopyright
  # → © 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.
  ```
- [ ] 웹 UI: 상단 바·스플래시·About 의 DREAMSCAPE 로고, 브라우저 탭 파비콘, About 의 라이선스 줄. 예전 로고가 보이면 강력 새로고침 `Cmd+Shift+R` (홈 화면/앱 창으로 추가했다면 지우고 다시 추가)
- [ ] 서버 동작은 예전과 같음 (포트 8080, 외부 기기 접속, 프리셋·쇼 불러오기)

## 환경 변수 / 서버 동작 변경

없습니다. `git diff 5c7ed01..HEAD -- server/` 결과가 비어 있습니다. `PORT`, `HOST`, `CONTROL_PORT`, `ALLOWED_HOSTS`, `DATA_DIR`, `PRESET_DIR`, `LIBRARY_DIR`, `OBJITTER_CAFFEINATE` 와 메뉴 `설정` 항목 모두 그대로입니다.

## 문제가 생기면

- **Swift 컴파일 오류**: `build-mac.log` 의 오류 부분과 `swiftc --version` 출력을 알려 주세요. 바뀐 Swift 코드는 `updateIcon()` (메뉴 막대 아이콘, `Bundle.main.image(forResource: "MenuBarIcon")` + `isTemplate` + `appearsDisabled`)과 `about()` (`orderFrontStandardAboutPanel(options: [.credits: …])`) 두 곳뿐입니다.
- **아이콘 생성 오류** (`sips`/`iconutil`): `file public/assets/icon-source.png` 결과와 로그를 알려 주세요. `icon-source.png` 가 없으면 `icon-512.png` 로 대체합니다.
- **npm ci 오류**: `node -v`, `npm -v` 와 로그.
- **되돌리기**
  - 스크립트·아이콘만 예전으로 빌드: `git checkout 5c7ed01 -- scripts/ public/` 후 `bash scripts/make-mac-pkg.sh` (끝나면 `git checkout HEAD -- scripts/ public/` 로 원상복구)
  - 또는 전에 만들어 둔 `.pkg` 를 다시 설치 (설정·데이터는 그대로 유지)

## 참고

- 개발 환경이 없는 다른 Mac 에는 [GitHub Releases](https://github.com/dreamscapeaudio2023-star/OBJITTER/releases) 의 .pkg 로 설치합니다 — [`MAC-INSTALL.md`](MAC-INSTALL.md) 참고.
- 로고 원본이 258px 라서 `icon-source.png`(1024px)·`icon-512.png` 는 확대된 것입니다. Finder 큰 아이콘 보기에서 약간 흐릴 수 있습니다 — 1024px 이상 PNG 나 SVG 원본을 받으면 Windows 에서 `scripts/make-brand-assets.ps1` 로 다시 만들면 됩니다.
- 회사 원본 디자인 패키지(`artifacts/`)는 `.gitignore` 에 있어 저장소에 없습니다. Mac 에서는 필요 없습니다 (파생 파일 `public/assets/`·`scripts/mac/assets/` 만 사용). `make-brand-assets.ps1` 는 Windows 전용입니다.
