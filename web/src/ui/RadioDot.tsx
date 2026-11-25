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
}

export function RadioDot({ checked, label, size = 'md', disabled, onSelect }: RadioDotProps) {
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
      tabIndex={onSelect ? 0 : -1}
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

export const RadioDotDemos: Array<{ name: string; props: RadioDotProps }> = [
  { name: 'on', props: { checked: true, label: '任务完成：出声', onSelect: () => {} } },
  { name: 'off', props: { checked: false, label: '任务完成：只出卡', onSelect: () => {} } },
  { name: 'sm', props: { checked: true, label: 'Codex', size: 'sm' } },
  { name: 'disabled', props: { checked: false, label: '提醒：不提示', disabled: true, onSelect: () => {} } },
];
