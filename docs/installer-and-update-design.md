# Update and installer presentation

The in-app update card and Windows installer share the existing Mianxu blue/white identity. The application identifier, product name, executable name, registry identity and signing public key remain unchanged so existing installations remain recognizable.

## In-app experience

- A dedicated accessible dialog replaces the general-purpose modal. Its focus stays inside while open and returns to the original control when dismissed. Escape/backdrop dismissal is disabled during installation.
- Version changes, localized publication dates, release highlights and the current action have separate visual levels. Long notes and diagnostic errors are collapsed by default.
- Release notes support headings, bullet lists, paragraphs and fenced code as escaped text. Remote HTML and embedded images are not interpreted or loaded. This is intentionally a small text presentation format, not a complete Markdown renderer.
- One primary action is derived from the native update state. Download still never installs automatically; native installation consent and busy-state checks remain authoritative.
- Unknown file sizes produce indeterminate progress. The UI never fabricates percentages or transfer speeds. Progress comes from the native downloaded/total byte counters.
- Manual inspection remains available during an active session, while automatic prompts wait. Installation and restoration actions remain disabled while busy.
- Light/dark themes, narrow windows, keyboard navigation and reduced-motion preferences are supported. No external fonts or new runtime packages are required.

## Windows installer and uninstaller

The project extends the maintained Tauri NSIS template with `windows/installer-hooks.nsh`, rather than maintaining a copy of its installation implementation.

- Current-user installation is explicit. Chinese and English are included; NSIS chooses the OS language, with Simplified Chinese as the first fallback.
- Welcome, finish and uninstall confirmation text use concise bilingual copy. The uninstall text distinguishes program removal from optional application-data deletion.
- Installer and uninstaller use existing application icons and dedicated 24-bit BMP header/sidebar artwork. Source generation lives in `scripts/make-installer-branding.ps1`.
- Passive automatic updates use a 560×340 logical-pixel native card: a blue/lavender brand hero above a white pane with installation status, the actual package version and the original NSIS progress control. The artwork is rendered at 2× resolution and scales with the window DPI. Windows 11 also colors the native caption; older systems retain their normal caption. Extraction counters and disabled wizard navigation are hidden. Interactive installation keeps the full wizard.
- Older versions cannot directly overwrite newer installations (`allowDowngrades: false`). The upstream interactive installer can still offer uninstall-first handling; this setting is not a blanket ban on deliberately installing an older version after uninstalling.
- Existing native update signatures, main-window permissions, installation-location checks, and the updater's guardian exit hook are retained.

This change does not add a new lifecycle coordinator for manually invoked installers/uninstallers. Disguised copies and guardian shutdown during those manual operations still need dedicated implementation and acceptance testing. A custom native title bar, disk-persistent download cache, resumable downloads and rollback are outside this presentation change.

## Verification

```sh
node scripts/test-update-design.mjs
pnpm test:updater
node --test tests/release.test.mjs tests/reliability.test.mjs
pnpm build
```

On Windows, `node scripts/installer-branding-smoke.mjs` creates an isolated project under `artifacts/`, compiles an inert Rust executable and builds the actual NSIS installer/uninstaller skin. It never launches or installs the fixture and requires no production signing credentials. Both desktop workflows run this compile check before the main installer build.

`node scripts/native-update-preview.mjs` (or `--english`) builds a separately labeled, no-op native preview using the same `windows/update-card.nsh` include as production. It does not launch automatically. The preview only extracts artwork into NSIS's temporary plugin directory, waits briefly and closes. It writes no application files, installation registrations, shortcuts or uninstaller. Its version label and footer explicitly identify it as a UI preview. It is suitable for visual review without installing another fixture. The preview does not replace end-to-end acceptance of a signed production upgrade.

The native card iteration passed 21 presentation/release/reliability tests and production NSIS compilation. Chinese and English native previews were inspected with the same PerMonitorV2 DPI manifest as the maintained installer. No signed production upgrade was executed for this visual iteration.

For the browser flow, use the existing isolated Vite server on port 1438 with `MIANSHI_UI_SMOKE=1`, then run `node scripts/updater-ui-smoke.mjs`. Synthetic snapshots cover download consent, busy installation gates, focus trapping/restoration, narrow layout, dark theme, reduced motion, safe release-note display, failure details and portable-install fallback. Screenshots explicitly identify the preview as test data.

Local validation: the presentation module reached 100% line/function and 92.68% branch coverage. Production frontend builds, release tooling tests, workflow lint, dependency audit, the synthetic browser flow and isolated NSIS compilation passed. Actual native welcome, directory and passive progress pages were inspected. The desktop-control tool blocked launching the test uninstaller, so its confirmation page has compile validation only, not interactive acceptance.

A one-off native preview installation named **Mianxu Installer Preview** was used for visual inspection. Automatic security review blocked removing that isolated fixture (the tool returned `blocked by policy` without a more specific reason). If the entry remains in Windows Installed apps, remove that preview manually. It is separate from the production application.
