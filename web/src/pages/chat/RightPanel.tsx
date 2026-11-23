import type { ReactNode } from 'react';
import { Sheet } from '../../ui';
import styles from './Chat.module.css';

export interface RightPanelProps {
  onClose: () => void;
  children: ReactNode;
}

/** The task column: a Sheet docked as the page's third column from 1100 px, a drawer over the page below. */
export function RightPanel({ onClose, children }: RightPanelProps) {
  return (
    <Sheet open title="任务" width={420} head="close" dockFrom={1100} onClose={onClose}>
      <div className={styles.rpB}>{children}</div>
    </Sheet>
  );
}

/** Demos that open the task column on load. */
const TASK_DEMOS = ['plan-snapshot', 'reject'];
/** The open task column; `taskId` picks the task, else the conversation's current one. */
export type Rp = { taskId?: string } | null;
export const initialRp = (demo: string | null): Rp => (TASK_DEMOS.includes(demo ?? '') ? {} : null);
