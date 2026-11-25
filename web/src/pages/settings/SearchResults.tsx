import { Icon } from '../../ui';
import { GROUP_LABEL, type RegEntry } from './registry';
import { SetSection } from './SetSection';
import styles from './SearchResults.module.css';

export interface SearchResultsProps {
  q: string;
  results: RegEntry[];
  onPick: (r: RegEntry) => void;
}

/** The hit in yellow. */
function Hit({ text, q }: { text: string; q: string }) {
  const n = q.trim();
  const i = text.toLowerCase().indexOf(n.toLowerCase());
  if (!n || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n.length)}</mark>
      {text.slice(i + n.length)}
    </>
  );
}

function Result({ r, q, onPick }: { r: RegEntry; q: string; onPick: (r: RegEntry) => void }) {
  const away = r.group.startsWith('@');
  return (
    <li>
      <button type="button" className={styles.row} onClick={() => onPick(r)}>
        <span className={styles.main}>
          <span className={styles.title}>
            <span>
              <Hit text={r.label} q={q} />
            </span>
            {r.deletesData && <span className={styles.danger}>删数据</span>}
          </span>
          <span className={styles.crumb}>{away ? r.section : `设置 › ${GROUP_LABEL[r.group] ?? r.group} › ${r.section}`}</span>
        </span>
        <span className={styles.go} aria-hidden="true">
          {away ? '↗' : '›'}
        </span>
      </button>
    </li>
  );
}

/** Settings search: the rows here (label with the hit, 「设置 › 组 › 分区」), then the ones on other pages; a click or Enter deep-links to the first. */
export function SearchResults({ q, results, onPick }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <Icon name="search" size={32} />
        <span>未找到「{q.trim()}」，可尝试搜索「截图」「快捷键」「外发」</span>
      </div>
    );
  }
  const here = results.filter((r) => !r.group.startsWith('@'));
  const away = results.filter((r) => r.group.startsWith('@'));
  return (
    <div className={styles.res}>
      <p className={styles.count}>
        找到 <span className="num">{results.length}</span> 项 │ Enter 打开第一项
      </p>
      {here.length > 0 && (
        <ul className={styles.list} aria-label={`搜索结果 ${results.length} 项`}>
          {here.map((r) => (
            <Result key={r.id} r={r} q={q} onPick={onPick} />
          ))}
        </ul>
      )}
      {away.length > 0 && (
        <SetSection title="在别的页">
          <ul className={styles.list} aria-label="在别的页">
            {away.map((r) => (
              <Result key={r.id} r={r} q={q} onPick={onPick} />
            ))}
          </ul>
        </SetSection>
      )}
    </div>
  );
}
