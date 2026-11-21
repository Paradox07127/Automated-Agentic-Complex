import type { CSSProperties, ReactNode } from 'react';
import { artUrl, toneVar, type FxTone } from './tone';
import styles from './GlowLayer.module.css';

/** 加色光层（plus-lighter）：叠在内容上发光，对应游戏的 bloom 贴图和加色材质。 */
export interface GlowLayerProps {
  /** 宽 px */
  w: number;
  /** 高 px */
  h: number;
  /** /art 下的贴图（例如 watch/ui-main-menu-btn01-bloom），作遮罩用颜色填；app 没带美术时用径向渐变替身 */
  sprite?: string;
  /** 颜色，默认 white */
  tone?: FxTone;
  /** 不透明度，默认 1（游戏左光晕 0.6、右光晕 0.35） */
  opacity?: number;
  /** 光层外扩 px，默认 0 */
  spread?: number;
  /** data-g 键，给 useGameClip 驱动 */
  g?: string;
  /** 被照亮的内容 */
  children?: ReactNode;
}

export function GlowLayer({ w, h, sprite, tone = 'white', opacity = 1, spread = 0, g, children }: GlowLayerProps) {
  const style = { width: w, height: h, '--glow-c': toneVar(tone), '--glow-spread': `${-spread}px` } as CSSProperties;
  const glow = { opacity, ...(sprite ? { '--glow-src': artUrl(sprite) } : {}) } as CSSProperties;
  return (
    <span className={styles.root} style={style} data-stub="GlowLayer">
      {children}
      <span className={styles.glow} style={glow} data-sprite={sprite ? '' : undefined} data-g={g} aria-hidden="true" />
    </span>
  );
}

const Plate = () => <span className={styles.demoPlate} />;

export const GlowLayerDemos: Array<{ name: string; props: GlowLayerProps }> = [
  { name: 'white', props: { w: 160, h: 96, opacity: 0.6, spread: 16, children: <Plate /> } },
  { name: 'yellow', props: { w: 160, h: 96, tone: 'yellow', opacity: 0.35, spread: 16, children: <Plate /> } },
  { name: 'bloom-sprite', props: { w: 78, h: 130, sprite: 'watch/ui-main-menu-btn01-bloom', tone: 'white', opacity: 0.6, children: <Plate /> } },
];
