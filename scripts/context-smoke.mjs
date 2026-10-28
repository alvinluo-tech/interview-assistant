import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const identifier = 'com.mianlingai.clone.audiosmoke';
const executable = path.resolve('artifacts/audio-smoke.exe');
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), 'Use the isolated smoke binary');
const directory = path.join(process.env.APPDATA, identifier);
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const ocr = Array.isArray(body.messages?.at(-1)?.content);
  const text = ocr ? '扫描简历：负责 ScanResumeSentinel 支付平台。' : '[{"category":"resume_deep","probability":"high","question":"如何实现支付幂等？","answer":"使用唯一业务键。"}]';
  response.setHeader('Content-Type', 'text/event-stream');
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'data.json'), JSON.stringify({ goals: [{ id: 'audit-goal', name: '后端', description: 'JD_SENTINEL 必须具备支付幂等设计经验', createdAt: Date.now() }] }));
await writeFile(path.join(directory, 'store.json'), JSON.stringify({ 'notice.usageAcknowledged.v2': true, 'onboarding.skipped': true,
  'capture.excluded': false, 'ai.provider': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-context-test', chatModel: 'local-chat', visionModel: 'local-vision', sttModel: '', ttsModel: '' } }));
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19393' } });
const main = new DesktopCdp(19393);

function pdfFixture() {
  const content = 'BT /F1 14 Tf 40 700 Td (ActualResumeSentinel built payment idempotency with Redis and MySQL.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf).toString('base64');
}
async function upload(name, type, base64) {
  await main.evaluate(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], ${JSON.stringify(name)}, {type:${JSON.stringify(type)}}));
    const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
try {
  await main.connect(); await main.waitFor("document.body.innerText.includes('面试工作台')");
  await main.click('资料管理');
  await upload('synthetic-resume.pdf', 'application/pdf', pdfFixture());
  await main.waitFor("document.querySelector('[aria-label=文档正文]')?.value.includes('ActualResumeSentinel')");
  assert.equal(requests.length, 0, 'Text PDFs must remain local');
  await main.click('确认正文并保存'); await main.waitFor("document.body.innerText.includes('synthetic-resume') && !document.querySelector('[aria-label=文档正文]')");
  const saved = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
  assert.match(saved.resumes.find(resume => resume.title === 'synthetic-resume').content, /ActualResumeSentinel/);
  console.log('PASS PDF worker extracts real text locally and persists the reviewed body');
  const image = await main.evaluate(`(() => { const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=200; const c=canvas.getContext('2d'); c.fillStyle='white'; c.fillRect(0,0,600,200); c.fillStyle='black'; c.font='30px sans-serif'; c.fillText('ScanResumeSentinel',20,90); return canvas.toDataURL('image/png').split(',')[1]; })()`);
  await upload('synthetic-scan.png', 'image/png', image);
  await main.waitFor("document.body.innerText.includes('确认发送图片/扫描页并识别')");
  assert.equal(requests.length, 0, 'No image may be sent before consent');
  await main.click('确认发送图片/扫描页并识别');
  await main.waitFor("document.querySelector('[aria-label=文档正文]')?.value.includes('ScanResumeSentinel')");
  assert.equal(requests.length, 1);
  await main.click('取消');
  assert.ok(!JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8')).resumes.some(resume => resume.title === 'synthetic-scan'));
  console.log('PASS image OCR requires consent and cancellation does not save an incomplete resume');
  await main.click('面试题库'); await main.click('生成我的面试准备');
  await main.waitFor("document.body.innerText.includes('如何实现支付幂等')");
  const prompt = JSON.stringify(requests.at(-1).messages);
  assert.match(prompt, /JD_SENTINEL/); assert.match(prompt, /ActualResumeSentinel/);
  console.log('PASS question generation receives parsed resume text and the complete job description');
  await main.evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('如何实现支付幂等')).click()");
  await main.click('收藏');await main.waitFor("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='已收藏')");
  const bank=JSON.parse(await readFile(path.join(directory,'data.json'),'utf8')).questionBanks[0];
  assert.ok(bank.favorites.includes('如何实现支付幂等？'));
  await main.click('资料管理');await main.click('面试题库');
  await main.waitFor("document.body.innerText.includes('如何实现支付幂等')");
  console.log('PASS question bank and favorites persist beyond the page component lifetime');
  await writeFile('artifacts/context-smoke-results.json', JSON.stringify({ checks: 4, realPdfParser: true, explicitVisionConsent: true, fullJobContext: true,questionBankPersisted:true,favoritesPersisted:true }, null, 2));
} catch (error) {
  console.error(error);
  try { console.error(await main.evaluate('document.body.innerText')); } catch {}
  process.exitCode = 1;
} finally {
  await main.invoke('cmd_quit_app').catch(() => child.kill()); main.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await delay(100);
}
