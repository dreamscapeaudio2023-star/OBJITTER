# Draws the tiles prepared by preview.js the way Companion renders a 72x72 button (top bar, icon, Arial text,
# word wrap that only breaks inside a word when the word itself is too wide). Scale 2x for readability.
param([string]$JsonPath, [string]$OutPath)
Add-Type -AssemblyName System.Drawing

$S = 2          # scale
$B = 72 * $S    # button
$GAP = 6 * $S
$PERROW = 12
$LABELW = 70 * $S
$groups = Get-Content -Raw -Encoding UTF8 $JsonPath | ConvertFrom-Json

$rows = 0
foreach ($g in $groups) { $rows += 2 * [math]::Ceiling($g.offline.Count / $PERROW) }
$W = $LABELW + $PERROW * ($B + $GAP) + $GAP
$H = $GAP + $groups.Count * (22 * $S) + $rows * ($B + $GAP) + $GAP

$bmp = New-Object System.Drawing.Bitmap $W, $H
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.SmoothingMode = 'AntiAlias'
$gfx.TextRenderingHint = 'AntiAliasGridFit'
$gfx.InterpolationMode = 'HighQualityBicubic'
$gfx.Clear([System.Drawing.ColorTranslator]::FromHtml('#2a2a2a'))
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
$white = [System.Drawing.Brushes]::White
$grey = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#9aa3b2'))
$hfont = New-Object System.Drawing.Font 'Arial', (10 * $S), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$lfont = New-Object System.Drawing.Font 'Arial', (8 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$tfont = New-Object System.Drawing.Font 'Arial', (7 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)

function Wrap($text, $font, $maxW) {
	$out = @()
	foreach ($para in ($text -split "`n")) {
		$line = ''
		foreach ($word in ($para -split ' ')) {
			$try = if ($line) { "$line $word" } else { $word }
			if ($gfx.MeasureString($try, $font, 10000, $fmt).Width -le $maxW) { $line = $try; continue }
			if ($line) { $out += $line; $line = '' }
			# word alone too wide: break inside it (what Companion does, and what the presets must avoid)
			$chunk = ''
			foreach ($ch in $word.ToCharArray()) {
				if ($gfx.MeasureString("$chunk$ch", $font, 10000, $fmt).Width -gt $maxW -and $chunk) { $out += $chunk; $chunk = '' }
				$chunk += $ch
			}
			$line = $chunk
		}
		$out += $line
	}
	return , $out
}

function DrawButton($t, $x, $y) {
	$gfx.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($t.bg))), $x, $y, $B, $B)
	# top bar (Companion shows the button location here)
	$gfx.FillRectangle([System.Drawing.Brushes]::Black, $x, $y, $B, 13 * $S)
	$gfx.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#c9a227'))), $x, $y + 13 * $S, $B, $S)
	$gfx.DrawString('x/x/x', $tfont, $grey, $x + 3 * $S, $y + 2 * $S)
	$areaY = $y + 14 * $S
	$areaH = 58 * $S
	if ($t.png) {
		$ms = New-Object System.IO.MemoryStream (, [Convert]::FromBase64String($t.png))
		$img = [System.Drawing.Image]::FromStream($ms)
		$gfx.DrawImage($img, [int]($x + ($B - $img.Width * $S) / 2), [int]$areaY, $img.Width * $S, $img.Height * $S)
		$img.Dispose()
	}
	if (-not $t.text) { return }
	$font = New-Object System.Drawing.Font 'Arial', ($t.size * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
	$lines = Wrap $t.text $font (68 * $S)
	$lh = $t.size * 1.15 * $S
	$total = $lines.Count * $lh
	$v = ($t.align -split ':')[1]
	$ty = if ($v -eq 'bottom') { $areaY + $areaH - $total - $S } elseif ($v -eq 'top') { $areaY } else { $areaY + ($areaH - $total) / 2 }
	$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($t.color))
	foreach ($l in $lines) {
		$w = $gfx.MeasureString($l, $font, 10000, $fmt).Width
		$gfx.DrawString($l, $font, $brush, [float]($x + ($B - $w) / 2), [float]$ty, $fmt)
		$ty += $lh
	}
	$font.Dispose()
}

$y = $GAP
foreach ($g in $groups) {
	$gfx.DrawString($g.name, $hfont, $white, $GAP, $y + 3 * $S)
	$y += 22 * $S
	foreach ($state in 'offline', 'live') {
		$tiles = $g.$state
		$gfx.DrawString($(if ($state -eq 'offline') { 'offline / no state' } else { 'live (sample state)' }), $lfont, $grey, $GAP, $y + 4 * $S)
		for ($i = 0; $i -lt $tiles.Count; $i++) {
			if ($i -gt 0 -and $i % $PERROW -eq 0) { $y += $B + $GAP }
			DrawButton $tiles[$i] ($LABELW + $GAP + ($i % $PERROW) * ($B + $GAP)) $y
		}
		$y += $B + $GAP
	}
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
