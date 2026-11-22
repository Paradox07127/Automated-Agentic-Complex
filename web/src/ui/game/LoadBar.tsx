import styles from './LoadBar.module.css';

/** 载入条：一条细长的灰色进度线，上方左端写角色名，右端「正在载入」和百分比；两端各一道细竖刻度。port 款是额度计量条：4 px 底线、两端 6 px 端口圆点、斜纹填充，满额变缺电橙，不写字。只是读数，不接点击。 */
export interface LoadBarProps {
  /** 已完成的份额 0–1 */
  fraction: number;
  /** 角色名，写在进度线左上；没有时不写 */
  name?: string | undefined;
  /** port：额度计量条 */
  variant?: 'load' | 'port';
  /** port 款的读屏名称（「截图额度」） */
  label?: string;
}

export function LoadBar({ fraction, name, variant = 'load', label }: LoadBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  if (variant === 'port')
    return (
      <span className={styles.port} data-stub="LoadBar" data-full={pct >= 100 || undefined} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i className={styles.portFill} style={{ width: `${pct}%` }} />
      </span>
    );
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
  { name: 'port', props: { fraction: 12 / 40, variant: 'port', label: '截图额度' } },
  { name: 'port-full', props: { fraction: 1, variant: 'port', label: '截图额度' } },
];
