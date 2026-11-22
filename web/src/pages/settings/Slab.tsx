import type { ReactNode } from 'react';
import { useSettings } from './ctx';
import { useRowShown } from './registry';
import styles from './rows.module.css';

export interface SlabProps {
  /** Anchor id, same `set-<id>` scheme as rows. */
  id: string;
  title?: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  /** row: a full-width row plate (default); plate: a readout plate with corner ticks; plain: no fill. */
  variant?: 'row' | 'plate' | 'plain';
  /** Child of the band or row above, drawn indented. */
  indent?: boolean;
  /** Screen-reader name when the title is not a string. */
  label?: string;
  children?: ReactNode;
}

/** Full-width block for lists, tables and readouts that do not fit the label + control layout; absent when its row is not shown. */
export function Slab({ id, title, desc, right, variant = 'row', indent, label, children }: SlabProps) {
  const { hl } = useSettings();
  const shown = useRowShown();
  if (!shown(id)) return null;
  return (
    <section
      id={`set-${id}`}
      className={[styles.slab, hl === id && styles.hl].filter(Boolean).join(' ')}
      data-variant={variant}
      data-sub={indent || undefined}
      data-row={id}
      data-nav-target={`set-${id}`}
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
    >
      {variant === 'plate' && (
        <>
          <i className={styles.tk} data-at="a" aria-hidden="true" />
          <i className={styles.tk} data-at="b" aria-hidden="true" />
        </>
      )}
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
