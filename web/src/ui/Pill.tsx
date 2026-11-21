import type { ReactNode } from 'react';
import styles from './Pill.module.css';

/** 状态签：高 20 直角；常态灰底，进行中墨框，完成墨块，需关注黄块，失败前加「!」签，dashed 用于「推断的」。 */
export interface PillProps {
  /** 底色，默认 paper */
  tone?: 'paper' | 'mission' | 'neutral' | 'success' | 'attention' | 'danger' | 'info';
  /** 虚线描边（待确认、推断） */
  dashed?: boolean;
  /** tooltip */
  title?: string;
  /** 标签文字 */
  children: ReactNode;
}

export function Pill({ tone = 'paper', dashed, title, children }: PillProps) {
  return (
    <span className={styles.pill} data-stub="Pill" data-tone={tone} data-dashed={dashed || undefined} title={title}>
      {children}
    </span>
  );
}

export const PillDemos: Array<{ name: string; props: PillProps }> = [
  { name: 'paper', props: { children: '角色任务' } },
  { name: 'mission', props: { tone: 'mission', children: '用户陈述' } },
  { name: 'neutral', props: { tone: 'neutral', children: '看到的' } },
  { name: 'success', props: { tone: 'success', children: '✓ 你确认的' } },
  { name: 'attention', props: { tone: 'attention', children: '待处理' } },
  { name: 'warning', props: { tone: 'attention', title: '内容已更新', children: '▲ 内容已更新 │ 按最新内容改' } },
  { name: 'danger', props: { tone: 'danger', children: '■ 失败' } },
  { name: 'info', props: { tone: 'info', children: '进行中' } },
  { name: 'dashed', props: { tone: 'attention', dashed: true, children: '推断的 │ 确认后才算数' } },
  { name: 'dashed-paper', props: { dashed: true, children: '待确认' } },
];
