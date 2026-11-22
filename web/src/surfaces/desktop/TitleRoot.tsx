import styles from './TitleRoot.module.css';

/** `stack.html#/title?name=…&en=…`: 雷霆大字, the game's region banner (BigMapNode) with her name, played once in the middle
 *  of the screen she stands on after a character switch. Native covers that screen, shows the page once it has loaded and
 *  closes it after the 5.333 s; the page takes no pointer and calls nothing. */
export function TitleRoot() {
  const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const name = q.get('name') ?? '';
  const en = q.get('en') ?? '';
  return (
    <div className={styles.root} data-surface-root="title">
      <div className={styles.block} data-slot="block">
        <div className={styles.band} data-slot="band" aria-hidden="true" />
        <div className={styles.row}>
          <i className={styles.bar} data-slot="bar" aria-hidden="true" />
          <span className={styles.name} data-slot="name">
            {name}
          </span>
          <i className={styles.bar} data-slot="bar" aria-hidden="true" />
        </div>
        {en && (
          <span className={styles.sub} data-slot="sub">
            {en}
          </span>
        )}
      </div>
    </div>
  );
}
