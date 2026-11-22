// Page plumbing: the page clock, the page's hash query, the jump to the MMD page, and confirm plus toast feedback.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { appNow } from '../../bridge/clock';
import { toast, type ToastOptions } from '../../shell/toast';
import { Modal, type ModalProps } from '../../ui';

export const pageNow = appNow;

/** Page-specific hash query (`?tab=…&ptab=…`) next to the shell's demo flags. */
export function usePageParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

/** Opens the MMD page, keeping the view flags (`theme`, `still`). */
export function useOpenMmd(): (replace?: boolean) => void {
  const navigate = useNavigate();
  return useCallback(
    (replace = false) =>
      void navigate({
        to: '/mmd',
        search: (prev: Record<string, unknown>) => Object.fromEntries(Object.entries(prev).filter(([k]) => k === 'theme' || k === 'still')),
        replace,
      }),
    [navigate],
  );
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
