import { useId, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { StatusTag } from './StatusTag';
import styles from './Row.module.css';

/** 列表行 = 任务行：暗底板右侧圆角，左 4 px 类别条常显（none 只在指向时出现），外部会话用虚线框；选中加浅色带与类别色斜纹，带子从右向左展开。 */
export interface RowProps {
  /** 标题 */
  title: ReactNode;
  /** 副行 */
  sub?: ReactNode;
  /** 左类别条：角色任务 / 编码会话 / 外部会话（虚线框） */
  category?: 'mission' | 'neutral' | 'ext' | 'none';
  /** 「需要你」：类别条换成等你橙 */
  attention?: boolean;
  /** 高 56 / 40，默认 task */
  height?: 'task' | 'compact';
  /** 右上角标（「需要你」等） */
  badge?: ReactNode;
  /** 右侧读数或操作 */
  right?: ReactNode;
  /** 选中 */
  selected?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因 */
  disabledReason?: string;
  /** 点击；带事件，页面可读修饰键（⌥ 点只看这一个） */
  onClick?: (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  /** 悬停提示（禁用时让给禁用原因） */
  tip?: string;
  /** `data-*` 透传到行根元素（定位、跳转落点） */
  [data: `data-${string}`]: string | number | boolean | undefined;
}

export function Row({ title, sub, category = 'none', attention, height = 'task', badge, right, selected, disabled, disabledReason, onClick, tip, ...data }: RowProps) {
  const reasonId = useId();
  const activate = (e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    if (!disabled) onClick?.(e);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(e);
    }
  };
  return (
    <div
      {...data}
      role="button"
      tabIndex={0}
      className={styles.row}
      data-stub="Row"
      data-category={category}
      data-attention={attention || undefined}
      data-height={height}
      aria-pressed={!!selected}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      title={disabled ? disabledReason : tip}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      <div className={styles.inner}>
        <div className={styles.main}>
          <span className={styles.title}>{title}</span>
          {sub && <span className={styles.sub}>{sub}</span>}
          {disabled && disabledReason && (
            <span id={reasonId} className={styles.reason}>
              {disabledReason}
            </span>
          )}
        </div>
        {(badge || right) && (
          <div className={styles.side}>
            {badge && <span className={styles.badge}>{badge}</span>}
            {right && <span className={styles.right}>{right}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export const RowDemos: Array<{ name: string; props: RowProps }> = [
  { name: 'task', props: { title: '整理本周提交周报', sub: '角色任务 │ 18 分钟', category: 'mission', right: '3/5' } },
  { name: 'waiting', props: { title: 'Codex 想修改 HostLink.swift', sub: '审批 │ Codex │ 修 HostLink 断线重连', category: 'neutral', attention: true, badge: <StatusTag state="awaiting_approval" label="待处理" />, right: '剩余 23 s' } },
  { name: 'selected', props: { title: '修 HostLink 断线重连', sub: 'Codex │ 12 分钟', category: 'neutral', selected: true, right: '12 分钟' } },
  { name: 'selected-mission', props: { title: '汇总 10 月开销表', sub: '角色任务 │ 6 分钟', category: 'mission', selected: true, right: '2/5' } },
  { name: 'ext', props: { title: '回归与安装验证', sub: 'Claude Code │ 外部', category: 'ext', height: 'compact' } },
  { name: 'compact', props: { title: '偏好：周报按项目分组', category: 'none', height: 'compact', right: '今天 11:02' } },
  { name: 'disabled', props: { title: '生成 Metal 渲染基准报告', sub: '角色任务 │ 已归档', category: 'mission', disabled: true, disabledReason: '已归档的任务不能重新打开' } },
];
