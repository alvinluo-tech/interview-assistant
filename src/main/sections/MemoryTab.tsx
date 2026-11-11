import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { t } from '../../lib/i18n';
import { addMemory, deleteMemory, listMemory, updateMemory, type MemoryFact } from '../../lib/memory';
import { Button, ConfirmDialog, Input, SectionHeader, SettingRow, showToast } from '../../ui/primitives';

/** 设置里的「长期记忆」：用户自己维护跨会话事实，可改、可删。 */
export function MemoryTab() {
  const [facts, setFacts] = useState<MemoryFact[]>(() => listMemory());
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryFact | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<MemoryFact[]>) {
    setBusy(true);
    try {
      setFacts(await action());
    } catch (error) {
      showToast({ type: 'error', title: t('记忆未保存'), description: String((error as Error).message || error) });
    } finally {
      setBusy(false);
    }
  }

  const add = () => {
    const text = draft.trim();
    if (!text || busy) return;
    void run(async () => {
      const next = await addMemory([text]);
      setDraft('');
      return next;
    });
  };

  const save = () => {
    if (!editing || busy) return;
    void run(async () => {
      const next = await updateMemory(editing.id, editing.text);
      setEditing(null);
      return next;
    });
  };

  return (
    <div>
      <SectionHeader
        title={t('长期记忆')}
        desc={t('这里的条目会作为背景注入自由对话和面试回答。只放稳定的事实：目标岗位、技术栈与年限、项目数字、明确的偏好与禁忌。')}
      />
      <div className="mb-3 flex gap-2">
        <Input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') add();
          }}
          placeholder={t('例如：三年后端经验，主要用 Go 和 PostgreSQL')}
          aria-label={t('新增记忆')}
        />
        <Button variant="secondary" disabled={busy || !draft.trim()} onClick={add}>
          <Plus size={14} className="mr-1" />
          {t('添加')}
        </Button>
      </div>
      {facts.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('还没有记忆条目。可以先在自由对话里点「记住要点」，从已经聊过的事情里提炼。')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {facts.map(fact => (
            <li key={fact.id} className="px-3 py-2">
              {editing?.id === fact.id ? (
                <div className="flex gap-2">
                  <Input
                    value={editing.text}
                    onChange={event => setEditing({ id: fact.id, text: event.target.value })}
                    onKeyDown={event => {
                      if (event.key === 'Enter') save();
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    autoFocus
                    aria-label={t('编辑记忆')}
                  />
                  <Button variant="secondary" disabled={busy} onClick={save}>
                    {t('保存')}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    {t('取消')}
                  </Button>
                </div>
              ) : (
                <SettingRow
                  title={<span className="font-normal">{fact.text}</span>}
                  desc={new Date(fact.updatedAt).toLocaleDateString()}
                >
                  <div className="flex gap-1">
                    <Button variant="ghost" aria-label={t('编辑记忆')} title={t('编辑记忆')} onClick={() => setEditing({ id: fact.id, text: fact.text })}>
                      <Pencil size={14} />
                    </Button>
                    <Button variant="ghost" aria-label={t('删除记忆')} title={t('删除记忆')} onClick={() => setPendingDelete(fact)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </SettingRow>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('删除这条记忆？')}
        body={pendingDelete?.text ?? ''}
        confirmText={t('删除')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void run(() => deleteMemory(target.id));
        }}
      />
    </div>
  );
}
