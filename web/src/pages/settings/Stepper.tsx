import styles from './Stepper.module.css';

export interface StepperProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  format?: (v: number) => string;
  disabled?: boolean;
  disabledReason?: string;
  onChange?: (v: number) => void;
}

/** Number stepper for the limit rows: light pill「− 300 秒 +」, bounded by the backend range. */
export function Stepper({ value, min, max, step, label, format = String, disabled, disabledReason, onChange }: StepperProps) {
  const go = (d: number) => onChange?.(Math.min(max, Math.max(min, Number((value + d).toFixed(2)))));
  return (
    <span className={styles.stepper} data-disabled={disabled || undefined} role="group" aria-label={label} title={disabled ? disabledReason : undefined}>
      <button type="button" aria-label={`${label} 减少`} disabled={disabled || value <= min} onClick={() => go(-step)}>
        −
      </button>
      <output className={styles.v} aria-live="polite">
        {format(value)}
      </output>
      <button type="button" aria-label={`${label} 增加`} disabled={disabled || value >= max} onClick={() => go(step)}>
        +
      </button>
    </span>
  );
}
