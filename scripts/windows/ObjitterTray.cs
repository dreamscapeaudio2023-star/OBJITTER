// Objitter tray app (Windows): runs the bundled Node server in the background and controls it from the notification area.
// Windows counterpart of scripts/mac/ObjitterMenuBar.swift. Built by scripts/make-windows-installer.ps1 with the in-box
// .NET Framework 4 compiler (csc.exe, C# 5). Expects node\node.exe and app\ next to Objitter.exe (+ embedded Objitter.ico).
// © 2026 DREAMSCAPE Inc. All rights reserved. Proprietary — see LICENSE.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class I18n
{
    public static readonly bool Ko = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ko";
    public static string L(string ko, string en) { return Ko ? ko : en; }
}

static class Paths
{
    public static readonly string Base = AppDomain.CurrentDomain.BaseDirectory;
    public static readonly string Node = Path.Combine(Base, @"node\node.exe");
    public static readonly string App = Path.Combine(Base, "app");
    public static readonly string Support = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Objitter");
    public static readonly string LogDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Objitter\Logs");
    public static readonly string Log = Path.Combine(LogDir, "server.log");
    public static readonly string Pid = Path.Combine(Support, "server.pid");
}

/// Menu settings, stored in HKCU\Software\DREAMSCAPE\Objitter (the Mac app uses the app.objitter defaults domain).
static class Settings
{
    const string KeyPath = @"Software\DREAMSCAPE\Objitter";
    static readonly string[] ServerKeys = { "Port", "ControlPort", "LocalOnly", "AllowedHosts", "AutoStart", "OpenBrowser", "PreventSleep" };

    public static bool ValidPort(int n) { return n >= 1 && n <= 65535; }

    static object Get(string name)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(KeyPath))
            return k == null ? null : k.GetValue(name);
    }
    static int GetInt(string name, int def)
    {
        object v = Get(name);
        if (v is int) return (int)v;
        int n;
        return v != null && int.TryParse(v.ToString(), out n) ? n : def;
    }
    static void Set(string name, object value, RegistryValueKind kind)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(KeyPath)) k.SetValue(name, value, kind);
    }
    static bool GetBool(string name, bool def) { return GetInt(name, def ? 1 : 0) != 0; }
    static void SetBool(string name, bool v) { Set(name, v ? 1 : 0, RegistryValueKind.DWord); }

    public static int Port
    {
        get { int p = GetInt("Port", 8080); return ValidPort(p) ? p : 8080; }
        set { Set("Port", value, RegistryValueKind.DWord); }
    }
    /// 0 = not set (the server uses the port saved in the web UI, default 9000).
    public static int ControlPort
    {
        get { int p = GetInt("ControlPort", 0); return ValidPort(p) ? p : 0; }
        set { Set("ControlPort", value, RegistryValueKind.DWord); }
    }
    public static bool LocalOnly { get { return GetBool("LocalOnly", false); } set { SetBool("LocalOnly", value); } }
    public static string AllowedHosts
    {
        get { object v = Get("AllowedHosts"); return v == null ? "" : v.ToString().Trim(); }
        set { Set("AllowedHosts", value, RegistryValueKind.String); }
    }
    public static bool AutoStart { get { return GetBool("AutoStart", true); } set { SetBool("AutoStart", value); } }
    public static bool OpenBrowser { get { return GetBool("OpenBrowser", true); } set { SetBool("OpenBrowser", value); } }
    public static bool PreventSleep { get { return GetBool("PreventSleep", true); } set { SetBool("PreventSleep", value); } }
    public static bool Welcomed { get { return GetBool("Welcomed", false); } set { SetBool("Welcomed", value); } }

    public static void Reset()
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(KeyPath, true))
        {
            if (k == null) return;
            foreach (string n in ServerKeys) k.DeleteValue(n, false);
        }
    }
}

/// "Launch at login" = HKCU\...\Run\Objitter (no admin rights needed).
static class LoginItem
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static string Command { get { return "\"" + Application.ExecutablePath + "\""; } }

    public static bool Enabled
    {
        get
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                string v = k == null ? null : k.GetValue("Objitter") as string;
                return v != null && string.Equals(v.Trim(), Command, StringComparison.OrdinalIgnoreCase);
            }
        }
        set
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (value) k.SetValue("Objitter", Command, RegistryValueKind.String);
                else k.DeleteValue("Objitter", false);
            }
        }
    }
}

static class Net
{
    /// true if something accepts connections on 127.0.0.1:port or the port can't be bound.
    public static bool PortInUse(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                if (ar.AsyncWaitHandle.WaitOne(300) && c.Connected) return true;
            }
        }
        catch { }
        try
        {
            TcpListener l = new TcpListener(IPAddress.Any, port);
            l.Start();
            l.Stop();
            return false;
        }
        catch { return true; }
    }

    public static List<string> LanAddresses()
    {
        List<string> result = new List<string>();
        try
        {
            foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback || ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
                foreach (UnicastIPAddressInformation ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string ip = ua.Address.ToString();
                    if (!ip.StartsWith("169.254.") && !result.Contains(ip)) result.Add(ip);
                }
            }
        }
        catch { }
        return result;
    }
}

