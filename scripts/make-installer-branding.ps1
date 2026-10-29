# Generate the small 24-bit BMP assets accepted by NSIS. Run on Windows after brand changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$destination = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/windows/branding'))
New-Item -ItemType Directory -Path $destination -Force | Out-Null
function Brush([string]$Color) { [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($Color)) }
function Label($Graphics, [string]$Text, [float]$X, [float]$Y, [float]$Size, [string]$Color, [bool]$Bold = $false) {
    $style = if ($Bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
    $font = [Drawing.Font]::new('Microsoft YaHei UI', $Size, $style, [Drawing.GraphicsUnit]::Pixel)
    $brush = Brush $Color
    try { $Graphics.DrawString($Text, $font, $brush, $X, $Y) } finally { $font.Dispose(); $brush.Dispose() }
}
function Mark($Graphics, [float]$X, [float]$Y, [float]$Size) {
    $brush = Brush '#0B8FD6'
    try { $Graphics.FillRectangle($brush, $X, $Y, $Size, $Size) } finally { $brush.Dispose() }
    Label $Graphics '面' ($X + $Size * .15) ($Y + $Size * .04) ($Size * .66) '#FFFFFF' $true
}
foreach ($kind in @('sidebar', 'header', 'uninstall-header')) {
    $width = if ($kind -eq 'sidebar') { 164 } else { 150 }
    $height = if ($kind -eq 'sidebar') { 314 } else { 57 }
    $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    try {
        if ($kind -eq 'sidebar') {
            $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#102C43'))
            Mark $graphics 20 28 48
            Label $graphics 'Mianxu' 19 89 21 '#FFFFFF' $true
            Label $graphics '桌面面试助手' 20 125 12 '#B9D7EA'
            $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#3B8CB3'), 1)
            try {
                $graphics.DrawLine($pen, 21, 166, 142, 166)
                $graphics.DrawRectangle($pen, 22, 199, 103, 37)
                $graphics.DrawLine($pen, 34, 212, 104, 212)
                $graphics.DrawLine($pen, 34, 221, 84, 221)
                $graphics.DrawRectangle($pen, 39, 246, 103, 26)
            } finally { $pen.Dispose() }
            Label $graphics '面试 · 笔试 · 模拟练习' 20 286 9 '#B9D7EA'
        } else {
            $graphics.Clear([Drawing.Color]::White)
            Mark $graphics 5 12 32
            Label $graphics 'Mianxu' 45 10 15 '#16364A' $true
            Label $graphics $(if ($kind -eq 'header') { '安装与更新' } else { '卸载与数据管理' }) 46 32 9 '#5B7384'
        }
        $bitmap.Save((Join-Path $destination ($kind + '.bmp')), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
Write-Output 'Generated installer and uninstaller branding bitmaps.'
