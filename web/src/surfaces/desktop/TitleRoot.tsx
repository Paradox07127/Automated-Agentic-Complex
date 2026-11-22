import type { CSSProperties } from 'react';
import styles from './TitleRoot.module.css';

/** `stack.html#/title?name=…&en=…`: 雷霆大字, her name in the game's big white area title, shown still in the middle of the
 *  screen she stands on after a character switch. Native covers that screen, shows the page once it has loaded and closes it
 *  after 5.4 s; the page takes no pointer and calls nothing. */
export function TitleRoot() {
  const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const name = q.get('name') ?? '';
  const en = q.get('en') ?? '';
  // Gap between glyphs as a share of the screen width: wide for short names, near 0.2 % for long ones.
  const gap = 0.002 + 0.019875 * Math.exp(-([...name].length - 1));
  return (
    <div className={styles.root} data-surface-root="title">
      <div className={styles.block} data-slot="block" style={{ '--gap': `${gap * 100}vw` } as CSSProperties}>
        <i className={styles.shadow} data-slot="shadow" aria-hidden="true" />
        <span className={styles.name} data-slot="name">
          {name}
        </span>
        {en && (
          <span className={styles.sub} data-slot="sub">
            {en}
          </span>
        )}
      </div>
    </div>
  );
}
