import { useRef, type KeyboardEvent } from 'react';
import { useControlled } from './useControlled';
import styles from './Seg.module.css';

/** 分段控件：2–4 项，role=radiogroup；超过 4 项改用 Select。 */
export interface SegProps {
  /** 选项，2–4 个；disabledReason 是禁用项的 tooltip */
  options: Array<{ value: string; label: string; disabled?: boolean; disabledReason?: string | undefined }>;
  /** 当前值 */
  value: string;
  /** 读屏名称 */
  label: string;
  /** 高 28 / 24，默认 md */
  size?: 'md' | 'sm';
  /** 选择 */
  onChange?: (value: string) => void;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function Seg({ options, value, label, size = 'md', onChange }: SegProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const selIndex = options.findIndex((o) => o.value === current);
  const tabStop = selIndex >= 0 && !options[selIndex]?.disabled ? selIndex : (enabled[0] ?? -1);

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setCurrent(o.value);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(selIndex));
    let target: number | undefined;
    const step = NEXT[e.key];
    if (step) target = enabled[(pos + step + enabled.length) % enabled.length];
    else if (e.key === 'Home') target = enabled[0];
    else if (e.key === 'End') target = enabled[enabled.length - 1];
    if (target === undefined) return;
    e.preventDefault();
    pick(target);
  };

  return (
    <div role="radiogroup" className={styles.seg} data-stub="Seg" data-size={size} aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className={styles.opt}
          aria-checked={o.value === current}
          disabled={o.disabled}
          title={o.disabled ? o.disabledReason : undefined}
          tabIndex={i === tabStop ? 0 : -1}
          onClick={() => pick(i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const SegDemos: Array<{ name: string; props: SegProps }> = [
  { name: 'source', props: { label: '来源', value: 'all', options: [{ value: 'all', label: '全部' }, { value: 'role', label: '角色' }, { value: 'code', label: '编码' }, { value: 'ext', label: '外部' }] } },
  { name: 'range', props: { label: '范围', value: '24h', size: 'sm', options: [{ value: '24h', label: '24 h' }, { value: '7d', label: '7 天' }] } },
  { name: 'disabled-option', props: { label: '保留期', value: '7d', options: [{ value: '7d', label: '7 天' }, { value: '30d', label: '30 天' }, { value: 'all', label: '全部保留', disabled: true }] } },
];
