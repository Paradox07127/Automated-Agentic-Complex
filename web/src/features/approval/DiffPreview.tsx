import { useState } from 'react';
import styles from './DiffPreview.module.css';

/** 差异预览：Edit / Write 类审批可折叠的 content_preview，标题写「+N −M」。 */
export interface DiffPreviewProps {
  /** unified diff 片段 */
  preview: string;
  /** 默认展开 */
  defaultOpen?: boolean;
  /** 只画差异行，开合由外层管（会话卡里的紧凑审批） */
  bare?: boolean;
}

function lineClass(line: string): string | undefined {
  if (line.startsWith('@@')) return styles.hunk;
  if (line.startsWith('+')) return styles.add;
  if (line.startsWith('-')) return styles.del;
  return undefined;
}

/** Added and removed line counts of a unified diff snippet. */
export function diffCounts(preview: string): { added: number; removed: number } {
  const lines = preview.split('\n');
  return { added: lines.filter((l) => l.startsWith('+')).length, removed: lines.filter((l) => l.startsWith('-')).length };
}

export function DiffPreview({ preview, defaultOpen = false, bare }: DiffPreviewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = preview.split('\n');
  const { added, removed } = diffCounts(preview);
  return (
    <div data-stub="DiffPreview" className={styles.root} data-bare={bare || undefined}>
      {!bare && (
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} 差异预览{' '}
          <span className="num">
            <span className={styles.addN}>+{added}</span> <span className={styles.delN}>−{removed}</span>
          </span>
        </button>
      )}
      {(open || bare) && (
        <pre className={styles.diff} data-selectable="">
          {lines.map((l, i) => (
            <span key={i} className={lineClass(l)}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
