# Regenerates the DREAMSCAPE brand assets (app icons, favicons, macOS menu bar template) from the
# company logo package artifacts/brand-logo-v3 (kept outside git). Windows PowerShell 5.1+ (System.Drawing).
# Usage (from the project folder):   powershell -ExecutionPolicy Bypass -File scripts/make-brand-assets.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$v3 = Join-Path $root 'artifacts\brand-logo-v3'
$pub = Join-Path $root 'public\assets'
$mac = Join-Path $root 'scripts\mac\assets'
New-Item -ItemType Directory -Force $mac | Out-Null

$native = [System.Drawing.Bitmap]::new("$v3\png\logo-dark-backed-native-260.png")
$white = [System.Drawing.Bitmap]::new("$v3\source\logo512_white.png")

function New-Canvas([int]$w, [int]$h) {
  $bmp = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

function Draw-Logo($g, $src, [double]$x, [double]$y, [double]$size) {
  $attr = [System.Drawing.Imaging.ImageAttributes]::new()
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $dst = [System.Drawing.Rectangle]::new([int][Math]::Round($x), [int][Math]::Round($y), [int][Math]::Round($size), [int][Math]::Round($size))
  $g.DrawImage($src, $dst, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
}

# Icon with the logo centred on a transparent or solid square.
function Save-Icon([string]$path, [int]$canvas, [double]$scale, $bg, [int]$shadow = 0) {
  $bmp, $g = New-Canvas $canvas $canvas
  if ($bg) { $g.Clear([System.Drawing.ColorTranslator]::FromHtml($bg)) }
  $size = [Math]::Round($canvas * $scale)
  $off = ($canvas - $size) / 2
  if ($shadow -gt 0) {
    # soft drop shadow (macOS icon grid style): tiny mask upscaled = cheap blur
    $k = 32; $sm = [int]($canvas / $k)
    $sb = [System.Drawing.Bitmap]::new($sm, $sm, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($sb); $sg.Clear([System.Drawing.Color]::Transparent)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
    $sg.FillRectangle($brush, [single]($off / $k), [single](($off + $shadow / 2) / $k), [single]($size / $k), [single]($size / $k))
    $brush.Dispose(); $sg.Dispose()
    $g.DrawImage($sb, [System.Drawing.Rectangle]::new(0, 0, $canvas, $canvas), -0.5, -0.5, $sm, $sm, [System.Drawing.GraphicsUnit]::Pixel)
    $sb.Dispose()
  }
  Draw-Logo $g $native $off $off $size
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

Save-Icon "$pub\icon-512.png" 512 0.875 $null
Save-Icon "$pub\icon-192.png" 192 0.875 $null
Save-Icon "$pub\icon-maskable-512.png" 512 0.56 '#23211A'
Save-Icon "$pub\apple-touch-icon.png" 180 0.74 '#23211A'
Save-Icon "$pub\icon-source.png" 1024 0.8046875 $null 28

Copy-Item "$v3\png\logo-dark-backed-16.png" "$pub\favicon-16.png" -Force
Copy-Item "$v3\png\logo-dark-backed-32.png" "$pub\favicon-32.png" -Force
Copy-Item "$v3\png\logo-dark-backed-48.png" "$pub\dreamscape-48.png" -Force
Copy-Item "$v3\png\logo-dark-backed-128.png" "$pub\dreamscape-128.png" -Force
Copy-Item "$v3\web\favicon.ico" (Join-Path $root 'public\favicon.ico') -Force
Copy-Item "$v3\svg\logo-dark-backed.svg" "$pub\logo.svg" -Force

# Menu bar template image: black + alpha taken from the light-on-transparent original mark.
# The thin frame is thickened slightly so it survives the 16/32 px downscale.
function Save-Template([string]$path, [int]$canvas, [int]$logo) {
  $w = $white.Width; $h = $white.Height
  $mask = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $frame = [Math]::Max(1, [int][Math]::Ceiling(1.4 * $w / $logo))
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $a = $white.GetPixel($x, $y).A
      $edge = [Math]::Min([Math]::Min($x, $w - 1 - $x), [Math]::Min($y, $h - 1 - $y))
      if ($edge -lt $frame) { $a = 255 }
      $mask.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, 0, 0, 0))
    }
  }
  $bmp, $g = New-Canvas $canvas $canvas
  $off = ($canvas - $logo) / 2
  Draw-Logo $g $mask $off $off $logo
  $g.Dispose(); $mask.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
Save-Template "$mac\MenuBarIcon.png" 18 16
Save-Template "$mac\MenuBarIcon@2x.png" 36 32

$native.Dispose(); $white.Dispose()
'ok'

