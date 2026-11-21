import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { playOnce, tokenEase, tokenMs } from './motion';
import styles from './MaskSweep.module.css';

/**
 * 入场扫出 / 溶解：mask-image 的 mask-position 随 --mask-y（0 全遮、1 全露）移动。挂载时自己播一次
 * （dur-g-panel-in、ease-g-enter），播完撤掉动画；game clip 的 --mask-y 轨（科技线）也能驱动它。
 */
export interface MaskSweepProps {
  /** sweep 柔边扫出，dissolve 带扫描线断口的溶解；默认 sweep */
  mode?: 'sweep' | 'dissolve';
  /** 从哪一边开始露出，默认 top */
  from?: 'top' | 'bottom' | 'left' | 'right';
  /** 挂载时播放，默认 true；false 时只按 --mask-y 显示（交给 game clip） */
  play?: boolean;
  /** 延迟 ms */
  delay?: number;
  /** data-g 键，给 useGameClip 驱动 --mask-y */
  g?: string;
  children: ReactNode;
}

export function MaskSweep({ mode = 'sweep', from = 'top', play = true, delay = 0, g, children }: MaskSweepProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !play) return;
    const a = playOnce(el, [{ '--mask-y': 0 }, { '--mask-y': 1 }], {
      duration: tokenMs(el, 'dur-g-panel-in', 417),
      easing: tokenEase(el, 'ease-g-enter', 'cubic-bezier(.333,0,0,1)'),
      delay,
    });
    return () => a?.cancel();
  }, [play, delay]);
  return (
    <div ref={ref} className={`${styles.sweep} ${styles[mode]} ${styles[from]}`} data-stub="MaskSweep" data-g={g}>
      {children}
    </div>
  );
}

const Card = ({ tone }: { tone: 'plate' | 'line' }) => <div className={tone === 'plate' ? styles.demoPlate : styles.demoLines} />;

export const MaskSweepDemos: Array<{ name: string; props: MaskSweepProps }> = [
  { name: 'sweep-top', props: { children: <Card tone="plate" /> } },
  { name: 'sweep-left', props: { from: 'left', children: <Card tone="plate" /> } },
  { name: 'dissolve', props: { mode: 'dissolve', from: 'bottom', children: <Card tone="line" /> } },
];
