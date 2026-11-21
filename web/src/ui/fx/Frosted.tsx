import type { CSSProperties, ReactNode } from 'react';
import styles from './Frosted.module.css';

/** 磨砂底（backdrop-filter）：游戏 watchblurpanel 的场景模糊 + #4C4C4C 底。减少透明度时换实底。 */
export interface FrostedProps {
  /** 模糊半径 px，默认 16；0 不模糊 */
  blur?: number;
  /** 底色占比 0–1，默认 0.5 */
  tint?: number;
  /** 宽 px，不给时随内容 */
  w?: number;
  /** 高 px，不给时随内容 */
  h?: number;
  children?: ReactNode;
}

export function Frosted({ blur = 16, tint = 0.5, w, h, children }: FrostedProps) {
  const style = { '--frost-blur': `${blur}px`, '--frost-tint': `${tint * 100}%`, width: w, height: h } as CSSProperties;
  return (
    <div className={styles.frost} style={style} data-stub="Frosted" data-blur={blur > 0 || undefined}>
      {children}
    </div>
  );
}

function Backdrop({ blur, tint }: { blur?: number; tint?: number }) {
  return (
    <div className={styles.demoBack}>
      <div className={styles.demoPanel}>
        <Frosted blur={blur} tint={tint} w={200} h={110} />
      </div>
    </div>
  );
}

// The demo root is a clear Frosted holding a striped backdrop and the panel under test.
export const FrostedDemos: Array<{ name: string; props: FrostedProps }> = [
  { name: 'panel', props: { blur: 0, tint: 0, children: <Backdrop /> } },
  { name: 'light-tint', props: { blur: 0, tint: 0, children: <Backdrop blur={8} tint={0.2} /> } },
];
