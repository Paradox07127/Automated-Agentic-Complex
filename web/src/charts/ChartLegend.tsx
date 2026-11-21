import type { ReactNode } from 'react';
import styles from './chart.module.css';

export interface LegendItem {
  key: string;
  /** Shape glyph in the state colour. */
  mark: ReactNode;
  label: string;
  count: number;
}

/** Legend row under a chart: glyph, label and count per item; zero counts stay listed but greyed. */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className={styles.legend} data-chart-legend="">
      {items.map((it) => (
        <li key={it.key} className={styles.legendItem} data-key={it.key} data-zero={it.count === 0 || undefined}>
          {it.mark}
          {it.label} <span className={styles.num}>{it.count}</span>
        </li>
      ))}
    </ul>
  );
}
