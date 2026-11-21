import type { ReactNode } from 'react';
import styles from './Paper.module.css';

/** 白纸卡（面板第 3 级）：只给决策（审批、复核、待确认）；两种主题下都是白纸，里面按亮色令牌取色。 */
export interface PaperProps {
  /** 左优先级条：0 danger、1 attention、2 无，默认 2 */
  priority?: 0 | 1 | 2;
  /** 读屏名称 */
  label?: string;
  /** 内容 */
  children?: ReactNode;
}

export function Paper({ priority = 2, label, children }: PaperProps) {
  return (
    <section data-theme="light" className={styles.paper} data-stub="Paper" data-priority={priority} aria-label={label}>
      {children}
    </section>
  );
}

export const PaperDemos: Array<{ name: string; props: PaperProps }> = [
  { name: 'review', props: { label: '待复核', children: '整理本周提交周报 v2 │ 待复核' } },
  { name: 'approval', props: { priority: 1, label: '待批准', children: 'Codex 想修改 HostLink.swift' } },
  { name: 'plain', props: { children: '只给决策：审批、复核、待确认。' } },
];
