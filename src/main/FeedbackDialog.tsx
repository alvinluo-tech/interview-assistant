/*
 * 反馈对话框（本地模式）：意见记录保存到本地数据层。
 */
import { useState } from 'react';
import { Button, Dialog, DialogTitle, Textarea } from '@/ui/primitives';
import { saveFeedback } from '@/lib/backend';
import { showToast } from '@/ui/primitives';

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogTitle>反馈</DialogTitle>
      <p className="mb-3 text-sm text-muted-foreground">
        本复刻版为本地模式，反馈会保存在本地（不走云端工单）。有问题可以直接改源码。
      </p>
      <Textarea
        rows={5}
        maxLength={2000}
        placeholder="说说你想要什么，越具体越好。"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{text.length}/2000</span>
        <Button
          size="sm"
          disabled={text.trim().length < 4 || submitted || saving}
          onClick={() => {
            setSaving(true);
            void saveFeedback(text).then(() => { setSubmitted(true); window.setTimeout(onClose, 600); })
              .catch(error => showToast({type:'error',title:'反馈保存失败',description:String(error)})).finally(() => setSaving(false));
          }}
        >
          {submitted ? '已保存' : saving ? '保存中…' : '保存到本地'}
        </Button>
      </div>
    </Dialog>
  );
}

