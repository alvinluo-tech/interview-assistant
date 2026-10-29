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

# Render at 2x; the native updater scales the artwork to its current window DPI.
$bitmap = [Drawing.Bitmap]::new(1120, 420, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.ScaleTransform(2, 2)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$gradient = [Drawing.Drawing2D.LinearGradientBrush]::new(
    [Drawing.Point]::new(0, 0), [Drawing.Point]::new(560, 210),
    [Drawing.ColorTranslator]::FromHtml('#647DF5'), [Drawing.ColorTranslator]::FromHtml('#A78BFA'))
try {
    $graphics.FillRectangle($gradient, 0, 0, 560, 210)
    $white = Brush '#FFFFFF'
    $outline = [Drawing.Pen]::new([Drawing.Color]::FromArgb(100, 255, 255, 255), 1.4)
    try {
        $mark = [Drawing.Drawing2D.GraphicsPath]::new()
        $mark.AddArc(250, 26, 16, 16, 180, 90)
        $mark.AddArc(294, 26, 16, 16, 270, 90)
        $mark.AddArc(294, 70, 16, 16, 0, 90)
        $mark.AddArc(250, 70, 16, 16, 90, 90)
        $mark.CloseFigure()
        try { $graphics.DrawPath($outline, $mark) } finally { $mark.Dispose() }
        $markFormat = [Drawing.StringFormat]::new()
        $markFormat.Alignment = [Drawing.StringAlignment]::Center
        $markFormat.LineAlignment = [Drawing.StringAlignment]::Center
        $markFont = [Drawing.Font]::new('Microsoft YaHei UI', 42, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
        try { $graphics.DrawString('面', $markFont, $white, [Drawing.RectangleF]::new(250, 26, 60, 60), $markFormat) } finally { $markFont.Dispose(); $markFormat.Dispose() }
        $center = [Drawing.StringFormat]::new()
        $center.Alignment = [Drawing.StringAlignment]::Center
        $pill = Brush '#5B61C9'
        $pillPath = [Drawing.Drawing2D.GraphicsPath]::new()
        $pillPath.AddArc(193, 148, 26, 26, 90, 180)
        $pillPath.AddArc(341, 148, 26, 26, 270, 180)
        $pillPath.CloseFigure()
        try { $graphics.FillPath($pill, $pillPath) } finally { $pill.Dispose(); $pillPath.Dispose() }
        foreach ($line in @(@('Mianxu', 104, 28, $true), @('面试 · 笔试 · 模拟练习', 152, 12, $false))) {
            $style = if ($line[3]) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
            $font = [Drawing.Font]::new('Microsoft YaHei UI', [float]$line[2], $style, [Drawing.GraphicsUnit]::Pixel)
            try { $graphics.DrawString([string]$line[0], $font, $white, [Drawing.RectangleF]::new(0, $line[1], 560, 44), $center) } finally { $font.Dispose() }
        }
        $center.Dispose()
    } finally { $white.Dispose(); $outline.Dispose() }
    $bitmap.Save((Join-Path $destination 'update-hero.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally { $gradient.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
Write-Output 'Generated high-resolution native update artwork.'
