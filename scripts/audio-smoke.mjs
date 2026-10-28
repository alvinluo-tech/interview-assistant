import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const identifier = 'com.mianlingai.clone.audiosmoke';
const executable = path.resolve('artifacts/audio-smoke.exe');
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), 'Use an isolated audio smoke binary');
const directory = path.join(process.env.APPDATA, identifier);
const main = new DesktopCdp(19391);
const overlay = new DesktopCdp(19391, 'overlay');
const requests = [];
let failTranscription = false;
let markMock = false;
const results = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  requests.push({ path: req.url, body });
  if (req.url === '/v1/chat/completions') {
    const payload = JSON.parse(body.toString());
    if (payload.model === 'mimo-v2.5-asr') {
      assert.equal(payload.stream, true);
      assert.ok(payload.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"这是实时"}}]}\n\n');
      await delay(350);
      res.end('data: {"choices":[{"delta":{"content":"识别的完整问题"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"这是本机"}}]}\n\n');
    await delay(900);
    res.end('data: {"choices":[{"delta":{"content":"测试参考回答"}}]}\n\ndata: [DONE]\n\n');
    return;
  }
  if (req.url === '/v1/audio/transcriptions') {
    if (markMock) res.setHeader('X-Mianshi-Test-Service', 'mock-ai');
    res.setHeader('Content-Type', 'application/json');
    await delay(700);
    if (failTranscription) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Test speech authentication rejected' } })); }
    else res.end(JSON.stringify({ text: '请介绍一下你的项目经历' }));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'data.json'), '{}');
await writeFile(path.join(directory, 'store.json'), JSON.stringify({
  'notice.usageAcknowledged.v2': true, 'onboarding.skipped': true, 'capture.excluded': false,
  'interview.autoAnswer': false, 'interview.silenceGateMs': 300,
  'ai.provider': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-audio-test', chatModel: 'local-chat', sttModel: 'local-stt', visionModel: '', ttsModel: '' },
}));
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19391 --autoplay-policy=no-user-gesture-required' } });