/// Graceful stop: Ctrl+Break on the server's (hidden) console → SIGBREAK → the server saves its state and exits.
static class ConsoleCtrl
{
    delegate bool HandlerRoutine(uint ctrlType);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);
    const uint CTRL_BREAK_EVENT = 1;
    // Keeps this app alive while it is briefly attached to the server's console (the event goes to every attached process).
    static readonly HandlerRoutine Ignore = delegate(uint t) { return true; };
    static readonly object Gate = new object();

    public static bool SendBreak(int pid)
    {
        lock (Gate)
        {
            FreeConsole();
            if (!AttachConsole((uint)pid)) return false;
            SetConsoleCtrlHandler(Ignore, true);
            bool ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
            Thread.Sleep(100);
            FreeConsole();
            return ok;
        }
    }
}

/// Keeps the PC from idle-sleeping while the server runs (Windows equivalent of `caffeinate -i`). Display may still turn off.
static class Power
{
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
    const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001;
    public static void Set(bool preventSleep) { SetThreadExecutionState(preventSleep ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED : ES_CONTINUOUS); }
}

static class Util
{
    public static void After(int ms, Action a)
    {
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = ms;
        t.Tick += delegate { t.Stop(); t.Dispose(); a(); };
        t.Start();
    }

    public static string LogTail(int lines)
    {
        try
        {
            using (FileStream fs = new FileStream(Paths.Log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader r = new StreamReader(fs, Encoding.UTF8))
            {
                string[] all = r.ReadToEnd().Replace("\r\n", "\n").Split('\n');
                int start = Math.Max(0, all.Length - lines);
                return string.Join("\n", all, start, all.Length - start).Trim();
            }
        }
        catch { return ""; }
    }

    public static string AppVersion()
    {
        try
        {
            Match m = Regex.Match(File.ReadAllText(Path.Combine(Paths.App, "package.json")), "\"version\"\\s*:\\s*\"([^\"]+)\"");
            if (m.Success) return m.Groups[1].Value;
        }
        catch { }
        return "";
    }

    public static void Open(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { Dialogs.Alert(I18n.L("열 수 없습니다.", "Could not open it."), target + "\n\n" + ex.Message); }
    }
}

enum ServerState { Stopped, Starting, Running, Stopping, Failed }

sealed class ServerController
{
    ServerState state = ServerState.Stopped;
    public ServerState State { get { return state; } private set { state = value; if (OnChange != null) OnChange(); } }
    public Action OnChange;
    public Action<bool> OnReady;
    public Action<string> OnFailed;
    public Action OnStopped;

    readonly SynchronizationContext ui;
    readonly System.Windows.Forms.Timer pollTimer = new System.Windows.Forms.Timer();
    readonly object logLock = new object();
    Process process;
    StreamWriter log;
    bool expectingExit, restartAfterStop, restartOpensBrowser, openBrowserWhenReady, pollBusy;
    int pollCount;
    /// Port the current server process was started with.
    public int RunningPort { get; private set; }

    public ServerController()
    {
        ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        pollTimer.Interval = 500;
        pollTimer.Tick += delegate { Poll(); };
    }

    public int Port { get { return Settings.Port; } }
    public bool IsActive { get { return process != null; } }

    void Fail(string message)
    {
        State = ServerState.Failed;
        if (OnFailed != null) OnFailed(message);
    }

    void PrepareDirs()
    {
        Directory.CreateDirectory(Path.Combine(Paths.Support, "data"));
        Directory.CreateDirectory(Path.Combine(Paths.Support, "library"));
        Directory.CreateDirectory(Paths.LogDir);
        string presets = Path.Combine(Paths.Support, "presets");
        if (!Directory.Exists(presets))
        {
            Directory.CreateDirectory(presets);
            CopyJson(Path.Combine(Paths.App, "presets"), presets);
            CopyJson(Path.Combine(Paths.App, "demo"), Paths.Support);
        }
    }

