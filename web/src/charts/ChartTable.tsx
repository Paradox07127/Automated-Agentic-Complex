import type { KeyboardEvent, ReactNode } from 'react';
import styles from './chart.module.css';

/** 「以表格查看」/「以图查看」 switch shown by every axis chart; `icon` is the corner button. */
export function TableToggle({ on, onToggle, icon = false }: { on: boolean; onToggle: (on: boolean) => void; icon?: boolean }) {
  if (icon) {
    const text = on ? '以图查看' : '以表格查看';
    return (
      <button type="button" className={styles.tableIcon} aria-pressed={on} aria-label={text} title={text} data-table-toggle="" onClick={() => onToggle(!on)}>
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
          {on ? <path d="M2 12V7h2.5v5zM5.75 12V2h2.5v10zM9.5 12V5H12v7z" fill="currentColor" /> : <path d="M1.5 2.5h11v2h-11zM1.5 6h11v2h-11zM1.5 9.5h11v2h-11z" fill="currentColor" />}
        </svg>
      </button>
    );
  }
  return (
    <button type="button" className={styles.tableToggle} aria-pressed={on} data-table-toggle="" onClick={() => onToggle(!on)}>
      {on ? '以图查看' : '以表格查看'}
    </button>
  );
}

export interface TableColumn {
  label: string;
  align?: 'right';
}

export interface TableRow {
  key: string;
  cells: ReactNode[];
}

/** Table view of a chart: one row per mark, same data as the drawing. */
export function DataTable({ caption, columns, rows, selected, onRow }: { caption: string; columns: TableColumn[]; rows: TableRow[]; selected?: string | null; onRow?: (key: string) => void }) {
  const rowKey = (e: KeyboardEvent, key: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onRow?.(key);
  };
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-chart-table="">
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col" className={c.align === 'right' ? styles.right : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-row={r.key} aria-selected={selected != null ? r.key === selected : undefined} className={onRow ? styles.clickRow : undefined} tabIndex={onRow ? 0 : undefined} onClick={onRow ? () => onRow(r.key) : undefined} onKeyDown={onRow ? (e) => rowKey(e, r.key) : undefined}>
              {r.cells.map((c, i) => (
                <td key={i} className={columns[i]?.align === 'right' ? styles.right : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
