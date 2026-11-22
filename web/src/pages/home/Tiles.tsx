import type { ReactNode } from 'react';
import styles from './Tiles.module.css';

/** A right-hand key group: the entrance flashes and brings it forward as one. */
export function Group({ g, children }: { g: string; children: ReactNode }) {
  return (
    <div className={styles.group} data-g={g}>
      {children}
    </div>
  );
}
