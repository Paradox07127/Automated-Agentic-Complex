import type { ReactNode } from 'react';
import styles from './ToolBar.module.css';

/** A tool page's filter bar under the page header: its filters, a hatch band over the free space, its main action at the right. */
export function ToolBar({ children, action }: { children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.bar} data-toolbar="">
      {children}
      <span className={styles.band} data-band="" aria-hidden="true" />
      {action && (
        <span className={styles.action} data-toolbar-action="">
          {action}
        </span>
      )}
    </div>
  );
}
