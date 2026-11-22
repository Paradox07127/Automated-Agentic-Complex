import type { CSSProperties } from 'react';
import styles from './Marks.module.css';

/** 微型拉丁标注：游戏界面角落里的小号英文，只是装饰，读屏跳过。 */
export interface MicroLabelProps {
  /** 英文，按大写画 */
  children: string;
}

export function MicroLabel({ children }: MicroLabelProps) {
  return (
    <span className={styles.micro} data-stub="MicroLabel" aria-hidden="true">
      {children}
    </span>
  );
}

export const MicroLabelDemos: Array<{ name: string; props: MicroLabelProps }> = [
  { name: 'default', props: { children: 'Agentic Complex / Appearance' } },
  { name: 'short', props: { children: 'MOD CFG' } },
];

/** 菱形标：橙（新 / 有改动 / 断点，游戏 red-dot）、黄（已改）、白（已完成的一步）、空心（未选 / 未到）。 */
export interface DiamondProps {
  /** 默认 orange */
  tone?: 'orange' | 'yellow' | 'white' | 'hollow';
  /** 边长 px，默认 9 */
  size?: number;
}

export function Diamond({ tone = 'orange', size = 9 }: DiamondProps) {
  return <i className={styles.diamond} data-stub="Diamond" data-tone={tone} style={{ '--d': `${size}px` } as CSSProperties} aria-hidden="true" />;
}

export const DiamondDemos: Array<{ name: string; props: DiamondProps }> = [
  { name: 'orange', props: { tone: 'orange' } },
  { name: 'yellow', props: { tone: 'yellow', size: 8 } },
  { name: 'white', props: { tone: 'white', size: 8 } },
  { name: 'hollow', props: { tone: 'hollow', size: 10 } },
];

/** Bar widths in px, bar then gap, repeating; a fixed pattern so every barcode reads the same. */
const BARS = [1, 2, 2, 1, 1, 1, 3, 2, 1, 1, 2, 1, 1, 3, 1, 1, 3, 1, 1, 2, 1, 1, 2, 1, 3, 2];

/** 竖条码装饰：1–3 px 的竖条，可带一行微型英文；颜色随文字色。 */
export interface BarcodeProps {
  /** 宽 px，默认 34 */
  width?: number;
  /** 条高 px，默认 10 */
  height?: number;
  /** 条码下面的微型英文 */
  label?: string;
}

export function Barcode({ width = 34, height = 10, label }: BarcodeProps) {
  const rects: Array<[number, number]> = [];
  for (let x = 0, i = 0; x < width; i += 2) {
    const w = BARS[i % BARS.length] ?? 1;
    rects.push([x, Math.min(w, width - x)]);
    x += w + (BARS[(i + 1) % BARS.length] ?? 1);
  }
  return (
    <span className={styles.barcode} data-stub="Barcode" aria-hidden="true">
      <svg className={styles.bars} width={width} height={height} viewBox={`0 0 ${width} ${height}`} focusable="false">
        {rects.map(([x, w]) => (
          <rect key={x} x={x} y={0} width={w} height={height} />
        ))}
      </svg>
      {label && <span className={styles.micro}>{label}</span>}
    </span>
  );
}

export const BarcodeDemos: Array<{ name: string; props: BarcodeProps }> = [
  { name: 'row-end', props: { width: 34, height: 9, label: 'AGENTIC' } },
  { name: 'wide', props: { width: 64, height: 14 } },
];
