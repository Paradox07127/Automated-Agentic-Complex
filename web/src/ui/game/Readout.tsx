import type { ReactNode } from 'react';
import { MicroLabel } from './Marks';
import styles from './Readout.module.css';

/** 读数刻：左边 2 px 竖条 + Saira 大数 + 小号单位，下面一行标签。tone：黄（主读数）、墨（次读数）、橙（过了注意线）、红（过了过高线）。lg 是读数带里的大号。 */
export interface ReadTickProps {
  /** 数；没有时写「—」 */
  value: ReactNode;
  /** 单位：%、MB、ms */
  unit?: string;
  /** 下面一行标签 */
  label: ReactNode;
  /** 默认 main */
  tone?: 'main' | 'ink' | 'warn' | 'bad';
  /** 默认 md（17 px），lg 24 px */
  size?: 'md' | 'lg';
  /** 单行：标签跟在数后面，同一条基线 */
  inline?: boolean;
}

export function ReadTick({ value, unit, label, tone = 'main', size = 'md', inline }: ReadTickProps) {
  return (
    <span className={styles.tick} data-stub="ReadTick" data-tone={tone} data-size={size} data-inline={inline || undefined}>
      <b className={styles.value}>
        {value}
        {unit && <small>{unit}</small>}
      </b>
      <span className={styles.label}>{label}</span>
    </span>
  );
}

export const ReadTickDemos: Array<{ name: string; props: ReadTickProps }> = [
  { name: 'main', props: { value: '59', unit: 'FPS', label: '帧率' } },
  { name: 'ink', props: { value: '412', unit: 'MB', label: '内存', tone: 'ink' } },
  { name: 'warn', props: { value: '86', unit: '%', label: 'CPU │ 单核占比', tone: 'warn' } },
  { name: 'bad', props: { value: '23.4', unit: 'ms', label: 'P95 帧耗时', tone: 'bad' } },
  { name: 'large', props: { value: '128', label: '近 1 小时轮数', size: 'lg' } },
];

/** 读数板的一格：小字标签、计量条、大数字、状态词，哪项没有就不画。 */
export interface ReadoutCell {
  /** 小字标签 */
  label: ReactNode;
  /** 计量条（LoadBar、BracketMeter） */
  meter?: ReactNode;
  /** 大数字 */
  value?: ReactNode;
  /** 状态词，或一句话（「坐着」） */
  word?: ReactNode;
  /** 靠右放（板里最后一格的开关和链接） */
  end?: boolean;
}

/** 读数板：浅板 + 右端斜纹 + 两角细十字，左边竖排英文眉标，格间 1 px 竖线。用来把一组同级读数排成一行。 */
export interface ReadoutPlateProps {
  cells: readonly ReadoutCell[];
  /** 左边竖排的英文眉标，例如 STATE CURRENT */
  eyebrow?: string;
  /** 读屏名称 */
  label?: string;
  /** 紧凑款：矮板、窄格、小一号的数 */
  compact?: boolean;
}

export function ReadoutPlate({ cells, eyebrow, label, compact }: ReadoutPlateProps) {
  return (
    <section className={styles.plate} data-stub="ReadoutPlate" data-compact={compact || undefined} aria-label={label}>
      <i className={styles.cross} data-at="a" aria-hidden="true" />
      <i className={styles.cross} data-at="b" aria-hidden="true" />
      {eyebrow && (
        <span className={styles.eyebrow}>
          <MicroLabel>{eyebrow}</MicroLabel>
        </span>
      )}
      {cells.map((c, i) => (
        <div key={i} className={styles.cell} data-end={c.end || undefined}>
          <span className={styles.k}>{c.label}</span>
          {c.meter}
          {c.value != null && <b className={styles.v}>{c.value}</b>}
          {c.word != null && <span className={styles.w}>{c.word}</span>}
        </div>
      ))}
    </section>
  );
}

export const ReadoutPlateDemos: Array<{ name: string; props: ReadoutPlateProps }> = [
  {
    name: 'state',
    props: {
      eyebrow: 'STATE CURRENT',
      label: '她现在的状态',
      cells: [
        { label: '精神', value: '0.80', word: '很好' },
        { label: '心情', value: '+0.20', word: '平稳' },
        { label: '投入', value: '0.45', word: '一般' },
        { label: '在做', word: '坐着' },
        { label: '状态影响行为', word: '开', end: true },
      ],
    },
  },
  { name: 'two', props: { cells: [{ label: '今天截图', value: '12 / 40' }, { label: '已释放', value: '3' }] } },
];
