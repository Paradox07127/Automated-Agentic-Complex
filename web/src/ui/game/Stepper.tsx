import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent as PressEvent, type ReactElement } from 'react';
import { placePopup, usePopupLayer } from '../popup';
import { useControlled } from '../useControlled';
import styles from './Stepper.module.css';

/** More values than this: the value between the arrows opens a list of them all. */
const MENU_OVER = 6;
const LIST_MAX = 260;

/** 步进器 ◀ 值 ▶：下面一排位置刻度（当前黄、默认值上方白刻痕）；值超过 6 个时中间的值点开下拉列表。←→ 换值。给 min / max / step 是数字款：中间的数可以直接输入。 */
export type StepperProps = StepperListProps | StepperNumberProps;

export interface StepperListProps {
  /** 读屏名称 */
  label: string;
  /** 取值，按顺序 */
  options: Array<{ value: string; label: string }>;
  /** 当前值 */
  value: string;
  /** 默认值：刻度上标出，列表里写「默认」 */
  defaultValue?: string;
  disabled?: boolean;
  /** 强制展开下拉（演示、截图） */
  open?: boolean;
  /** 紧凑款：矮一号、窄一号 */
  compact?: boolean;
  onChange?: (value: string) => void;
}

/** 数字款 ◀ 数 ▶：箭头 ±step（Shift ±big），中间的数可以直接输入（回车或离开时提交），↑↓ 同箭头；超出的值收到 min–max。 */
export interface StepperNumberProps {
  /** 读屏名称；两个箭头是「减少」「增加」 */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Shift 加箭头一次走多少，默认 step */
  big?: number;
  /** 显示几位小数 */
  digits?: number;
  /** 和包里的不一样：黄框黄字 */
  changed?: boolean;
  disabled?: boolean;
  /** 禁用时悬停说的原因 */
  disabledReason?: string;
  compact?: boolean;
  /** 实心深底：放在浅色页面的行里也够对比度 */
  solid?: boolean;
  /** 不在输入时怎么写这个数（「128k」「$2.50」）；输入时写原数 */
  format?: (value: number) => string;
  onChange?: (value: number) => void;
}

function Chev({ left }: { left?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" strokeWidth="2.6" />
    </svg>
  );
}

export function Stepper(p: StepperNumberProps): ReactElement;
export function Stepper(p: StepperListProps): ReactElement;
export function Stepper(p: StepperProps): ReactElement {
  return 'min' in p ? <NumberStepper {...p} /> : <ListStepper {...p} />;
}

function NumberStepper({ label, value, min, max, step, big = step, digits, changed, disabled, disabledReason, compact, solid, format, onChange }: StepperNumberProps) {
  const [text, setText] = useState<string | null>(null);
  const put = (v: number) => {
    const next = Number(Math.min(max, Math.max(min, Math.round(v / step) * step)).toFixed(digits ?? 0));
    if (next !== value) onChange?.(next);
  };
  const commit = () => {
    if (text === null) return;
    setText(null);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) put(n);
  };
  const by = (dir: number) => (e: PressEvent | KeyboardEvent) => put(value + dir * (e.shiftKey ? big : step));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setText(null);
      by(e.key === 'ArrowUp' ? 1 : -1)(e);
    }
  };
  return (
    <div className={styles.wrap} data-stub="Stepper" data-size={compact ? 'compact' : undefined} data-changed={changed || undefined} data-solid={solid || undefined}>
      <div className={styles.step} data-num="" aria-disabled={disabled || undefined} title={disabled ? disabledReason : undefined}>
        <button type="button" className={styles.ar} tabIndex={-1} aria-label={`${label}：减少`} disabled={disabled || value <= min} onClick={by(-1)}>
          <Chev left />
        </button>
        <input
          className={styles.num}
          type={format ? 'text' : 'number'}
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          aria-label={label}
          value={text ?? (format ? format(value) : digits ? value.toFixed(digits) : String(value))}
          disabled={disabled}
          onFocus={format ? () => setText(String(value)) : undefined}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={onKey}
        />
        <button type="button" className={styles.ar} tabIndex={-1} aria-label={`${label}：增加`} disabled={disabled || value >= max} onClick={by(1)}>
          <Chev />
        </button>
      </div>
    </div>
  );
}