// Synthetic WebAudio input exercises the real WebView audio callback and desktop HTTP.
// Physical microphones and real AI accounts are never used.
const installAudio = `(() => {
  window.__testCaptures = [];
  window.__denyMic = false;
  navigator.mediaDevices.enumerateDevices = async () => [{kind:'audioinput',deviceId:'mic-a',label:'测试麦克风 A'}, {kind:'audioinput',deviceId:'mic-b',label:'测试麦克风 B'}];
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (window.__denyMic) throw new DOMException('Permission denied', 'NotAllowedError');
    const context = new AudioContext({sampleRate: 48000});
    const oscillator = context.createOscillator(); oscillator.frequency.value = 220;
    const gain = context.createGain(); gain.gain.value = 0.2;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
    const stream = destination.stream; const track = stream.getAudioTracks()[0];
    Object.defineProperty(track, 'label', {value: constraints.audio?.deviceId?.exact === 'mic-b' ? '测试麦克风 B' : '测试麦克风 A'});
    const stop = track.stop.bind(track); track.stop = () => { stop(); void context.close(); };
    window.__testCaptures.push({gain, stream, constraints}); return stream;
  };
})()`;
async function check(name, work) { await work(); results.push(name); console.log(`PASS ${name}`); }
async function setTone(value) { await overlay.evaluate(`window.__testCaptures.at(-1).gain.gain.value = ${value}`); }
async function start() {
  await main.click('开始面试');
  await overlay.waitFor("!!window.__ml_engine && !!document.querySelector('[data-testid=audio-input-feedback]')");
}
async function interactive() {
  await overlay.evaluate(`document.querySelector('button[title="悬停或点击切到窗口模式"]')?.click()`);
  await delay(150);
}
async function voiceAsk(label = '语音提问') {
  await overlay.evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}) && !b.disabled).click()`);
  await delay(100);
}
async function end() {
  await interactive();
  await overlay.evaluate(`document.querySelector('button[title="结束面试"]').click()`);
  await main.waitFor("!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '开始面试')?.disabled");
  await overlay.waitFor("window.__ml_engine().status === 'ended'");
}
try {
  await main.connect(); await overlay.connect();
  await main.waitFor("document.body.innerText.includes('面试工作台')");
  await main.evaluate(installAudio); await overlay.evaluate(installAudio);
  await main.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('实时听译 · 自动答题')).click()");
  await main.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('线上面试')).click()");
  await check('real Windows playback reaches the online interview as undistorted mono 16k WAV', async () => {
    await start();
    await overlay.waitFor("window.__ml_engine().status === 'listening'");
    assert.ok(await overlay.evaluate('!!window.__ml_engine().audio.deviceLabel'));
    const before = requests.length;
    await main.evaluate(`(async () => {
      const context = new AudioContext({sampleRate:48000}); await context.resume();
      const tone = context.createOscillator(); tone.frequency.value = 440;
      const gain = context.createGain(); gain.gain.value = 0.1;
      tone.connect(gain).connect(context.destination); tone.start();
      await new Promise(resolve => setTimeout(resolve, 1200));
      tone.stop(); await context.close();
    })()`);
    await interactive(); await overlay.click('立即转写');
    await overlay.waitFor("window.__ml_engine().messages.some(m => m.role === 'INTERVIEWER')");
    const candidates = requests.slice(before).filter(request => request.path === '/v1/audio/transcriptions');
    const hasTone = candidates.some(request => {
      const offset = request.body.indexOf(Buffer.from('RIFF'));
      if (offset < 0) return false;
      const wav = request.body.subarray(offset);
      assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
      const length = wav.readUInt32LE(40) / 2;
      const power = frequency => {
        let real = 0, imaginary = 0;
        for (let i = 0; i < length; i++) {
          const sample = wav.readInt16LE(44 + i * 2); const angle = i * frequency * Math.PI * 2 / 16000;
          real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle);
        }
        return real * real + imaginary * imaginary;
      };
      return length >= 10000 && length <= 16000 * 4 && power(440) > Math.max(1e6, power(440 / 9) * 20);
    });
    assert.ok(hasTone, 'ASR must receive the original 440Hz tone, not slowed-down or duplicated playback');
    await overlay.click('暂停'); await overlay.waitFor("window.__ml_engine().status === 'paused'");
    await overlay.click('继续'); await overlay.waitFor("window.__ml_engine().status === 'listening'");
    await end();
    // Subsequent microphone checks count only their own requests.
    requests.length = 0;
  });
  await main.evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('模拟练习')).click()");
  await main.waitFor("!!document.querySelector('[data-testid=microphone-check]')");
  await check('workbench offers device selection and a local volume test', async () => {
    await main.select('[aria-label="录音麦克风"]', 'mic-b');
    await main.click('测试麦克风');
    await main.waitFor("Number(document.querySelector('[role=meter]').getAttribute('aria-valuenow')) > 0");
    assert.equal(requests.length, 0);
    await main.click('停止检测');
    await main.waitFor("window.__testCaptures.at(-1).stream.getTracks().every(t => t.readyState === 'ended')");
  });
  await check('overlay uses the selected microphone and displays real audio levels', async () => {
    await start();
    await overlay.waitFor("window.__ml_engine().status === 'listening'");
    await overlay.waitFor("window.__ml_engine().audio.level > 0");
    assert.ok((await overlay.evaluate('document.body.innerText')).includes('测试麦克风 B'));
    assert.equal(await overlay.evaluate('window.__testCaptures.length'), 1, 'StrictMode must not open duplicate capture');
    const screenshot = await overlay.command('Page.captureScreenshot', { format: 'png' });
    await writeFile('artifacts/audio-overlay.png', Buffer.from(screenshot.data, 'base64'));
  });
  await check('silence submits a mono 16k WAV, shows transcription progress and renders text', async () => {
    await delay(300); await setTone(0);
    await overlay.waitFor("document.body.innerText.includes('正在转写')");
    await overlay.waitFor("document.body.innerText.includes('请介绍一下你的项目经历')");
    assert.equal(requests[0].path, '/v1/audio/transcriptions');
    const index = requests[0].body.indexOf(Buffer.from('RIFF'));
    assert.ok(index >= 0); assert.equal(requests[0].body.readUInt32LE(index + 24), 16000);
    assert.equal(requests[0].body.readUInt16LE(index + 22), 1);
    assert.ok(requests[0].body.includes(Buffer.from('local-stt')));
  });
  await check('pause releases unfinished input and resume can capture another utterance', async () => {
    await interactive(); await overlay.click('暂停');
    await overlay.waitFor("window.__ml_engine().status === 'paused'");
    assert.equal(await overlay.evaluate('window.__testCaptures.at(-1).stream.getTracks()[0].enabled'), false);
    await overlay.click('继续');
    await overlay.waitFor("window.__ml_engine().status === 'listening' && window.__ml_engine().audio.level > 0");
    const before = await overlay.evaluate('window.__ml_engine().messages.length');
    await delay(200); await overlay.click('立即转写');
    await overlay.waitFor(`window.__ml_engine().messages.length > ${before}`);
    await setTone(0);
  });
  await check('manual voice ask pauses automatic capture, shows volume and generates an answer', async () => {
    await voiceAsk();
    await overlay.waitFor("document.body.innerText.includes('结束并提问')");
    assert.equal(await overlay.evaluate('window.__ml_engine().status'), 'paused');
    await overlay.waitFor("Number(document.querySelector('[aria-label=语音提问音量]').getAttribute('aria-valuenow')) > 0");
    await delay(600); await voiceAsk('结束并提问');
    await overlay.waitFor("document.body.innerText.includes('这是本机测试参考回答')");
    assert.equal(await overlay.evaluate('window.__ml_engine().status'), 'listening');
    await end();
    assert.equal(await overlay.evaluate('window.__testCaptures.at(-1).stream.getTracks()[0].readyState'), 'ended');
  });
  await check('denied permission is visible on an empty chat and retry recovers', async () => {
    await overlay.evaluate('window.__denyMic = true');
    await start(); await overlay.waitFor("window.__ml_engine().status === 'error'");
    assert.match(await overlay.evaluate("document.querySelector('[role=alert]').textContent"), /麦克风权限被拒绝/);
    await overlay.evaluate('window.__denyMic = false');
    await interactive(); await overlay.click('重试收音');
    await overlay.waitFor("window.__ml_engine().status === 'listening' && window.__ml_engine().audio.level > 0");
    await end();
  });
  await check('manual voice ask reports permission failure without leaving recording active', async () => {
    await start(); await overlay.waitFor("window.__ml_engine().status === 'listening'");
    await overlay.evaluate('window.__denyMic = true');
    await interactive(); await voiceAsk();
    await overlay.waitFor("Array.from(document.querySelectorAll('[role=alert]')).some(el => el.textContent.includes('麦克风权限被拒绝'))");
    assert.ok(!(await overlay.evaluate('document.body.innerText')).includes('结束并提问'));
    await overlay.evaluate('window.__denyMic = false');
    await end();
  });
  await check('ASR service failure is visible before the first transcript', async () => {
    failTranscription = true;
    await start(); await overlay.waitFor("window.__ml_engine().audio.level > 0");
    await delay(250); await setTone(0);
    await overlay.waitFor("document.querySelector('[role=alert]')?.textContent.includes('401')");
    assert.equal(await overlay.evaluate('window.__ml_engine().messages.length'), 0);
    await end();
  });
  await check('marked fixture responses are rejected before creating any interview question', async () => {
    failTranscription = false; markMock = true;
    await start(); await overlay.waitFor("window.__ml_engine().audio.level > 0");
    await delay(350); await setTone(0);
    await overlay.waitFor("document.querySelector('[role=alert]')?.textContent.includes('本地测试服务')");
    assert.equal(await overlay.evaluate('window.__ml_engine().messages.length'), 0);
    await end();
  });
  await check('MiMo auto mode displays streamed subtitles before any pause or AI request', async () => {
    markMock = false;
    const config = await main.invoke('cmd_ai_load_settings');
    config.providers[0].models.push({ id: 'mimo-v2.5-asr', name: 'MiMo ASR', source: 'custom' });
    config.routes.stt.modelId = 'mimo-v2.5-asr';
    config.speechInputMode = 'auto';
    await main.invoke('cmd_ai_save_settings', { config });
    await main.waitFor("document.querySelector('[data-testid=speech-mode-summary]')?.textContent.includes('分段实时字幕')");
    await main.evaluate("document.querySelector('button[role=switch][aria-checked=false]')?.click()");
    await start();
    await overlay.waitFor("window.__ml_engine().audio.recognitionMode === 'segmented'");
    await overlay.waitFor("document.querySelector('[data-testid=live-transcript]')?.textContent.includes('这是实时')");
    assert.equal(await overlay.evaluate('window.__ml_engine().messages.length'), 0);
    assert.equal(await overlay.evaluate('window.__ml_engine().turns.length'), 0);
    const screenshot = await overlay.command('Page.captureScreenshot', { format: 'png' });
    await writeFile('artifacts/live-subtitles.png', Buffer.from(screenshot.data, 'base64'));
  });
  await check('pausing speech finalizes one question and renders the AI answer incrementally', async () => {
    await setTone(0);
    await overlay.waitFor("window.__ml_engine().messages.some(m => m.role === 'INTERVIEWER' && m.text.includes('识别的完整问题'))");
    await overlay.waitFor("window.__ml_engine().messages.some(m => m.role === 'ASSISTANT' && m.pending && m.text === '这是本机')");
    await overlay.waitFor("window.__ml_engine().messages.some(m => m.role === 'ASSISTANT' && !m.pending && m.text === '这是本机测试参考回答')");
    assert.equal(await overlay.evaluate("window.__ml_engine().messages.filter(m => m.role === 'INTERVIEWER').length"), 1);
    assert.equal(await overlay.evaluate('window.__ml_engine().liveTranscripts.length'), 0);
    await end();
  });
  assert.deepEqual(await main.evaluate("window.__errors.filter(e => !e.includes('HotKey already registered'))"), []);
  assert.deepEqual(await overlay.evaluate('window.__errors'), []);
  await writeFile('artifacts/audio-smoke-results.json', JSON.stringify({ results, requests: requests.map(r => ({path:r.path,bytes:r.body.length})) }, null, 2));
  console.log(`${results.length} desktop audio checks passed`);
} catch (error) {
  console.error(error);
  for (const [name, cdp] of [['main', main], ['overlay', overlay]]) {
    try { console.error(name, await cdp.evaluate('({text:document.body.innerText, errors:window.__errors, state:window.__ml_engine?.()})')); } catch {}
  }
  process.exitCode = 1;
} finally {
  await main.invoke('cmd_quit_app').catch(() => child.kill());
  main.close(); overlay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
