import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { placePopup, usePopupLayer } from '../popup';
import { useControlled } from '../useControlled';
import styles from './Stepper.module.css';

/** More values than this: the value between the arrows opens a list of them all. */
const MENU_OVER = 6;
const LIST_MAX = 260;

/** 步进器 ◀ 值 ▶：下面一排位置刻度（当前黄、默认值上方白刻痕）；值超过 6 个时中间的值点开下拉列表。←→ 换值。 */
export interface StepperProps {
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
  onChange?: (value: string) => void;
}

function Chev({ left }: { left?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" strokeWidth="2.6" />
    </svg>
  );
}

export function Stepper({ label, options, value, defaultValue, disabled, open: forced, onChange }: StepperProps) {
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
    <div className={styles.wrap} data-stub="Stepper">
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
];
