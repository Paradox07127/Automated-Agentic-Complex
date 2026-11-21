import type { ReactNode } from 'react';
import styles from './Plate.module.css';

/** 板（面板第 2 级）：浅一级底色、1 px 描边、直角，顶边左段一条墨色粗签，编号签在其下；给需要聚焦的模块。 */
export interface PlateProps {
  /** 左上编号签，例如 02 */
  no?: string;
  /** 读屏名称 */
  label?: string;
  /** 内容 */
  children?: ReactNode;
}

export function Plate({ no, label, children }: PlateProps) {
  return (
    <section className={styles.plate} data-stub="Plate" data-numbered={no ? '' : undefined} aria-label={label}>
      {no && (
        <span className={styles.no} aria-hidden="true">
          {no}
        </span>
      )}
      {children}
    </section>
  );
}

export const PlateDemos: Array<{ name: string; props: PlateProps }> = [
  { name: 'numbered', props: { no: '02', label: '本周提交', children: '本周提交 14 次，周四最多。' } },
  { name: 'bare', props: { children: '没有编号签的板' } },
];
