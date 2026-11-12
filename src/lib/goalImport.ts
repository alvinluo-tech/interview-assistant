/**
 * 导入 JD 时的小工具：岗位文件里常写「公司：xxx」，能读到就顺便填上。
 * 读不到就留空，让用户在右侧自己改，不做任何猜测。
 */
const COMPANY_LINE = /^公司\s*[:：]\s*(.+)$/m;

export function companyFromJd(text: string): string {
  return COMPANY_LINE.exec(text)?.[1]?.trim() ?? '';
}
