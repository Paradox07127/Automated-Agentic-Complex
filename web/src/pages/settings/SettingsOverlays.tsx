import { useEffect, useId, useState } from 'react';
import { toast as pushToast } from '../../shell/toast';
import { Btn, Dialog } from '../../ui';
import { useSettings } from './ctx';
import styles from './SettingsOverlays.module.css';

/** Confirm dialog for the settings page; `model.notify` toasts go to the shell's queue. */
export function SettingsOverlays() {
  const { model } = useSettings();
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState('');
  const wordId = useId();
  const { confirm, toast, notify } = model;

  useEffect(() => {
    if (!toast) return;
    pushToast(toast.message, {
      severity: toast.severity,
      persistent: toast.persistent,
      action: toast.action ? { label: toast.action.label, onClick: toast.action.onClick } : toast.persistent ? { label: '知道了' } : undefined,
    });
    notify(null);
  }, [toast, notify]);

  useEffect(() => setWord(''), [confirm]);

  if (!confirm) return null;
  const ok = !confirm.confirmWord || word.trim() === confirm.confirmWord;
  const close = () => model.ask(null);
  const run = () => {
    if (busy || !ok) return;
    setBusy(true);
    void Promise.resolve(confirm.onConfirm()).finally(() => {
      setBusy(false);
      model.ask(null);
    });
  };

  // Footer order puts 取消 first, so every confirm, danger or not, opens on the safe choice (or on the confirm word): Enter cancels.
  return (
    <Dialog
      open
      title={confirm.title}
      onClose={close}
      footer={
        <>
          <Btn variant="secondary" kbd="esc" onClick={close}>
            {confirm.cancelLabel ?? '取消'}
          </Btn>
          <Btn variant={confirm.danger ? 'danger' : 'primary'} disabled={!ok} disabledReason={confirm.confirmWord ? `先输入「${confirm.confirmWord}」` : undefined} loading={busy} onClick={run}>
            {busy ? '正在处理…' : confirm.confirmLabel}
          </Btn>
        </>
      }
    >
      <div className={styles.body} data-danger={confirm.danger || undefined}>
        {confirm.note && <div className={styles.note}>{confirm.note}</div>}
        {confirm.warning && (
          <p role="alert" className={styles.warning}>
            {confirm.warning}
          </p>
        )}
        {confirm.confirmWord && (
          <label className={styles.field} htmlFor={wordId}>
            <span>输入「{confirm.confirmWord}」确认</span>
            <input
              id={wordId}
              className={styles.input}
              value={word}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setWord(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run();
              }}
            />
          </label>
        )}
      </div>
    </Dialog>
  );
}
