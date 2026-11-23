import type { ReactNode } from 'react';
import styles from './CardFrame.module.css';

/** 栈卡外框：定宽 336，入场只平移；「等你」标签点进来时闪一下。键帽在卡左的结构线上。决策白纸卡（popup）画弹窗的白带并按弹窗动效入场。 */
export interface CardFrameProps {
  cardId: string;
  /** 「等你」标签点进来时闪一下 */
  highlight?: boolean;
  /** 白纸决策卡（两种主题都是白纸，会话里的紧凑版也是）：弹窗的白带（上下羽化、水印、刻度条）和弹窗入场 */
  popup?: boolean;
  /** 危险操作：卡顶红胶带 */
  danger?: boolean;
  children: ReactNode;
}

export function CardFrame({ cardId, highlight, popup, danger, children }: CardFrameProps) {
  return (
    <div className={styles.frame} data-card-id={cardId} data-highlight={highlight || undefined} data-popup={popup || undefined} data-theme={popup ? 'light' : undefined} data-danger={danger || undefined}>
      {danger && <i className={styles.tape} aria-hidden="true" />}
      {children}
    </div>
  );
}
