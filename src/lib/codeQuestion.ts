/*
 * 笔试题解析：从模型答案里取出代码、从题干里取出样例、判断评测模式。
 *
 * 主流笔试平台分两种评测方式（2026 校招现状）：
 * - ACM 模式（牛客、赛码、华为机考、多数大厂自研平台）：自己读 stdin、写 stdout、写 main。
 * - 核心代码模式（LeetCode 风格）：只实现函数/类，输入输出由平台驱动。
 * 所以同一份答案在两种模式下能否直接跑，结论完全不同；这里先把两件事分开识别。
 */

export interface CodeSample {
  /** 原始输入文本（可能是 stdin，也可能是核心代码模式的参数表） */
  input: string;
  /** 期望输出；缺失时为空串，表示只能跑通不能判定 */
  output: string;
}

export interface CodeBlock {
  /** 语言标签（fenced code 的 info string），未知时为 '' */
  language: string;
  code: string;
}

export type RunMode = 'acm' | 'core';

const LANGUAGE_ALIASES: Record<string, string> = {
  py: 'python', python3: 'python', python: 'python',
  js: 'javascript', node: 'javascript', javascript: 'javascript', ts: 'javascript', typescript: 'javascript',
  java: 'java', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', go: 'go', golang: 'go',
};

/** 归一化语言标签；不认识时返回 ''。 */
export function normalizeLanguage(tag: string): string {
  return LANGUAGE_ALIASES[tag.trim().toLowerCase()] ?? '';
}

/** 从答案里挑出最可能的那段代码：优先带语言标签的、其次最长的 fenced block。 */
export function extractCodeBlock(answer: string): CodeBlock | null {
  const blocks: CodeBlock[] = [];
  // 用字符串拼 RegExp：正则字面量里的反引号会让 i18n 源码扫描的注释剥离状态机误判。
  const fence = new RegExp('```([^\\n]*)\\n([\\s\\S]*?)```', 'g');
  for (const match of answer.matchAll(fence)) {
    const code = match[2].replace(/\s+$/, '');
    if (!code.trim()) continue;
    blocks.push({ language: normalizeLanguage(match[1].split(/\s+/)[0] ?? ''), code });
  }
  if (!blocks.length) return null;
  const tagged = blocks.filter((block) => block.language);
  const pool = tagged.length ? tagged : blocks;
  return pool.reduce((best, block) => (block.code.length > best.code.length ? block : best));
}

