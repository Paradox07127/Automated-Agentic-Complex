import { useEffect, useId, useRef, useState } from 'react';
import { toast as pushToast } from '../../shell/toast';
import { Btn, OverlayPortal, useOverlayFocus } from '../../ui';
import { useSettings } from './ctx';
import type { ConfirmSpec } from './model';
import styles from './SettingsOverlays.module.css';

/** The settings page's confirms on the white paper card; `model.notify` toasts go to the shell's queue. */
export function SettingsOverlays() {
  const { model } = useSettings();
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

  if (!confirm) return null;
  return (
    <OverlayPortal>
      <Paper spec={confirm} onClose={() => model.ask(null)} />
    </OverlayPortal>
  );
}

/** White paper card (decisions only): the warning tape along the top, red on danger, the question, ▲ what cannot be undone, the list of what goes, then 取消 and the confirm. Opens on 取消, so Enter cancels. */
function Paper({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState('');
  const wordId = useId();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  const ok = !spec.confirmWord || word.trim() === spec.confirmWord;
  const run = () => {
    if (busy || !ok) return;
    setBusy(true);
    void Promise.resolve(spec.onConfirm()).finally(() => {
      setBusy(false);
      onClose();
    });
  };
  return (
    <div
      className={styles.veil}
      data-stub="SettingsConfirm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-theme="light" data-danger={spec.danger || undefined} className={styles.paper} onKeyDown={trap}>
        <h2 id={titleId} className={styles.title}>
          {spec.title}
        </h2>
        {spec.warning && (
          <p role="alert" className={styles.warning}>
            {spec.warning}
          </p>
        )}
        {spec.list && spec.list.length > 0 && (
          <ul className={styles.list}>
            {spec.list.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {spec.note && <div className={styles.note}>{spec.note}</div>}
        {spec.confirmWord && (
          <label className={styles.field} htmlFor={wordId}>
            <span>输入「{spec.confirmWord}」确认</span>
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
        <div className={styles.acts}>
          <Btn onClick={onClose}>{spec.cancelLabel ?? '取消'}</Btn>
          <Btn variant={spec.danger ? 'danger' : 'primary'} loading={busy} disabled={!ok} disabledReason={spec.confirmWord ? `先输入「${spec.confirmWord}」` : undefined} onClick={run}>
            {busy ? '正在处理…' : spec.confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
