import styles from './Pip.module.css';

export interface PipProps {
  tone: 'ok' | 'paused' | 'failed' | 'idle';
  label: string;
}

/** Small state mark with its words: ink block ok, dashed frame paused, yellow block failed. */
export function Pip({ tone, label }: PipProps) {
  return (
    <span className={styles.pip} data-tone={tone}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
