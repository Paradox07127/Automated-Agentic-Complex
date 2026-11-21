import type { ReactNode } from 'react';
import { useSettings } from './ctx';
import styles from './rows.module.css';

export interface SlabProps {
  /** Anchor id, same `set-<id>` scheme as rows. */
  id: string;
  title?: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  /** row: a full-width row plate (default); plate: the focus panel; plain: no fill. */
  variant?: 'row' | 'plate' | 'plain';
  children?: ReactNode;
}

/** Full-width block for charts and lists that do not fit the label + control layout. */
export function Slab({ id, title, desc, right, variant = 'row', children }: SlabProps) {
  const { hl } = useSettings();
  return (
    <section id={`set-${id}`} className={[styles.slab, hl === id && styles.hl].filter(Boolean).join(' ')} data-variant={variant} data-row={id} data-nav-target={`set-${id}`} aria-label={typeof title === 'string' ? title : undefined}>
      {(title != null || right != null) && (
        <div className={styles.slabHead}>
          {title != null && <h4 className={styles.slabTitle}>{title}</h4>}
          {right != null && <span className={styles.slabRight}>{right}</span>}
        </div>
      )}
      {desc != null && <div className={styles.slabDesc}>{desc}</div>}
      {children}
    </section>
  );
}
