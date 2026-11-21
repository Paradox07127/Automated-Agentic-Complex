import type { CatalogEntry } from './catalog';
import styles from './CatalogToc.module.css';

export interface CatalogTocProps {
  ui: CatalogEntry[];
  charts: CatalogEntry[];
  features: CatalogEntry[];
}

function jump(name: string) {
  document.querySelector(`[data-component="${name}"]`)?.scrollIntoView({ block: 'start' });
}

/** `#/ds` contents: ui and features scroll to their section on this page; charts open on `#/dv`. */
export function CatalogToc({ ui, charts, features }: CatalogTocProps) {
  const groups: Array<[string, CatalogEntry[]]> = [['ui', ui], ['charts', charts], ['features', features]];
  return (
    <nav className={styles.toc} aria-label="目录">
      {groups.map(([label, entries]) => (
        <section key={label} className={styles.group}>
          <h2 className={styles.head}>
            {label} <span className={styles.count}>[{entries.length}]</span>
          </h2>
          <ul className={styles.list} aria-label={label}>
            {entries.map((e) => (
              <li key={`${e.group}/${e.name}`}>
                {label === 'charts' ? (
                  <a className={styles.item} href={`#/dv?c=${e.name}`}>
                    {e.name}
                  </a>
                ) : (
                  <button type="button" className={styles.item} onClick={() => jump(e.name)}>
                    {e.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
