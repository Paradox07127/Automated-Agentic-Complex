import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconBtn, useOverlayFocus } from '../../ui';
import styles from './Chat.module.css';

export interface RightPanelProps {
  onClose: () => void;
  children: ReactNode;
}

function OverlayPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <>
      <button type="button" className={styles.scrim} tabIndex={-1} aria-hidden="true" onClick={onClose} />
      <aside ref={panel} className={styles.rp} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>{children}</aside>
    </>
  );
}

/** The task column; it becomes a keyboard-contained overlay at small widths. */
export function RightPanel({ onClose, children }: RightPanelProps) {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 1099px)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 1099px)');
    if (!mq) return;
    const changed = () => setNarrow(mq.matches);
    mq.addEventListener('change', changed);
    return () => mq.removeEventListener('change', changed);
  }, []);
  const body = (
    <>
      <div className={styles.rpH}>
        <span className={styles.sp} />
        <IconBtn icon="close" label="收起右栏" onClick={onClose} />
      </div>
      <div className={styles.rpB}>{children}</div>
    </>
  );
  return narrow ? <OverlayPanel label="任务" onClose={onClose}>{body}</OverlayPanel> : <aside className={styles.rp} aria-label="任务">{body}</aside>;
}

/** Demos that open the task column on load. */
const TASK_DEMOS = ['plan-snapshot', 'reject'];
/** The open task column; `taskId` picks the task, else the conversation's current one. */
export type Rp = { taskId?: string } | null;
export const initialRp = (demo: string | null): Rp => (TASK_DEMOS.includes(demo ?? '') ? {} : null);
