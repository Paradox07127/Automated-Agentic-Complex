import { useId, type ReactNode } from 'react';
import styles from './Field.module.css';

/** Field and TextArea's shared outer frame: the line under the box says why it is disabled, or what is wrong. */
export function useFieldNote({ disabled, disabledReason, invalid, error }: { disabled?: boolean; disabledReason?: string; invalid?: boolean; error?: string }) {
  const id = useId();
  const err = invalid && error ? error : undefined;
  const why = !err && disabled && disabledReason ? disabledReason : undefined;
  const text = err ?? why;
  return {
    aria: {
      'aria-invalid': invalid || undefined,
      'aria-describedby': text ? id : undefined,
      'aria-errormessage': err ? id : undefined,
    },
    note: text ? (
      <span id={id} className={styles.note} data-kind={err ? 'error' : 'why'}>
        {text}
      </span>
    ) : null,
  };
}

/** A prefix or suffix slot inside the box. */
export function Slot({ children }: { children?: ReactNode }) {
  return children == null ? null : <span className={styles.slot}>{children}</span>;
}
