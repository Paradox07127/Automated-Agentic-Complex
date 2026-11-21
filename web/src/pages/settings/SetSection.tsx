import type { ReactNode } from 'react';
import styles from './section.module.css';

export interface SetSectionProps {
  title: string;
  /** Right end of the head (a secondary action or an ⓘ). */
  right?: ReactNode;
  children: ReactNode;
}

/** Settings section under a group title: yellow bar and title, a rule to the right end with a small ornament. */
export function SetSection({ title, right, children }: SetSectionProps) {
  return (
    <section className={styles.sec} aria-label={title}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        {right != null && <span className={styles.right}>{right}</span>}
        <span className={styles.decoHub} aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}
