/*
 * 更新日志弹窗（对齐原版 oI）：本复刻版的更新条目。
 */
import { Button, Dialog, DialogTitle } from '@/ui/primitives';
import { setSetting } from '@/lib/store';
import { APP_VERSION } from '@/lib/env';

interface Entry {
  date: string;
  items: { tag: 'new' | 'improved' | 'fixed'; text: string }[];
}

const ENTRIES: Entry[] = [
  {
    date: '2026-10-28',
    items: [
      { tag: 'new', text: '首个复刻版本：面试浮窗 / 笔试浮窗 / 模拟面试 / 题库资料全套页面。' },
      { tag: 'new', text: 'AI 管线本地化：接入你自己的 OpenAI 兼容接口（对话 / 视觉 / 语音转写）。' },
      { tag: 'improved', text: '浮窗样式系统与原版一致：主题、透明度、文字描边、字号、滚动速度、快捷键调透明度。' },
    ],
  },
];

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={() => {
        void setSetting('changelog.seenDate', `${new Date().toISOString().slice(0, 10)}#${APP_VERSION}`);
        onClose();
      }}
      className="max-w-lg"
    >
      <DialogTitle>已更新到新版本</DialogTitle>
      <div className="mb-4 flex flex-col gap-4">
        {ENTRIES.map((e) => (
          <div key={e.date}>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{e.date}</div>
            <div className="flex flex-col gap-1.5">
              {e.items.map((it, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1 py-px text-[11px] font-medium ${
                      it.tag === 'new'
                        ? 'bg-primary/10 text-primary'
                        : it.tag === 'improved'
                          ? 'bg-sky-500/10 text-sky-600'
                          : 'bg-emerald-500/10 text-emerald-600'
                    }`}
                  >
                    {it.tag === 'new' ? '新功能' : it.tag === 'improved' ? '体验优化' : '问题修复'}
                  </span>
                  <span>{it.text}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void setSetting('changelog.snoozedDate', new Date().toISOString().slice(0, 10));
            onClose();
          }}
        >
          今日不再提示
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void setSetting('changelog.seenDate', `${new Date().toISOString().slice(0, 10)}#${APP_VERSION}`);
            onClose();
          }}
        >
          知道了
        </Button>
      </div>
    </Dialog>
  );
}
