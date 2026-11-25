import { formatClock } from '../../domain';
import { Btn } from '../../ui';
import styles from './Page.module.css';

export interface PauseReadoutProps {
  /** Epoch ms when it ends; null = until turned off. */
  until: number | null;
  kind: string;
  now: number;
  onResume: () => void;
}

/** Standing readout「观察暂停 · 还剩 18 分 · 14:50 恢复 [现在恢复]」; no ring, the total is not stored. */
export function PauseReadout({ until, kind, now, onResume }: PauseReadoutProps) {
  const left = until == null ? null : Math.max(0, Math.ceil((until - now) / 60_000));
  return (
    <span className={styles.pause} role="status">
      <span>{kind}</span>
      <span className={styles.t2}>
        {until != null ? (
          <>
            剩余 <span className="num">{left}</span> 分 │ <span className="num">{formatClock(until)}</span> 恢复
          </>
        ) : (
          '直至手动恢复'
        )}
      </span>
      <Btn variant="ghost" size="sm" onClick={onResume}>
        立即恢复
      </Btn>
    </span>
  );
}
