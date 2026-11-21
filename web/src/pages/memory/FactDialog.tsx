import { useState } from 'react';
import type { FactKind } from '../../domain';
import { Btn, Dialog, Select } from '../../ui';
import { ADD_KINDS } from './model';
import styles from './FactDialog.module.css';

export interface FactDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Resolves true when agentd stored it; the dialog then closes. */
  onSave: (text: string, kind: FactKind) => Promise<boolean>;
}

/** 新增记忆：居中 Dialog；新加的来源记为「用户陈述」。 */
export function FactDialog({ open, onCancel, onSave }: FactDialogProps) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<FactKind>('preference');
  const [busy, setBusy] = useState(false);
  if (!open) return <Dialog open={false} title="" />;
  const close = () => {
    setText('');
    onCancel();
  };
  const save = () => {
    setBusy(true);
    void onSave(text.trim(), kind).then((ok) => {
      setBusy(false);
      if (ok) setText('');
    });
  };
  return (
    <Dialog
      open
      title="新增记忆"
      onClose={close}
      footer={
        <>
          <Btn variant="ghost" onClick={close}>
            取消
          </Btn>
          <Btn variant="primary" loading={busy} disabled={!text.trim()} disabledReason="内容不能为空" onClick={save}>
            保存
          </Btn>
        </>
      }
    >
      <div className={styles.form}>
        <textarea className={styles.textarea} rows={3} maxLength={500} value={text} placeholder="要角色记住的事" aria-label="新记忆内容" onChange={(e) => setText(e.target.value)} />
        <label className={styles.field}>
          <span className={styles.meta}>分组</span>
          <Select label="分组" value={kind} options={ADD_KINDS.map((k) => ({ value: k.kind, label: k.label }))} width={120} onChange={(v) => setKind(v as FactKind)} />
        </label>
        <span className={styles.meta}>保存后来源记为「用户陈述」</span>
      </div>
    </Dialog>
  );
}
