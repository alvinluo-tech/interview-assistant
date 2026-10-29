import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReleaseTag, prepareRelease, collectRelease, buildUpdateManifest } from '../scripts/release.mjs';

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

function macFixture(t, triple, cpu, { binary = 'Mianxu', dmgName = '骆耀升老公酱面试助手.dmg' } = {}) {
  const root = fixture(t);
  prepareRelease(root, 'v0.1.1');
  const target = path.join(root, 'src-tauri/target', triple, 'release');
  mkdirSync(path.join(target, 'bundle/dmg'), { recursive: true });
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(cpu, 4);
  writeFileSync(path.join(target, binary), executable);
  const image = Buffer.alloc(1024);
  image.write('koly', image.length - 512);
  const dmg = path.join(target, 'bundle/dmg', dmgName);
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

test('collect discovers the DMG and accepts the cargo binary name', t => {
  const { root } = macFixture(t, 'aarch64-apple-darwin', 0x0100000c, { binary: 'mianxu', dmgName: 'Mianxu.dmg' });
  assert.ok(collectRelease(root, 'v0.1.1', 'aarch64-apple-darwin').includes('Mianxu_0.1.1_arm64.dmg'));
});

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

test('a release requiring updater support cannot collect an unsigned installer', t => {
  const root = fixture(t); prepareRelease(root, 'v0.1.2');
  const target = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release');
  mkdirSync(path.join(target, 'bundle/nsis'), { recursive: true });
  writeFileSync(path.join(target, 'bundle/nsis/setup.exe'), 'MZsynthetic-installer');
  writeFileSync(path.join(target, 'Mianxu.exe'), 'MZsynthetic-app');
  assert.throws(() => collectRelease(root, 'v0.1.2', 'x86_64-pc-windows-msvc', { updater: true }), /signature|签名|\.sig/);
});

function signedRoot(t, triple) {
  const signing = JSON.parse(readFileSync('tests/fixtures/updater-signed.json', 'utf8'));
  const root = triple.includes('windows') ? fixture(t) : macFixture(t, triple, triple.startsWith('aarch64') ? 0x0100000c : 0x01000007).root;
  prepareRelease(root, 'v0.1.2');
  writeFileSync(path.join(root, 'src-tauri/updater-public-key.txt'), signing.publicKey);
  const target = path.join(root, 'src-tauri/target', triple, 'release');
  const windows = triple.includes('windows');
  const bundle = path.join(target, 'bundle', windows ? 'nsis' : 'macos');
  mkdirSync(bundle, { recursive: true });
  const source = path.join(bundle, windows ? 'setup.exe' : 'fixture.app.tar.gz');
  const signed = signing[windows ? 'windows' : 'macos'];
  writeFileSync(source, Buffer.from(signed.bytes, 'base64'));
  writeFileSync(source + '.sig', signed.signature);
  if (windows) writeFileSync(path.join(target, 'Mianxu.exe'), 'MZsynthetic-portable');
  return { root, source, signing };
}

test('signed update collection verifies actual signatures and rejects tampering and version replay', t => {
  const triple = 'x86_64-pc-windows-msvc';
  const good = signedRoot(t, triple);
  assert.ok(collectRelease(good.root, 'v0.1.2', triple, { updater: true }).includes('Mianxu_0.1.2_x64-setup.exe.sig'));
  const bad = signedRoot(t, triple);
  writeFileSync(bad.source, 'MZmodified-after-signing');
  assert.throws(() => collectRelease(bad.root, 'v0.1.2', triple, { updater: true }), /signature|Signature|verification/i);
  const replay = signedRoot(t, triple); prepareRelease(replay.root, 'v0.1.3');
  assert.throws(() => collectRelease(replay.root, 'v0.1.3', triple, { updater: true }), /version/i);
});

test('a complete cross-platform manifest contains only verified official signed updates', t => {
  const root = fixture(t), directory = path.join(root, 'release-assets'); mkdirSync(directory);
  for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    const signed = signedRoot(t, triple);
    writeFileSync(path.join(root, 'src-tauri/updater-public-key.txt'), signed.signing.publicKey);
    for (const name of collectRelease(signed.root, 'v0.1.2', triple, { updater: true })) {
      writeFileSync(path.join(directory, name), readFileSync(path.join(signed.root, 'release-assets', name)));
    }
  }
  const manifest = buildUpdateManifest(root, 'v0.1.2', { notes: 'Synthetic release notes', pubDate: '2026-10-29T00:00:00Z' });
  assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']);
  assert.equal(manifest.version, '0.1.2');
  for (const entry of Object.values(manifest.platforms)) {
    assert.ok(entry.url.startsWith('https://github.com/alvinluo-tech/interview-assistant/releases/download/v0.1.2/'));
    assert.ok(entry.signature.length > 100);
  }
  writeFileSync(path.join(directory, 'Mianxu_0.1.2_arm64.app.tar.gz.sig'), 'damaged');
  assert.throws(() => buildUpdateManifest(root, 'v0.1.2'), /signature|Signature|verification/i);
});
