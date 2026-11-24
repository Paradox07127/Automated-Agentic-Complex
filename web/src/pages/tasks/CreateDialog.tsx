import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../../bridge';
import { keyText } from '../../bridge/platformText';
import type { Goal } from '../../domain';
import type { PushToast } from '../../shell/toast';
import { Btn, Dialog } from '../../ui';
import { isPluginOff } from '../../shell/plugins';
import { failMessage } from './actions';
import { draftProblem, offText, submitDraft } from './create';
import { CreateForm, type CreateDraft } from './CreateForm';

export interface CreateDialogProps {
  draft: CreateDraft | null;
  setDraft: (d: CreateDraft | null) => void;
  goals: Goal[];
  push: PushToast;
  /** After agentd took it: the new task row's id when there is one. */
  onCreated: (select: string | null) => void;
}

/** 新建 dialog, 560 wide: kind comes from the menu item; ⌘↵ submits; selects the new task. */
export function CreateDialog({ draft, setDraft, goals, push, onCreated }: CreateDialogProps) {
  const bridge = getBridge();
  const [busy, setBusy] = useState(false);
  const submitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      submitRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [draft]);
  if (!draft) return null;
  const canPick = bridge.capabilities.nativeFilePicker;
  const problem = draftProblem(draft, canPick);
  const pickFolder = async () => {
    try {
      const h = await bridge.files.pickFolder({ purpose: 'session_cwd' });
      if (h) setDraft({ ...draft, cwd: h });
      else push('没有选择目录');
    } catch {
      push('这台电脑的外壳暂不支持选择目录', { severity: 'danger' });
    }
  };
  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const r = await submitDraft(draft);
      setDraft(null);
      push(`已交派：${r.label}`);
      onCreated(r.select);
    } catch (e) {
      const text = isPluginOff(e) ? offText(draft.kind) : failMessage(e);
      if (text !== null) push(`交派失败：${text}`, { severity: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  submitRef.current = () => void submit();
  return (
    <Dialog
      open
      title="新建"
      onClose={() => setDraft(null)}
      footer={
        <>
          <Btn variant="ghost" kbd="esc" onClick={() => setDraft(null)}>
            取消
          </Btn>
          <Btn variant="primary" kbd={keyText('⌘↵')} loading={busy} disabled={problem != null} disabledReason={problem ?? undefined} onClick={() => void submit()}>
            交派
          </Btn>
        </>
      }
    >
      <CreateForm draft={draft} onChange={setDraft} goals={goals} canPick={canPick} onPickFolder={() => void pickFolder()} />
    </Dialog>
  );
}
