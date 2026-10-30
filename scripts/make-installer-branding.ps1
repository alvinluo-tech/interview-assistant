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
function RoundedPath([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius) {
    $shape = [Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $shape.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $shape.AddArc(($X + $Width - $diameter), $Y, $diameter, $diameter, 270, 90)
    $shape.AddArc(($X + $Width - $diameter), ($Y + $Height - $diameter), $diameter, $diameter, 0, 90)
    $shape.AddArc($X, ($Y + $Height - $diameter), $diameter, $diameter, 90, 90)
    $shape.CloseFigure()
    return $shape
}
function Mark($Graphics, [float]$X, [float]$Y, [float]$Size) {
    $brush = Brush '#0879BA'
    $shape = RoundedPath $X $Y $Size $Size ($Size * .26)
    try { $Graphics.FillPath($brush, $shape) } finally { $brush.Dispose(); $shape.Dispose() }
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

# Render at 2x; the native pages scale this compact header to the window DPI.
foreach ($language in @('zh', 'en')) {
    $bitmap = [Drawing.Bitmap]::new(1120, 280, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.ScaleTransform(2, 2)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    try {
        $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#F5F9FC'))
        Mark $graphics 36 36 60
        Label $graphics 'Mianxu' 114 31 28 '#192C3A' $true
        Label $graphics $(if ($language -eq 'zh') { '桌面面试助手' } else { 'Your interview companion' }) 116 78 12 '#647887'
        $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#E5EDF3'), 1)
        try { $graphics.DrawLine($pen, 0, 139, 560, 139) } finally { $pen.Dispose() }
        $filename = if ($language -eq 'zh') { 'update-hero.bmp' } else { 'update-hero-en.bmp' }
        $bitmap.Save((Join-Path $destination $filename), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

# Real native buttons keep their accessible text, focus and click handling.
# Bitmap faces use a single blue and generous radii, with no gradient or shadow.
foreach ($button in @(@('install', '立即安装', 'Install now'), @('launch', '打开 Mianxu', 'Open Mianxu'), @('continue', '继续', 'Continue'), @('close', '完成', 'Finish'), @('browse', '更改', 'Change'), @('dismiss', '完成', 'Finish'))) {
    foreach ($language in @('zh', 'en')) {
        $width = if ($button[0] -eq 'browse') { 144 } elseif ($button[0] -eq 'dismiss') { 192 } else { 416 }
        $height = if ($button[0] -eq 'browse') { 84 } elseif ($button[0] -eq 'dismiss') { 56 } else { 88 }
        $secondary = $button[0] -in @('browse', 'dismiss')
        $buttonBitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $g = [Drawing.Graphics]::FromImage($buttonBitmap)
        $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.Clear([Drawing.Color]::White)
        $fill = Brush $(if ($secondary) { '#EFF4F8' } else { '#0879BA' })
        $ink = Brush $(if ($secondary) { '#33556D' } else { '#FFFFFF' })
        $shape = RoundedPath 0 0 ($width - 1) ($height - 1) $(if ($secondary) { 20 } else { 43 })
        $format = [Drawing.StringFormat]::new()
        $format.Alignment = [Drawing.StringAlignment]::Center
        $format.LineAlignment = [Drawing.StringAlignment]::Center
        $font = [Drawing.Font]::new('Microsoft YaHei UI', $(if ($secondary) { 24 } else { 28 }), [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
        try {
            $g.FillPath($fill, $shape)
            $caption = if ($language -eq 'zh') { $button[1] } else { $button[2] }
            $g.DrawString($caption, $font, $ink, [Drawing.RectangleF]::new(0, 0, $width, $height), $format)
            $buttonBitmap.Save((Join-Path $destination ('button-' + $button[0] + '-' + $language + '.bmp')), [Drawing.Imaging.ImageFormat]::Bmp)
        } finally { $font.Dispose(); $format.Dispose(); $shape.Dispose(); $fill.Dispose(); $ink.Dispose(); $g.Dispose(); $buttonBitmap.Dispose() }
    }
}
Write-Output 'Generated compact blue/white native installer artwork (Chinese and English).'

# A bitmap-backed surface avoids the square background erase of native STATIC
# controls. The editable folder field remains a separate accessible EDIT.
$surface = [Drawing.Bitmap]::new(816, 84, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [Drawing.Graphics]::FromImage($surface)
$g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$fill = Brush '#EFF4F8'
$shape = RoundedPath 0 0 815 83 20
try {
    $g.Clear([Drawing.Color]::White)
    $g.FillPath($fill, $shape)
    $surface.Save((Join-Path $destination 'folder-surface.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally { $shape.Dispose(); $fill.Dispose(); $g.Dispose(); $surface.Dispose() }
