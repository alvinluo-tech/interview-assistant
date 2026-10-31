"""Generate desktop icon assets from the checked-in brand artwork using Tauri."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = root / 'src' / 'assets' / 'brand.png'
destination = root / 'src-tauri' / 'icons'
cli = root / 'node_modules' / '@tauri-apps' / 'cli' / 'tauri.js'
names = [
    '32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns',
    'StoreLogo.png', 'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
    'Square89x89Logo.png', 'Square107x107Logo.png', 'Square142x142Logo.png',
    'Square150x150Logo.png', 'Square284x284Logo.png', 'Square310x310Logo.png',
]
with tempfile.TemporaryDirectory(prefix='mianxu-icons-') as generated:
    subprocess.run(['node', str(cli), 'icon', str(source), '--output', generated], cwd=root, check=True)
    for name in names:
        shutil.copyfile(Path(generated) / name, destination / name)
print('Generated desktop icons from src/assets/brand.png.')
