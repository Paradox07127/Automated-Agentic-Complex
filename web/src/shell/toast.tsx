import { create } from 'zustand';
import { Toast, type ToastProps } from '../ui';
import styles from './Toast.module.css';

export type ToastOptions = Omit<ToastProps, 'message' | 'onClose'>;

/** Push a toast into the shell's queue; the Toast itself times out (2.5 s, 4 s with an action, errors stay) and reports back. */
export type PushToast = (message: string, opts?: ToastOptions) => void;

interface Item extends ToastOptions {
  id: number;
  message: string;
}

const MAX = 3;
const UNDO = '撤销';
let seq = 0;

const useQueue = create<{ items: Item[] }>(() => ({ items: [] }));

const isUndo = (x: ToastOptions) => x.action?.label === UNDO;

/** A new 撤销 toast replaces the one still showing: only the latest change can be undone from here. */
export const toast: PushToast = (message, opts = {}) => {
  seq += 1;
  const item = { id: seq, message, ...opts };
  useQueue.setState((s) => ({ items: [...(isUndo(item) ? s.items.filter((x) => !isUndo(x)) : s.items), item].slice(-MAX) }));
};

function dismiss(id: number): void {
  useQueue.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function useToast(): PushToast {
  return toast;
}

/** Per window, normal toasts stack at the top centre and system toasts below them; at most 3, newest last. */
export function ToastHost() {
  const items = useQueue((s) => s.items);
  if (items.length === 0) return null;
  return (
    <>
      {(['normal', 'system'] as const).map((kind) => {
        const list = items.filter((x) => (x.kind ?? 'normal') === kind);
        return list.length === 0 ? null : (
          <div key={kind} className={styles.host} data-kind={kind} aria-live="polite">
            {list.map(({ id, ...t }) => (
              <Toast key={id} {...t} onClose={() => dismiss(id)} />
            ))}
          </div>
        );
      })}
    </>
  );
}
