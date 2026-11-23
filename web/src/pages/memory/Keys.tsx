import { keyText } from '../../bridge/platformText';
import styles from './Keys.module.css';

/** The bottom bar's key legend: `[↑][↓] 选择  [Enter] 修改 …`; a narrow or short window keeps the first two. */
export function Keys({ keys }: { keys: Array<[string[], string]> }) {
  return (
    <span className={styles.keys}>
      {keys.map(([caps, what], i) => (
        <span key={what} className={styles.k} data-more={i >= 2 || undefined}>
          {caps.map((c) => (
            <kbd key={c}>{keyText(c)}</kbd>
          ))}
          {what}
        </span>
      ))}
    </span>
  );
}