function ListStepper({ label, options, value, defaultValue, disabled, open: forced, compact, onChange }: StepperListProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const i = options.findIndex((o) => o.value === current);
  const menu = options.length > MENU_OVER;
  const [openState, setOpen] = useState(false);
  const open = menu && (!!forced || openState);
  const [active, setActive] = useState(Math.max(0, i));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const text = (o: { value: string; label: string } | undefined) => o?.label ?? current;

  const place = useCallback(() => {
    const r = root.current?.getBoundingClientRect();
    const l = list.current;
    if (!r || !l) return null;
    return { ...placePopup(r, r.width, l.scrollHeight, 'left', LIST_MAX), width: r.width };
  }, []);
  const { inline, layer, portal } = usePopupLayer(open, root, place);

  useEffect(() => {
    if (!openState || forced) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [openState, forced]);

  useEffect(() => {
    if (openState) list.current?.focus();
  }, [openState]);

  const go = (k: number) => {
    const o = options[k];
    if (!o || disabled) return;
    if (o.value !== current) setCurrent(o.value);
  };
  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const show = () => {
    if (disabled) return;
    setActive(Math.max(0, i));
    setOpen(true);
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (list.current?.contains(e.target as Node)) return;
    const by = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!by) return;
    e.preventDefault();
    go(i + by);
  };
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    show();
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const move: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last };
    if (e.key in move) {
      e.preventDefault();
      setActive(move[e.key] ?? active);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go(active);
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      trigger.current?.focus();
      if (e.shiftKey) e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={styles.wrap} data-stub="Stepper" data-size={compact ? 'compact' : undefined}>
      <div ref={root} role="group" aria-label={label} className={styles.step} data-open={open || undefined} aria-disabled={disabled || undefined} onKeyDown={onRowKey}>
        <button type="button" className={styles.ar} aria-label={`${label}：上一个`} disabled={disabled || i <= 0} onClick={() => go(i - 1)}>
          <Chev left />
        </button>
        <span className={styles.mid}>
          {menu ? (
            <button
              ref={trigger}
              type="button"
              className={styles.val}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls={open ? `${id}-list` : undefined}
              aria-label={`${label}：${text(options[i])}`}
              disabled={disabled}
              onClick={() => (openState ? close(false) : show())}
              onKeyDown={onTriggerKey}
            >
              <span className={styles.text}>{text(options[i])}</span>
              <i className={styles.caret} aria-hidden="true" />
            </button>
          ) : (
            <span className={styles.val} data-value="">
              <span className={styles.text}>{text(options[i])}</span>
            </span>
          )}
          <span className={styles.pips} aria-hidden="true">
            {options.map((o, k) => (
              <i key={o.value} data-on={k === i || undefined} data-default={o.value === defaultValue || undefined} />
            ))}
          </span>
        </span>
        <button type="button" className={styles.ar} aria-label={`${label}：下一个`} disabled={disabled || i < 0 || i >= options.length - 1} onClick={() => go(i + 1)}>
          <Chev />
        </button>
      </div>
      {open &&
        inline !== undefined &&
        portal(
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            data-overlay=""
            className={styles.list}
            style={inline ? undefined : layer?.place}
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${id}-o${active}`}
            onKeyDown={onListKey}
          >
            {options.map((o, k) => (
              <li
                key={o.value}
                id={`${id}-o${k}`}
                role="option"
                className={styles.opt}
                aria-selected={k === i}
                data-active={k === active || undefined}
                onMouseEnter={() => setActive(k)}
                onClick={() => {
                  go(k);
                  close(true);
                }}
              >
                <span className={styles.ix} aria-hidden="true">
                  {String(k + 1).padStart(2, '0')}
                </span>
                <span className={styles.optLabel}>{o.label}</span>
                {o.value === defaultValue && <span className={styles.dt}>默认</span>}
              </li>
            ))}
          </ul>,
        )}
    </div>
  );
}

const LENGTH = [
  { value: 'short', label: '短' },
  { value: 'mid', label: '中' },
  { value: 'long', label: '长' },
];
const COLORS = ['Black', 'Silver', 'Gold', 'Ash', 'Rose', 'Teal', 'Ink', 'Snow'].map((c) => ({ value: c.toLowerCase(), label: c }));

export const StepperDemos: Array<{ name: string; props: StepperProps }> = [
  { name: 'three', props: { label: '裙摆', options: LENGTH, value: 'short', defaultValue: 'long' } },
  { name: 'menu', props: { label: 'Hair Color', options: COLORS, value: 'silver', defaultValue: 'black' } },
  { name: 'menu-open', props: { label: 'Hair Color', options: COLORS, value: 'silver', defaultValue: 'black', open: true } },
  { name: 'disabled', props: { label: '裙摆', options: LENGTH, value: 'mid', defaultValue: 'mid', disabled: true } },
  { name: 'compact', props: { label: '裙摆', options: LENGTH, value: 'short', defaultValue: 'long', compact: true } },
  { name: 'number', props: { label: '权重', value: 12, min: 1, max: 100000, step: 1, big: 10, changed: true } },
  { name: 'number-compact', props: { label: '保持秒数', value: 1.5, min: 0, max: 600, step: 0.5, big: 2, digits: 1, compact: true } },
  { name: 'number-format', props: { label: '上下文长度', value: 128000, min: 16000, max: 2000000, step: 16000, format: (n) => `${Math.round(n / 1000)}k` } },
  { name: 'number-disabled', props: { label: '费用上限', value: 2.5, min: 0.5, max: 20, step: 0.5, digits: 2, format: (n) => `$${n.toFixed(2)}`, disabled: true, disabledReason: '这个模型没有目录价格' } },
  { name: 'number-solid', props: { label: '最大输出', value: 4096, min: 1024, max: 32768, step: 1024, solid: true } },
];
