import type { ReactNode } from 'react';
import { SRow } from '../../ui';
import { useSettings } from './ctx';
import { useRowShown } from './registry';
import styles from './rows.module.css';

export interface SetRowProps {
  id: string;
  title: string;
  desc?: ReactNode;
  control: ReactNode;
  /** Dependent row, drawn indented under its parent. */
  indent?: boolean;
  /** The control opens a dialog or another page: the row takes the pressable cut corner and trace hover. */
  opens?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Description reads as a warning (hotkey conflict). */
  descTone?: 'attention';
  children?: ReactNode;
}

/** Settings row: the shared SRow plus deep-link flash, indent, ✓ saved, the draft mark and「需重启」only while a restart is due. A read-only group's cause stays in the bar above it. Absent while its plug-in is off, or outside 开发者模式 for a developer row. */
export function SetRow({ id, title, desc, control, indent, opens, disabled, disabledReason, descTone, children }: SetRowProps) {
  const { model, ro, hl } = useSettings();
  const shown = useRowShown();
  if (!shown(id)) return null;
  const drafted = id in model.draft;
  const tip = typeof desc === 'string' && descTone !== 'attention' ? desc : undefined;
  const d =
    (desc != null && !tip) || drafted ? (
      <>
        {desc != null && !tip && <span className={descTone === 'attention' ? styles.att : undefined}>{desc}</span>}
        {drafted && <span className={styles.att}>未应用</span>}
      </>
    ) : undefined;
  const ctl = (
    <span className={styles.ctl}>
      {model.ok === id && (
        <span className={styles.ok} aria-live="polite">
          ✓ 已保存
        </span>
      )}
      {control}
    </span>
  );
  const cls = [styles.row, indent && styles.indent, hl === id && styles.hl].filter(Boolean).join(' ');
  return (
    <div className={cls} data-row={id} data-nav-target={`set-${id}`} data-opens={opens || undefined}>
      <SRow
        id={id}
        title={title}
        desc={d}
        tip={tip}
        control={ctl}
        effect={model.pending[id] ? 'backend' : 'now'}
        pending={!!model.pending[id]}
        disabled={disabled || ro}
        disabledReason={ro ? undefined : disabledReason}
      >
        {children}
      </SRow>
    </div>
  );
}
