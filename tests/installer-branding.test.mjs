import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { previewSource } from '../scripts/native-update-preview.mjs';
import { customizeTemplate, restoreTemplate } from '../scripts/customize-installer-template.mjs';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

test('branded installer preserves upgrade identity and uses an explicit user installation policy', () => {
  assert.equal(config.identifier, 'com.luoyaosheng.mianxu');
  assert.equal(config.productName, '骆耀升老公酱面试助手');
  assert.equal(config.bundle.windows?.nsis?.installMode, 'currentUser');
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.deepEqual(config.bundle.windows.nsis.languages, ['SimpChinese', 'English']);
  assert.equal(config.plugins.updater.windows.installMode, 'passive');
});

test('native preview exercises the production card without application installation side effects', () => {
  for (const language of ['SimpChinese', 'English']) {
    const source = previewSource('C:/fixture', 'C:/fixture/preview.exe', language);
    assert.match(source, /update-card\.nsh/);
    assert.match(source, /!insertmacro MIANXU_UPDATE_CARD/);
    assert.match(source, /UI PREVIEW/);
    assert.doesNotMatch(source, /WriteReg|WriteUninstaller|CreateShortcut|DeleteReg|RMDir|ExecWait|\bFile\b/i);
    assert.match(source, /RequestExecutionLevel user/);
    assert.match(source, /SetOutPath "\$PLUGINSDIR"/);
  }
  assert.throws(() => previewSource('C:/fixture', 'preview.exe', 'invalid'));
  for (const name of ['update-hero', 'update-hero-en']) {
    const hero = readFileSync(`src-tauri/windows/branding/${name}.bmp`);
    assert.equal(hero.readInt32LE(18), 1120);
    assert.equal(hero.readInt32LE(22), 280);
    assert.equal(hero.readUInt16LE(28), 24);
  }
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

test('interactive installs use branded entry and completion pages around the maintained install engine', () => {
  assert.equal(config.bundle.windows.nsis.template, 'windows/installer.nsi');
  const template = readFileSync('src-tauri/windows/installer.nsi', 'utf8');
  assert.match(template, /Page custom MianxuInstallPage MianxuInstallLeave/);
  assert.match(template, /Page custom MianxuFinishPage/);
  assert.doesNotMatch(template, /!insertmacro MUI_PAGE_WELCOME|!insertmacro MUI_PAGE_DIRECTORY|!insertmacro MUI_PAGE_FINISH/);
  for (const invariant of ['Function PageLeaveReinstall', 'Function RestorePreviousInstallLocation', 'Section WebView2', 'Section Install', 'Function .onInstSuccess', 'Section Uninstall', 'ALLOWDOWNGRADES', 'CheckIfAppIsRunning']) {
    assert.ok(template.includes(invariant), `Preserve upstream behavior: ${invariant}`);
  }
});

test('the custom installer reverses exactly to the pinned upstream engine', () => {
  const template = readFileSync('src-tauri/windows/installer.nsi', 'utf8').replaceAll('\r\n', '\n');
  const upstream = restoreTemplate(template);
  assert.equal(customizeTemplate(upstream), template);
  assert.equal(customizeTemplate(upstream.replaceAll('\n', '\r\n')), template);
  assert.throws(() => customizeTemplate(''), /baseline/);
  assert.throws(() => restoreTemplate(''), /provenance/);
  assert.throws(() => restoreTemplate(template.replace('Page custom MianxuInstallPage MianxuInstallLeave', 'Page custom Removed')), /anchor/);
  assert.throws(() => customizeTemplate(restoreTemplate(template.replace('Section WebView2', 'Section Unauthorized'))), /baseline/);
});

test('native control artwork uses the bitmap format and dimensions accepted by NSIS', () => {
  for (const kind of ['install', 'launch', 'continue', 'close', 'browse', 'dismiss']) for (const language of ['zh', 'en']) {
    const bytes = readFileSync(`src-tauri/windows/branding/button-${kind}-${language}.bmp`);
    assert.equal(bytes.toString('ascii', 0, 2), 'BM');
    assert.equal(bytes.readInt32LE(18), kind === 'browse' ? 144 : kind === 'dismiss' ? 192 : 416);
    assert.equal(bytes.readInt32LE(22), kind === 'browse' ? 84 : kind === 'dismiss' ? 56 : 88);
    assert.equal(bytes.readUInt16LE(28), 24);
  }
  const surface = readFileSync('src-tauri/windows/branding/folder-surface.bmp');
  assert.equal(surface.readInt32LE(18), 816);
  assert.equal(surface.readInt32LE(22), 84);
  assert.equal(surface.readUInt16LE(28), 24);
});
