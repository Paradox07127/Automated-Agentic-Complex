import type { CSSProperties, ReactNode } from 'react';
import styles from './AlertTip.module.css';

/** 出事提示（游戏 MachineSmartAlertNode）：深色胶囊，左边圆底黄「!」，原因，右端 ›，下面一个小三角指向出事的地方；浮在面板上，往右下投影。点了跳到出事的地方。 */
export interface AlertTipProps {
  /** 原因，一行 */
  children: ReactNode;
  /** 读屏名称（「出事的工位：3」） */
  label?: string;
  /** 小三角的横向位置（CSS 长度，相对胶囊左缘），默认居中 */
  pointAt?: string;
  onClick: () => void;
}

export function AlertTip({ children, label, pointAt, onClick }: AlertTipProps) {
  return (
    <button type="button" className={styles.alert} data-stub="AlertTip" aria-label={label} onClick={onClick} style={pointAt ? ({ '--px': pointAt } as CSSProperties) : undefined}>
      <span className={styles.ex} aria-hidden="true">
        !
      </span>
      <span className={styles.tx}>{children}</span>
      <span className={styles.go} aria-hidden="true" />
    </button>
  );
}

export const AlertTipDemos: Array<{ name: string; props: AlertTipProps }> = [
  {
    name: 'default',
    props: {
      children: (
        <>
          <span className="num">14:20</span> 整理失败：模型没有返回
        </>
      ),
      label: '出事的工位：3',
      onClick: () => undefined,
    },
  },
  { name: 'pointed', props: { children: '截图额度已满，只读窗口文字', pointAt: '24px', onClick: () => undefined } },
];
