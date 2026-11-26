import type { HTMLAttributes, KeyboardEvent } from 'react';
import styles from './RadioDot.module.css';

/** 单选圆点：选中时中心一个实心点，role=radio，点击或空格选中；已选中的再点不再触发。 */
export interface RadioDotProps {
  /** 是否选中 */
  checked: boolean;
  /** 读屏名称 */
  label: string;
  /** 18 / 14，默认 md；表格行里用 sm */
  size?: 'md' | 'sm';
  /** 禁用 */
  disabled?: boolean;
  /** 选中；不给时圆点不进 Tab 顺序，由外层（如表格行）负责点选 */
  onSelect?: () => void;
  /** 在 RadioDotGroup 里：是否是这一组唯一的 Tab 停点（选中的那个，没有选中时第一个）；不给时自己就是停点 */
  tabStop?: boolean;
}

export function RadioDot({ checked, label, size = 'md', disabled, onSelect, tabStop }: RadioDotProps) {
  const pick = () => {
    if (!disabled && !checked) onSelect?.();
  };
  return (
    <button
      type="button"
      role="radio"
      className={styles.dot}
      data-stub="RadioDot"
      data-size={size}
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={onSelect && tabStop !== false ? 0 : -1}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key !== ' ') return;
        e.preventDefault();
        pick();
      }}
      onKeyUp={(e) => {
        if (e.key === ' ') e.preventDefault();
      }}
    />
  );
}

const STEP: Readonly<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export interface RadioDotGroupProps extends HTMLAttributes<HTMLSpanElement> {
  /** 读屏组名 */
  label: string;
}

/** 一组单选圆点：role=radiogroup，方向键聚焦并选中前一个 / 后一个（首尾相接）；Tab 停点由各圆点的 tabStop 给出。 */
export function RadioDotGroup({ label, children, ...rest }: RadioDotGroupProps) {
  const move = (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = STEP[e.key];
    if (!step) return;
    const dots = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = dots.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (dots[at]!.getAttribute('aria-disabled') === 'true') return;
    const to = dots[(at + step + dots.length) % dots.length]!;
    to.focus();
    to.click();
  };
  return (
    <span role="radiogroup" aria-label={label} {...rest} onKeyDown={move}>
      {children}
    </span>
  );
}

export const RadioDotDemos: Array<{ name: string; props: RadioDotProps }> = [
  { name: 'on', props: { checked: true, label: '任务完成：出声', onSelect: () => {} } },
  { name: 'off', props: { checked: false, label: '任务完成：只出卡', onSelect: () => {} } },
  { name: 'sm', props: { checked: true, label: 'Codex', size: 'sm' } },
  { name: 'disabled', props: { checked: false, label: '提醒：不提示', disabled: true, onSelect: () => {} } },
];
