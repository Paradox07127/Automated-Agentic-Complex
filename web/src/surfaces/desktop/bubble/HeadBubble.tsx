import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from '../../../ui/Icon';
import styles from './HeadBubble.module.css';

/** The five things the bubble says, in one shape. */
export type BubbleKind = 'speech' | 'remind' | 'done' | 'error' | 'notice';

/** The kind row of the kinds that have one: its icon and word. */
const HEAD: Partial<Record<BubbleKind, { icon: IconName; word: string }>> = {
  remind: { icon: 'bell', word: '提醒' },
  done: { icon: 'check', word: '做完了' },
  error: { icon: 'warn', word: '出错了' },
};

export interface HeadBubbleProps {
  kind: BubbleKind;
  /** After the kind's word in its row: the time of a reminder, 刚刚 for a result. */
  time?: string | undefined;
  /** The bottom corner the tail leaves from, toward her head; none while she is not there to point at. */
  tail?: 'left' | 'right' | 'bottom' | null;
  /** Shown on hover only: 回复 · 在对话里看全文 · ✕. */
  acts?: ReactNode;
  /** The one action a result or an error always shows (打开, 看详情). */
  one?: ReactNode;
  /** The time line along the bottom: ms left of `total`; it pauses with `paused`. */
  timer?: { key: string; ms: number; total: number; paused: boolean } | null;
  children: ReactNode;
}

/**
 * The bubble beside her head (the game's headlabel): a dark (light) rounded card, 300 px at most, a 12 × 10 tail from its
 * bottom corner toward her head, the kind's row for a reminder, a result or an error, the actions on hover and a 2 px
 * time line along the bottom. Its top padding drags the panel.
 */
export function HeadBubble({ kind, time, tail = null, acts, one, timer, children }: HeadBubbleProps) {
  const head = HEAD[kind];
  return (
    <div className={styles.bubble} data-region="" data-glass="" data-bubble="" data-kind={kind} data-tail={tail ?? undefined}>
      <span className={styles.drag} data-drag="" aria-hidden="true" />
      {head && (
        <p className={styles.kind} data-k={kind}>
          <Icon name={head.icon} size={14} />
          {head.word}
          {time && <span className={styles.time}>{time}</span>}
        </p>
      )}
      <div className={styles.body}>{children}</div>
      {one && <div className={styles.one}>{one}</div>}
      {acts && <div className={styles.acts}>{acts}</div>}
      {timer && (
        <span
          key={timer.key}
          className={styles.timer}
          data-bubble-timer=""
          data-paused={timer.paused ? '' : undefined}
          aria-hidden="true"
          style={{ '--timer-ms': `${timer.ms}ms`, '--timer-from': String(timer.total > 0 ? timer.ms / timer.total : 1) } as CSSProperties}
        />
      )}
      {tail && (
        <svg className={styles.tail} viewBox="0 0 12 10" aria-hidden="true">
          <path d="M0 0h12L2 10z" />
        </svg>
      )}
    </div>
  );
}
