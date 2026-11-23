// A character page option row (设定, 模组设置, 显示) drawn as a settings page row: title and marks, one line under it, the control column.
import type { ReactNode } from 'react';
import { IconBtn, ModLine } from '../../ui';
import rows from '../settings/rows.module.css';
import styles from './OptionRow.module.css';

export interface OptionRowProps {
  /** Makes the modified line's id unique. */
  id: string;
  title: ReactNode;
  /** Marks after the title that stay whole (DEV, restart). */
  marks?: ReactNode;
  desc?: ReactNode;
  descTone?: 'bad';
  /** Off its default: the settings page's modified line, and `reset` puts it back. */
  modified?: boolean;
  reset?: { label: string; disabled: boolean; onPress: () => void };
  /** Before the control: the default's name, a compare key. */
  aside?: ReactNode;
  control: ReactNode;
  /** busy: a save is running; fail: the last save did not land. */
  state?: 'busy' | 'fail' | undefined;
  /** The keyboard is on this row. */
  focused?: boolean;
}

export function OptionRow(p: OptionRowProps) {
  const modId = `opt-${p.id}-mod`;
  return (
    <div className={`${rows.row} ${styles.row}`} data-modified={p.modified || undefined} data-state={p.state} data-focused={p.focused || undefined} aria-describedby={p.modified ? modId : undefined}>
      <div className={rows.lab}>
        <div className={rows.tt}>
          <span>{p.title}</span>
          {p.marks}
          {p.modified && <ModLine id={modId} />}
        </div>
        {p.desc != null && (
          <div className={rows.d} data-tone={p.descTone}>
            {p.desc}
          </div>
        )}
      </div>
      <div className={rows.ctl}>
        {p.aside}
        {p.modified && p.reset && <IconBtn icon="refresh" size="xs" label={p.reset.label} disabled={p.reset.disabled} onClick={p.reset.onPress} />}
        {p.control}
      </div>
    </div>
  );
}
