import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const executable = path.resolve('artifacts/byok-smoke.exe');
const identifier = 'com.mianlingai.clone.byoksmoke';
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), 'Use the isolated BYOK smoke binary');
const directory = path.join(process.env.APPDATA, identifier);
const credential = 'byok-local-test-credential';
const calls = [];
const results = [];
const cdp = new DesktopCdp(19389);
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  calls.push({ path: req.url, authorization: req.headers.authorization, body });
  res.setHeader('Content-Type', 'application/json');
  // Intentionally no CORS headers: the native desktop transport must handle it.
  if (req.url.startsWith('/unavailable/')) { res.writeHead(404); res.end(JSON.stringify({ error: { message: 'Models endpoint is not supported' } })); return; }
  if (req.url.startsWith('/denied/')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: `Invalid key ${credential}` } })); return; }
  if (req.url.startsWith('/slow/')) { setTimeout(() => res.end(JSON.stringify({ data: [{ id: 'wrong-stale-result' }] })), 1000); return; }
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: 'chat/echo' }, { id: 'vision/model' }, { id: 'speech/transcribe' }, { id: 'speech/tts' }, { id: 'chat/echo' }] })); return;
  }
  if (req.url.endsWith('/chat/completions')) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"连接"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"正常"}}]}\n\ndata: [DONE]\n\n'), 30); return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'store.json'), JSON.stringify({
  'notice.usageAcknowledged.v2': true, 'onboarding.skipped': true, 'capture.excluded': false,
  'ai.provider': { baseUrl, apiKey: credential, chatModel: 'legacy/chat', visionModel: '', sttModel: '', ttsModel: '' },
}));
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19389' } });
async function check(name, work) { await work(); results.push(name); console.log(`PASS ${name}`); }
async function openAi() { await cdp.click('设置'); await cdp.click('AI 服务'); await cdp.waitFor("!!document.querySelector('[data-testid=ai-services]')"); }
try {
  await cdp.connect(); await openAi();
  await check('legacy configuration migrates and credentials are encrypted on disk', async () => {
    const value = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(value.providers[0].apiKey, credential);
    assert.equal(value.routes.chat.modelId, 'legacy/chat');
    const disk = await readFile(path.join(directory, 'store.json'), 'utf8');
    assert.ok(!disk.includes(credential));
    assert.ok(!Object.hasOwn(JSON.parse(disk), 'ai.provider'));
  });
  await check('native model discovery works without CORS and deduplicates IDs', async () => {
    await cdp.click('连接并获取模型');
    await cdp.waitFor("document.body.innerText.includes('已从接口获取 4 个模型')");
    assert.equal(calls.find(c => c.path === '/v1/models').authorization, `Bearer ${credential}`);
  });
  await check('custom model can be added, searched and assigned to a purpose', async () => {
    await cdp.input('[aria-label="自定义模型 ID"]', 'private/my-model');
    await cdp.input('[aria-label="自定义模型显示名称"]', '我的私有模型');
    await cdp.click('添加模型');
    await cdp.input('[aria-label="搜索模型"]', '私有');
    assert.ok((await cdp.evaluate('document.body.innerText')).includes('private/my-model'));
    const providers = await cdp.invoke('cmd_ai_load_settings');
    await cdp.select('#ai-route-chat', JSON.stringify({ providerId: providers.providers[0].id, modelId: 'private/my-model' }));
    await cdp.click('保存配置');
    const config = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(config.routes.chat.modelId, 'private/my-model');
    assert.ok(config.providers[0].models.some(m => m.id === 'private/my-model' && m.source === 'custom'));
  });
  await check('model test consumes a real SSE response and displays measured latency', async () => {
    await cdp.click('测试对话');
    await cdp.waitFor("document.body.innerText.includes('对话测试通过')");
    assert.equal(calls.find(c => c.body?.model === 'private/my-model').body.stream, true);
  });
  await check('refresh preserves custom IDs and saved selected models', async () => {
    await cdp.click('连接并获取模型');
    await cdp.waitFor("document.body.innerText.includes('已从接口获取 4 个模型')");
    await cdp.click('保存配置');
    const config = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(config.routes.chat.modelId, 'private/my-model');
    assert.ok(config.providers[0].models.some(m => m.id === 'legacy/chat'));
  });
  await check('model list survives reload and key stays encrypted after save', async () => {
    await cdp.waitFor("document.body.innerText.includes('配置已同步')");
    await cdp.evaluate("location.reload(); 'scheduled'"); await delay(1000); await openAi();
    const config = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(config.routes.chat.modelId, 'private/my-model');
    assert.equal(await cdp.evaluate("document.querySelector('#ai-api-key').type"), 'password');
    assert.ok(!(await readFile(path.join(directory, 'store.json'), 'utf8')).includes(credential));
  });
  await check('models endpoint failure keeps manual model entry usable', async () => {
    await cdp.input('#ai-base-url', baseUrl.replace('/v1', '/unavailable'));
    await cdp.click('连接并获取模型');
    await cdp.waitFor("document.body.innerText.includes('HTTP 404')");
    assert.equal(await cdp.evaluate("document.querySelector('[aria-label=\"自定义模型 ID\"]').disabled"), false);
    await cdp.click('撤销更改');
  });
  await check('unsaved settings require an explicit discard when changing tabs', async () => {
    await cdp.input('#ai-provider-name', 'Unsaved name');
    await cdp.click('通用');
    await cdp.waitFor("document.body.innerText.includes('放弃未保存的 AI 配置')");
    await cdp.click('取消');
    assert.equal(await cdp.evaluate("document.querySelector('#ai-provider-name').value"), 'Unsaved name');
    await cdp.click('撤销更改');
  });
  await check('authentication errors explain the failure without exposing the key', async () => {
    await cdp.input('#ai-base-url', baseUrl.replace('/v1', '/denied'));
    await cdp.click('连接并获取模型');
    await cdp.waitFor("document.body.innerText.includes('HTTP 401')");
    assert.ok(!(await cdp.evaluate('document.body.innerText')).includes(credential));
    await cdp.click('撤销更改');
  });
  await check('editing a connection cancels stale discovery results', async () => {
    await cdp.input('#ai-base-url', baseUrl.replace('/v1', '/slow'));
    await cdp.click('连接并获取模型');
    await cdp.input('#ai-base-url', baseUrl);
    await delay(1200);
    assert.ok(!(await cdp.evaluate('document.body.innerText')).includes('wrong-stale-result'));
    await cdp.click('撤销更改');
  });
  await check('a second no-key provider can independently serve both speech roles', async () => {
    await cdp.select('#ai-preset', 'ollama');
    await cdp.click('添加连接');
    await cdp.input('#ai-base-url', baseUrl);
    await cdp.click('连接并获取模型');
    await cdp.waitFor("document.body.innerText.includes('已从接口获取 4 个模型')");
    assert.equal(calls.filter(c => c.path === '/v1/models').at(-1).authorization, undefined);
    for (const [role, model] of [['stt', 'speech/transcribe'], ['tts', 'speech/tts']]) {
      const value = await cdp.evaluate(`Array.from(document.querySelector('#ai-route-${role}').options).find(o => o.textContent.includes('本地 Ollama') && o.value.includes(${JSON.stringify(model)})).value`);
      await cdp.select(`#ai-route-${role}`, value);
    }
    await cdp.click('保存配置');
    await cdp.waitFor("document.body.innerText.includes('配置已同步')");
    const config = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(config.providers.length, 2);
    const local = config.providers.find(p => p.name === '本地 Ollama');
    assert.equal(local.authMode, 'none');
    assert.equal(config.routes.stt.providerId, local.id);
    assert.equal(config.routes.tts.providerId, local.id);
    assert.notEqual(config.routes.chat.providerId, local.id);
  });
  const screenshot = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile('artifacts/byok-settings.png', Buffer.from(screenshot.data, 'base64'));
  await cdp.evaluate("document.querySelector('#ai-route-chat').scrollIntoView({block:'center'});");
  const routesScreenshot = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile('artifacts/byok-routes.png', Buffer.from(routesScreenshot.data, 'base64'));
  await check('deleting a provider clears dependent assignments and keeps other routes', async () => {
    await cdp.evaluate("document.querySelector('[aria-label=\"删除当前连接\"]').click()");
    await cdp.click('删除连接');
    await cdp.click('保存配置');
    const config = await cdp.invoke('cmd_ai_load_settings');
    assert.equal(config.providers.length, 1);
    assert.equal(config.routes.stt, null);
    assert.equal(config.routes.tts, null);
    assert.equal(config.routes.chat.modelId, 'private/my-model');
  });
  await check('recognition-only models disable text tests and explain actual audio verification', async () => {
    for (const model of ['fun-asr', 'fun-asr-flash-2026-06-15', 'fun-asr-realtime']) {
      await cdp.input('[aria-label="自定义模型 ID"]', model);
      await cdp.click('添加模型');
    }
    await cdp.input('[aria-label="搜索模型"]', 'fun');
    const before = calls.length;
    const controls = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).filter(button=>button.textContent.trim()==='语音专用').map(button=>({disabled:button.disabled,title:button.title}))`);
    assert.equal(controls.length, 3);assert.ok(controls.every(button=>button.disabled && button.title));
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).filter(button=>button.textContent.trim()==='语音专用').forEach(button=>button.click())`);
    await delay(100);assert.equal(calls.length, before, 'Disabled speech-model controls must not issue requests');
    assert.ok((await cdp.evaluate('document.body.innerText')).includes('「测试麦克风」仅检查本地音量'));
    await cdp.input('[aria-label="搜索模型"]', '');
    assert.ok(await cdp.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='测试对话'&&!button.disabled)`));
  });
  await check('a saved unsupported Bailian file model can be repaired to realtime without changing its credential', async () => {
    await cdp.click('撤销更改');
    const config=await cdp.invoke('cmd_ai_load_settings');
    const connection=config.providers[0];
    connection.baseUrl='https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    for(const id of ['fun-asr','fun-asr-realtime'])if(!connection.models.some(model=>model.id===id))connection.models.push({id,name:id,source:'custom'});
    config.routes.stt={providerId:connection.id,modelId:'fun-asr'};config.speechInputMode='auto';
    await cdp.invoke('cmd_ai_save_settings',{config});
    await cdp.waitFor("!!document.querySelector('[data-testid=unsupported-speech-model]')");
    assert.ok(await cdp.evaluate(`Array.from(document.querySelector('#ai-route-stt').options).find(option=>option.value.includes('"modelId":"fun-asr"')).disabled`));
    const before=calls.length;
    await cdp.click('改用当前连接的实时识别');
    assert.equal(await cdp.evaluate("document.querySelector('#ai-speech-mode').value"),'realtime');
    await cdp.click('保存配置');
    await cdp.waitFor("document.body.innerText.includes('配置已同步')&&!document.querySelector('[data-testid=unsupported-speech-model]')");
    const repaired=await cdp.invoke('cmd_ai_load_settings');
    assert.equal(repaired.routes.stt.modelId,'fun-asr-realtime');assert.equal(repaired.speechInputMode,'realtime');
    assert.equal(repaired.providers[0].apiKey,connection.apiKey);assert.equal(repaired.providers[0].baseUrl,connection.baseUrl);
    assert.equal(calls.length,before,'Changing the draft and saving must not invoke the cloud service');
  });
  await writeFile('artifacts/byok-smoke-result.json', JSON.stringify({ passed: results.length, results, identifier }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} catch (error) {
  try { await cdp.invoke('plugin:http|fetch', { clientConfig: { method: 'GET', url: `${baseUrl}/models`, headers: [] } }); } catch (diagnostic) { console.error('Native transport diagnostic:', diagnostic.message); }
  const body = await cdp.evaluate('document.body.innerText').catch(() => 'unavailable');
  console.error(body.slice(-4500));
  throw error;
} finally {
  try { await cdp.evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('cmd_exit_app'), 20); 'scheduled'"); } catch { /* Already exited. */ }
  cdp.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await delay(500);
  if (child.exitCode === null) child.kill();
}
