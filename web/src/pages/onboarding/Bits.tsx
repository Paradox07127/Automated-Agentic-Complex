import { LoadBar } from '../../ui/game';
import styles from './Bits.module.css';

/** A wait with no progress value: the tip over the shared indeterminate LoadBar. */
export function Loading({ tip }: { tip: string }) {
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <span className={styles.tip}>{tip}</span>
      <LoadBar fraction={0} indeterminate />
    </div>
  );
}
