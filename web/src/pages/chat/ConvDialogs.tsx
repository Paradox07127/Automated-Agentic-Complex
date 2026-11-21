import { useState } from 'react';
import type { Conversation } from '../../domain';
import { Btn, Dialog } from '../../ui';
import styles from './Chat.module.css';

/** agentd takes a title of 1–80 characters (conversations.py title()). */
const MAX_TITLE = 80;

export function RenameDialog({ conv, onClose, onRename }: { conv: Conversation | null; onClose: () => void; onRename: (c: Conversation, title: string) => void }) {
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState<string | null>(null);
  if ((conv?.id ?? null) !== from) {
    setFrom(conv?.id ?? null);
    setTitle(conv?.title ?? '');
  }
  const t = title.trim();
  const ok = conv != null && t.length > 0 && t.length <= MAX_TITLE && t !== conv.title;
  const submit = () => {
    if (!ok || !conv) return;
    onRename(conv, t);
    onClose();
  };
  return (
    <Dialog
      open={conv != null}
      title="重命名对话"
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <Btn variant="secondary" disabled={!ok} disabledReason={t.length > MAX_TITLE ? '标题最多 80 个字' : '先写新标题'} onClick={submit}>
            改名
          </Btn>
        </>
      }
    >
      <input
        className={styles.field}
        aria-label="对话标题"
        value={title}
        maxLength={MAX_TITLE}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
        }}
      />
    </Dialog>
  );
}

export function DeleteDialog({ conv, onClose, onDelete }: { conv: Conversation | null; onClose: () => void; onDelete: (c: Conversation) => void }) {
  return (
    <Dialog
      open={conv != null}
      title={`删除对话「${conv?.title ?? ''}」？`}
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            不删除
          </Btn>
          <Btn
            variant="danger"
            onClick={() => {
              if (conv) onDelete(conv);
              onClose();
            }}
          >
            删除
          </Btn>
        </>
      }
    >
      <p>消息会一起删除，不能恢复；已交派的任务和产物不受影响。</p>
    </Dialog>
  );
}
