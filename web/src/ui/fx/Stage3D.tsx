import type { CSSProperties, ReactNode } from 'react';
import styles from './Stage3D.module.css';

/** 透视容器：子元素的 translateZ（游戏 World Space 画布的前后位移）在这里有景深。 */
export interface Stage3DProps {
  /** 视距 px，默认 800（游戏相机参数不在 prefab 里，按观感取） */
  perspective?: number;
  /** 视点，CSS perspective-origin，默认中心 */
  origin?: string;
  /** 宽 px，不给时随内容 */
  w?: number;
  /** 高 px，不给时随内容 */
  h?: number;
  children: ReactNode;
}

export function Stage3D({ perspective = 800, origin = '50% 50%', w, h, children }: Stage3DProps) {
  const style = { '--stage-p': `${perspective}px`, '--stage-o': origin, width: w, height: h } as CSSProperties;
  return (
    <div className={styles.stage} style={style} data-stub="Stage3D">
      <div className={styles.scene}>{children}</div>
    </div>
  );
}

function Planes() {
  return (
    <div className={styles.demoPlanes}>
      {[0, 30, 60].map((z) => (
        <span key={z} className={styles.demoPlane} style={{ translate: `${z}px ${-z / 2}px ${z}px` }} />
      ))}
    </div>
  );
}

export const Stage3DDemos: Array<{ name: string; props: Stage3DProps }> = [
  { name: 'depth', props: { w: 280, h: 200, children: <Planes /> } },
  { name: 'near', props: { w: 280, h: 200, perspective: 300, origin: '20% 30%', children: <Planes /> } },
];
