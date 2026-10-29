// Compile the production installer skin against an inert, isolated Rust executable.
// This script NEVER launches an installer or changes installed applications/registry entries.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('The NSIS packaging smoke test requires Windows.');
const repo = process.cwd();
mkdirSync('artifacts', { recursive: true });
const project = mkdtempSync(path.join(repo, 'artifacts/installer-packaging-'));
const root = path.join(project, 'src-tauri');
for (const directory of ['src', 'target/release']) mkdirSync(path.join(root, directory), { recursive: true });
mkdirSync(path.join(project, 'dist'));
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
config.productName = 'Mianxu Packaging Check';
config.identifier = 'com.luoyaosheng.mianxu.packaging-check';
config.version = '0.0.0';
config.mainBinaryName = 'Mianxu';
config.build = { frontendDist: '../dist' };
config.app = { windows: [] };
delete config.plugins;
config.bundle.createUpdaterArtifacts = false;
config.bundle.windows.webviewInstallMode = { type: 'skip' };
config.bundle.icon = config.bundle.icon.map(file => path.join(repo, 'src-tauri', file));
for (const key of ['installerHooks', 'installerIcon', 'uninstallerIcon', 'sidebarImage', 'headerImage', 'uninstallerHeaderImage']) {
  config.bundle.windows.nsis[key] = path.join(repo, 'src-tauri', config.bundle.windows.nsis[key]);
}
writeFileSync(path.join(root, 'tauri.conf.json'), JSON.stringify(config, null, 2));
writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="mianxu-packaging-check"\nversion="0.0.0"\nedition="2024"\nauthors=["Mianxu"]\ndefault-run="Mianxu"\n\n[[bin]]\nname="Mianxu"\npath="src/main.rs"\n');
const main = path.join(root, 'src/main.rs');
writeFileSync(main, '#![windows_subsystem="windows"]\nfn main() {}\n');
writeFileSync(path.join(project, 'dist/index.html'), '<title>Packaging fixture</title>');
execFileSync('rustc', ['--crate-name', 'mianxu_packaging_check', '--edition', '2024', '-C', 'opt-level=1', main, '-o', path.join(root, 'target/release/Mianxu.exe')], { stdio: 'inherit', windowsHide: true });
const env = { ...process.env };
for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY_PATH']) delete env[key];
execFileSync(process.execPath, [path.join(repo, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--bundles', 'nsis', '--ci', '--no-sign', '--no-binary-patching'], { cwd: project, env, stdio: 'inherit', windowsHide: true });
console.log('PASS: production branding, bilingual strings and installer/uninstaller hooks compile. The fixture was not installed.');
