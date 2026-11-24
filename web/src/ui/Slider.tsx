import { useEffect, useState, type CSSProperties } from 'react';
import { useControlled } from './useControlled';
import styles from './Slider.module.css';

/** 滑条：细槽、更细的填充、38×6 横条把手，默认值处画刻度，右侧读数可直接输入。 */
export interface SliderProps {
  /** 当前值 */
  value: number;
  /** 最小值 */
  min: number;
  /** 最大值 */
  max: number;
  /** 读屏名称 */
  label: string;
  /** 步长，默认 1 */
  step?: number;
  /** 默认值刻度 */
  defaultValue?: number;
  /** 读数单位，例如 % */
  unit?: string;
  /** 禁用 */
  disabled?: boolean;
  /** 变更 */
  onChange?: (value: number) => void;
}

const frac = (v: number, min: number, max: number) => (max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0);

export function Slider({ value, min, max, label, step = 1, defaultValue, unit, disabled, onChange }: SliderProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) setDraft(null);
  }, [disabled]);

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (disabled || draft.trim() === '' || !Number.isFinite(n)) return;
    const snapped = Math.round((n - min) / step) * step + min;
    setCurrent(Math.min(max, Math.max(min, Number(snapped.toFixed(6)))));
  };

  const style = { '--fill-n': frac(current, min, max), '--tick-n': defaultValue != null ? frac(defaultValue, min, max) : undefined } as CSSProperties;

  return (
    <div className={styles.slider} data-stub="Slider" data-default={defaultValue} data-disabled={disabled || undefined} style={style}>
      <span className={styles.track}>
        <input
          type="range"
          className={styles.range}
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={disabled}
          aria-valuetext={`${current}${unit ?? ''}`}
          onChange={(e) => setCurrent(Number(e.currentTarget.value))}
        />
        {defaultValue != null && <i className={styles.tick} aria-hidden="true" title={`默认 ${defaultValue}${unit ?? ''}`} />}
      </span>
      {draft === null ? (
        <button type="button" className={styles.readout} disabled={disabled} aria-label={`${label}：${current}${unit ?? ''}，点击输入`} onClick={() => setDraft(String(current))}>
          {current}
          {unit && <small>{unit}</small>}
        </button>
      ) : (
        <input
          className={styles.edit}
          type="number"
          inputMode="decimal"
          aria-label={`${label}（${min}–${max}）`}
          min={min}
          max={max}
          step={step}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setDraft(null);
          }}
        />
      )}
    </div>
  );
}

export const SliderDemos: Array<{ name: string; props: SliderProps }> = [
  { name: 'scale', props: { label: '大小', value: 100, min: 50, max: 200, defaultValue: 100, unit: '%' } },
  { name: 'changed', props: { label: '音量', value: 35, min: 0, max: 100, defaultValue: 70, unit: '%' } },
  { name: 'disabled', props: { label: '透明度', value: 80, min: 0, max: 100, step: 5, unit: '%', disabled: true } },
];
