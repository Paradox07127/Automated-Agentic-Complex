import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { placePopup, usePopupLayer } from './popup';
import { useControlled } from './useControlled';
import styles from './Select.module.css';

/** The plate reaches 4 px past the caption on each side; the list is as wide. */
const PLATE_OUT = 4;
const LIST_MAX = 235;

/** 下拉：浅色胶囊，展开时灰色列表板从上方包住胶囊；默认值写「（默认）」，有风险的项加 ▲；最多显示 7 项。 */
export interface SelectProps {
  /** 当前值 */
  value: string;
  /** 选项 */
  options: Array<{ value: string; label: string; risky?: boolean }>;
  /** 读屏名称 */
  label: string;
  /** 值前面的灰字前缀，如「排序」；只给眼睛看，读屏名仍是 label */
  prefix?: string;
  /** 默认值，标「（默认）」 */
  defaultValue?: string;
  /** 强制展开（演示、截图） */
  open?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 宽度 px，默认填满控件列 */
  width?: number;
  /** 选择 */
  onChange?: (value: string) => void;
}

export function Select({ value, options, label, prefix, defaultValue, open: forced, disabled, width, onChange }: SelectProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const [openState, setOpen] = useState(false);
  const open = !!forced || openState;
  const selIndex = Math.max(0, options.findIndex((o) => o.value === current));
  const [active, setActive] = useState(selIndex);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const text = (v: string) => `${options.find((o) => o.value === v)?.label ?? v}${v === defaultValue ? '（默认）' : ''}`;

  const place = useCallback(() => {
    const d = root.current;
    const l = list.current;
    if (!d || !l) return null;
    const r = d.getBoundingClientRect();
    const plate = { top: r.top, bottom: r.bottom, left: r.left - PLATE_OUT, right: r.right + PLATE_OUT };
    const width = plate.right - plate.left;
    return { ...placePopup(plate, width, l.scrollHeight, 'left', LIST_MAX), width };
  }, []);
  const { inline, layer, portal } = usePopupLayer(open, root, place);
  const up = !inline && layer?.place.bottom !== undefined;

  useEffect(() => {
    if (!openState || forced) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (root.current && !root.current.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [openState, forced]);

  useEffect(() => {
    if (openState) list.current?.focus();
  }, [openState]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const show = () => {
    if (disabled) return;
    setActive(selIndex);
    setOpen(true);
  };
  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || disabled) return;
    setCurrent(o.value);
    close(true);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const move: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last };
    if (e.key in move) {
      e.preventDefault();
      setActive(move[e.key] ?? active);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      // The list sits at the end of body: Tab goes on from the trigger, Shift+Tab lands on it.
      trigger.current?.focus();
      if (e.shiftKey) e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={root} className={styles.drop} data-stub="Select" data-open={open || undefined} data-up={up || undefined} style={width ? { width } : undefined}>
      <button
        ref={trigger}
        type="button"
        className={styles.head}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={label}
        title={text(current)}
        disabled={disabled}
        onClick={() => (openState ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {prefix && (
          <span className={styles.prefix} data-prefix="" aria-hidden="true">
            {prefix}
          </span>
        )}
        <span className={styles.value}>{text(current)}</span>
        <span className={styles.tri} aria-hidden="true" />
      </button>
      {open && inline !== undefined && portal(
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          data-overlay=""
          className={styles.list}
          data-theme={inline ? undefined : layer?.theme}
          data-up={up || undefined}
          style={inline ? undefined : layer?.place}
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${id}-o${active}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-o${i}`}
              data-index={i}
              role="option"
              className={styles.opt}
              aria-selected={o.value === current}
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className={styles.optLabel}>{text(o.value)}</span>
              {o.risky && (
                <span className={styles.risk} title="有风险">
                  ▲<span className={styles.riskText}>有风险</span>
                </span>
              )}
              {o.value === current && <Icon name="check" size={12} />}
            </li>
          ))}
        </ul>,
      )}
    </div>
  );
}

const PROACTIVE = [
  { value: '安静', label: '安静' },
  { value: '适中', label: '适中' },
  { value: '活跃', label: '活跃', risky: true },
];

export const SelectDemos: Array<{ name: string; props: SelectProps }> = [
  { name: 'closed', props: { label: '主动程度', value: '适中', defaultValue: '适中', options: PROACTIVE } },
  { name: 'open', props: { label: '主动程度', value: '适中', defaultValue: '适中', open: true, options: PROACTIVE } },
  { name: 'prefix', props: { label: '排序方式', prefix: '排序', value: 'new', width: 160, options: [{ value: 'new', label: '最新' }, { value: 'old', label: '最早' }] } },
  { name: 'disabled', props: { label: '主动程度', value: '安静', defaultValue: '适中', disabled: true, options: PROACTIVE } },
  {
    name: 'long',
    props: {
      label: '模型',
      value: 'm3',
      width: 200,
      open: true,
      options: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'].map((v, i) => ({ value: v, label: `本地模型 ${i + 1}` })),
    },
  },
];
