import type { ReactNode } from 'react';
import { Barcode, MicroLabel } from './Marks';
import styles from './GameFrame.module.css';

/**
 * 游戏外框，三种：
 * - monitor（默认，监视框）：深底（浅色主题白@.55）+ 1.5 px 亮框，左上黑底斜切小牌标题（中文 + 英文微标），右下微型英文和条码；
 * - media（引导外框，GuideMediaPanel）：半透明底、两侧 4 px 竖条和刻度、左上微型字 + REC 牌、右上条码、两角细十字；
 * - chart（图表板，电力统计）：深顶条（标题 + 微型英文）+ 浅格面。
 * 都不加阴影。
 */
export interface GameFrameProps {
  /** monitor 和 chart 的标题 */
  title?: ReactNode;
  /** 英文微标：monitor 跟在标题后，media 在左上，chart 在顶条右端 */
  micro?: string;
  /** monitor 右下的微型英文（条码前） */
  foot?: string;
  /** media 左上的小牌，默认 REC */
  tag?: string;
  /** 默认 monitor */
  variant?: 'monitor' | 'media' | 'chart';
  /** 读屏名称（有了就是一个 region） */
  label?: string;
  children?: ReactNode;
}

export function GameFrame({ title, micro, foot, tag = 'REC', variant = 'monitor', label, children }: GameFrameProps) {
  const own = { className: styles.frame, 'data-stub': 'GameFrame', 'data-variant': variant, role: label ? 'region' : undefined, 'aria-label': label };
  if (variant === 'chart')
    return (
      <div {...own}>
        <div className={styles.head}>
          {title}
          {micro && <MicroLabel>{micro}</MicroLabel>}
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    );
  if (variant === 'media')
    return (
      <div {...own}>
        <i className={styles.cross} data-at="a" aria-hidden="true" />
        <i className={styles.cross} data-at="b" aria-hidden="true" />
        <i className={styles.tickL} aria-hidden="true" />
        <i className={styles.tickR} aria-hidden="true" />
        <span className={styles.mediaMark} aria-hidden="true">
          {micro && <MicroLabel>{micro}</MicroLabel>}
          <span className={styles.rec}>{tag}</span>
        </span>
        <span className={styles.mediaCode}>
          <Barcode width={40} height={8} />
        </span>
        {children}
      </div>
    );
  return (
    <div {...own}>
      {title != null && (
        <span className={styles.tagTitle}>
          {title}
          {micro && <MicroLabel>{micro}</MicroLabel>}
        </span>
      )}
      {children}
      {foot && (
        <span className={styles.foot} aria-hidden="true">
          <Barcode width={60} height={8} />
          <MicroLabel>{foot}</MicroLabel>
        </span>
      )}
    </div>
  );
}

const FILL = <div style={{ height: 120 }} />;

export const GameFrameDemos: Array<{ name: string; props: GameFrameProps }> = [
  { name: 'monitor', props: { title: '精神与心情 │ 行为决策', micro: 'TODAY', foot: 'AIC BEHAVIOR TODAY', children: FILL } },
  { name: 'media', props: { variant: 'media', micro: '02 CONNECT', children: FILL } },
  { name: 'chart', props: { variant: 'chart', title: '帧率', micro: 'FRAME RATE 60 S', children: FILL } },
];
