import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

test('branded installer preserves upgrade identity and uses an explicit user installation policy', () => {
  assert.equal(config.identifier, 'com.luoyaosheng.mianxu');
  assert.equal(config.productName, '骆耀升老公酱面试助手');
  assert.equal(config.bundle.windows?.nsis?.installMode, 'currentUser');
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.deepEqual(config.bundle.windows.nsis.languages, ['SimpChinese', 'English']);
  assert.equal(config.plugins.updater.windows.installMode, 'passive');
});

test('installer and uninstaller use supported 24-bit branding bitmaps', () => {
  const nsis = config.bundle.windows?.nsis;
  assert.ok(nsis?.sidebarImage && nsis?.headerImage && nsis?.uninstallerHeaderImage);
  for (const [key, width, height] of [['sidebarImage', 164, 314], ['headerImage', 150, 57], ['uninstallerHeaderImage', 150, 57]]) {
    const bytes = readFileSync(path.join('src-tauri', nsis[key]));
    assert.equal(bytes.toString('ascii', 0, 2), 'BM');
    assert.equal(bytes.readInt32LE(18), width);
    assert.equal(bytes.readInt32LE(22), height);
    assert.equal(bytes.readUInt16LE(28), 24);
  }
  assert.ok(nsis.installerHooks && nsis.installerIcon && nsis.uninstallerIcon);
});
