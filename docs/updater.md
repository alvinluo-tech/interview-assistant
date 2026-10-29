# Signed desktop updates

The client uses the Tauri v2 native updater and the fixed public manifest:

`https://github.com/alvinluo-tech/interview-assistant/releases/latest/download/latest.json`

It no longer calls the anonymous GitHub REST releases API. This avoids sharing its 60 requests/hour/IP quota with other users of the same proxy. GitHub downloads can still fail because of network restrictions; errors remain visible and the official release page is always available.

## User experience

- Check eight seconds after the main window loads, then every six hours while visible. Manual checks have a 15-second native cooldown.
- The main window and Settings share one state. A newly discovered version prompts at most once per day; later versions get their own reminder.
- During an interview, exam, recording, mock interview, or connected phone session, the main window shows a badge. Automatic prompts wait until idle.
- Download shows progress, then verifies the file signature and the version authenticated by that signature. It never starts installation by itself.
- **Restart and install** is a separate user action. Native code checks activity again and excludes new audio, overlay, mock-window and phone starts while installing.
- Settings are flushed before handing control to the installer. Editable unsaved form content must be saved by the user first. A success notice requires the next launch's actual version to match the pending target.
- Downloads are held in memory until installation or process exit. This first implementation has no resumable downloads, background installation, or automatic rollback.

## Supported installations

| Installation | Behavior |
| --- | --- |
| Windows NSIS installation | Auto-install after the executable directory matches its uninstall registry entry and uninstaller |
| Windows portable EXE | Check updates and open the official page; manual replacement |
| Windows disguised copy | Restore the original program first, preserving disguise preferences; check again there |
| macOS installed `.app` | Signed `.app.tar.gz` updater; the app must be outside `/Volumes` and the updater must have filesystem access |
| macOS mounted DMG | Ask the user to copy to Applications first |
| Development build | Check only; use a release installation to test installation |

The updater's signature is independent of Apple Developer ID/notarization and Windows Authenticode. It does not replace those mechanisms. Existing v0.1.1 users must manually install the first updater-enabled version once.

## Signing material

`scripts/setup-updater-key.ps1` is a **one-time** generator. It refuses to overwrite existing material. Production keys have already been generated for this integration; do not rerun it to deploy.

Only `src-tauri/updater-public-key.txt` and the same public key in `tauri.conf.json` belong in Git. The encrypted private key and its password are stored outside the repository at `$HOME/.mianxu/updater-signing`. Windows ACLs limit access to the generating user; `password.dpapi` is protected with Windows DPAPI.

Back up the encrypted private key **and its password** in an approved password manager/offline secure backup. Copying `password.dpapi` alone is insufficient for recovery on another Windows account/machine. Keep the existing public/private pair for subsequent releases: replacing it breaks upgrades for installed clients unless a deliberate key migration is shipped first.

GitHub Actions needs these two repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the encrypted private-key file contents.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password that unlocks it.

After obtaining approval to modify repository secrets, run:

```powershell
pwsh -File scripts/configure-updater-secrets.ps1
# Preflight above changes nothing. Authenticate gh using your existing account.
pwsh -File scripts/configure-updater-secrets.ps1 -Apply
```

`-GitHubCli` can select an existing trusted CLI executable. The script sends values through stdin and never prints them or places them in CLI arguments. If either upload fails, fix the configuration before publishing. This task has not uploaded credentials automatically.

## Release process

Ordinary main/PR builds use `tauri.ci.conf.json`, generate test installers and do not receive signing secrets. Tag builds use `tauri.release.conf.json`, which enables `bundle.createUpdaterArtifacts`. The signing key is injected only into the release build step. Tag-derived versions remain the single version source.

1. Run the normal local verification, review the diff, commit, and obtain approval to push/tag.
2. Push a new `vX.Y.Z` tag. Existing public release assets must not be overwritten.
3. Windows x64, macOS arm64 and macOS x64 jobs build and test independently. pnpm and Rust dependency caches are reused.
4. Each job verifies its updater signature **and bound version** with `tools/update-verifier` using the same minisign verification library as Tauri. Missing signatures, modified payloads and version replays fail closed.
5. Once all three builds pass, the publisher checks SHA-256 files and independently rechecks all three signatures. It generates `latest.json` with `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64` entries pointing only to that repository/tag.
6. Installers, portable EXE, Mac archives, signatures, manifest and checksums are uploaded to a draft before it becomes public. A failure leaves the draft unpublished. Stable clients use GitHub's latest stable release; prerelease tags do not advance this channel.

`SHA256SUMS.txt` helps manual downloads; signatures authorize automatic installation. A checksum cannot substitute for a signature. No production signing key is available to the publishing job or PR code.

## Verification and rollout

```sh
pnpm test:updater
pnpm test:core-coverage
node --test tests/release.test.mjs tests/reliability.test.mjs
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --lib
```

For the synthetic browser flow, start an isolated Vite server on port 1438 with `MIANSHI_UI_SMOKE=1`, then run `node scripts/updater-ui-smoke.mjs`. It mounts the actual update components and uses a synthetic native bridge without personal settings, network downloads or OS installation.

Before broad rollout, perform an actual installed old-to-new upgrade on Windows and both Mac architectures, including disguise restoration, active sessions, download interruption, corrupt signatures, unwritable directories and installation failure. Local Windows builds and synthetic tests cannot establish macOS installation success.

If a release is bad, publish a higher fixed version; do not replace signed files under an existing public tag or advertise a lower version as a downgrade. Hosting can later move to a controlled HTTPS CDN through a shipped endpoint/allowlist change, retaining signature verification.

Local validation on Windows (2026-10-29): 130 JavaScript tests passed across the regression/protocol/coverage suites; 46 native workspace tests passed and one hardware audio test was intentionally ignored. The updater client controller has 100% line/branch/function coverage; the four-module core suite has 99.40% lines, 87.02% branches and 88.89% functions. These percentages do not describe whole-application or native coverage. Frontend production build, workflow lint, synthetic updater dialog flow, signing-secret preflight and npm production-dependency audit passed. No real OS upgrade or Mac runtime validation has been performed in this Windows session.
