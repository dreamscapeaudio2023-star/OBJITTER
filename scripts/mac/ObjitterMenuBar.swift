// Objitter menu bar app: runs the bundled Node server in the background and controls it from the status menu.
// Built by scripts/make-mac-pkg.sh. Expects Contents/Resources/{node/bin/node, app/} (+ optional MenuBarIcon.png/@2x).
// © 2026 DREAMSCAPE Inc.
import AppKit
import Darwin
import ServiceManagement

let isKorean = (Locale.preferredLanguages.first ?? "").hasPrefix("ko")
func L(_ ko: String, _ en: String) -> String { isKorean ? ko : en }

enum Key {
    static let port = "port"
    static let controlPort = "controlPort"
    static let localOnly = "localOnly"
    static let allowedHosts = "allowedHosts"
    static let autoStart = "autoStart"
    static let openBrowser = "openBrowser"
    static let preventSleep = "preventSleep"
}

let defaults = UserDefaults.standard
let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/Objitter")
let logDir = home.appendingPathComponent("Library/Logs/Objitter")
let logURL = logDir.appendingPathComponent("server.log")
let pidURL = supportDir.appendingPathComponent("server.pid")

func validPort(_ n: Int) -> Bool { (1...65535).contains(n) }

/// true if something accepts connections on 127.0.0.1:port or the port can't be bound.
func portInUse(_ port: Int) -> Bool {
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let withAddr = { (fd: Int32, op: (Int32, UnsafePointer<sockaddr>, socklen_t) -> Int32) -> Int32 in
        withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { op(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
    }
    let c = socket(AF_INET, SOCK_STREAM, 0)
    if c >= 0 {
        let connected = withAddr(c, Darwin.connect) == 0
        close(c)
        if connected { return true }
    }
    let b = socket(AF_INET, SOCK_STREAM, 0)
    guard b >= 0 else { return false }
    defer { close(b) }
    var yes: Int32 = 1
    setsockopt(b, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    addr.sin_addr.s_addr = INADDR_ANY
    return withAddr(b, Darwin.bind) != 0
}

func lanAddresses() -> [String] {
    var result: [String] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
    defer { freeifaddrs(ifaddr) }
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let ifa = ptr.pointee
        guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
              (ifa.ifa_flags & UInt32(IFF_UP)) != 0, (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            let ip = String(cString: host)
            if !ip.hasPrefix("169.254."), !result.contains(ip) { result.append(ip) }
        }
    }
    return result
}

func logTail(_ lines: Int = 12) -> String {
    guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
    return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
}

final class ServerController {
    enum State: Equatable { case stopped, starting, running, stopping, failed }

    var state: State = .stopped { didSet { onChange?() } }
    var onChange: (() -> Void)?
    var onReady: ((_ openBrowser: Bool) -> Void)?
    var onFailed: ((_ message: String) -> Void)?
    var onStopped: (() -> Void)?

    private var process: Process?
    private var expectingExit = false
    private var restartAfterStop = false
    private var restartOpensBrowser = false
    private var openBrowserWhenReady = false
    /// Port the current server process was started with.
    private(set) var runningPort = 0
    private var pollTimer: Timer?
    private var pollCount = 0

    private let res = Bundle.main.resourceURL!
    private var nodeURL: URL { res.appendingPathComponent("node/bin/node") }
    private var appDir: URL { res.appendingPathComponent("app") }

    var port: Int {
        let p = defaults.integer(forKey: Key.port)
        return validPort(p) ? p : 8080
    }
    var isActive: Bool { process != nil }

    private func prepareDirs() {
        for d in ["data", "library"] {
            try? fm.createDirectory(at: supportDir.appendingPathComponent(d), withIntermediateDirectories: true)
        }
        try? fm.createDirectory(at: logDir, withIntermediateDirectories: true)
        let presets = supportDir.appendingPathComponent("presets")
        if !fm.fileExists(atPath: presets.path) {
            try? fm.createDirectory(at: presets, withIntermediateDirectories: true)
            copyJSON(from: appDir.appendingPathComponent("presets"), to: presets)
            copyJSON(from: appDir.appendingPathComponent("demo"), to: supportDir)
        }
    }

    private func copyJSON(from src: URL, to dst: URL) {
        for f in (try? fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "json" {
            try? fm.copyItem(at: f, to: dst.appendingPathComponent(f.lastPathComponent))
        }
    }

    /// Stops a server left behind by a crashed / force-quit previous instance of this app.
    func killStale() {
        guard let s = try? String(contentsOf: pidURL, encoding: .utf8), let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return }
        defer { try? fm.removeItem(at: pidURL) }
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "command="]
        let pipe = Pipe()
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return }
        ps.waitUntilExit()
        let cmd = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard cmd.contains("node/bin/node"), cmd.contains("server/index.js") else { return }
        kill(pid, SIGTERM)
        for _ in 0..<30 where kill(pid, 0) == 0 { usleep(100_000) }
        if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
    }

    func start(openBrowser: Bool) {
        guard process == nil else { return }
        prepareDirs()
        let port = self.port
        if portInUse(port) {
            state = .failed
            onFailed?(L("포트 \(port)을(를) 이미 다른 프로그램(또는 다른 Objitter)이 사용 중입니다.\n설정 → 웹 UI 포트에서 다른 포트를 지정하세요.",
                        "Port \(port) is already in use by another program (or another Objitter).\nChoose a different port in Settings → Web UI Port."))
            return
        }

        if fm.fileExists(atPath: logURL.path) {
            let old = logDir.appendingPathComponent("server.log.1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: logURL, to: old)
        }
        fm.createFile(atPath: logURL.path, contents: nil)
        guard let log = try? FileHandle(forWritingTo: logURL) else { return }

        var env = ProcessInfo.processInfo.environment
        env["DATA_DIR"] = supportDir.appendingPathComponent("data").path
        env["PRESET_DIR"] = supportDir.appendingPathComponent("presets").path
        env["LIBRARY_DIR"] = supportDir.appendingPathComponent("library").path
        env["PORT"] = String(port)
        env["HOST"] = defaults.bool(forKey: Key.localOnly) ? "127.0.0.1" : nil
        let cp = defaults.integer(forKey: Key.controlPort)
        env["CONTROL_PORT"] = validPort(cp) ? String(cp) : nil
        let hosts = (defaults.string(forKey: Key.allowedHosts) ?? "").trimmingCharacters(in: .whitespaces)
        env["ALLOWED_HOSTS"] = hosts.isEmpty ? nil : hosts
        env["OBJITTER_CAFFEINATE"] = defaults.bool(forKey: Key.preventSleep) ? "1" : "0"

        let p = Process()
        p.executableURL = nodeURL
        p.arguments = ["server/index.js"]
        p.currentDirectoryURL = appDir
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.didExit(proc) }
        }
        do {
            try p.run()
        } catch {
            state = .failed
            onFailed?(error.localizedDescription)
            return
        }
        try? log.close()
        process = p
        runningPort = port
        expectingExit = false
        openBrowserWhenReady = openBrowser
        try? String(p.processIdentifier).write(to: pidURL, atomically: true, encoding: .utf8)
        state = .starting
        pollCount = 0
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard state == .starting else { pollTimer?.invalidate(); return }
        pollCount += 1
        if pollCount > 60 {
            pollTimer?.invalidate()
            stop()
            state = .failed
            onFailed?(L("서버가 30초 안에 응답하지 않았습니다.", "The server did not respond within 30 seconds.") + "\n\n" + logTail())
            return
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            guard response is HTTPURLResponse else { return }
            DispatchQueue.main.async {
                guard let self, self.state == .starting else { return }
                self.pollTimer?.invalidate()
                self.state = .running
                self.onReady?(self.openBrowserWhenReady)
            }
        }.resume()
    }

    private func didExit(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        pollTimer?.invalidate()
        try? fm.removeItem(at: pidURL)
        if expectingExit {
            if state != .failed { state = .stopped }
            onStopped?()
            if restartAfterStop {
                restartAfterStop = false
                start(openBrowser: restartOpensBrowser)
            }
        } else {
            state = .failed
            onFailed?(L("서버가 예기치 않게 종료되었습니다 (코드 \(proc.terminationStatus)).", "The server exited unexpectedly (code \(proc.terminationStatus)).") + "\n\n" + logTail())
        }
    }

    func stop() {
        guard let p = process else { return }
        expectingExit = true
        if state != .failed { state = .stopping }
        p.terminate()
        let pid = p.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.process === p, p.isRunning { kill(pid, SIGKILL) }
        }
    }

    func restart(openBrowser: Bool = false) {
        if process != nil {
            restartAfterStop = true
            restartOpensBrowser = openBrowser
            stop()
        } else {
            start(openBrowser: openBrowser)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let server = ServerController()
    var statusItem: NSStatusItem!
    var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        defaults.register(defaults: [
            Key.port: 8080, Key.controlPort: 0, Key.localOnly: false, Key.allowedHosts: "",
            Key.autoStart: true, Key.openBrowser: true, Key.preventSleep: true,
        ])
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        server.onChange = { [weak self] in self?.updateIcon() }
        server.onReady = { [weak self] open in if open { self?.openUI() } }
        server.onFailed = { [weak self] msg in self?.showFailure(msg) }
        server.onStopped = { [weak self] in
            if self?.terminating == true { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        updateIcon()
        server.killStale()
        if defaults.bool(forKey: Key.autoStart) {
            server.start(openBrowser: defaults.bool(forKey: Key.openBrowser))
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if server.state == .running { openUI() } else if !server.isActive { server.start(openBrowser: true) }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.isActive else { return .terminateNow }
        terminating = true
        server.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    // MARK: - status icon

    /// DREAMSCAPE logo as a template image (Contents/Resources/MenuBarIcon.png + @2x). nil → SF Symbols.
    lazy var brandIcon: NSImage? = {
        guard let img = Bundle.main.image(forResource: "MenuBarIcon") else { return nil }
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        img.accessibilityDescription = "Objitter"
        return img
    }()

    func updateIcon() {
        guard let button = statusItem.button else { return }
        if server.state != .failed, let logo = brandIcon {
            button.image = logo
            button.appearsDisabled = server.state != .running
        } else {
            let symbol: String
            switch server.state {
            case .running: symbol = "waveform.circle.fill"
            case .starting, .stopping: symbol = "waveform.circle"
            case .stopped: symbol = "circle.dashed"
            case .failed: symbol = "exclamationmark.triangle"
            }
            let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Objitter")
            img?.isTemplate = true
            button.image = img
            button.appearsDisabled = false
        }
        button.toolTip = "Objitter — " + stateText()
    }

    func stateText() -> String {
        switch server.state {
        case .running: return L("실행 중 · 포트 \(server.port)", "Running · port \(server.port)")
        case .starting: return L("시작 중…", "Starting…")
        case .stopping: return L("정지 중…", "Stopping…")
        case .stopped: return L("정지됨", "Stopped")
        case .failed: return L("오류로 정지됨", "Stopped (error)")
        }
    }

    // MARK: - menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let st = server.state
        let running = st == .running
        let bullet: String
        switch st {
        case .running: bullet = "●"
        case .failed: bullet = "⚠︎"
        case .stopped: bullet = "○"
        default: bullet = "◌"
        }
        let head = NSMenuItem(title: "Objitter  \(bullet) \(stateText())", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())

        menu.addItem(item(L("웹 UI 열기", "Open Web UI"), #selector(openUIAction), "o", enabled: running))
        let net = NSMenuItem(title: L("네트워크 주소 복사", "Copy Network Address"), action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if defaults.bool(forKey: Key.localOnly) {
            let i = NSMenuItem(title: L("이 컴퓨터에서만 접속 허용 중", "Local access only"), action: nil, keyEquivalent: "")
            i.isEnabled = false
            sub.addItem(i)
        } else {
            let ips = lanAddresses()
            if ips.isEmpty {
                let i = NSMenuItem(title: L("네트워크 연결 없음", "No network connection"), action: nil, keyEquivalent: "")
                i.isEnabled = false
                sub.addItem(i)
            }
            for ip in ips {
                let i = item("http://\(ip):\(server.port)", #selector(copyAddress(_:)), "", enabled: running)
                i.representedObject = "http://\(ip):\(server.port)"
                sub.addItem(i)
            }
        }
        net.submenu = sub
        menu.addItem(net)
        menu.addItem(.separator())

        menu.addItem(item(L("서버 시작", "Start Server"), #selector(startAction), "s", enabled: !server.isActive))
        menu.addItem(item(L("서버 정지", "Stop Server"), #selector(stopAction), "t", enabled: server.isActive && st != .stopping))
        menu.addItem(item(L("서버 재시작", "Restart Server"), #selector(restartAction), "r", enabled: st == .running || !server.isActive))
        menu.addItem(.separator())

        let settings = NSMenuItem(title: L("설정", "Settings"), action: nil, keyEquivalent: "")
        settings.submenu = settingsMenu()
        menu.addItem(settings)
        menu.addItem(item(L("로그 보기", "Show Log"), #selector(showLog), "l"))
        menu.addItem(item(L("데이터 폴더 열기", "Open Data Folder"), #selector(openDataFolder), ""))
        menu.addItem(.separator())
        menu.addItem(item(L("Objitter 정보", "About Objitter"), #selector(about), ""))
        menu.addItem(item(L("Objitter 종료", "Quit Objitter"), #selector(quit), "q"))
    }

    func settingsMenu() -> NSMenu {
        let m = NSMenu()
        let header = { (t: String) in
            let i = NSMenuItem(title: t, action: nil, keyEquivalent: "")
            i.isEnabled = false
            m.addItem(i)
        }
        header(L("서버 (변경 시 재시작 필요)", "Server (restart to apply)"))
        m.addItem(item(L("웹 UI 포트: \(server.port)…", "Web UI Port: \(server.port)…"), #selector(changePort), ""))
        let cp = defaults.integer(forKey: Key.controlPort)
        let cpText = validPort(cp) ? String(cp) : L("앱 설정 사용", "use app setting")
        m.addItem(item(L("OSC 컨트롤 포트: \(cpText)…", "OSC Control Port: \(cpText)…"), #selector(changeControlPort), ""))
        m.addItem(check(L("같은 네트워크의 다른 기기 접속 허용", "Allow Access from Other Devices on the Network"),
                        #selector(toggleRemote), !defaults.bool(forKey: Key.localOnly)))
        let hosts = (defaults.string(forKey: Key.allowedHosts) ?? "").trimmingCharacters(in: .whitespaces)
        m.addItem(item(L("허용 호스트 이름: \(hosts.isEmpty ? "없음" : hosts)…", "Allowed Host Names: \(hosts.isEmpty ? "none" : hosts)…"),
                       #selector(changeHosts), ""))
        m.addItem(check(L("실행 중 잠자기 방지", "Prevent Sleep While Running"), #selector(toggleSleep), defaults.bool(forKey: Key.preventSleep)))
        m.addItem(.separator())
        header(L("앱", "App"))
        m.addItem(check(L("앱 실행 시 서버 자동 시작", "Start Server When App Launches"), #selector(toggleAutoStart), defaults.bool(forKey: Key.autoStart)))
        m.addItem(check(L("서버 시작 시 브라우저 열기", "Open Browser When Server Starts"), #selector(toggleOpenBrowser), defaults.bool(forKey: Key.openBrowser)))
        if #available(macOS 13.0, *) {
            m.addItem(check(L("로그인 시 Objitter 실행", "Launch Objitter at Login"), #selector(toggleLoginItem), SMAppService.mainApp.status == .enabled))
        }
        m.addItem(.separator())
        m.addItem(item(L("설정 초기화…", "Reset Settings…"), #selector(resetSettings), ""))
        return m
    }

    func item(_ title: String, _ action: Selector, _ key: String, enabled: Bool = true) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        i.target = self
        i.isEnabled = enabled
        return i
    }

    func check(_ title: String, _ action: Selector, _ on: Bool) -> NSMenuItem {
        let i = item(title, action, "")
        i.state = on ? .on : .off
        return i
    }

    // MARK: - actions

    func openUI() {
        NSWorkspace.shared.open(URL(string: "http://localhost:\(server.port)")!)
    }

    @objc func openUIAction() { openUI() }

    @objc func copyAddress(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    @objc func startAction() { server.start(openBrowser: defaults.bool(forKey: Key.openBrowser)) }
    @objc func stopAction() { server.stop() }
    @objc func restartAction() { server.restart() }

    @objc func showLog() {
        if !fm.fileExists(atPath: logURL.path) {
            try? fm.createDirectory(at: logDir, withIntermediateDirectories: true)
            fm.createFile(atPath: logURL.path, contents: nil)
        }
        NSWorkspace.shared.open(logURL)
    }

    @objc func openDataFolder() {
        try? fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(supportDir)
    }

    @objc func about() {
        NSApp.activate(ignoringOtherApps: true)
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        let credits = NSAttributedString(
            string: L("DREAMSCAPE 제작\n이머시브 오디오 오브젝트 모션 컨트롤러", "Made by DREAMSCAPE\nImmersive audio object motion controller"),
            attributes: [
                .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: style,
            ])
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
    }

    @objc func quit() { NSApp.terminate(nil) }

    @objc func changePort() {
        guard let v = askPort(title: L("웹 UI 포트", "Web UI Port"),
                              message: L("브라우저로 접속할 포트 번호 (1–65535). 기본값 8080.", "Port for the browser UI (1–65535). Default 8080."),
                              current: String(server.port), allowEmpty: false) else { return }
        guard v != server.port else { return }
        defaults.set(v, forKey: Key.port)
        applyServerSetting()
    }

    @objc func changeControlPort() {
        let cp = defaults.integer(forKey: Key.controlPort)
        guard let v = askPort(title: L("OSC 컨트롤 포트", "OSC Control Port"),
                              message: L("QLab·콘솔 등에서 OSC 명령을 받을 UDP 포트.\n비워 두면 웹 UI의 출력 설정에 저장된 값(기본 9000)을 씁니다.",
                                         "UDP port for OSC control from QLab, consoles, etc.\nLeave empty to use the value saved in the web UI output settings (default 9000)."),
                              current: validPort(cp) ? String(cp) : "", allowEmpty: true) else { return }
        guard v != cp else { return }
        defaults.set(v, forKey: Key.controlPort)
        applyServerSetting()
    }

    @objc func changeHosts() {
        let cur = defaults.string(forKey: Key.allowedHosts) ?? ""
        guard let v = ask(title: L("허용 호스트 이름", "Allowed Host Names"),
                          message: L("IP·localhost 외의 이름(예: 사내 DNS 별칭)으로 접속할 때 추가합니다. 쉼표로 구분.",
                                     "Extra host names (e.g. internal DNS aliases) allowed besides IPs and localhost. Comma-separated."),
                          current: cur, placeholder: "show-pc.lan, foh.local") else { return }
        let cleaned = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ",")
        guard cleaned != cur else { return }
        defaults.set(cleaned, forKey: Key.allowedHosts)
        applyServerSetting()
    }

    @objc func toggleRemote() {
        defaults.set(!defaults.bool(forKey: Key.localOnly), forKey: Key.localOnly)
        applyServerSetting()
    }

    @objc func toggleSleep() {
        defaults.set(!defaults.bool(forKey: Key.preventSleep), forKey: Key.preventSleep)
        applyServerSetting()
    }

    @objc func toggleAutoStart() { defaults.set(!defaults.bool(forKey: Key.autoStart), forKey: Key.autoStart) }
    @objc func toggleOpenBrowser() { defaults.set(!defaults.bool(forKey: Key.openBrowser), forKey: Key.openBrowser) }

    @objc func toggleLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            alert(L("로그인 항목을 변경하지 못했습니다.", "Could not change the login item."),
                  error.localizedDescription + "\n\n" + L("시스템 설정 → 일반 → 로그인 항목에서 직접 추가할 수 있습니다.",
                                                         "You can add it manually in System Settings → General → Login Items."))
        }
    }

    @objc func resetSettings() {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = L("설정을 기본값으로 되돌릴까요?", "Reset all settings to defaults?")
        a.informativeText = L("포트 8080, 외부 접속 허용, 자동 시작 등. 프리셋·세션 데이터는 그대로 유지됩니다.",
                              "Port 8080, network access on, auto start, etc. Presets and session data are kept.")
        a.addButton(withTitle: L("초기화", "Reset"))
        a.addButton(withTitle: L("취소", "Cancel"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        for k in [Key.port, Key.controlPort, Key.localOnly, Key.allowedHosts, Key.autoStart, Key.openBrowser, Key.preventSleep] {
            defaults.removeObject(forKey: k)
        }
        applyServerSetting()
    }

    /// Server settings only take effect on (re)start.
    func applyServerSetting() {
        guard server.isActive else { return }
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = L("서버를 재시작해서 적용할까요?", "Restart the server to apply?")
        a.informativeText = L("재시작하는 동안 OSC 출력이 잠시 멈춥니다. 열려 있는 브라우저는 자동으로 다시 연결됩니다 (포트를 바꿨다면 새 주소로 열립니다).",
                              "OSC output pauses briefly during the restart. Open browsers reconnect automatically (a new port opens a new tab).")
        a.addButton(withTitle: L("지금 재시작", "Restart Now"))
        a.addButton(withTitle: L("나중에", "Later"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        server.restart(openBrowser: server.runningPort != server.port)
    }

    // MARK: - dialogs

    func ask(title: String, message: String, current: String, placeholder: String = "") -> String? {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = current
        field.placeholderString = placeholder
        a.accessoryView = field
        a.addButton(withTitle: L("확인", "OK"))
        a.addButton(withTitle: L("취소", "Cancel"))
        a.window.initialFirstResponder = field
        return a.runModal() == .alertFirstButtonReturn ? field.stringValue.trimmingCharacters(in: .whitespaces) : nil
    }

    /// Returns the port, 0 for "empty" (when allowed), nil when cancelled.
    func askPort(title: String, message: String, current: String, allowEmpty: Bool) -> Int? {
        var value = current
        while true {
            guard let s = ask(title: title, message: message, current: value, placeholder: allowEmpty ? "9000" : "8080") else { return nil }
            if s.isEmpty && allowEmpty { return 0 }
            if let n = Int(s), validPort(n) { return n }
            alert(L("올바른 포트 번호가 아닙니다.", "Not a valid port number."), L("1부터 65535 사이의 숫자를 입력하세요.", "Enter a number from 1 to 65535."))
            value = s
        }
    }

    func alert(_ title: String, _ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.alertStyle = .warning
        a.runModal()
    }

    func showFailure(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = L("Objitter 서버를 실행할 수 없습니다.", "The Objitter server is not running.")
        a.informativeText = message
        a.alertStyle = .critical
        a.addButton(withTitle: L("확인", "OK"))
        a.addButton(withTitle: L("포트 변경…", "Change Port…"))
        a.addButton(withTitle: L("로그 보기", "Show Log"))
        switch a.runModal() {
        case .alertSecondButtonReturn:
            changePort()
            if !server.isActive { server.start(openBrowser: defaults.bool(forKey: Key.openBrowser)) }
        case .alertThirdButtonReturn: showLog()
        default: break
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
