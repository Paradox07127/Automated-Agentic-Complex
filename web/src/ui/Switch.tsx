import { useId, useRef } from 'react';
import { useToggleClip } from './ToggleClip';
import { useControlled } from './useControlled';
import styles from './Switch.module.css';

/** 布尔开关：圆角槽、滑块带「开 / 关」，role=switch，空格或回车切换。 */
export interface SwitchProps {
  /** 是否打开 */
  checked: boolean;
  /** 读屏名称 */
  label: string;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因，悬停和读屏都能看到 */
  disabledReason?: string;
  /** 切换 */
  onChange?: (checked: boolean) => void;
}

export function Switch({ checked, label, disabled, disabledReason, onChange }: SwitchProps) {
  const [on, setOn] = useControlled(checked, onChange);
  const reasonId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  useToggleClip(ref, on);
  const flip = () => {
    if (!disabled) setOn(!on);
  };
  const control = (
    <button
      ref={ref}
      type="button"
      role="switch"
      className={styles.sw}
      data-stub="Switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      title={disabled ? disabledReason : undefined}
      onClick={flip}
      onKeyDown={(e) => {
        // Handle both keys here so a key press flips once in every engine (no synthesized click).
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        flip();
      }}
      onKeyUp={(e) => {
        if (e.key === ' ') e.preventDefault();
      }}
    >
      <i className={styles.track} aria-hidden="true" />
      <i className={styles.light} aria-hidden="true" />
      <i className={styles.knob} data-part="knob" data-g="knob" aria-hidden="true" />
      <span className={styles.labels} aria-hidden="true">
        <span className={styles.side} data-t="开" />
        <span className={styles.side} data-t="关" />
      </span>
    </button>
  );
  if (!(disabled && disabledReason)) return control;
  return (
    <>
      {control}
      <span id={reasonId} hidden>
        {disabledReason}
      </span>
    </>
  );
}

export const SwitchDemos: Array<{ name: string; props: SwitchProps }> = [
  { name: 'on', props: { checked: true, label: '观察电脑上的活动' } },
  { name: 'off', props: { checked: false, label: '窗口文字' } },
  { name: 'disabled', props: { checked: false, label: '附上截图', disabled: true, disabledReason: '屏幕录制未允许' } },
  { name: 'disabled-on', props: { checked: true, label: '辅助功能', disabled: true, disabledReason: '由系统设置控制' } },
];
