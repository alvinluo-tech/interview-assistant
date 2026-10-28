# Project Guidelines — interview-assistant

Agent memory for this repository. These rules apply to every commit, push, and release made in this project, by any person or agent.

## Git & Pushes

- **All commit messages, PR titles, and release notes MUST be written in English.** No Chinese (or other languages) in commit subjects or bodies, even though the product's display name is Chinese.
- Follow **Conventional Commits**: `type: subject` with types `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.
  - Subject: imperative mood, no trailing period, ≤ 72 characters.
  - Example: `chore: initial commit v0.1.0`, `feat(mock): persist review report to session`.
- Commits and pushes go to `https://github.com/alvinluo-tech/interview-assistant` on branch `main`.

## Versioning & Releases

- App version currently `0.1.0`; the project versions from scratch (never follow the older 0.3.x lineage).
- Releases are tag-driven: a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which syncs the version across `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `Cargo.lock` (`scripts/release.mjs`). Do not bump versions by hand.

## Never Commit

- Local machine paths (e.g. `D:\...`, `E:\code\...`, `C:\Users\...`) — see `.gitignore` for the excluded list (`_recon/`, `analysis_mianling/`, artifacts, generated schemas).
- Secrets, API keys, or `store.json` / `data.json` user data.

## Verification Before Push

- `pnpm build` (tsc + vite) must pass.
- If release/packaging logic changed: `node --test tests/release.test.mjs tests/reliability.test.mjs`.
