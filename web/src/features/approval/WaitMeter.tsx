import { formatDuration } from '../../domain';
import { MINUTE } from '../../domain/units';
import styles from './WaitMeter.module.css';

/** 等待计量：提问、复核行用 3 格（<5 分、5–30 分、>30 分），attention 色，保留文字；审批行用倒计时环。 */
export interface WaitMeterProps {
  /** 开始等待的时间（epoch ms） */
  since: number;
  /** 当前时间 */
  now: number;
  /** 画在白纸卡上 */
  onPaper?: boolean;
}

/** Filled cells for a wait: 1 under 5 minutes, 2 up to 30 minutes, 3 beyond. */
export function waitLevel(ms: number): 1 | 2 | 3 {
  if (ms < 5 * MINUTE) return 1;
  if (ms <= 30 * MINUTE) return 2;
  return 3;
}

export function WaitMeter({ since, now, onPaper }: WaitMeterProps) {
  const waited = Math.max(0, now - since);
  const level = waitLevel(waited);
  const text = formatDuration(waited);
  return (
    <span data-stub="WaitMeter" className={styles.root} data-paper={onPaper || undefined} role="img" aria-label={`已等待 ${text}，${level}/3 格`}>
      <span className={styles.cells} aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= level ? styles.on : undefined} />
        ))}
      </span>
      <span className={styles.text}>等了 {text}</span>
    </span>
  );
}
