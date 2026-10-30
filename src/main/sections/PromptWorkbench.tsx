import { useEffect, useState } from 'react';
import { Button, Card, SectionHeader, Select, Textarea, showToast } from '@/ui/primitives';
import { useSetting, setSetting } from '@/lib/store';
import { PROMPT_VERSION, type AiTask } from '@/lib/aiTaskPolicy';
import { TASK_PROMPTS, type TaskPreferences } from '@/lib/taskPrompts';
const EMPTY_PREFERENCES: TaskPreferences = {};
export function PromptWorkbench({ onDirtyChange }: {
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const saved = useSetting<TaskPreferences>('ai.taskPreferences', EMPTY_PREFERENCES)[0];
    const [task, setTask] = useState<AiTask>('interview-answer');
    const [text, setText] = useState(saved[task] || '');
    const [busy, setBusy] = useState(false);
    useEffect(() => setText(saved[task] || ''), [saved, task]);
    const dirty = text !== (saved[task] || '');
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
    useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
    async function save(value: string) {
        setBusy(true);
        try {
            await setSetting('ai.taskPreferences', { ...saved, [task]: value }, { strict: true });
            setText(value);
            showToast({ type: 'success', title: '本任务的表达偏好已保存' });
        }
        catch (error) {
            showToast({ type: 'error', title: '指令未保存', description: String(error) });
        }
        finally {
            setBusy(false);
        }
    }
    return <Card className="p-5">
    <SectionHeader title="AI 指令" desc="按任务调整表达方式。保存或恢复后可切换任务；工作台的回答风格、语言和补充要求仍会一起生效。"/>
    <Select aria-label="选择 AI 任务" value={task} onChange={event => setTask(event.target.value as AiTask)} disabled={busy || dirty}>
      {(Object.keys(TASK_PROMPTS) as AiTask[]).map(key => <option key={key} value={key}>{TASK_PROMPTS[key].label}</option>)}
    </Select>
    <div className="my-4 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed"><div className="mb-1 font-medium">基础规则 · {PROMPT_VERSION}</div>{TASK_PROMPTS[task].instruction}</div>
    <label className="text-xs font-medium">你的表达偏好<Textarea aria-label="任务表达偏好" className="mt-2" rows={5} maxLength={2000} value={text} onChange={event => setText(event.target.value)} placeholder="例如：先用一句话给结论，再用一个贴近订单系统的例子解释。"/></label>
    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">保存后从下一次生成生效，不改写已有记录。请勿在这里填写密钥。资料选择和任务需要会决定每轮实际上下文。</p>
    <div className="mt-4 flex gap-2"><Button disabled={busy || text === (saved[task] || '')} onClick={() => void save(text)}>保存本任务</Button><Button variant="outline" disabled={busy || !text} onClick={() => void save('')}>恢复默认</Button></div>
  </Card>;
}
