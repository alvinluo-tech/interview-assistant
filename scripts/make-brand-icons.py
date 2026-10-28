# 生成品牌应用图标：品牌蓝圆角方块 + 白色「面」字（与应用内 BrandMark 一致）。
# 输出覆盖 src-tauri/icons/ 全套（tauri.conf bundle.icon 引用的名字不变）。
from PIL import Image, ImageDraw, ImageFont, ImageOps
import os

OUT = r'src-tauri/icons'
MASTER = 1024
BG_TOP = (11, 143, 214)    # hsl(201,96%,44%)
BG_BOT = (4, 111, 168)     # hsl(201,96%,34%)
CORNER = int(MASTER * 0.225)

# 渐变背景 + 圆角蒙版
base = Image.new('RGB', (MASTER, MASTER))
grad = Image.new('RGB', (1, MASTER))
for y in range(MASTER):
    t = y / (MASTER - 1)
    grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)))
base = grad.resize((MASTER, MASTER))

mask = Image.new('L', (MASTER, MASTER), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, MASTER - 1, MASTER - 1], radius=CORNER, fill=255)
icon = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
icon.paste(base, (0, 0), mask)

# 「面」字：微软雅黑 Bold，光学居中（字面略上移）
font = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', int(MASTER * 0.58))
d = ImageDraw.Draw(icon)
left, top, right, bottom = d.textbbox((0, 0), '面', font=font)
w, h = right - left, bottom - top
d.text(((MASTER - w) / 2 - left, (MASTER - h) / 2 - top - MASTER * 0.01), '面',
       font=font, fill=(255, 255, 255, 255))

master_rgba = icon

def save_png(size, name):
    master_rgba.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))

save_png(32, '32x32.png')
save_png(128, '128x128.png')
save_png(256, '128x128@2x.png')
save_png(512, 'icon.png')
save_png(256, 'icon.ico')  # placeholder, real ico below

# 多尺寸 ico
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
frames = [master_rgba.resize(s, Image.LANCZOS) for s in ico_sizes]
frames[-1].save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=ico_sizes)

# icns（macOS，保持 bundle.icon 列表完整）
master_rgba.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'icon.icns'), format='ICNS')

# Square/Store logos（MSI 用；targets 只有 nsis，但保持一致）
for name, size in [
    ('Square30x30Logo.png', 30), ('Square44x44Logo.png', 44), ('Square71x71Logo.png', 71),
    ('Square89x89Logo.png', 89), ('Square107x107Logo.png', 107), ('Square142x142Logo.png', 142),
    ('Square150x150Logo.png', 150), ('Square284x284Logo.png', 284), ('Square310x310Logo.png', 310),
    ('StoreLogo.png', 50),
]:
    save_png(size, name)

print('done')
