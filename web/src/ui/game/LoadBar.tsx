import styles from './LoadBar.module.css';

/** 载入条：一条细长的灰色进度线，上方左端写角色名，右端「正在载入」和百分比；两端各一道细竖刻度。只是读数，不接点击。 */
export interface LoadBarProps {
  /** 已完成的份额 0–1 */
  fraction: number;
  /** 角色名，写在进度线左上；没有时不写 */
  name?: string | undefined;
}

export function LoadBar({ fraction, name }: LoadBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className={styles.bar} data-stub="LoadBar" role="progressbar" aria-label={name ? `正在载入 ${name}` : '正在载入'}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={styles.text}>
        {name && <b className={styles.name}>{name}</b>}
        <span className={styles.state}>正在载入</span>
        <span className={styles.pct}>{pct}%</span>
      </div>
      <span className={styles.track}>
        <span className={styles.fill} data-fill="" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export const LoadBarDemos: Array<{ name: string; props: LoadBarProps }> = [
  { name: 'start', props: { fraction: 0, name: '示例乙' } },
  { name: 'half', props: { fraction: 0.56, name: '示例乙' } },
  { name: 'no-name', props: { fraction: 0.85 } },
];
