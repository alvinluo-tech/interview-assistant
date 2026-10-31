/*
 * 使用须知弹窗（对齐原版 hO）：首次启动强制弹，5 秒倒计时后可确认。
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogTitle } from '@/ui/primitives';
import { setSetting, useSetting } from '@/lib/store';

const BANNED = [
  '国家教育考试：高考、研究生招生考试（含复试）、自学考试、成人高考等',
  '公务员录用考试：国考、省考、选调生、遴选等',
  '事业单位公开招聘：事业编、教师招聘、医疗卫生招聘等',
  '军队文职人员招考',
  '国家职业资格 / 专业技术资格考试：法考、教师资格、注册会计师、医师资格等',
  '以及其他法律法规禁止使用辅助工具的考试。违规使用的后果需自行承担。',
];

export function UsageNotice() {
  const acked = useSetting('notice.usageAcknowledged.v2', false)[0];
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (acked) return;
    setCountdown(5);
    const timer = window.setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [acked]);

  if (acked) return null;

  return (
    <Dialog open onClose={() => {}} dismissable={false} className="max-w-xl">
      <DialogTitle>使用须知</DialogTitle>
      <div className="mb-3 text-sm leading-relaxed">
        <p className="font-medium">以下考试（含笔试、面试、复试等全部环节）禁止使用本软件：</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          {BANNED.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>
      <p className="mb-2 text-[13px] leading-relaxed text-muted-foreground">
        所有回答均由 AI 生成、仅供参考，请结合自身情况独立判断。应用使用你自行配置的
        AI 接口，音频、截图与文本会发送到你所配置的服务商处理。
      </p>
      <div className="flex justify-end">
        <Button disabled={countdown > 0} onClick={() => void setSetting('notice.usageAcknowledged.v2', true)}>
          {countdown > 0 ? `我已阅读并同意（${countdown} 秒）` : '我已阅读并同意'}
        </Button>
      </div>
    </Dialog>
  );
}
