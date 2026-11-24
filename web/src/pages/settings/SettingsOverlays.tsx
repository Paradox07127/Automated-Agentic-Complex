import { useEffect, useId, useRef, useState } from 'react';
import { toast as pushToast } from '../../shell/toast';
import { Btn, Field, OverlayPortal, useOverlayFocus } from '../../ui';
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
      {/* Closes only the confirm it was opened for. */}
      <Paper key={confirm.title} spec={confirm} onClose={() => model.ask((c) => (c?.title === confirm.title ? null : c))} />
    </OverlayPortal>
  );
}

/**
 * White paper card (decisions only): the warning tape along the top, red on danger, the question, ▲ what cannot be undone, the list
 * of what goes, then 取消 and the confirm. Opens on 取消, so Enter cancels. While the confirmed action runs it cannot be dismissed.
 */
function Paper({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const { model } = useSettings();
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState('');
  const wordId = useId();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = () => !busy && onClose();
  const trap = useOverlayFocus(panel, dismiss);
  const ok = !spec.confirmWord || word.trim() === spec.confirmWord;
  const run = async () => {
    if (busy || !ok) return;
    setBusy(true);
    try {
      await spec.onConfirm();
    } catch {
      model.notify({ message: `没能完成「${spec.confirmLabel}」`, severity: 'danger', persistent: true });
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <div
      className={styles.veil}
      data-stub="SettingsConfirm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
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
            <Field
              id={wordId}
              label={`输入「${spec.confirmWord}」确认`}
              value={word}
              autoComplete="off"
              spellCheck={false}
              onChange={setWord}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
            />
          </label>
        )}
        <div className={styles.acts}>
          <Btn disabled={busy} onClick={dismiss}>
            {spec.cancelLabel ?? '取消'}
          </Btn>
          <Btn variant={spec.danger ? 'danger' : 'primary'} loading={busy} disabled={!ok} disabledReason={spec.confirmWord ? `先输入「${spec.confirmWord}」` : undefined} onClick={() => void run()}>
            {busy ? '正在处理…' : spec.confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
}
