import type { ReactNode } from 'react';
import { SecHead } from '../../ui';
import styles from './section.module.css';

export interface SetSectionProps {
  title: string;
  /** ⓘ right after the title; the group's own line sits on its first section. */
  info?: string;
  /** Right end of the head. */
  right?: ReactNode;
  children: ReactNode;
}

/** A section: the shared group title (SecHead) with its ⓘ after the title and its right end after the rule, then the rows. */
export function SetSection({ title, info, right, children }: SetSectionProps) {
  return (
    <section className={styles.sec} aria-label={title}>
      <SecHead title={title} info={info || undefined} right={right} />
      {children}
    </section>
  );
}
