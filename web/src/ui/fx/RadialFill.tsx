import type { CSSProperties } from 'react';
import { artUrl, toneVar, type FxTone } from './tone';
import styles from './RadialFill.module.css';

/** 径向填充（游戏 Image filled radial360）：conic-gradient 遮罩按 --fill 露出一段弧；game clip 的 --fill 轨可以直接驱动。 */
export interface RadialFillProps {
  /** 填充比例 0–1 */
  amount: number;
  /** 直径 px */
  size: number;
  /** 起点，游戏 Origin360：bottom 0、right 1、top 2、left 3；默认 top */
  origin?: 'bottom' | 'right' | 'top' | 'left';
  /** 顺时针，默认 true */
  clockwise?: boolean;
  /** 环宽 px；不给时填满整个圆 */
  thickness?: number;
  /** 颜色，默认 ring-yellow */
  tone?: FxTone;
  /** /art 下的环贴图（例如 watch/ui-out-ring），作遮罩用颜色填；app 没带美术时画 CSS 环 */
  sprite?: string;
  /** data-g 键，给 useGameClip 驱动 --fill */
  g?: string;
}

const FROM = { top: '0deg', right: '90deg', bottom: '180deg', left: '270deg' } as const;

export function RadialFill({ amount, size, origin = 'top', clockwise = true, thickness, tone = 'ring-yellow', sprite, g }: RadialFillProps) {
  const style = {
    '--fill': amount,
    '--fill-from': FROM[origin],
    '--fill-c': toneVar(tone),
    '--fill-thick': thickness ? `${thickness}px` : '100%',
    ...(sprite ? { '--fill-src': artUrl(sprite) } : {}),
    width: size,
    height: size,
  } as CSSProperties;
  return (
    <span
      className={`${styles.fill} ${clockwise ? styles.cw : styles.ccw}`}
      style={style}
      data-stub="RadialFill"
      data-sprite={sprite ? '' : undefined}
      data-g={g}
      aria-hidden="true"
    />
  );
}

export const RadialFillDemos: Array<{ name: string; props: RadialFillProps }> = [
  { name: 'ring', props: { amount: 0.75, size: 160, thickness: 3 } },
  { name: 'arc-36', props: { amount: 0.1, size: 160, thickness: 6, origin: 'right', tone: 'yellow' } },
  { name: 'disc-ccw', props: { amount: 0.4, size: 120, clockwise: false, tone: 'ring' } },
  { name: 'sprite', props: { amount: 0.6, size: 200, sprite: 'watch/ui-out-ring', tone: 'ring-yellow' } },
];
