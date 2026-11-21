import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { toneVar, type FxTone } from './tone';
import styles from './Breath.module.css';

/** 红点呼吸（游戏 M_fx_reddot_loop）：CSS 循环，只在点进入视口时挂上，离开就撤掉；静帧和减少动态时不动。 */
export interface BreathProps {
  /** 直径 px，默认 8 */
  size?: number;
  /** 颜色，默认 reddot */
  tone?: FxTone;
  /** 读屏文字，例如「有新内容」；不给时只作装饰 */
  label?: string;
}

export function Breath({ size = 8, tone = 'reddot', label }: BreathProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setLive(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const style = { '--dot-size': `${size}px`, '--dot-c': toneVar(tone) } as CSSProperties;
  return (
    <span
      ref={ref}
      className={styles.dot}
      style={style}
      data-stub="Breath"
      data-live={live || undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export const BreathDemos: Array<{ name: string; props: BreathProps }> = [
  { name: 'reddot', props: { label: '有新内容' } },
  { name: 'large', props: { size: 14 } },
  { name: 'lemon', props: { size: 10, tone: 'lemon' } },
];
