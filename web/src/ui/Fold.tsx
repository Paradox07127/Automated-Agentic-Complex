import { useId, useState, type ReactNode } from 'react';
import styles from './Fold.module.css';

/** 折叠段（桌面卡，外观同对话页的折叠行）：上下细线间一行，箭头 + 标签 + 计数 + 收起时的摘要，默认收起，点一下展开。 */
export interface FoldProps {
  /** 给了就按 id 记住展开状态（页面生命周期内） */
  id?: string;
  /** 标签 */
  label: string;
  /** 标签后的计数 */
  count?: number;
  /** 收起时标签后的一行摘要 */
  summary?: ReactNode;
  /** 展开后的内容 */
  children: ReactNode;
}

const OPEN = new Map<string, boolean>();

export function Fold({ id, label, count, summary, children }: FoldProps) {
  const [open, setOpen] = useState(() => (id ? (OPEN.get(id) ?? false) : false));
  const bodyId = useId();
  const toggle = () => {
    if (id) OPEN.set(id, !open);
    setOpen(!open);
  };
  return (
    <div className={styles.fold} data-stub="Fold" data-open={open || undefined}>
      <button type="button" className={styles.head} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle}>
        <svg className={styles.chev} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className={styles.label}>{label}</span>
        {count != null && <span className={`${styles.count} num`}>{count}</span>}
        {!open && summary != null && <span className={styles.summary}>{summary}</span>}
      </button>
      {open && (
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
}
