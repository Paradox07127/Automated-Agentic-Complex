import { useEffect, useRef, useState } from 'react';
import { isStill } from '../../features/approval/useCountdown';
import styles from './LifeLine.module.css';

/** 寿命线：2 px，从满宽缩到 0，悬停暂停；走完调用 onEnd（复核卡折叠、交付卡进历史）。 */
export interface LifeLineProps {
  /** 总寿命（秒） */
  totalS: number;
  /** 剩余（秒） */
  leftS: number;
  /** 悬停或冻结时暂停 */
  paused: boolean;
  /** 走完 */
  onEnd?: () => void;
}

const STEP = 200;

export function LifeLine({ totalS, leftS, paused, onEnd }: LifeLineProps) {
  const [leftMs, setLeftMs] = useState(leftS * 1000);
  const ended = leftMs <= 0;
  const endRef = useRef(onEnd);
  useEffect(() => {
    endRef.current = onEnd;
  });

  useEffect(() => {
    if (paused || ended || isStill()) return;
    const t = setInterval(() => setLeftMs((l) => Math.max(0, l - STEP)), STEP);
    return () => clearInterval(t);
  }, [paused, ended]);

  useEffect(() => {
    if (ended) endRef.current?.();
  }, [ended]);

  const pct = totalS > 0 ? Math.min(100, (leftMs / (totalS * 1000)) * 100) : 0;
  return (
    <div className={styles.line} data-paused={paused || undefined} aria-hidden="true">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
