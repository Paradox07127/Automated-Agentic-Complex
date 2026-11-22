import { useState } from 'react';
import styles from './LoadBar.module.css';

/** 载入条：照游戏帝江号上切换仓库的进度条。左边深灰方格放角色小头像，青色填充上写角色名，右端「正在载入」和百分比，下面一条同进度的青色斜纹细条。只是读数，不接点击。 */
export interface LoadBarProps {
  /** 已完成的份额 0–1 */
  fraction: number;
  /** 角色名，写在填充左端；没有时不写 */
  name?: string | undefined;
  /** 角色小头像；没有或读不出来时画一个中性人形 */
  head?: string | undefined;
}

export function LoadBar({ fraction, name, head }: LoadBarProps) {
  const [failed, setFailed] = useState<string>();
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  const fill = { width: `${pct}%` };
  return (
    <div className={styles.bar} data-stub="LoadBar" role="progressbar" aria-label={name ? `正在载入 ${name}` : '正在载入'}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden="true">
          {head && head !== failed ? (
            <img src={head} alt="" onError={() => setFailed(head)} />
          ) : (
            <svg viewBox="0 0 24 24" focusable="false">
              <circle cx={12} cy={8.5} r={4} />
              <path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5z" />
            </svg>
          )}
        </span>
        <span className={styles.body}>
          <span className={styles.fill} data-fill="" style={fill} />
          {name && <b className={styles.name}>{name}</b>}
          <span className={styles.end}>
            <span>正在载入</span>
            <span className={styles.pct}>{pct}%</span>
          </span>
        </span>
        <span className={styles.corners} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <span className={styles.strip} aria-hidden="true">
        <span className={styles.stripes} data-fill="" style={fill} />
      </span>
    </div>
  );
}

export const LoadBarDemos: Array<{ name: string; props: LoadBarProps }> = [
  { name: 'start', props: { fraction: 0, name: '示例乙' } },
  { name: 'half', props: { fraction: 0.56, name: '示例乙' } },
  { name: 'no-name', props: { fraction: 0.85 } },
];