    static void CopyJson(string src, string dst)
    {
        if (!Directory.Exists(src)) return;
        foreach (string f in Directory.GetFiles(src, "*.json"))
        {
            try { File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), false); } catch { }
        }
    }

    static string CommandLineOf(int pid)
    {
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                foreach (ManagementObject o in s.Get())
                {
                    object v = o["CommandLine"];
                    return v == null ? null : v.ToString();
                }
        }
        catch { }
        return null;
    }

    /// Stops a server left behind by a crashed / killed previous instance of this app (only our bundled node + server/index.js).
    public void KillStale()
    {
        int pid;
        try
        {
            if (!File.Exists(Paths.Pid) || !int.TryParse(File.ReadAllText(Paths.Pid).Trim(), out pid) || pid <= 0) return;
            File.Delete(Paths.Pid);
        }
        catch { return; }
        try
        {
            Process p = Process.GetProcessById(pid);
            string exe = p.MainModule.FileName;
            if (!string.Equals(Path.GetFullPath(exe), Path.GetFullPath(Paths.Node), StringComparison.OrdinalIgnoreCase)) return;
            string cmd = CommandLineOf(pid);
            if (cmd == null || cmd.IndexOf("server/index.js", StringComparison.OrdinalIgnoreCase) < 0) return;
            if (!ConsoleCtrl.SendBreak(pid) || !p.WaitForExit(3000)) p.Kill();
        }
        catch { }
    }

    public void Start(bool openBrowser)
    {
        if (process != null) return;
        if (!File.Exists(Paths.Node) || !File.Exists(Path.Combine(Paths.App, @"server\index.js")))
        {
            Fail(I18n.L("Objitter 파일이 없습니다. 다시 설치하세요.\n", "Objitter files are missing. Please reinstall.\n") + Paths.Base);
            return;
        }
        try { PrepareDirs(); }
        catch (Exception ex) { Fail(ex.Message); return; }
        int port = Port;
        if (Net.PortInUse(port))
        {
            Fail(I18n.L("포트 " + port + "을(를) 이미 다른 프로그램(또는 다른 Objitter)이 사용 중입니다.\n설정 → 웹 UI 포트에서 다른 포트를 지정하세요.",
                        "Port " + port + " is already in use by another program (or another Objitter).\nChoose a different port in Settings → Web UI Port."));
            return;
        }

        try
        {
            if (File.Exists(Paths.Log))
            {
                string old = Paths.Log + ".1";
                if (File.Exists(old)) File.Delete(old);
                File.Move(Paths.Log, old);
            }
            FileStream fs = new FileStream(Paths.Log, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            log = new StreamWriter(fs, new UTF8Encoding(false));
            log.AutoFlush = true;
        }
        catch (Exception ex) { Fail(ex.Message); return; }

        ProcessStartInfo psi = new ProcessStartInfo(Paths.Node, "server/index.js");
        psi.WorkingDirectory = Paths.App;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        var env = psi.EnvironmentVariables;
        env["DATA_DIR"] = Path.Combine(Paths.Support, "data");
        env["PRESET_DIR"] = Path.Combine(Paths.Support, "presets");
        env["LIBRARY_DIR"] = Path.Combine(Paths.Support, "library");
        env["PORT"] = port.ToString();
        if (Settings.LocalOnly) env["HOST"] = "127.0.0.1"; else env.Remove("HOST");
        int cp = Settings.ControlPort;
        if (cp > 0) env["CONTROL_PORT"] = cp.ToString(); else env.Remove("CONTROL_PORT");
        string hosts = Settings.AllowedHosts;
        if (hosts.Length > 0) env["ALLOWED_HOSTS"] = hosts; else env.Remove("ALLOWED_HOSTS");
        bool preventSleep = Settings.PreventSleep;
        env["OBJITTER_CAFFEINATE"] = preventSleep ? "1" : "0";

        Process p = new Process();
        p.StartInfo = psi;
        p.EnableRaisingEvents = true;
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { WriteLog(e.Data); };
        p.Exited += delegate { ui.Post(delegate { DidExit(p); }, null); };
        try
        {
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            CloseLog();
            Fail(ex.Message);
            return;
        }
        process = p;
        RunningPort = port;
        expectingExit = false;
        openBrowserWhenReady = openBrowser;
        try { File.WriteAllText(Paths.Pid, p.Id.ToString()); } catch { }
        Power.Set(preventSleep);
        if (preventSleep) WriteLog("  > Windows: idle sleep prevented while running (tray setting \"Prevent Sleep\")");
        State = ServerState.Starting;
        pollCount = 0;
        pollTimer.Start();
    }

    void WriteLog(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try { if (log != null) log.WriteLine(line); } catch { }
        }
    }

    void CloseLog()
    {
        lock (logLock)
        {
            try { if (log != null) log.Dispose(); } catch { }
            log = null;
        }
    }

    void Poll()
    {
        if (State != ServerState.Starting) { pollTimer.Stop(); return; }
        if (pollBusy) return;
        pollCount++;
        if (pollCount > 60)
        {
            pollTimer.Stop();
            Stop();
            Fail(I18n.L("서버가 30초 안에 응답하지 않았습니다.", "The server did not respond within 30 seconds.") + "\n\n" + Util.LogTail(12));
            return;
        }
        pollBusy = true;
        Process target = process;
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + RunningPort + "/");
            req.Timeout = 1000;
            req.Proxy = null;
            req.BeginGetResponse(delegate(IAsyncResult ar)
            {
                bool answered = false;
                try { using (req.EndGetResponse(ar)) answered = true; }
                catch (WebException we) { answered = we.Response != null; if (we.Response != null) we.Response.Close(); }
                catch { }
                ui.Post(delegate
                {
                    pollBusy = false;
                    if (!answered || State != ServerState.Starting || target != process) return;
                    pollTimer.Stop();
                    State = ServerState.Running;
                    if (OnReady != null) OnReady(openBrowserWhenReady);
                }, null);
            }, null);
        }
        catch { pollBusy = false; }
    }

    void DidExit(Process p)
    {
        if (p != process) return;
        process = null;
        pollTimer.Stop();
        try { p.WaitForExit(); } catch { }
        CloseLog();
        try { File.Delete(Paths.Pid); } catch { }
        Power.Set(false);
        int code = 0;
        try { code = p.ExitCode; } catch { }
        if (expectingExit)
        {
            if (State != ServerState.Failed) State = ServerState.Stopped;
            if (OnStopped != null) OnStopped();
            if (restartAfterStop)
            {
                restartAfterStop = false;
                Start(restartOpensBrowser);
            }
        }
        else
        {
            Fail(I18n.L("서버가 예기치 않게 종료되었습니다 (코드 " + code + ").", "The server exited unexpectedly (code " + code + ").") + "\n\n" + Util.LogTail(12));
        }
    }

    public void Stop()
    {
        Process p = process;
        if (p == null) return;
        expectingExit = true;
        if (State != ServerState.Failed) State = ServerState.Stopping;
        if (!ConsoleCtrl.SendBreak(p.Id))
        {
            try { p.Kill(); } catch { }
            return;
        }
        Util.After(5000, delegate
        {
            try { if (process == p && !p.HasExited) p.Kill(); } catch { }
        });
    }

    /// Synchronous stop for Windows logoff / shutdown.
    public void StopNow(int timeoutMs)
    {
        Process p = process;
        if (p == null) return;
        expectingExit = true;
        try
        {
            if (!ConsoleCtrl.SendBreak(p.Id) || !p.WaitForExit(timeoutMs)) p.Kill();
        }
        catch { }
        try { File.Delete(Paths.Pid); } catch { }
        Power.Set(false);
    }

    public void Restart(bool openBrowser)
    {
        if (process != null)
        {
            restartAfterStop = true;
            restartOpensBrowser = openBrowser;
            Stop();
        }
        else Start(openBrowser);
    }
}

