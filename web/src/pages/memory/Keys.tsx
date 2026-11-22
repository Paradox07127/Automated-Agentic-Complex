import type { ReactNode } from 'react';
import { keyText } from '../../bridge/platformText';
import { Glyph } from './parts';
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

/** Right group of the bottom bar: links, a capsule, the red 清空. */
export const BarEnd = ({ children }: { children: ReactNode }) => <span className={styles.end}>{children}</span>;

/** A link-looking button at the bottom bar's right (整理记录 ›). */
export const BarLink = ({ children, onClick }: { children: string; onClick: () => void }) => (
  <button type="button" className={styles.blink} onClick={onClick}>
    {children}
  </button>
);

/** The bottom bar's red text button (清空记忆…). */
export const BarDanger = ({ children, onClick }: { children: string; onClick: () => void }) => (
  <button type="button" className={styles.bdanger} onClick={onClick}>
    <Glyph name="trash" size={14} />
    {children}
  </button>
);
