; Objitter Windows installer (Inno Setup 6.3+). Built by scripts/make-windows-installer.ps1, which passes
; AppVersion, SourceDir (assembled app: Objitter.exe, node\, app\), OutputDir and IconFile with /D.
; Per-user install (no admin rights): %LOCALAPPDATA%\Programs\Objitter. User data stays in %APPDATA%\Objitter.
; © 2026 DREAMSCAPE Inc. All rights reserved. Proprietary — see LICENSE.

#ifndef AppVersion
  #error Build with scripts/make-windows-installer.ps1
#endif

[Setup]
AppId={{9677C931-B0CE-4BAD-AC31-131AB0AF057F}
AppName=Objitter
AppVersion={#AppVersion}
AppVerName=Objitter {#AppVersion}
AppPublisher=DREAMSCAPE Inc.
AppCopyright=© 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.
VersionInfoVersion={#AppVersion}
VersionInfoCompany=DREAMSCAPE Inc.
VersionInfoDescription=Objitter Setup
VersionInfoProductName=Objitter
DefaultDirName={autopf}\Objitter
DefaultGroupName=Objitter
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile={#SourceDir}\app\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename=Objitter-{#AppVersion}-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Objitter.exe
UninstallDisplayName=Objitter
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ko"; MessagesFile: "compiler:Languages\Korean.isl"

[CustomMessages]
en.StartupTask=Launch Objitter at Windows sign-in
ko.StartupTask=Windows 로그인 시 Objitter 실행
en.ConsoleShortcut=Objitter (console, troubleshooting)
ko.ConsoleShortcut=Objitter (콘솔, 문제 해결용)

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "{cm:StartupTask}"; Flags: unchecked

[InstallDelete]
; Replace the bundled server/runtime completely so no stale files survive an update (like the Mac installer).
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Objitter"; Filename: "{app}\Objitter.exe"
Name: "{autoprograms}\{cm:ConsoleShortcut}"; Filename: "{app}\Objitter (console).cmd"; IconFilename: "{app}\Objitter.exe"
Name: "{autodesktop}\Objitter"; Filename: "{app}\Objitter.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Objitter"; ValueData: """{app}\Objitter.exe"""; Tasks: startup

[Run]
Filename: "{app}\Objitter.exe"; Description: "{cm:LaunchProgram,Objitter}"; Flags: nowait postinstall

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';

{ Asks a running Objitter tray app to stop its server and quit, and waits for it (up to 15 s). }
procedure QuitRunningObjitter();
var
  Exe: String;
  Code: Integer;
begin
  Exe := ExpandConstant('{app}\Objitter.exe');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  QuitRunningObjitter();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  QuitRunningObjitter();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Value: String;
begin
  if CurUninstallStep = usUninstall then
    if RegQueryStringValue(HKCU, RunKey, 'Objitter', Value) then
      if Pos(Lowercase(ExpandConstant('{app}')), Lowercase(Value)) > 0 then
        RegDeleteValue(HKCU, RunKey, 'Objitter');
end;
