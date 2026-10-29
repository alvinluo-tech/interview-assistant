/*
 * 网申助手（1:1 对齐原版 mB，BS:37522-37576）：
 * 原版此页本身就是另一个桌面客户端的推广页——标题/副题、4 卖点卡、促销条 + 「去浏览器下载」。
 */
import { ExternalLink, FileText, LogIn, Send, Target } from 'lucide-react';

const LANDING = 'https://www.mianlingai.com/job-apply';

const FEATURES = [
  {
    icon: LogIn,
    title: '全自动登录',
    desc: '每家招聘网站的注册、登录都由 AI 来做。接通验证码自动转发后，不用守着手机。',
  },
  {
    icon: Send,
    title: '全自动投递',
    desc: '填申请表、上传简历、按下提交，一家投完接着下一家。北森、Moka、飞书招聘和各家官网都能投。',
  },
  {
    icon: Target,
    title: '按岗位挑、按岗位答',
    desc: 'AI 按你的简历推荐岗位，写清每家为什么合适；「为什么选择我们」这类开放题按这家公司现场写。',
  },
  {
    icon: FileText,
    title: '一家一版简历',
    desc: '每投一家先读岗位要求，把最相关的经历提到前面，排成一页 PDF 再投出去。',
  },
];

function openLanding(source: string) {
  window.open(`${LANDING}?from=${encodeURIComponent(source)}`, '_blank');
}

export function JobApplyPage() {
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold tracking-tight">网申助手</h1>
        <p className="text-[13px] leading-snug text-muted-foreground">
          面灵的另一个桌面客户端：AI 替你一家接一家投网申，用的就是你在这里上传的简历。
        </p>
      </header>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-3">
        {FEATURES.map((f) => (
          <section key={f.title} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="size-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="line-clamp-2 text-[14px] font-semibold leading-snug">{f.title}</h2>
                <p className="text-[12px] leading-relaxed text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          </section>
        ))}
      </div>
      <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">
            每人免费试投 5 家，Pro 会员期内不限家数。Windows / macOS / Linux 都有。
          </p>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => openLanding('desktop-sidebar')}
          >
            去浏览器下载
            <ExternalLink className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
