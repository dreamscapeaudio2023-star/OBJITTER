# Builds a self-contained Windows installer: dist\Objitter-<version>-Setup.exe (+ .sha256)
# The installed Objitter.exe is a notification-area (tray) app (scripts/windows/ObjitterTray.cs) that runs the bundled
# Node.js (win-x64) server in the background, so target PCs need nothing else. Windows counterpart of make-mac-pkg.sh.
# User data lives in %APPDATA%\Objitter, the server log in %LOCALAPPDATA%\Objitter\Logs\server.log,
# tray settings in HKCU\Software\DREAMSCAPE\Objitter.
# Usage (from the project folder):   powershell -ExecutionPolicy Bypass -File scripts\make-windows-installer.ps1
# Options: -NodeVersion v24.21.0   -Zip (also build a portable dist\Objitter-<version>-win-x64.zip)
#          -Iscc <path to ISCC.exe> (default: Inno Setup 6 in Program Files; without it only the zip is built)
# Requires: Windows PowerShell 5.1, npm (build PC only), .NET Framework 4.x csc.exe (in-box), Inno Setup 6.3+ for the .exe.
param(
  [string]$NodeVersion = 'v24.21.0',
  [switch]$Zip,
  [string]$Iscc = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $version) { $version = '0.0.0' }
$build = Join-Path $root 'build'
$cache = Join-Path $build 'cache'
$work = Join-Path $build 'windows'
$stage = Join-Path $work 'Objitter'
$dist = Join-Path $root 'dist'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4.x) not found.' }

Write-Host "Building Objitter $version for Windows (Node $NodeVersion)..."
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $cache, $stage, $dist, "$stage\node", "$stage\app" | Out-Null

