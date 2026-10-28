/*
 * 网申助手（原版为另一个桌面客户端，此处为占位说明页，保留原版卖点文案）。
 */
import { Briefcase, ExternalLink } from 'lucide-react';
import { Badge, Button, Card, SectionHeader } from '@/ui/primitives';

const FEATURES = [
  {
    title: '全自动登录',
    desc: '每家招聘网站的注册、登录都由 AI 来做。接通验证码自动转发后，不用守着手机。',
  },
  {
    title: '全自动投递',
    desc: '填申请表、上传简历、按下提交，一家投完接着下一家。北森、Moka、飞书招聘和各家官网都能投。',
  },
  {
    title: '按岗位挑、按岗位答',
    desc: 'AI 按你的简历推荐岗位，写清每家为什么合适；「为什么选择我们」这类开放题按这家公司现场写。',
  },
  {
    title: '一家一版简历',
    desc: '每投一家先读岗位要求，把最相关的经历提到前面，排成一页 PDF 再投出去。',
  },
];

export function JobApplyPage() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader
          title="网申助手"
          desc="原版由原厂商的另一款桌面客户端承载（AI 替你一家接一家投网申，用的就是你在这里上传的简历）。本复刻版不包含该独立产品，这里是入口说明。"
          right={<Badge variant="secondary">未包含</Badge>}
        />
        <div className="grid grid-cols-2 gap-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Briefcase size={13} className="text-primary" />
                {f.title}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.desc}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-md border border-dashed px-3 py-2">
          <span className="text-xs text-muted-foreground">
            原版说明：每人免费试投 5 家，Pro 会员期内不限家数。Windows / macOS / Linux 都有。
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open('https://www.mianlingai.com/job-apply', '_blank')}
          >
            <ExternalLink size={12} />
            官网了解
          </Button>
        </div>
      </Card>
    </div>
  );
}
