import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReleaseTag, prepareRelease, collectRelease } from '../scripts/release.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'mianxu-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mianxu-release-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  for (const file of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    writeFileSync(path.join(root, file), readFileSync(file));
  }
  return root;
}

test('valid stable and prerelease tags determine the release kind', () => {
  assert.deepEqual(parseReleaseTag('v0.1.1'), { tag: 'v0.1.1', version: '0.1.1', prerelease: false });
  assert.equal(parseReleaseTag('v1.0.0-rc.1').prerelease, true);
  assert.equal(parseReleaseTag('v1.0.0-beta.0').version, '1.0.0-beta.0');
});
test('invalid or unsafe tags are rejected before changing any file', t => {
  const root = fixture(t);
  const before = readFileSync(path.join(root, 'package.json'), 'utf8');
  for (const tag of ['main', '0.1.1', 'v01.2.3', 'v1.2.3-01', 'v65536.0.0', 'v1.2.3+build', 'v1.2.3\nextra', 'v1.2.3; echo unsafe']) {
    assert.throws(() => prepareRelease(root, tag));
  }
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});
test('tag version is synchronized across all manifests and only the root Cargo lock entry', t => {
  const root = fixture(t);
  const oldLock = readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  const oldConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  prepareRelease(root, 'v0.4.0-rc.1');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.4.0-rc.1');
  const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.version, '0.4.0-rc.1');
  assert.deepEqual(config.app, oldConfig.app);
  assert.match(readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), /^version = "0\.4\.0-rc\.1"$/m);
  const newLock = readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  const withoutOwnVersion = text => text.replace(/(name = "mianxu"\r?\nversion = ")[^"]+/, '$1ROOT_VERSION');
  assert.equal(withoutOwnVersion(newLock), withoutOwnVersion(oldLock));
  assert.match(newLock, /name = "mianxu"\r?\nversion = "0\.4\.0-rc\.1"/);
});
test('collect stages only installers and embedded app binaries and generates verifiable checksums', t => {
  const root = fixture(t);
  prepareRelease(root, 'v0.1.1');
  const target = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release');
  mkdirSync(path.join(target, 'bundle/nsis'), { recursive: true });
  writeFileSync(path.join(target, 'bundle/nsis/骆耀升老公酱面试助手_0.1.1_x64-setup.exe'), 'MZfixture-installer');
  writeFileSync(path.join(target, 'Mianxu.exe'), 'MZfixture-app');
  writeFileSync(path.join(target, 'private-test-data.json'), '{"dummy":"must not ship"}');
  const names = collectRelease(root, 'v0.1.1');
  const output = path.join(root, 'release-assets');
  assert.deepEqual(readdirSync(output).sort(), names.sort());
  const lines = readFileSync(path.join(output, 'windows-x64-SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const [digest, filename] = line.split('  ');
    assert.equal(createHash('sha256').update(readFileSync(path.join(output, filename))).digest('hex'), digest);
  }
  assert.throws(() => collectRelease(root, 'v0.1.1'), /must be empty/);
});

function macFixture(t, triple, cpu) {
  const root = fixture(t);
  prepareRelease(root, 'v0.1.1');
  const target = path.join(root, 'src-tauri/target', triple, 'release/bundle');
  const app = path.join(target, 'macos/骆耀升老公酱面试助手.app/Contents/MacOS');
  mkdirSync(app, { recursive: true });
  mkdirSync(path.join(target, 'dmg'), { recursive: true });
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(cpu, 4);
  writeFileSync(path.join(app, 'Mianxu'), executable);
  const image = Buffer.alloc(1024);
  image.write('koly', image.length - 512);
  const dmg = path.join(target, 'dmg/骆耀升老公酱面试助手.dmg');
  writeFileSync(dmg, image);
  return { root, dmg };
}

for (const [triple, cpu, platform] of [
  ['aarch64-apple-darwin', 0x0100000c, 'macos-arm64'],
  ['x86_64-apple-darwin', 0x01000007, 'macos-x64'],
]) {
  test(`collect ${platform} checks the app architecture and stages only the DMG with unique checksums`, t => {
    const { root } = macFixture(t, triple, cpu);
    const names = collectRelease(root, 'v0.1.1', triple);
    const filename = `Mianxu_0.1.1_${platform === 'macos-arm64' ? 'arm64' : 'x64'}.dmg`;
    assert.deepEqual(names, [filename, `${platform}-SHA256SUMS.txt`]);
    const output = path.join(root, 'release-assets');
    assert.deepEqual(readdirSync(output).sort(), names.sort());
    const digest = createHash('sha256').update(readFileSync(path.join(output, filename))).digest('hex');
    assert.equal(readFileSync(path.join(output, `${platform}-SHA256SUMS.txt`), 'utf8'), `${digest}  ${filename}\n`);
  });
}

test('macOS outputs with the wrong architecture or damaged DMG cannot ship', t => {
  const { root, dmg } = macFixture(t, 'aarch64-apple-darwin', 0x01000007);
  assert.throws(() => collectRelease(root, 'v0.1.1', 'aarch64-apple-darwin'), /architecture/);
  const intel = macFixture(t, 'x86_64-apple-darwin', 0x01000007);
  writeFileSync(intel.dmg, 'broken disk image');
  assert.throws(() => collectRelease(intel.root, 'v0.1.1', 'x86_64-apple-darwin'), /Invalid macOS disk image/);
  writeFileSync(path.join(path.dirname(dmg), 'stale.dmg'), 'old build');
  assert.throws(() => collectRelease(root, 'v0.1.1', 'aarch64-apple-darwin'), /exactly one/);
  assert.throws(() => collectRelease(root, 'v0.1.1', '../unknown'), /Unsupported release target/);
});
test('missing or invalid build outputs prevent staging assets', t => {
  const root = fixture(t);
  prepareRelease(root, 'v0.1.1');
  const target = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release');
  mkdirSync(path.join(target, 'bundle/nsis'), { recursive: true });
  assert.throws(() => collectRelease(root, 'v0.1.1'), /exactly one/);
  writeFileSync(path.join(target, 'bundle/nsis/setup.exe'), 'not an executable');
  writeFileSync(path.join(target, 'Mianxu.exe'), 'MZfixture-app');
  assert.throws(() => collectRelease(root, 'v0.1.1'), /Invalid Windows executable/);
});
