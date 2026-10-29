import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { evaluateFixture } from './compile-fixture.mjs';
function load() {
  assert.ok(existsSync('src/lib/updatePresentation.ts'), 'A release-note and update-state presentation model is required');
  return evaluateFixture('src/lib/updatePresentation.ts', { exports: {}, Intl, Date });
}
const state = (phase, extra = {}) => ({ phase, downloaded: 0, busy: false, canInstall: true, ...extra });

test('release notes become bounded readable sections with safe text instead of raw Markdown', () => {
  const { releaseNotes } = load();
  const notes = releaseNotes('# Mianxu 0.1.3\n\nA useful update.\n\n## Improvements\n- **Clear** progress\n- [Release page](https://example.test)\n- `Settings` fixes\n- Fourth change\n\n```html\n<script>alert(1)</script>\n```');
  assert.equal(notes.summary, 'A useful update.');
  assert.deepEqual(Array.from(notes.highlights), ['Clear progress', 'Release page', 'Settings fixes']);
  assert.equal(notes.blocks[0].kind, 'heading');
  assert.ok(notes.blocks.some(block => block.kind === 'code' && block.text.includes('<script>')));
  assert.equal(releaseNotes('').blocks.length, 0);
  assert.ok(releaseNotes('x'.repeat(100_000)).blocks[0].text.length <= 32_000);
});

test('progress never invents a percentage when the content length is unknown', () => {
  const { downloadProgress, formatBytes } = load();
  assert.equal(downloadProgress(state('downloading', { downloaded: 12 })).percent, null);
  assert.equal(downloadProgress(state('downloading', { downloaded: 25, total: 100 })).percent, 25);
  assert.equal(downloadProgress(state('downloading', { downloaded: -5, total: NaN })).percent, null);
  assert.equal(downloadProgress(state('ready')).percent, 100);
  assert.equal(downloadProgress(state('verifying', { downloaded: 100, total: 100 })).percent, 100);
  assert.equal(downloadProgress(state('downloading', { downloaded: 110, total: 100 })).percent, 100);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(undefined), '—');
});

test('each state has one meaningful primary action and installation remains gated', () => {
  const { updatePresentation } = load();
  assert.equal(updatePresentation(state('available')).action, 'download');
  assert.equal(updatePresentation(state('ready')).action, 'install');
  assert.equal(updatePresentation(state('ready', { busy: true })).disabled, true);
  assert.equal(updatePresentation(state('downloading')).action, null);
  assert.equal(updatePresentation(state('installing')).action, null);
  assert.equal(updatePresentation(state('available', { canInstall: false })).action, 'release');
  assert.equal(updatePresentation(state('available', { canInstall: false, canRestoreOriginal: true })).action, 'restore');
  assert.equal(updatePresentation(state('upToDate')).action, 'check');
  assert.equal(updatePresentation(state('checking')).action, null);
  assert.equal(updatePresentation(state('verifying')).action, null);
  assert.equal(updatePresentation(state('error', { version: '0.1.3' })).action, 'download');
  assert.equal(updatePresentation(state('error')).action, 'check');
  assert.equal(updatePresentation(state('idle')).action, 'check');
});

test('dates and errors get readable summaries while retaining diagnostic detail', () => {
  const { releaseDate, updateFailure } = load();
  assert.match(releaseDate('2026-10-29T08:48:11Z'), /2026/);
  assert.match(releaseDate('2026-10-29 8:48:11.790 +00:00:00'), /2026/);
  assert.equal(releaseDate('not-a-date'), null);
  assert.equal(releaseDate(undefined), null);
  assert.match(updateFailure('签名验证失败').title, /验证/);
  assert.match(updateFailure('HTTP 403 connection timeout').title, /连接/);
  assert.equal(updateFailure('Unexpected failure').detail, 'Unexpected failure');
  assert.ok(updateFailure(undefined).description);
});
