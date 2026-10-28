import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const targets = {
  'x86_64-pc-windows-msvc': { platform: 'windows-x64', bundles: 'nsis' },
  'aarch64-apple-darwin': { platform: 'macos-arm64', bundles: 'dmg', cpu: 0x0100000c },
  'x86_64-apple-darwin': { platform: 'macos-x64', bundles: 'dmg', cpu: 0x01000007 },
};

/** English brand of the published bundles; the product name stays Chinese. */
const APP_NAME = 'Mianxu';

function bundleArch(platform) {
  return platform === 'macos-arm64' ? 'arm64' : 'x64';
}

function releaseTarget(target) {
  if (!Object.hasOwn(targets, target)) throw new Error('Unsupported release target');
  return targets[target];
}

export function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag ?? '');
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)
    || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.1 (components <= 65535)');
  }
  return { tag, version: tag.slice(1), prerelease: !!match[4] };
}

/** Change only the CI checkout; the tag determines all embedded package versions. */
export function prepareRelease(root, tag) {
  const release = parseReleaseTag(tag);
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  let manifest = read('src-tauri/Cargo.toml');
  let lock = read('src-tauri/Cargo.lock');
  let changedManifest = false;
  manifest = manifest.replace(/(^\[package\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m, (block, header, content) => {
    if (!/^version\s*=\s*"[^"]+"/m.test(content)) throw new Error('Cargo package version missing');
    changedManifest = true;
    return header + content.replace(/^(version\s*=\s*")[^"]+(".*)$/m, `$1${release.version}$2`);
  });
  if (!changedManifest) throw new Error('Cargo [package] section missing');
  const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownPackage = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = ")[^"]+("\\r?\\n)`, 'g');
  if ([...lock.matchAll(ownPackage)].length !== 1) throw new Error('Expected exactly one local package in Cargo.lock');
  lock = lock.replace(ownPackage, `$1${release.version}$2`);
  pkg.version = config.version = release.version;
  for (const [file, value] of [
    ['package.json', JSON.stringify(pkg, null, 2) + '\n'],
    ['src-tauri/tauri.conf.json', JSON.stringify(config, null, 2) + '\n'],
    ['src-tauri/Cargo.toml', manifest], ['src-tauri/Cargo.lock', lock],
  ]) writeFileSync(path.join(root, file), value);
  return release;
}

export function collectRelease(root, tag, triple = 'x86_64-pc-windows-msvc') {
  const release = parseReleaseTag(tag);
  const { platform, bundles, cpu } = releaseTarget(triple);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== release.version) throw new Error('Run release preparation before collecting artifacts');
  const output = path.join(root, 'release-assets');
  if (existsSync(output) && readdirSync(output).length) throw new Error('release-assets must be empty to prevent stale uploads');
  const target = path.join(root, 'src-tauri/target', triple, 'release');
  const extension = bundles === 'nsis' ? '.exe' : '.dmg';
  const installers = readdirSync(path.join(target, 'bundle', bundles)).filter(file => file.endsWith(extension));
  if (installers.length !== 1) throw new Error(`Expected exactly one ${bundles} installer`);
  const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  // Tauri has named the bundled executable after the main binary, the package or
  // the product name depending on version; prefer the known names and fall back
  // to the only executable present instead of guessing wrong again.
  const binaryNames = [...new Set([config.mainBinaryName, APP_NAME, pkg.name, config.productName].filter(Boolean))];
  const appBinary = (directory, extension = '') => {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name);
    for (const name of binaryNames) {
      if (files.includes(`${name}${extension}`)) return path.join(directory, `${name}${extension}`);
    }
    const candidates = extension ? files.filter(file => file.endsWith(extension)) : files;
    if (candidates.length === 1) return path.join(directory, candidates[0]);
    throw new Error(`App executable not found in ${directory} (found: ${files.join(', ') || 'nothing'})`);
  };
  const prefix = `${APP_NAME}_${release.version}_${bundleArch(platform)}`;
  const files = bundles === 'nsis'
    ? [[path.join(target, 'bundle/nsis', installers[0]), `${prefix}-setup.exe`],
      [appBinary(target, '.exe'), `${prefix}-portable.exe`]]
    : [[path.join(target, 'bundle/dmg', installers[0]), `${prefix}.dmg`]];
  if (bundles === 'dmg') {
    // Check the architecture on cargo's own output. The bundle layout varies
    // between Tauri versions (the .app may not even remain in bundle/macos once
    // the DMG is written), while the DMG step already fails the build when the
    // app cannot be embedded.
    const executable = readFileSync(appBinary(target));
    if (executable.length < 8 || executable.readUInt32LE(0) !== 0xfeedfacf || executable.readUInt32LE(4) !== cpu) {
      throw new Error(`App executable architecture does not match ${triple}`);
    }
  }
  const hashes = files.map(([source, filename]) => {
    const bytes = readFileSync(source);
    if (bundles === 'nsis' && (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ')) {
      throw new Error(`Invalid Windows executable: ${filename}`);
    }
    if (bundles === 'dmg' && (bytes.length < 512 || bytes.toString('ascii', bytes.length - 512, bytes.length - 508) !== 'koly')) {
      throw new Error(`Invalid macOS disk image: ${filename}`);
    }
    return `${createHash('sha256').update(bytes).digest('hex')}  ${filename}`;
  });
  mkdirSync(output, { recursive: true });
  files.forEach(([source, filename]) => copyFileSync(source, path.join(output, filename)));
  const checksum = `${platform}-SHA256SUMS.txt`;
  writeFileSync(path.join(output, checksum), hashes.join('\n') + '\n');
  return [...files.map(([, filename]) => filename), checksum];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, tag = process.env.RELEASE_TAG] = process.argv.slice(2);
  if (command === 'prepare') {
    const result = prepareRelease(process.cwd(), tag);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\nversion=${result.version}\nprerelease=${result.prerelease}\n`);
    console.log(`Prepared ${result.tag} (${result.prerelease ? 'prerelease' : 'stable'})`);
  } else if (command === 'build') {
    const triple = process.env.RELEASE_TARGET;
    const { bundles } = releaseTarget(triple);
    const result = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--ci',
      '--target', triple, '--bundles', bundles, '--', '--locked'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  } else if (command === 'collect') console.log(collectRelease(process.cwd(), tag, process.env.RELEASE_TARGET).join('\n'));
  else throw new Error('Usage: node scripts/release.mjs <prepare|build|collect> [vVERSION]');
}
