/**
 * 本地模拟 AI 服务（OpenAI 兼容）：用于端到端验证流式作答、截屏解题、语音转写。
 * - POST /v1/chat/completions  → SSE 流式回答（按场景返回不同内容）
 * - POST /v1/audio/transcriptions → 固定转写文本
 * - POST /v1/audio/speech → 极简静音 wav（模拟 TTS）
 * 仅开发夹具：node tests/fixtures/mock-ai.mjs 8787 --allow-fixtures
 * 桌面客户端会拒绝带测试标记的响应，禁止用于日常 AI 配置。
 */
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);
const allowFixtures = process.argv.includes('--allow-fixtures');

const EXAM_ANSWER = `**思路**：这是两数之和，用哈希表一次遍历即可。

\`\`\`python
def two_sum(nums, target):
    seen = {}
    for i, v in enumerate(nums):
        if target - v in seen:
            return [seen[target - v], i]
        seen[v] = i
    return []
\`\`\`

- 时间复杂度 O(n)，空间复杂度 O(n)
- 注意：先查表再写入，避免同一个元素用两次
- 边界：空数组返回空列表

答案：B`;

const INTERVIEW_ANSWER = `我之前在实习时负责过订单服务的稳定性治理，主要做了三件事。

第一是把下单链路的超时和重试策略重新梳理了一遍，把非幂等接口的重试去掉，改成服务端幂等键加去重表。

第二是给库存扣减加了 Redis 预扣加消息队列削峰，压测下超卖率从千分之三降到零。

第三是补了链路监控，把下单成功率、耗时 P99 打到看板上，出问题能在 5 分钟内定位。

这个项目让我对高并发下的一致性有了比较实际的理解。`;

function sse(res, chunks, delayMs = 30) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= chunks.length) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const payload = { choices: [{ delta: { content: chunks[i] } }] };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    i++;
  }, delayMs);
  res.on('close', () => clearInterval(timer));
}

function splitChunks(text, size = 6) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  // CORS：浏览器/webview 直接调用必需
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Mianshi-Test-Service');
  res.setHeader('X-Mianshi-Test-Service', 'mock-ai');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url === '/__mianshi_test__/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'mock-ai', realTranscription: false, fixturesEnabled: allowFixtures }));
    return;
  }
  if (!allowFixtures) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '这是开发测试服务，不支持真实语音识别。开发夹具需显式添加 --allow-fixtures。' } }));
    req.resume();
    return;
  }
  if (url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let hasImage = false;
      try {
        const json = JSON.parse(body);
        hasImage = JSON.stringify(json).includes('image_url');
      } catch {
        // ignore
      }
      console.log(`[mock-ai] chat vision=${hasImage} bytes=${body.length}`);
      sse(res, splitChunks(hasImage ? EXAM_ANSWER : INTERVIEW_ANSWER));
    });
    return;
  }
  if (url.startsWith('/v1/audio/transcriptions')) {
    req.on('data', () => {});
    req.on('end', () => {
      console.log('[mock-ai] stt');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '请先做一个简短的自我介绍，重点讲一下你做过的项目。' }));
    });
    return;
  }
  if (url.startsWith('/v1/audio/speech')) {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tts disabled in mock' }));
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ai] TEST FIXTURES ONLY, real transcription unavailable; listening on http://127.0.0.1:${server.address().port}/v1`);
});
