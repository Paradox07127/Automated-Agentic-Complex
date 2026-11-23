import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { Slot, useFieldNote } from './fieldParts';
import { useControlled } from './useControlled';
import styles from './Field.module.css';

/** 单行输入：白胶囊，高 32（sm 24），聚焦 2 px 焦点环；禁用时虚线框，框下写原因；出错时红框，框下写错在哪。 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'prefix' | 'value' | 'className' | 'style' | 'aria-label'> {
  /** 读屏名称 */
  label: string;
  /** 当前文字；不给时由 defaultValue 起头、不受控 */
  value?: string;
  /** 文字变化 */
  onChange?: (value: string) => void;
  /** 高 32 / 24，默认 md */
  size?: 'md' | 'sm';
  /** 禁用时框下写的原因 */
  disabledReason?: string;
  /** 值不对：红框，aria-invalid */
  invalid?: boolean;
  /** invalid 时框下写的错误文字 */
  error?: string;
  /** 框内文字前（图标、单位、协议名） */
  prefix?: ReactNode;
  /** 框内文字后（单位、清除钮、小按钮） */
  suffix?: ReactNode;
  /** 等宽字（地址、路径、令牌、模型名） */
  mono?: boolean;
  /** 输入框引用 */
  inputRef?: Ref<HTMLInputElement>;
}

export function Field({ label, value, onChange, size = 'md', disabled, disabledReason, invalid, error, prefix, suffix, mono, inputRef, ...rest }: FieldProps) {
  const { aria, note } = useFieldNote({ disabled, disabledReason, invalid, error });
  const [text, setText] = useControlled(value ?? '', onChange);
  return (
    <span className={styles.field} data-stub="Field" data-size={size} data-invalid={invalid || undefined} data-disabled={disabled || undefined} data-mono={mono || undefined}>
      <span className={styles.box}>
        <Slot>{prefix}</Slot>
        <input
          {...rest}
          ref={inputRef}
          className={styles.input}
          value={value === undefined ? undefined : text}
          disabled={disabled}
          aria-label={label}
          {...aria}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Slot>{suffix}</Slot>
      </span>
      {note}
    </span>
  );
}

export const FieldDemos: Array<{ name: string; props: FieldProps }> = [
  { name: 'empty', props: { label: '服务地址', value: '', placeholder: '例如 http://127.0.0.1:8080' } },
  { name: 'filled', props: { label: '标题', value: '每日代码变更小结' } },
  { name: 'sm', props: { label: '时间', value: '18:30', size: 'sm' } },
  { name: 'mono', props: { label: '模型', value: 'claude-opus-5-5', mono: true } },
  { name: 'prefix-suffix', props: { label: '超时', value: '30', prefix: '超时', suffix: '秒', maxLength: 4 } },
  { name: 'disabled', props: { label: '令牌', value: '', type: 'password', placeholder: '粘贴令牌', disabled: true, disabledReason: '后台没有运行，开起来后才能改' } },
  { name: 'invalid', props: { label: '端口', value: '80a', invalid: true, error: '端口只能是 1 到 65535 的数字' } },
];
