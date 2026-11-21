import { useState, type ReactNode } from 'react';
import { toast, type ToastOptions } from '../../shell/toast';
import { Modal, type ModalProps } from '../../ui';

export type ConfirmSpec = Omit<ModalProps, 'open' | 'onCancel' | 'onConfirm'> & { onConfirm: () => void };

/** Page confirm dialog plus the shell toast: every action gets visible feedback, every destructive one a confirm. */
export function useFeedback(): {
  toast: (message: string, opts?: ToastOptions) => void;
  ask: (spec: ConfirmSpec) => void;
  node: ReactNode;
} {
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
