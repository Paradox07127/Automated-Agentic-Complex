import type { ReactNode } from 'react';
import { formatClock } from '../domain';
import { Btn } from './Btn';
import styles from './ErrBar.module.css';

/** 出错条：浅一级底色加 1 px 墨色框，文字前一个黄色小旗（失败 ■ 或注意 ▲），写原因、数据时间和重试。 */
export interface ErrBarProps {
  /** 原因 */
  message: string;
  /** 默认 danger */
  tone?: 'danger' | 'warning';
  /** 下面数据的时间（epoch ms），显示「下面是 hh:mm 的数据」 */
  staleAt?: number;
  /** 重试 */
  onRetry?: () => void;
  /** 附加操作 */
  extra?: ReactNode;
}

export function ErrBar({ message, tone = 'danger', staleAt, onRetry, extra }: ErrBarProps) {
  return (
    <div role="alert" className={styles.bar} data-stub="ErrBar" data-tone={tone}>
      <svg className={styles.glyph} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {tone === 'danger' ? <rect x="1.2" y="1.2" width="7.6" height="7.6" fill="currentColor" /> : <path d="M5 .8 9.6 9.2H.4z" fill="currentColor" />}
      </svg>
      <span className={styles.vh}>{tone === 'danger' ? '失败：' : '注意：'}</span>
      <span className={styles.msg}>{message}</span>
      {staleAt != null && <span className={styles.stale}>下面是 {formatClock(staleAt)} 的数据</span>}
      <span className={styles.sp} />
      {extra}
      {onRetry && (
        <Btn size="sm" icon="refresh" onClick={onRetry}>
          重试
        </Btn>
      )}
    </div>
  );
}

export const ErrBarDemos: Array<{ name: string; props: ErrBarProps }> = [
  { name: 'default', props: { message: '步骤接口不可用', staleAt: new Date(2026, 9, 29, 14, 31).getTime(), onRetry: () => {} } },
  { name: 'warning', props: { message: '内核未就绪：codex 未登录', tone: 'warning', extra: <Btn size="sm" variant="ghost">前往设置</Btn> } },
  { name: 'plain', props: { message: '读取记忆失败：数据库被占用' } },
];
