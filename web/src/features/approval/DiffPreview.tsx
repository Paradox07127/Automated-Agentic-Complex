import { useId, useState } from 'react';
import { MoreLines } from '../../ui/MoreLines';
import styles from './DiffPreview.module.css';

/** 差异预览：Edit / Write 类审批的 content_preview，是 unified diff 时标题写「+N −M」，是写入的新内容时写「内容预览」；先显示前 6 行，长的给「全部 N 行」。 */
export interface DiffPreviewProps {
  /** unified diff 片段，或写入的新内容 */
  preview: string;
  /** 默认显示全部行 */
  defaultOpen?: boolean;
  /** 只画全部差异行，开合由外层管（会话卡里的紧凑审批） */
  bare?: boolean;
}

/** Lines shown before 全部 N 行. */
const PREVIEW = 6;

/** The preview's lines, without the empty one after a trailing newline. */
function linesOf(preview: string): string[] {
  const lines = preview.split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function lineClass(line: string): string | undefined {
  if (line.startsWith('@@')) return styles.hunk;
  if (line.startsWith('+')) return styles.add;
  if (line.startsWith('-')) return styles.del;
  return undefined;
}

/** Added and removed line counts of a unified diff snippet; null for new content (a Write's text, an Edit's new string), which has no hunk. */
export function diffCounts(preview: string): { added: number; removed: number } | null {
  const lines = linesOf(preview);
  if (!lines.some((l) => l.startsWith('@@'))) return null;
  return { added: lines.filter((l) => l.startsWith('+')).length, removed: lines.filter((l) => l.startsWith('-')).length };
}

export function DiffPreview({ preview, defaultOpen = false, bare }: DiffPreviewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const diffId = useId();
  const lines = linesOf(preview);
  const counts = diffCounts(preview);
  const all = open || bare || lines.length <= PREVIEW;
  return (
    <div data-stub="DiffPreview" className={styles.root} data-bare={bare || undefined}>
      {!bare && (
        <span className={styles.head}>
          {counts ? (
            <>
              差异预览{' '}
              <span className="num">
                <span className={styles.addN}>+{counts.added}</span> <span className={styles.delN}>−{counts.removed}</span>
              </span>
            </>
          ) : (
            '内容预览'
          )}
        </span>
      )}
      <div className={styles.box}>
        <pre id={diffId} className={styles.diff} data-selectable="">
          {(all ? lines : lines.slice(0, PREVIEW)).map((l, i) => (
            <span key={i} className={counts ? lineClass(l) : undefined}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
        {!bare && lines.length > PREVIEW && <MoreLines total={lines.length} open={open} controls={diffId} onToggle={() => setOpen((o) => !o)} />}
      </div>
    </div>
  );
}
