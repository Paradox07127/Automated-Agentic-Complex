import { useId, useRef } from 'react';
import { useToggleClip } from './ToggleClip';
import { useControlled } from './useControlled';
import styles from './Toggle.module.css';

/** 开关：圆角槽上深色滑块盖住「开 | 关」中当前一侧，role=switch，空格切换；列表内用 sm。 */
export interface ToggleProps {
  /** 是否打开 */
  on: boolean;
  /** 读屏名称 */
  label: string;
  /** 92×20 / 72×20，默认 md */
  size?: 'md' | 'sm';
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因 */
  disabledReason?: string;
  /** 切换 */
  onChange?: (on: boolean) => void;
}

export function Toggle({ on, label, size = 'md', disabled, disabledReason, onChange }: ToggleProps) {
  const [checked, setChecked] = useControlled(on, onChange);
  const reasonId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  useToggleClip(ref, checked);
  const control = (
    <button
      ref={ref}
      type="button"
      role="switch"
      className={styles.tgl}
      data-stub="Toggle"
      data-size={size}
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      title={disabled ? disabledReason : undefined}
      onClick={() => {
        if (!disabled) setChecked(!checked);
      }}
    >
      <i className={styles.light} aria-hidden="true" />
      <i className={styles.knob} data-part="knob" data-g="knob" aria-hidden="true" />
      <span className={styles.labels} aria-hidden="true">
        <span className={styles.side} data-t="开" />
        <span className={styles.side} data-t="关" />
      </span>
    </button>
  );
  if (!(disabled && disabledReason)) return control;
  // The reason lives outside the switch so it describes, not names, it.
  return (
    <>
      {control}
      <span id={reasonId} hidden>
        {disabledReason}
      </span>
    </>
  );
}

export const ToggleDemos: Array<{ name: string; props: ToggleProps }> = [
  { name: 'on', props: { on: true, label: '观察电脑上的活动' } },
  { name: 'off', props: { on: false, label: '窗口文字' } },
  { name: 'on-sm', props: { on: true, label: '终端', size: 'sm' } },
  { name: 'off-sm', props: { on: false, label: '网页正文', size: 'sm' } },
  { name: 'disabled', props: { on: false, label: '附上截图', disabled: true, disabledReason: '屏幕录制未允许' } },
  { name: 'disabled-on-sm', props: { on: true, label: '辅助功能', size: 'sm', disabled: true, disabledReason: '由系统设置控制' } },
];
