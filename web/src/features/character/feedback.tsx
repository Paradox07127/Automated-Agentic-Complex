// Page plumbing: the page clock, the page's hash query, and confirm plus toast feedback.
import { useMemo, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { appNow } from '../../bridge/clock';
import { toast, type ToastOptions } from '../../shell/toast';
import { Btn, Dialog, ErrBar } from '../../ui';

export const pageNow = appNow;

/** Page-specific hash query (`?tab=…&ptab=…`) next to the shell's demo flags. */
export function usePageParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

/** A confirm: the question, a note and a warning under it; danger makes the confirm red. */
export interface ConfirmSpec {
  title: string;
  note?: string;
  children?: ReactNode;
  warning?: string;
  danger?: boolean;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

export type Toast = (message: string, opts?: ToastOptions) => void;

/** Page confirm dialog plus the shell toast. */
export function useFeedback(): { toast: Toast; ask: (spec: ConfirmSpec) => void; node: ReactNode } {
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const node = confirm && (
    <Dialog
      open
      title={confirm.title}
      onClose={() => setConfirm(null)}
      footer={
        <>
          <Btn variant="secondary" kbd="esc" onClick={() => setConfirm(null)}>
            {confirm.cancelLabel ?? '取消'}
          </Btn>
          <Btn
            variant={confirm.danger ? 'danger' : 'primary'}
            onClick={() => {
              setConfirm(null);
              confirm.onConfirm();
            }}
          >
            {confirm.confirmLabel}
          </Btn>
        </>
      }
    >
      {confirm.note && <p>{confirm.note}</p>}
      {confirm.children}
      {confirm.warning && <ErrBar tone="warning" message={confirm.warning} />}
    </Dialog>
  );
  return { toast, ask: setConfirm, node };
}
