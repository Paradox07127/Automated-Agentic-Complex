import type { ReactNode } from 'react';
import { InfoTip } from '../../ui';
import styles from './section.module.css';

export interface SetSectionProps {
  title: string;
  /** ⓘ beside the title; the group's own line sits on its first section. */
  info?: string;
  /** Right end of the head. */
  right?: ReactNode;
  children: ReactNode;
}

/** A section: yellow bar and title, a rule to the right end with the hub ornament. */
export function SetSection({ title, info, right, children }: SetSectionProps) {
  return (
    <section className={styles.sec} aria-label={title}>
      <div className={styles.head}>
        <h3 className={styles.title}>
          {title}
          {info && <InfoTip>{info}</InfoTip>}
        </h3>
        {right != null && <span className={styles.right}>{right}</span>}
        <svg className={styles.deco} viewBox="0 0 58 7" aria-hidden="true">
          <path d="M0 7L4 0h1.6L1.6 7zM4 7l4-7h1.6L5.6 7z" fill="currentColor" />
          <path d="M13 3h18v1H13z" fill="currentColor" />
          <path d="M34 0h10v7H34zM35 1v5h8V1z" fill="currentColor" fillRule="evenodd" />
          <path d="M46 0h12v7H46zM47 1v5h10V1z" fill="currentColor" fillRule="evenodd" />
        </svg>
      </div>
      {children}
    </section>
  );
}
