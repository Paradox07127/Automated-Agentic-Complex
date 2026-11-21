import { Empty, Icon } from '../../ui';
import { GROUP_LABEL, type RegEntry } from './registry';
import styles from './SearchResults.module.css';

export interface SearchResultsProps {
  q: string;
  results: RegEntry[];
  onPick: (r: RegEntry) => void;
}

/** Settings search: breadcrumb「分组 / 节」, data-deletion mark, click deep-links to the row. */
export function SearchResults({ q, results, onPick }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className={styles.empty}>
        <Empty icon="search" title={`没有找到「${q.trim()}」`} desc="试试别的说法，比如「截图」「热键」「外发」。" />
      </div>
    );
  }
  return (
    <ul className={styles.list} aria-label={`搜索结果 ${results.length} 项`}>
      <li className={styles.count}>
        找到 <span className="num">{results.length}</span> 项
      </li>
      {results.map((r) => (
        <li key={r.id}>
          <button type="button" className={styles.row} onClick={() => onPick(r)}>
            <span className={styles.main}>
              <span className={styles.title}>{r.label}</span>
              <span className={styles.crumb}>{r.group.startsWith('@') ? r.section : `${GROUP_LABEL[r.group] ?? r.group} / ${r.section}`}</span>
            </span>
            {r.deletesData && <span className={styles.danger}>删数据</span>}
            <Icon name="chev" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
