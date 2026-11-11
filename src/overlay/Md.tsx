/*
 * 浮窗 markdown 渲染器。
 *
 * 两条路径：
 * - ≤ RICH_MARKDOWN_LIMIT：用 react-markdown + remark-gfm（CommonMark + GFM 全量语法），
 *   代码块/表格/标签由自定义组件接管，格式问题交给规范解析器，不再手写状态机。
 * - 超过上限：退回原来的手写渲染器（线性、带预算保护）。remark 的解析成本随长度线性上升，
 *   浮窗里不能让几万字的答案在流式阶段反复重解析。
 *
 * 流式更新统一节流：每 RENDER_THROTTLE_MS 最多重新解析一次，避免每个 token 都跑一遍 AST。
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '@/lib/i18n';
import { useCopyFeedback } from '@/lib/clipboard';
import { DwellButton } from './widgets';
import { usePlatformOptional } from './platform';

/** 超过这个长度改用轻量渲染器。 */
export const RICH_MARKDOWN_LIMIT = 20000;
/** 流式节流窗口。 */
export const RENDER_THROTTLE_MS = 120;

/** 插件数组提到模块级：react-markdown 每次渲染都会重建 processor，但保持引用稳定更利于审阅。 */
const REMARK_PLUGINS = [remarkGfm];

/**
 * 流式中途拿到的文本可能只有开始的围栏、还没有结束的那一行，此时 remark 会把整段当成
 * 普通文本，界面上就会闪过一行原样的 ```。渲染前补一个闭合围栏，落盘内容不受影响。
 */
export function balanceFences(source: string): string {
  let fences = 0;
  for (const line of source.split('\n')) if (/^\s*```/.test(line)) fences += 1;
  return fences % 2 === 1 ? `${source}\n\`\`\`` : source;
}

export function Md({ text }: { text: string }) {
  const throttled = useThrottled(text, RENDER_THROTTLE_MS);
  // 两条路径都用节流后的文本：超长内容更不能每个 token 重渲染一次。
  if (text.length > RICH_MARKDOWN_LIMIT) {
    return <div className="overlay-md">{renderBlocks(throttled)}</div>;
  }
  return (
    <div className="overlay-md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{balanceFences(throttled)}</ReactMarkdown>
    </div>
  );
}

/** 把高频变更的文本压到固定频率，保证 remark 不会每个 token 都解析一次。 */
function useThrottled(value: string, ms: number): string {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const timer = useRef<number | null>(null);
  latest.current = value;
  useEffect(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, ms);
  }, [value, ms]);
  /*
   * 清理必须把 ref 也归零。StrictMode 在开发环境会把「挂载 → 清理 → 再挂载」跑一遍：
   * 只 clearTimeout 而不清 ref，第二次挂载看到非空 ref 就不再排程，shown 永远停在初值
   * —— 表现就是流式回答一片空白（或只显示第一帧）。生产构建不会双跑，但这是真 bug。
   */
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );
  return shown;
}

function CopyCodeButton({ code }: { code: string }) {
  const platform = usePlatformOptional();
  // 每块代码一个唯一 zone id，否则多个代码块会抢同一个热区。
  const id = `md-copy-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { copied, copy } = useCopyFeedback(() => code);
  const label = copied ? t('已复制') : t('复制');
  if (!platform) {
    return <button type="button" className="overlay-code-copy" data-copied={copied} onClick={copy}>{label}</button>;
  }
  return <DwellButton id={id} inline hoverMs={900} onTrigger={copy}>{label}</DwellButton>;
}

function CopyTableButton({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const platform = usePlatformOptional();
  const id = `md-table-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { copied, copy } = useCopyFeedback(() => {
    const table = target.current?.querySelector('table');
    if (!table) return '';
    return Array.from(table.querySelectorAll('tr'))
      .map((row) =>
        Array.from(row.querySelectorAll('th, td'))
          .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
          .join('\t'),
      )
      .join('\n');
  });
  const label = copied ? t('已复制') : t('复制');
  if (!platform) {
    return <button type="button" className="overlay-code-copy" data-copied={copied} onClick={copy}>{label}</button>;
  }
  return <DwellButton id={id} inline hoverMs={900} onTrigger={copy}>{label}</DwellButton>;
}

function TableBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="md-table-block">
      <div className="overlay-code-head">
        <span className="overlay-code-lang">{t('表格')}</span>
        <CopyTableButton target={ref} />
      </div>
      <div ref={ref} className="md-table-scroll">
        <table>{children}</table>
      </div>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="overlay-code-block">
      <div className="overlay-code-head">
        <span className="overlay-code-lang">{language || t('代码')}</span>
        <CopyCodeButton code={code} />
      </div>
      <pre className="overlay-code-body">{code}</pre>
    </div>
  );
}

