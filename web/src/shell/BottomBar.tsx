import type { ReactNode } from 'react';
import styles from './BottomBar.module.css';

/** The zones of the shell's bottom bar: key hints or filters at the left, a status line after them, the page's actions at the right (its main one last). */
export interface BottomBarZones {
  /** Key hints, filters, a tool page's range switch. */
  lead?: ReactNode;
  /** One line of state: 未应用 3 项, 后台已断开. Read out when it changes. */
  status?: ReactNode;
  /** Page-level actions, the main one last. */
  actions?: ReactNode;
}

export function BottomBar({ lead, status, actions }: BottomBarZones) {
  return (
    <div className={styles.bar} data-bottom-zones="">
      {lead != null && <div className={styles.lead}>{lead}</div>}
      {status != null && (
        <div className={styles.status} role="status">
          {status}
        </div>
      )}
      {actions != null && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
