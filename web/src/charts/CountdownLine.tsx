import { isUrgent } from '../domain';
import { fraction } from './scale';
import styles from './CountdownLine.module.css';

/** 倒计时线：卡底 2 px，次墨从满宽收缩到 0；≤10 s 改 trace；装饰性，aria-hidden。 */
export interface CountdownLineProps {
  /** 剩余秒数 */
  secondsLeft: number | null;
  /** 窗口秒数；任一为 null 时不渲染 */
  windowS: number | null;
}

export function CountdownLine({ secondsLeft, windowS }: CountdownLineProps) {
  if (secondsLeft == null || !windowS) return null;
  const f = fraction(secondsLeft, windowS);
  return (
    <div aria-hidden="true" data-stub="CountdownLine" data-urgent={isUrgent(secondsLeft) || undefined} data-fraction={f.toFixed(2)} className={styles.root}>
      <i className={styles.fill} style={{ width: `${f * 100}%` }} />
    </div>
  );
}

export const CountdownLineDemos: Array<{ name: string; props: CountdownLineProps }> = [
  { name: 'default', props: { secondsLeft: 23, windowS: 55 } },
  { name: 'urgent', props: { secondsLeft: 6, windowS: 50 } },
  { name: 'full', props: { secondsLeft: 55, windowS: 55 } },
  { name: 'expired', props: { secondsLeft: 0, windowS: 55 } },
];
