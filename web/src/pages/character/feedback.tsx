// Page plumbing: the page clock, the page's hash query, and confirm plus toast feedback.
import { useMemo, useState, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { appNow } from '../../bridge/clock';
import { toast, type ToastOptions } from '../../shell/toast';
import { Modal, type ModalProps } from '../../ui';

export const pageNow = appNow;

/** Page-specific hash query (`?tab=…&ptab=…`) next to the shell's demo flags. */
export function usePageParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

export type ConfirmSpec = Omit<ModalProps, 'open' | 'onCancel' | 'onConfirm'> & { onConfirm: () => void };

export type Toast = (message: string, opts?: ToastOptions) => void;

/** Page confirm dialog plus the shell toast. */
export function useFeedback(): { toast: Toast; ask: (spec: ConfirmSpec) => void; node: ReactNode } {
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const node = confirm && (
    <Modal
      {...confirm}
      open
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        setConfirm(null);
        confirm.onConfirm();
      }}
    />
  );
  return { toast, ask: setConfirm, node };
}
