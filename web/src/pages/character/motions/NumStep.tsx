import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import styles from './NumStep.module.css';

export interface NumStepProps {
  /** Read out as the field's name; the arrows add 「减少」 and 「增加」. */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Shift with an arrow. */
  big: number;
  /** Decimals shown. */
  digits?: number;
  /** Differs from the pack's: a yellow frame. */
  changed?: boolean;
  disabled?: boolean;
  onCommit: (v: number) => void;
}

/** 游戏式切换器 ◀ 值 ▶：点箭头 ±step（Shift ±big），中间的数可以直接输入，↑↓ 同箭头；超出范围的值收到 min–max。 */
export function NumStep(p: NumStepProps) {
  const [text, setText] = useState<string | null>(null);
  const fix = (v: number) => Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));
  const show = (v: number) => (p.digits ? v.toFixed(p.digits) : String(v));
  const put = (v: number) => {
    const next = Number(fix(v).toFixed(p.digits ?? 0));
    if (next !== p.value) p.onCommit(next);
  };
  const commit = () => {
    if (text === null) return;
    setText(null);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) put(n);
  };
  const by = (dir: number) => (e: MouseEvent | KeyboardEvent) => put(p.value + dir * (e.shiftKey ? p.big : p.step));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setText(null);
      by(e.key === 'ArrowUp' ? 1 : -1)(e);
    }
  };
  return (
    <span className={styles.step} data-changed={p.changed || undefined} aria-disabled={p.disabled || undefined}>
      <button type="button" className={styles.ar} tabIndex={-1} aria-label={`${p.label}：减少`} disabled={p.disabled || p.value <= p.min} onClick={by(-1)}>
        <i aria-hidden="true" data-dir="l" />
      </button>
      <input
        className={styles.val}
        type="number"
        inputMode="decimal"
        min={p.min}
        max={p.max}
        step={p.step}
        aria-label={p.label}
        value={text ?? show(p.value)}
        disabled={p.disabled}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      <button type="button" className={styles.ar} tabIndex={-1} aria-label={`${p.label}：增加`} disabled={p.disabled || p.value >= p.max} onClick={by(1)}>
        <i aria-hidden="true" data-dir="r" />
      </button>
    </span>
  );
}