/// Small NSAlert-like dialog: bold title, message, optional text field, custom buttons.
static class Dialogs
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
    const int EM_SETCUEBANNER = 0x1501;
    public static Icon AppIcon;

    /// Returns the clicked button index (-1 = closed). When input != null a text field is shown and its value returned in input.
    public static int Show(string title, string message, string[] buttons, ref string input, string placeholder, Icon icon)
    {
        using (Form f = new Form())
        {
            f.Text = "Objitter";
            f.Icon = AppIcon;
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.MaximizeBox = false;
            f.MinimizeBox = false;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.TopMost = true;
            f.ShowInTaskbar = true;
            f.Font = SystemFonts.MessageBoxFont;
            f.AutoSize = true;
            f.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            f.Padding = new Padding(12);

            TableLayoutPanel grid = new TableLayoutPanel();
            grid.AutoSize = true;
            grid.ColumnCount = 2;
            grid.RowCount = 4;
            grid.Dock = DockStyle.Fill;
            if (icon != null)
            {
                PictureBox pic = new PictureBox();
                pic.Image = new Icon(icon, 48, 48).ToBitmap();
                pic.SizeMode = PictureBoxSizeMode.Zoom;
                pic.Size = new Size(48, 48);
                pic.Margin = new Padding(0, 0, 12, 0);
                grid.Controls.Add(pic, 0, 0);
                grid.SetRowSpan(pic, 3);
            }
            Label head = new Label();
            head.Text = title;
            head.AutoSize = true;
            head.MaximumSize = new Size(440, 0);
            head.Font = new Font(f.Font, FontStyle.Bold);
            head.Margin = new Padding(0, 0, 0, 8);
            grid.Controls.Add(head, 1, 0);
            if (!string.IsNullOrEmpty(message))
            {
                Label body = new Label();
                body.Text = message;
                body.AutoSize = true;
                body.MaximumSize = new Size(440, 0);
                body.Margin = new Padding(0, 0, 0, 8);
                grid.Controls.Add(body, 1, 1);
            }
            TextBox box = null;
            if (input != null)
            {
                box = new TextBox();
                box.Text = input;
                box.Width = 300;
                box.Margin = new Padding(0, 0, 0, 8);
                grid.Controls.Add(box, 1, 2);
                if (!string.IsNullOrEmpty(placeholder))
                    box.HandleCreated += delegate { SendMessage(box.Handle, EM_SETCUEBANNER, (IntPtr)1, placeholder); };
            }
            FlowLayoutPanel row = new FlowLayoutPanel();
            row.FlowDirection = FlowDirection.RightToLeft;
            row.AutoSize = true;
            row.Dock = DockStyle.Fill;
            row.Margin = new Padding(0, 8, 0, 0);
            int result = -1;
            for (int i = buttons.Length - 1; i >= 0; i--)
            {
                Button b = new Button();
                b.Text = buttons[i];
                b.AutoSize = true;
                b.MinimumSize = new Size(88, 0);
                int idx = i;
                b.Click += delegate { result = idx; f.Close(); };
                row.Controls.Add(b);
                if (i == 0) f.AcceptButton = b;
                if (i == buttons.Length - 1 && buttons.Length > 1) f.CancelButton = b;
            }
            grid.Controls.Add(row, 0, 3);
            grid.SetColumnSpan(row, 2);
            f.Controls.Add(grid);
            f.Shown += delegate
            {
                f.Activate();
                if (box != null) { box.Focus(); box.SelectAll(); }
                else if (f.AcceptButton != null) ((Button)f.AcceptButton).Focus();
            };
            f.ShowDialog();
            if (box != null) input = box.Text.Trim();
            return result;
        }
    }

    public static void Alert(string title, string message)
    {
        string none = null;
        Show(title, message, new[] { I18n.L("확인", "OK") }, ref none, null, SystemIcons.Warning);
    }

    public static string Ask(string title, string message, string current, string placeholder)
    {
        string v = current;
        return Show(title, message, new[] { I18n.L("확인", "OK"), I18n.L("취소", "Cancel") }, ref v, placeholder, AppIcon) == 0 ? v : null;
    }

    /// Returns the port, 0 for "empty" (when allowed), -1 when cancelled.
    public static int AskPort(string title, string message, string current, bool allowEmpty)
    {
        string value = current;
        while (true)
        {
            string s = Ask(title, message, value, allowEmpty ? "9000" : "8080");
            if (s == null) return -1;
            if (s.Length == 0 && allowEmpty) return 0;
            int n;
            if (int.TryParse(s, out n) && Settings.ValidPort(n)) return n;
            Alert(I18n.L("올바른 포트 번호가 아닙니다.", "Not a valid port number."), I18n.L("1부터 65535 사이의 숫자를 입력하세요.", "Enter a number from 1 to 65535."));
            value = s;
        }
    }
}

