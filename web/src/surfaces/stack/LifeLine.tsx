import { useEffect, useRef, type CSSProperties } from 'react';
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

export function LifeLine({ totalS, leftS, paused, onEnd }: LifeLineProps) {
  const initialMs = Math.max(0, leftS * 1000);
  const leftMsRef = useRef(initialMs);
  const endRef = useRef(onEnd);
  useEffect(() => {
    endRef.current = onEnd;
  });

  useEffect(() => {
    if (leftMsRef.current <= 0) {
      endRef.current?.();
      return;
    }
    if (paused || isStill()) return;
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      leftMsRef.current = 0;
      endRef.current?.();
    }, leftMsRef.current);
    return () => {
      clearTimeout(timer);
      leftMsRef.current = Math.max(0, leftMsRef.current - (performance.now() - startedAt));
    };
  }, [paused]);

  const still = isStill();
  const ratio = totalS > 0 ? Math.min(1, Math.max(0, leftS / totalS)) : 0;
  const barStyle = { '--life-from': String(ratio), '--life-ms': `${initialMs}ms` } as CSSProperties;
  return (
    <div className={styles.line} data-paused={paused || still || undefined} aria-hidden="true">
      <i style={barStyle} />
    </div>
  );
}