/** 语言识别：先看代码特征，再看题干措辞。 */
export function detectLanguage(block: CodeBlock, questionText = ''): string {
  if (block.language) return block.language;
  const code = block.code;
  if (/^\s*(public\s+)?(final\s+)?class\s+\w+[\s\S]*\bpublic\s+static\s+void\s+main\b/m.test(code)) return 'java';
  if (/#include\s*<(iostream|vector|algorithm)>/.test(code) || /\bstd::(cin|cout)\b/.test(code)) return 'cpp';
  if (/#include\s*<stdio\.h>/.test(code) || /\bscanf\s*\(/.test(code)) return 'c';
  if (/^\s*package\s+main\b/m.test(code) || /\bfmt\.Print/.test(code)) return 'go';
  if (/^\s*def\s+\w+\s*\(|^\s*class\s+\w+.*:\s*$/m.test(code) || /\bprint\s*\(/.test(code) && !/\bfunction\b|=>/.test(code)) return 'python';
  if (/\bfunction\b|=>|const\s+\w+\s*=|require\(/.test(code)) return 'javascript';
  if (/核心代码|函数签名|实现\s*\w+\s*函数/.test(questionText)) return 'python';
  return 'python';
}

/** ACM（自己读写标准输入输出）还是核心代码（只写函数）。 */
export function detectRunMode(code: string, questionText = ''): RunMode {
  const acm = [
    /\bint\s+main\s*\(/, /\bfn\s+main\s*\(/, /\bfunc\s+main\s*\(/, /if\s+__name__\s*==/,
    /\bsys\.stdin\b/, /\binput\s*\(/, /\bcin\s*>>/, /\bscanf\s*\(/, /Scanner\s*\(\s*System\.in/,
    /\breadline\b/, /process\.stdin/, /\bstd::cin\b/, /bufio\.NewScanner/,
  ];
  if (acm.some((pattern) => pattern.test(code))) return 'acm';
  // 题面写了「输入描述/输出描述/标准输入」就是 ACM：即使答案只给了函数，也按 ACM 处理。
  // 顺序很重要——先按代码特征判 core 的话，这里永远看不到题面，ACM 的整段 stdin
  // 会被当成「k = v」参数表去解析，必判失败。
  if (/ACM\s*模式|标准输入|输入描述|输出描述/.test(questionText) && !/核心代码|函数签名/.test(questionText)) return 'acm';
  if (/class\s+Solution|^\s*def\s+\w+\s*\(self/m.test(code)) return 'core';
  return 'core';
}

// 中文标记必须带冒号（否则「输出描述:」会被误当成样例输出）；
// 英文的「Sample Input 0」不带冒号，单独一条规则。
const MARKER = /^(样例输入|样例输出|输入例子|输出例子|示例输入|示例输出|输入示例|输出示例|输入|输出|sample\s*input|sample\s*output|input|output)\s*(\d+)?\s*[:：]\s*(.*)$/i;
// 无冒号写法：字节/美团题面的「样例输入」「样例输出」单独占一行，值在下一行。
const SAMPLE_ONLY = /^(sample\s*input|sample\s*output|样例输入|样例输出|输入示例|输出示例)\s*(\d+)?\s*$/i;
// 紧凑写法：「示例1：输入：5」——标题、标记、内容挤在同一行。
const COMPACT = /^(?:示例|样例|例子|example)\s*\d*\s*[:：]?\s*(样例输入|样例输出|输入例子|输出例子|示例输入|示例输出|输入示例|输出示例|输入|输出|sample\s*input|sample\s*output|input|output)\s*[:：]\s*(.*)$/i;
const HEADER = /^(示例|样例|例子|example)\s*\d*\s*[:：]?\s*$/i;

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/：/g, ':').replace(/[ \t]+$/gm, '');
}

/**
 * 从题干里提取「输入 → 输出」样例。
 * 覆盖牛客（输入例子1/输出例子1）、LeetCode 中文（示例 1：输入：/输出：）、
 * 华为机考（样例1 输入:/输出:）、HackerRank（Sample Input 0/Sample Output 0）。
 * 输入与输出按出现顺序两两配对；没有输出标记的样例 output 为空。
 */
export function parseSamples(questionText: string): CodeSample[] {
  if (!questionText) return [];
  const lines = normalize(questionText).split('\n');
  const inputs: string[] = [];
  const outputs: string[] = [];
  let current: { kind: 'input' | 'output'; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (current.kind === 'input') inputs.push(text); else outputs.push(text);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (HEADER.test(line)) { flush(); continue; }
    const compact = COMPACT.exec(line);
    const marker = compact ? null : MARKER.exec(line);
    const sampleOnly = compact || marker ? null : SAMPLE_ONLY.exec(line);
    if (compact || marker || sampleOnly) {
      flush();
      const name = (compact ?? marker ?? sampleOnly)![1];
      const kind = /输入|input/i.test(name) ? 'input' : 'output';
      const rest = compact ? compact[2] : marker?.[3] ?? '';
      current = { kind, lines: rest ? [rest] : [] };
      continue;
    }
    if (!current) continue;
    // 下一节标题（题目描述、说明、提示等）结束当前样例
    if (/^(输入描述|输出描述|解释|说明|提示|注意|数据范围|约束|note|constraints?|explanation)\s*[:：]?/i.test(line)) { flush(); continue; }
    current.lines.push(raw);
  }
  flush();

  const count = Math.min(inputs.length, outputs.length) || inputs.length;
  const samples: CodeSample[] = [];
  for (let i = 0; i < count; i++) {
    const input = (inputs[i] ?? '').trim();
    const output = (outputs[i] ?? '').trim();
    if (!input && !output) continue;
    samples.push({ input, output });
  }
  return samples;
}

/** 归一化输出，用于比对：统一换行、去行尾空白、去首尾空行。 */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}