sealed class TrayApp : ApplicationContext
{
    readonly ServerController server = new ServerController();
    readonly NotifyIcon tray = new NotifyIcon();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly Icon iconRunning, iconIdle, iconFailed;
    bool terminating, exited;

    static string L(string ko, string en) { return I18n.L(ko, en); }

    public TrayApp(EventWaitHandle activate, EventWaitHandle quit)
    {
        iconRunning = LoadAppIcon(SystemInformation.SmallIconSize.Width);
        Dialogs.AppIcon = LoadAppIcon(32);
        iconIdle = Dimmed(iconRunning);
        iconFailed = WithWarning(iconRunning);

        menu.Opening += delegate { BuildMenu(); };
        menu.Items.Add("…");
        tray.ContextMenuStrip = menu;
        tray.MouseUp += delegate(object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            MethodInfo show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
            if (show != null) show.Invoke(tray, null);
        };
        server.OnChange = UpdateIcon;
        server.OnReady = delegate(bool open) { if (open) OpenUI(); };
        server.OnFailed = ShowFailure;
        server.OnStopped = delegate { if (terminating) ExitNow(); };
        UpdateIcon();
        tray.Visible = true;

        SystemEvents.SessionEnding += delegate { server.StopNow(3000); };
        WatchSignals(activate, quit);

        server.KillStale();
        if (!Settings.Welcomed)
        {
            Settings.Welcomed = true;
            tray.ShowBalloonTip(8000, "Objitter",
                L("알림 영역(작업 표시줄 오른쪽 아래)에서 Objitter 를 제어합니다. 아이콘이 안 보이면 ^ 를 누르세요.",
                  "Control Objitter from the notification area (bottom-right of the taskbar). If the icon is hidden, click ^."),
                ToolTipIcon.Info);
        }
        if (Settings.AutoStart) server.Start(Settings.OpenBrowser);
    }

