import type { CSSProperties, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { Slot, useFieldNote } from './fieldParts';
import { useControlled } from './useControlled';
import styles from './Field.module.css';

/** 多行输入：和 Field 同一个白框，圆角 16（sm 12）；autoGrow 从一行起随内容长高，到 maxRows 行后滚动。 */
export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'prefix' | 'value' | 'className' | 'style' | 'aria-label'> {
  /** 读屏名称 */
  label: string;
  /** 当前文字；不给时由 defaultValue 起头、不受控 */
  value?: string;
  /** 文字变化 */
  onChange?: (value: string) => void;
  /** 字号和留白，默认 md */
  size?: 'md' | 'sm';
  /** 固定行数，默认 3；autoGrow 时不用 */
  rows?: number;
  /** 从一行起随内容长高（对话输入框） */
  autoGrow?: boolean;
  /** autoGrow 时最多长到几行，默认 5 */
  maxRows?: number;
  /** 禁用时框下写的原因 */
  disabledReason?: string;
  /** 值不对：红框，aria-invalid */
  invalid?: boolean;
  /** invalid 时框下写的错误文字 */
  error?: string;
  /** 框内文字前，贴底对齐 */
  prefix?: ReactNode;
  /** 框内文字后，贴底对齐 */
  suffix?: ReactNode;
  /** 等宽字 */
  mono?: boolean;
  /** 桌面浮层上（快速输入）：HUD 场底、四角小点、方角无框，大一号字，不能拖高 */
  hud?: boolean;
  /** 文本框引用 */
  textareaRef?: Ref<HTMLTextAreaElement>;
}

export function TextArea({ label, value, onChange, size = 'md', rows = 3, autoGrow, maxRows = 5, disabled, disabledReason, invalid, error, prefix, suffix, mono, hud, textareaRef, ...rest }: TextAreaProps) {
  const { aria, note } = useFieldNote({ disabled, disabledReason, invalid, error });
  const [text, setText] = useControlled(value ?? '', onChange);
  return (
    <span
      className={styles.field}
      data-stub="TextArea"
      data-multi=""
      data-size={size}
      data-autogrow={autoGrow || undefined}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      data-mono={mono || undefined}
      data-hud={hud || undefined}
      style={autoGrow ? ({ '--max-rows': String(maxRows) } as CSSProperties) : undefined}
    >
      <span className={styles.box}>
        <Slot>{prefix}</Slot>
        <textarea
          {...rest}
          ref={textareaRef}
          className={styles.input}
          rows={autoGrow ? 1 : rows}
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

export const TextAreaDemos: Array<{ name: string; props: TextAreaProps }> = [
  { name: 'empty', props: { label: '要求', value: '', placeholder: '要做什么，做到什么程度？' } },
  { name: 'filled', props: { label: '内容', value: '周五下午不开会。\n周报在周一上午发。', maxLength: 500 } },
  { name: 'auto-grow', props: { label: '消息', value: '', placeholder: '对管理员说…', autoGrow: true, maxRows: 5 } },
  { name: 'auto-grow-long', props: { label: '消息', value: '第一行\n第二行\n第三行\n第四行\n第五行\n第六行，超出五行后在框内滚动', autoGrow: true, maxRows: 5 } },
  { name: 'disabled', props: { label: '指令', value: '', placeholder: '交给后台作业执行的说明', disabled: true, disabledReason: '该任务正在运行，停止后方可修改' } },
  { name: 'invalid', props: { label: '要求', value: '', invalid: true, error: '要求不能为空' } },
  { name: 'hud', props: { label: '对 角色 说的话', value: '', placeholder: '帮我查这个报错', rows: 1, hud: true } },
];
