import type { ReactNode } from 'react';
import { InfoTip, SecHead } from '../../ui';
import styles from './section.module.css';

export interface SetSectionProps {
  title: string;
  /** ⓘ at the head's right end; the group's own line sits on its first section. */
  info?: string;
  /** Right end of the head. */
  right?: ReactNode;
  children: ReactNode;
}

/** A section: the shared group title (SecHead), its ⓘ and right end after the rule, then the rows. */
export function SetSection({ title, info, right, children }: SetSectionProps) {
  const end =
    info || right != null ? (
      <>
        {right}
        {info && <InfoTip>{info}</InfoTip>}
      </>
    ) : undefined;
  return (
    <section className={styles.sec} aria-label={title}>
      <SecHead title={title} right={end} />
      {children}
    </section>
  );
}
