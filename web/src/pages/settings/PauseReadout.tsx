import { formatClock, formatDuration } from '../../domain';
import { Btn } from '../../ui';
import { clock } from './api';
import styles from './groups.module.css';

export interface PauseReadoutProps {
  /** e.g. 免打扰、观察暂停 */
  kind: string;
  /** Resume time, epoch ms. */
  until: number;
  /** What still happens during it, e.g.「提醒照常」. */
  note?: string;
  disabled?: boolean;
  onResume: () => void;
}

/** Standing readout「⏸ 还剩 18 m · 15:32 恢复 [现在恢复]」; no ring, the total is not stored. */
export function PauseReadout({ kind, until, note, disabled, onResume }: PauseReadoutProps) {
  return (
    <span className={styles.pause} role="status">
      <span aria-hidden="true">⏸</span>
      <span>
        {kind} │ 还剩 <span className="num">{formatDuration(Math.max(0, until - clock()))}</span> │ <span className="num">{formatClock(until)}</span> 恢复
        {note && <span className={styles.t3}> │ {note}</span>}
      </span>
      <Btn size="sm" variant="ghost" disabled={disabled} onClick={onResume}>
        现在恢复
      </Btn>
    </span>
  );
}