    /// Second launch (e.g. Start menu) → open the UI / start; `Objitter.exe --quit` (installer) → quit.
    void WatchSignals(EventWaitHandle activate, EventWaitHandle quit)
    {
        SynchronizationContext ui = SynchronizationContext.Current;
        Thread t = new Thread(delegate()
        {
            WaitHandle[] handles = { activate, quit };
            while (true)
            {
                int i = WaitHandle.WaitAny(handles);
                if (i == 0) ui.Post(delegate { Reopen(); }, null);
                else { ui.Post(delegate { Quit(); }, null); return; }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    void Reopen()
    {
        if (server.State == ServerState.Running) OpenUI();
        else if (!server.IsActive) server.Start(true);
    }

    // ---- icons ----

    static Icon LoadAppIcon(int size)
    {
        try
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Objitter.ico"))
                if (s != null) return new Icon(s, size, size);
        }
        catch { }
        return Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
    }

    static Icon Dimmed(Icon src)
    {
        using (Bitmap b = src.ToBitmap())
        {
            Bitmap dst = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(dst))
            using (ImageAttributes attr = new ImageAttributes())
            {
                float k = 1f / 3f;
                attr.SetColorMatrix(new ColorMatrix(new float[][] {
                    new float[] { k, k, k, 0, 0 }, new float[] { k, k, k, 0, 0 }, new float[] { k, k, k, 0, 0 },
                    new float[] { 0, 0, 0, 0.55f, 0 }, new float[] { 0, 0, 0, 0, 1 } }));
                g.DrawImage(b, new Rectangle(0, 0, b.Width, b.Height), 0, 0, b.Width, b.Height, GraphicsUnit.Pixel, attr);
            }
            return Icon.FromHandle(dst.GetHicon());
        }
    }

    static Icon WithWarning(Icon src)
    {
        using (Bitmap b = src.ToBitmap())
        {
            Bitmap dst = new Bitmap(b);
            using (Graphics g = Graphics.FromImage(dst))
            {
                int s = Math.Max(8, b.Width * 5 / 8);
                g.DrawIcon(new Icon(SystemIcons.Warning, s, s), new Rectangle(b.Width - s, b.Height - s, s, s));
            }
            return Icon.FromHandle(dst.GetHicon());
        }
    }

    void UpdateIcon()
    {
        ServerState st = server.State;
        tray.Icon = st == ServerState.Running ? iconRunning : st == ServerState.Failed ? iconFailed : iconIdle;
        string tip = "Objitter — " + StateText();
        tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    }

    string StateText()
    {
        switch (server.State)
        {
            case ServerState.Running: return L("실행 중 · 포트 " + server.RunningPort, "Running · port " + server.RunningPort);
            case ServerState.Starting: return L("시작 중…", "Starting…");
            case ServerState.Stopping: return L("정지 중…", "Stopping…");
            case ServerState.Stopped: return L("정지됨", "Stopped");
            default: return L("오류로 정지됨", "Stopped (error)");
        }
    }

    // ---- menu ----

    int UiPort { get { return server.IsActive ? server.RunningPort : server.Port; } }

    ToolStripMenuItem Item(string title, Action action, bool enabled)
    {
        ToolStripMenuItem i = new ToolStripMenuItem(title);
        i.Enabled = enabled;
        if (action != null) i.Click += delegate { action(); };
        return i;
    }
    ToolStripMenuItem Item(string title, Action action) { return Item(title, action, true); }
    ToolStripMenuItem Check(string title, Action action, bool on)
    {
        ToolStripMenuItem i = Item(title, action);
        i.Checked = on;
        return i;
    }
    static ToolStripMenuItem Header(string title)
    {
        ToolStripMenuItem i = new ToolStripMenuItem(title);
        i.Enabled = false;
        return i;
    }

    void BuildMenu()
    {
        menu.Items.Clear();
        ServerState st = server.State;
        bool running = st == ServerState.Running;
        string bullet = running ? "●" : st == ServerState.Failed ? "⚠" : st == ServerState.Stopped ? "○" : "◌";
        menu.Items.Add(Header("Objitter  " + bullet + " " + StateText()));
        menu.Items.Add(new ToolStripSeparator());

        ToolStripMenuItem open = Item(L("웹 UI 열기", "Open Web UI"), OpenUI, running);
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add(open);
        ToolStripMenuItem net = new ToolStripMenuItem(L("네트워크 주소 복사", "Copy Network Address"));
        if (Settings.LocalOnly)
            net.DropDownItems.Add(Header(L("이 컴퓨터에서만 접속 허용 중", "Local access only")));
        else
        {
            List<string> ips = Net.LanAddresses();
            if (ips.Count == 0) net.DropDownItems.Add(Header(L("네트워크 연결 없음", "No network connection")));
            foreach (string ip in ips)
            {
                string url = "http://" + ip + ":" + UiPort;
                net.DropDownItems.Add(Item(url, delegate { CopyAddress(url); }, running));
            }
        }
        menu.Items.Add(net);
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add(Item(L("서버 시작", "Start Server"), delegate { server.Start(Settings.OpenBrowser); }, !server.IsActive));
        menu.Items.Add(Item(L("서버 정지", "Stop Server"), server.Stop, server.IsActive && st != ServerState.Stopping));
        menu.Items.Add(Item(L("서버 재시작", "Restart Server"), delegate { server.Restart(false); }, running || !server.IsActive));
        menu.Items.Add(new ToolStripSeparator());

        ToolStripMenuItem settings = new ToolStripMenuItem(L("설정", "Settings"));
        BuildSettings(settings.DropDownItems);
        menu.Items.Add(settings);
        menu.Items.Add(Item(L("로그 보기", "Show Log"), ShowLog));
        menu.Items.Add(Item(L("데이터 폴더 열기", "Open Data Folder"), OpenDataFolder));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item(L("Objitter 정보", "About Objitter"), About));
        menu.Items.Add(Item(L("Objitter 종료", "Quit Objitter"), Quit));
    }

    void BuildSettings(ToolStripItemCollection m)
    {
        m.Add(Header(L("서버 (변경 시 재시작 필요)", "Server (restart to apply)")));
        m.Add(Item(L("웹 UI 포트: " + server.Port + "…", "Web UI Port: " + server.Port + "…"), ChangePort));
        int cp = Settings.ControlPort;
        string cpText = cp > 0 ? cp.ToString() : L("앱 설정 사용", "use app setting");
        m.Add(Item(L("OSC 컨트롤 포트: " + cpText + "…", "OSC Control Port: " + cpText + "…"), ChangeControlPort));
        m.Add(Check(L("같은 네트워크의 다른 기기 접속 허용", "Allow Access from Other Devices on the Network"), ToggleRemote, !Settings.LocalOnly));
        string hosts = Settings.AllowedHosts;
        m.Add(Item(L("허용 호스트 이름: " + (hosts.Length == 0 ? "없음" : hosts) + "…", "Allowed Host Names: " + (hosts.Length == 0 ? "none" : hosts) + "…"), ChangeHosts));
        m.Add(Check(L("실행 중 절전 모드 방지", "Prevent Sleep While Running"), ToggleSleep, Settings.PreventSleep));
        m.Add(new ToolStripSeparator());
        m.Add(Header(L("앱", "App")));
        m.Add(Check(L("앱 실행 시 서버 자동 시작", "Start Server When App Launches"), delegate { Settings.AutoStart = !Settings.AutoStart; }, Settings.AutoStart));
        m.Add(Check(L("서버 시작 시 브라우저 열기", "Open Browser When Server Starts"), delegate { Settings.OpenBrowser = !Settings.OpenBrowser; }, Settings.OpenBrowser));
        m.Add(Check(L("Windows 로그인 시 Objitter 실행", "Launch Objitter at Windows Sign-in"), ToggleLoginItem, LoginItem.Enabled));
        m.Add(new ToolStripSeparator());
        m.Add(Item(L("설정 초기화…", "Reset Settings…"), ResetSettings));
    }

    // ---- actions ----

    void OpenUI() { Util.Open("http://localhost:" + UiPort); }

    void CopyAddress(string url)
    {
        try
        {
            Clipboard.SetText(url);
            tray.ShowBalloonTip(3000, "Objitter", L("복사됨: ", "Copied: ") + url, ToolTipIcon.None);
        }
        catch (Exception ex) { Dialogs.Alert(L("복사하지 못했습니다.", "Could not copy."), ex.Message); }
    }

    void ShowLog()
    {
        try
        {
            if (!File.Exists(Paths.Log))
            {
                Directory.CreateDirectory(Paths.LogDir);
                using (File.Create(Paths.Log)) { }
            }
        }
        catch { }
        Util.Open(Paths.Log);
    }

    void OpenDataFolder()
    {
        try { Directory.CreateDirectory(Paths.Support); } catch { }
        Util.Open(Paths.Support);
    }

    void About()
    {
        string v = Util.AppVersion();
        string none = null;
        Dialogs.Show("Objitter" + (v.Length > 0 ? " " + v : ""),
            L("DREAMSCAPE 제작\n이머시브 오디오 오브젝트 모션 컨트롤러\n사내 전용 · 무단 복제·배포 금지",
              "Made by DREAMSCAPE\nImmersive audio object motion controller\nInternal use only · No copying or distribution without permission")
            + "\n\n© 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.",
            new[] { L("확인", "OK") }, ref none, null, Dialogs.AppIcon);
    }

    void Quit()
    {
        if (!server.IsActive) { ExitNow(); return; }
        terminating = true;
        server.Stop();
        Util.After(7000, ExitNow);
    }

    void ExitNow()
    {
        if (exited) return;
        exited = true;
        Power.Set(false);
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }

    void ChangePort()
    {
        int v = Dialogs.AskPort(L("웹 UI 포트", "Web UI Port"),
            L("브라우저로 접속할 포트 번호 (1–65535). 기본값 8080.", "Port for the browser UI (1–65535). Default 8080."),
            server.Port.ToString(), false);
        if (v <= 0 || v == server.Port) return;
        Settings.Port = v;
        ApplyServerSetting();
    }

    void ChangeControlPort()
    {
        int cp = Settings.ControlPort;
        int v = Dialogs.AskPort(L("OSC 컨트롤 포트", "OSC Control Port"),
            L("QLab·콘솔 등에서 OSC 명령을 받을 UDP 포트.\n비워 두면 웹 UI의 출력 설정에 저장된 값(기본 9000)을 씁니다.",
              "UDP port for OSC control from QLab, consoles, etc.\nLeave empty to use the value saved in the web UI output settings (default 9000)."),
            cp > 0 ? cp.ToString() : "", true);
        if (v < 0 || v == cp) return;
        Settings.ControlPort = v;
        ApplyServerSetting();
    }

    void ChangeHosts()
    {
        string cur = Settings.AllowedHosts;
        string v = Dialogs.Ask(L("허용 호스트 이름", "Allowed Host Names"),
            L("IP·localhost 외의 이름(예: 사내 DNS 별칭)으로 접속할 때 추가합니다. 쉼표로 구분.",
              "Extra host names (e.g. internal DNS aliases) allowed besides IPs and localhost. Comma-separated."),
            cur, "show-pc.lan, foh.local");
        if (v == null) return;
        List<string> parts = new List<string>();
        foreach (string s in v.Split(',')) if (s.Trim().Length > 0) parts.Add(s.Trim());
        string cleaned = string.Join(",", parts.ToArray());
        if (cleaned == cur) return;
        Settings.AllowedHosts = cleaned;
        ApplyServerSetting();
    }

    void ToggleRemote() { Settings.LocalOnly = !Settings.LocalOnly; ApplyServerSetting(); }
    void ToggleSleep() { Settings.PreventSleep = !Settings.PreventSleep; ApplyServerSetting(); }

    void ToggleLoginItem()
    {
        try { LoginItem.Enabled = !LoginItem.Enabled; }
        catch (Exception ex)
        {
            Dialogs.Alert(L("로그인 시 실행을 변경하지 못했습니다.", "Could not change the sign-in setting."),
                ex.Message + "\n\n" + L("작업 관리자 → 시작 앱에서 직접 바꿀 수 있습니다.", "You can change it in Task Manager → Startup apps."));
        }
    }

    void ResetSettings()
    {
        string none = null;
        int r = Dialogs.Show(L("설정을 기본값으로 되돌릴까요?", "Reset all settings to defaults?"),
            L("포트 8080, 외부 접속 허용, 자동 시작 등. 프리셋·세션 데이터는 그대로 유지됩니다.",
              "Port 8080, network access on, auto start, etc. Presets and session data are kept."),
            new[] { L("초기화", "Reset"), L("취소", "Cancel") }, ref none, null, SystemIcons.Question);
        if (r != 0) return;
        Settings.Reset();
        ApplyServerSetting();
    }

    /// Server settings only take effect on (re)start.
    void ApplyServerSetting()
    {
        if (!server.IsActive) return;
        string none = null;
        int r = Dialogs.Show(L("서버를 재시작해서 적용할까요?", "Restart the server to apply?"),
            L("재시작하는 동안 OSC 출력이 잠시 멈춥니다. 열려 있는 브라우저는 자동으로 다시 연결됩니다 (포트를 바꿨다면 새 주소로 열립니다).",
              "OSC output pauses briefly during the restart. Open browsers reconnect automatically (a new port opens a new tab)."),
            new[] { L("지금 재시작", "Restart Now"), L("나중에", "Later") }, ref none, null, SystemIcons.Question);
        if (r != 0) return;
        server.Restart(server.RunningPort != server.Port);
    }

    void ShowFailure(string message)
    {
        string none = null;
        int r = Dialogs.Show(L("Objitter 서버를 실행할 수 없습니다.", "The Objitter server is not running."), message,
            new[] { L("확인", "OK"), L("포트 변경…", "Change Port…"), L("로그 보기", "Show Log") }, ref none, null, SystemIcons.Error);
        if (r == 1)
        {
            ChangePort();
            if (!server.IsActive) server.Start(Settings.OpenBrowser);
        }
        else if (r == 2) ShowLog();
    }
}

static class Program
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main(string[] args)
    {
        bool quit = Array.IndexOf(args, "--quit") >= 0;
        EventWaitHandle activate = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DREAMSCAPE.Objitter.Activate");
        EventWaitHandle quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DREAMSCAPE.Objitter.Quit");
        bool created;
        Mutex mutex = new Mutex(true, @"Local\DREAMSCAPE.Objitter.Tray", out created);
        if (!created)
        {
            if (!quit) { activate.Set(); return; }
            // Installer / uninstaller: ask the running instance to stop its server and quit, then wait for it.
            quitEvent.Set();
            try { mutex.WaitOne(15000); } catch (AbandonedMutexException) { }
            return;
        }
        if (quit) return;
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp(activate, quitEvent));
        GC.KeepAlive(mutex);
    }
}
