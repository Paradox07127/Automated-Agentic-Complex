import type { ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import type { CatalogEntry } from './catalog';
import styles from './CatalogView.module.css';

export interface CatalogViewProps {
  entries: CatalogEntry[];
  /** Wraps each rendered demo, e.g. in ChartState for `?state=`. */
  wrap?: (node: ReactNode) => ReactNode;
}

/** Lists every demo, or only `?c=<Name>&d=<demo>` when given (one component, one demo, for screenshots). */
export function CatalogView({ entries, wrap = (n) => n }: CatalogViewProps) {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const q = new URLSearchParams(search);
  const c = q.get('c');
  const d = q.get('d');
  const shown = c ? entries.filter((e) => e.name === c) : entries;

  if (c && shown.length === 0) return <p className={styles.missing}>没有组件 {c}</p>;

  return (
    <div className={styles.root} data-catalog-filter={c ?? 'all'}>
      {shown.map((e) => (
        <section key={e.name} className={styles.entry} data-component={e.name}>
          <h2 className={styles.name}>
            {e.name}
            <span className={styles.group}>{e.group}</span>
          </h2>
          {e.demos
            .filter((demo) => !d || demo.name === d)
            .map((demo) => (
              <figure key={demo.name} className={styles.demo} data-demo={`${e.name}-${demo.name}`} data-modal-inline="">
                <figcaption className={styles.caption}>{demo.name}</figcaption>
                <div className={styles.stage}>{wrap(<e.component {...demo.props} />)}</div>
              </figure>
            ))}
        </section>
      ))}
    </div>
  );
}
