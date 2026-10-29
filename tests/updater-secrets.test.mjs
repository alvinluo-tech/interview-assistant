import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('Windows secret uploader reads newline-terminated DPAPI files without exposing values in arguments', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mianxu-updater-secrets-'));
  const cli = path.join(root, 'fake-gh.exe');
  // A synthetic CLI consumes only fixture values and never contacts GitHub.
  writeFileSync(path.join(root, 'fake-gh.rs'), `use std::io::{self, Read};
fn main() {
  let args: Vec<_> = std::env::args().skip(1).collect();
  assert_eq!(args.len(), 5);
  assert_eq!(&args[..2], &["secret", "set"]);
  assert_eq!(&args[3..], &["--repo", "alvinluo-tech/interview-assistant"]);
  let mut value = String::new(); io::stdin().read_to_string(&mut value).unwrap();
  match args[2].as_str() {
    "TAURI_SIGNING_PRIVATE_KEY" => assert_eq!(value, "synthetic-encrypted-private-key"),
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" => assert_eq!(value, "synthetic-test-password"),
    _ => panic!("Unexpected secret name"),
  }
  println!("accepted {} via stdin", args[2]);
}`);
  execFileSync('rustc', [path.join(root, 'fake-gh.rs'), '-o', cli], { windowsHide: true });
  writeFileSync(path.join(root, 'mianxu.key'), 'synthetic-encrypted-private-key');
  writeFileSync(path.join(root, 'mianxu.key.pub'), readFileSync('src-tauri/updater-public-key.txt'));
  const fixture = path.join(root, 'fixture.ps1');
  writeFileSync(fixture, `$ErrorActionPreference='Stop'
'synthetic-test-password' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'password.dpapi')
& $env:UPDATER_SECRET_SCRIPT -KeyDirectory $PSScriptRoot -GitHubCli (Join-Path $PSScriptRoot 'fake-gh.exe') -Apply
`);
  const result = spawnSync('pwsh', ['-NoProfile', '-File', fixture], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, UPDATER_SECRET_SCRIPT: path.resolve('scripts/configure-updater-secrets.ps1') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /accepted TAURI_SIGNING_PRIVATE_KEY via stdin/);
  assert.match(result.stdout, /accepted TAURI_SIGNING_PRIVATE_KEY_PASSWORD via stdin/);
  assert.ok(!result.stdout.includes('synthetic-test-password'));
});