# ---- Node.js (win-x64): node.exe + its license ----
$nodeZip = Join-Path $cache "node-$NodeVersion-win-x64.zip"
if (-not (Test-Path $nodeZip)) {
  Write-Host "  downloading Node $NodeVersion (win-x64)..."
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile "$nodeZip.part"
  Move-Item "$nodeZip.part" $nodeZip -Force
}
$za = [IO.Compression.ZipFile]::OpenRead($nodeZip)
try {
  foreach ($name in 'node.exe', 'LICENSE') {
    $entry = $za.GetEntry("node-$NodeVersion-win-x64/$name")
    if (-not $entry) { throw "$name not found in $nodeZip" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$stage\node\$name", $true)
  }
} finally { $za.Dispose() }

# ---- app files + production dependencies ----
Write-Host '  copying app files...'
foreach ($f in 'package.json', 'package-lock.json', 'README.md', 'LICENSE') {
  if (Test-Path "$root\$f") { Copy-Item "$root\$f" "$stage\app\" }
}
Copy-Item "$root\server", "$root\public" "$stage\app\" -Recurse
New-Item -ItemType Directory -Force "$stage\app\presets", "$stage\app\demo" | Out-Null
Copy-Item "$root\presets\Demo - *.json" "$stage\app\presets\"
Copy-Item "$root\demo\*" "$stage\app\demo\" -Recurse
Push-Location "$stage\app"
try {
  & npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Get-ChildItem "$stage\app" -Recurse -Force -Include '.DS_Store', 'Thumbs.db', 'desktop.ini' | Remove-Item -Force

# ---- icon (DREAMSCAPE logo): multi-size .ico, small sizes from the hand-made favicons ----
function New-Frame([string]$src, [int]$size) {
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.Dispose(); $img.Dispose()
  if ($size -ge 256) {
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    return , $ms.ToArray()
  }
  # 32-bit DIB: BITMAPINFOHEADER, bottom-up BGRA rows, empty AND mask
  $data = $bmp.LockBits((New-Object System.Drawing.Rectangle 0, 0, $size, $size), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $bmp.PixelFormat)
  $px = New-Object byte[] ($size * $size * 4)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
  $bmp.UnlockBits($data); $bmp.Dispose()
  $maskRow = [int][Math]::Ceiling($size / 32) * 4
  $ms = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $ms
  $w.Write([int32]40); $w.Write([int32]$size); $w.Write([int32]($size * 2)); $w.Write([int16]1); $w.Write([int16]32)
  $w.Write([int32]0); $w.Write([int32]($px.Length + $maskRow * $size)); $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0)
  for ($y = $size - 1; $y -ge 0; $y--) { $w.Write($px, $y * $size * 4, $size * 4) }
  $w.Write((New-Object byte[] ($maskRow * $size)))
  $w.Flush()
  return , $ms.ToArray()
}
$assets = "$root\public\assets"
$bigSrc = if (Test-Path "$assets\icon-source.png") { "$assets\icon-source.png" } else { "$assets\icon-512.png" }
$frames = @(
  @(16, "$assets\favicon-16.png"), @(20, "$assets\favicon-32.png"), @(24, "$assets\favicon-32.png"), @(32, "$assets\favicon-32.png"),
  @(40, "$assets\dreamscape-48.png"), @(48, "$assets\dreamscape-48.png"), @(64, "$assets\dreamscape-128.png"), @(256, $bigSrc)
)
$ico = Join-Path $work 'Objitter.ico'
$images = foreach ($fr in $frames) { , (New-Frame $fr[1] $fr[0]) }
$fs = [IO.File]::Create($ico)
$w = New-Object IO.BinaryWriter $fs
$w.Write([int16]0); $w.Write([int16]1); $w.Write([int16]$frames.Count)
$offset = 6 + 16 * $frames.Count
for ($i = 0; $i -lt $frames.Count; $i++) {
  $s = $frames[$i][0]; $len = $images[$i].Length
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([int16]1); $w.Write([int16]32); $w.Write([int32]$len); $w.Write([int32]$offset)
  $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Dispose()

# ---- tray app (Objitter.exe) ----
Write-Host '  compiling tray app...'
$info = Join-Path $work 'AssemblyInfo.cs'
$numVer = ($version -replace '[^0-9.].*$', '')
if ($numVer -notmatch '^\d+(\.\d+){0,3}$') { $numVer = '0.0.0' }
@"
using System.Reflection;
[assembly: AssemblyTitle("Objitter")]
[assembly: AssemblyProduct("Objitter")]
[assembly: AssemblyDescription("Objitter - immersive audio object motion controller")]
[assembly: AssemblyCompany("DREAMSCAPE Inc.")]
[assembly: AssemblyCopyright("\u00A9 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.")]
[assembly: AssemblyVersion("$numVer")]
[assembly: AssemblyFileVersion("$numVer")]
[assembly: AssemblyInformationalVersion("$version")]
"@ | Set-Content -Encoding UTF8 $info
& $csc /nologo /target:winexe /optimize+ /codepage:65001 /platform:anycpu "/win32icon:$ico" "/resource:$ico,Objitter.ico" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll `
  "/out:$stage\Objitter.exe" "$root\scripts\windows\ObjitterTray.cs" $info
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }

# ---- console launcher kept for troubleshooting: shows the live server log (quit the tray app first) ----
@'
@echo off
rem Runs the bundled Objitter server in this window with the tray app's data folders (quit the tray app first).
setlocal
title Objitter
set "SUPPORT=%APPDATA%\Objitter"
set "DATA_DIR=%SUPPORT%\data"
set "PRESET_DIR=%SUPPORT%\presets"
set "LIBRARY_DIR=%SUPPORT%\library"
for %%D in ("%DATA_DIR%" "%PRESET_DIR%" "%LIBRARY_DIR%") do if not exist "%%~D" mkdir "%%~D"
if "%PORT%"=="" for /f "tokens=3" %%P in ('reg query "HKCU\Software\DREAMSCAPE\Objitter" /v Port 2^>nul ^| find "REG_DWORD"') do set /a PORT=%%P
if "%PORT%"=="" set PORT=8080
cd /d "%~dp0app"
"%~dp0node\node.exe" server\index.js
pause
'@ -replace "`r?`n", "`r`n" | Set-Content -Encoding ASCII "$stage\Objitter (console).cmd"

# ---- packages ----
$outputs = @()
if (-not $Iscc) {
  foreach ($p in "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") {
    if (Test-Path $p) { $Iscc = $p; break }
  }
}
if ($Iscc) {
  Write-Host '  building installer (Inno Setup)...'
  & $Iscc /Q "/DAppVersion=$version" "/DSourceDir=$stage" "/DOutputDir=$dist" "/DIconFile=$ico" "$root\scripts\windows\Objitter.iss"
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
  $outputs += Join-Path $dist "Objitter-$version-Setup.exe"
} else {
  Write-Warning 'Inno Setup 6 not found - building the portable zip only (https://jrsoftware.org/isinfo.php).'
  $Zip = $true
}
if ($Zip) {
  $zipPath = Join-Path $dist "Objitter-$version-win-x64.zip"
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
  $outputs += $zipPath
}
foreach ($o in $outputs) {
  $hash = (Get-FileHash -Algorithm SHA256 $o).Hash.ToLower()
  "$hash  $(Split-Path -Leaf $o)" | Set-Content -Encoding ASCII "$o.sha256"
  Write-Host ("Done: {0} ({1:N1} MB)" -f $o, ((Get-Item $o).Length / 1MB))
}
