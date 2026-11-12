/**
 * 导入 JD 时的小工具：岗位文件里常写「公司：xxx」，能读到就顺便填上。
 * 读不到就留空，让用户在右侧自己改，不做任何猜测。
 */
const COMPANY_LINE = /^公司\s*[:：]\s*(.+)$/m;
const COMPANY_PREFIX = /^公司/;

export function companyFromJd(text: string): string {
  return COMPANY_LINE.exec(text)?.[1]?.trim() ?? '';
}

/** JD 首行通常就是岗位名；跳过「公司：」这类抬头和过长的段落。 */
export function headingFromJd(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line.length <= 40 && !COMPANY_PREFIX.test(line)) ?? ''
  );
}
