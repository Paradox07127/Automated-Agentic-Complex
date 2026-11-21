import styles from './Progress.module.css';

/** 进度条：左边阶段名，右边整数百分比，下面一条按比例填黄的横条。 */
export interface ProgressProps {
  /** 阶段名，也是读屏名 */
  label: string;
  /** 0–1 */
  value: number;
}

export function Progress({ label, value }: ProgressProps) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div className={styles.prog} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-stub="Progress">
      <span className={styles.lbl}>{label}</span>
      <span className={styles.pct}>{`${pct}%`}</span>
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export const ProgressDemos: Array<{ name: string; props: ProgressProps }> = [
  { name: 'default', props: { label: '重定向骨骼', value: 0.42 } },
  { name: 'start', props: { label: '准备中', value: 0 } },
  { name: 'reload', props: { label: '载入角色', value: 1 } },
];
