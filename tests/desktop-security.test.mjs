import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const security=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')).app.security;
test('production CSP restricts executable resources while supporting document and audio assets',()=>{
  const csp=security.csp;assert.ok(csp&&typeof csp==='object','Production CSP must be configured');
  assert.match(String(csp['default-src']),/'self'/);assert.equal(csp['object-src'],"'none'");assert.equal(csp['base-uri'],"'none'");
  assert.doesNotMatch(String(csp['script-src']),/'unsafe-inline'|'unsafe-eval'|https?:|\*/);
  assert.match(String(csp['script-src']),/'wasm-unsafe-eval'/);assert.match(String(csp['worker-src']),/blob:/);assert.match(String(csp['media-src']),/blob:/);
  assert.match(String(csp['connect-src']),/ipc:/);assert.doesNotMatch(String(csp['connect-src']),/\*|https?:\s|wss?:\s/);
});
