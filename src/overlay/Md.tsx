/* 浮窗 markdown 渲染器：代码块逐行渲染、折行不横滚、答案标签、表格/引用/列表。 */
import { Fragment, type ReactNode } from 'react';

export function Md({ text }: { text: string }) {
  return <div className="overlay-md">{renderBlocks(text)}</div>;
}

function renderBlocks(src: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
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
          {codeLines.map((l, j) => (
            <span className="overlay-code-line" key={j}>
              {l || ' '}
            </span>
          ))}
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
      nodes.push(<blockquote key={key++}>{renderBlocks(quoteLines.join('\n'))}</blockquote>);
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
      nodes.push(<Fragment key={key++}>{src.slice(last, m.index)}</Fragment>);
    }
    if (m[1]) {
      // 答案标签：**核心要点**/**参考回答** 单独成段标记
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
    nodes.push(<Fragment key={key++}>{src.slice(last)}</Fragment>);
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
