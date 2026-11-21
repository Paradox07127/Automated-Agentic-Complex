import styles from './Fraction.module.css';

/** 步骤读数「3/5」：主值 15 tnum，分母缩小变灰；未知写「—」。 */
export interface FractionProps {
  /** 分子，null 显示「—」 */
  value: number | null;
  /** 分母；没有总数时只写分子 */
  total?: number | null;
  /** 读屏前缀，例如「步骤」 */
  label?: string;
}

export function Fraction({ value, total, label }: FractionProps) {
  const spoken = `${label ? `${label} ` : ''}${value ?? '未知'}${total != null ? ` / ${total}` : ''}`;
  return (
    <span className={styles.frac} data-stub="Fraction" data-unknown={value == null || undefined} role="img" aria-label={spoken}>
      {value ?? '—'}
      {total != null && <small className={styles.den}>/{total}</small>}
    </span>
  );
}

export const FractionDemos: Array<{ name: string; props: FractionProps }> = [
  { name: 'default', props: { value: 3, total: 5, label: '步骤' } },
  { name: 'unknown', props: { value: null, total: 5 } },
  { name: 'no-total', props: { value: 12, label: '工具调用' } },
];
