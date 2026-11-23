import type { ReactNode } from 'react';
import { formatClock } from '../domain';
import { Icon } from './Icon';
import styles from './Receipt.module.css';

/** 完成回执：一行「✓ 已批准 │ 12:30」，替换掉处理完的操作。ok 绿勾、neutral 灰勾（已取消、已响过）、danger 红叉（没送达）。 */
export interface ReceiptProps {
  /** 回执文字，如「已批准」「已回答：周五」 */
  children: ReactNode;
  /** 发生时刻（毫秒）；给了写在文字后 */
  at?: number;
  /** 默认 ok */
  tone?: 'ok' | 'neutral' | 'danger';
}

export function Receipt({ children, at, tone = 'ok' }: ReceiptProps) {
  const mark = tone === 'danger' ? 'close' : 'check';
  return (
    <p className={styles.receipt} data-stub="Receipt" data-tone={tone} role="status">
      <span className={styles.mark} data-mark={mark} aria-hidden="true">
        <Icon name={mark} size={14} />
      </span>
      <span className={styles.text}>{children}</span>
      {at != null && (
        <>
          <span className={styles.sep}>{' │ '}</span>
          <span className={`${styles.at} num`}>{formatClock(at)}</span>
        </>
      )}
    </p>
  );
}

const AT = new Date(2026, 10, 22, 12, 30).getTime();

export const ReceiptDemos: Array<{ name: string; props: ReceiptProps }> = [
  { name: 'ok', props: { children: '已批准', at: AT } },
  { name: 'answered', props: { children: '已回答：周五下午' } },
  { name: 'neutral', props: { tone: 'neutral', children: '已取消', at: AT } },
  { name: 'danger', props: { tone: 'danger', children: '没能送达决定', at: AT } },
];