/** 最小的 hast 结构，只用来从 `pre > code` 里取语言和原文。 */
type HastNode = {
  type: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function hastText(node?: HastNode): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function hastLanguage(node?: HastNode): string {
  const code = node?.children?.[0];
  const names = code?.properties?.className;
  const list = Array.isArray(names) ? names.map(String) : typeof names === 'string' ? [names] : [];
  for (const name of list) {
    const hit = /^language-([\w+#-]+)$/.exec(name);
    if (hit) return hit[1];
  }
  return '';
}

const COMPONENTS = {
  /*
   * 围栏代码块由 `pre` 整体接管：react-markdown 传给组件的是 hast 节点，能直接取到
   * `pre > code` 的语言和原文。这样单行且没写语言的围栏块也仍然是代码块，
   * 不会被误判成行内代码（行内代码只走下面的 `code`）。
   */
  pre: ({ node }: { node?: HastNode }) => (
    <CodeBlock language={hastLanguage(node)} code={hastText(node).replace(/\n$/, '')} />
  ),
  code: ({ children }: { children?: ReactNode }) => <code className="inline-code">{children}</code>,
  table: ({ children }: { children?: ReactNode }) => <TableBlock>{children}</TableBlock>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  // 「核心要点 / 参考回答」这类标签单独加样式。用 hast 原文判断，
  // 标签里带行内代码或强调时 String(children) 会变成 "[object Object]"。
  strong: ({ node, children }: { node?: HastNode; children?: ReactNode }) => {
    const label = node ? hastText(node) : String(children ?? '');
    const isLabel = /^(核心要点|参考回答|要点|回答|答案)$/.test(label);
    return <strong className={isLabel ? 'md-answer-label' : undefined}>{children}</strong>;
  },
} as const;

// ---------------- 超长内容的轻量渲染器（原实现，保持不动） ----------------

function renderBlocks(src: string, depth=0, budget={remaining:6000}): ReactNode[] {
  const plain=()=>[<pre key="plain" className="whitespace-pre-wrap break-words font-sans" style={{overflowWrap:'anywhere'}} aria-label={t('复杂内容按纯文本显示')}>{src}</pre>];
  if(depth>=12||src.length>100000||budget.remaining<=0)return plain();
  const nodes: ReactNode[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  if(lines.length>2000||lines.length>budget.remaining)return plain();
  budget.remaining-=lines.length;
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    const fence = /^```([a-zA-Z0-9+#-]*)\s*$/.exec(line.trim());
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      nodes.push(
        <div className="overlay-code-block" key={key++}>
          <div className="overlay-code-head">
            <span className="overlay-code-lang">{fence[1] || t('代码')}</span>
            <CopyCodeButton code={codeLines.join('\n')} />
          </div>
          <pre className="overlay-code-body">{codeLines.join('\n')}</pre>
        </div>,
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2]);
      const Tag = `h${Math.min(level, 6)}` as 'h1';
      nodes.push(<Tag key={key++}>{content}</Tag>);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(<hr key={key++} />);
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      nodes.push(<blockquote key={key++}>{renderBlocks(quoteLines.join('\n'),depth+1,budget)}</blockquote>);
      continue;
    }

    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      nodes.push(
        <table key={key++}>
          <thead>
            <tr>
              {header.map((c, j) => (
                <th key={j}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, k) => (
                  <td key={k}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      nodes.push(
        <Tag key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 普通段落
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(<p key={key++}>{inline(paraLines.join('\n'))}</p>);
  }

  return nodes;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 行内格式：**加粗**、*斜体*、`code`、==高亮==、[链接](url) */
function inline(src: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(==([^=]+)==)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = pattern.exec(src)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={key++}>{src.slice(last, m.index)}</span>);
    }
    if (m[1]) {
      const isLabel = /^(核心要点|参考回答|要点|回答|答案)$/.test(m[2]);
      nodes.push(
        <strong key={key++} className={isLabel ? 'md-answer-label' : undefined}>
          {m[2]}
        </strong>,
      );
    } else if (m[3]) {
      nodes.push(<em key={key++}>{m[4]}</em>);
    } else if (m[5]) {
      nodes.push(
        <code key={key++} className="inline-code">
          {m[6]}
        </code>,
      );
    } else if (m[7]) {
      nodes.push(<mark key={key++}>{m[8]}</mark>);
    } else if (m[9]) {
      nodes.push(
        <a key={key++} href={m[11]} target="_blank" rel="noreferrer">
          {m[10]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) {
    nodes.push(<span key={key++}>{src.slice(last)}</span>);
  }
  return nodes;
}

/** 复制答案时剥离 markdown 与追问标记 */
export function mdToPlain(text: string): string {
  return text
    .replace(/\[\[FOLLOWUP:[^\]]*\]\]/g, '')
    .replace(/```[a-zA-Z0-9+#-]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/==([^=]+)==/g, '$1')
    .trim();
}
