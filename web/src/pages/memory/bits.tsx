import type { Fact, MemorySource } from '../../domain';
import { useEvidence } from './data';
import { SRC } from './model';
import styles from './Memory.module.css';

export const SrcGlyph = ({ src }: { src: MemorySource }) => <i className={styles.glyph} data-src={SRC[src].key} aria-hidden="true" />;

/** Source square plus the short word (陈述 / 观察 / 确认 / 推断), or the full name. */
export const SrcTag = ({ src, full }: { src: MemorySource; full?: boolean }) => (
  <span className={styles.srcTag}>
    <SrcGlyph src={src} />
    {full ? SRC[src].full : SRC[src].short}
  </span>
);

export interface EvidenceViewProps {
  fact: Fact;
  now: number;
  /** Open the chat or the observation page at the source. */
  onJump?: (k: 'chat' | 'obs') => void;
}

/** 出处：对话原句（引号）或观察片段（缩略图位 + 应用）；没有出处时是「手动添加」。 */
export function EvidenceView({ fact, now, onJump }: EvidenceViewProps) {
  const { ev, pending } = useEvidence(fact, now);
  if (!ev) return <p className={styles.cap}>手动添加</p>;
  return (
    <div className={styles.ev} data-k={ev.k} aria-busy={pending || undefined}>
      {ev.k === 'obs' && <span className={styles.thumb} aria-hidden="true" />}
      <div className={styles.evBody}>
        <div className={styles.evMeta}>
          <span className="num">{ev.when}</span>
          <span>{ev.where}</span>
        </div>
        {ev.quote && (
          <div className={styles.evQuote}>
            {ev.k === 'chat' ? (
              <>
                <span className={styles.who}>用户</span>「{ev.quote}」
              </>
            ) : (
              <span className={styles.mono}>{ev.quote}</span>
            )}
          </div>
        )}
      </div>
      {onJump && (
        <button type="button" className={styles.lnk} onClick={() => onJump(ev.k)}>
          {ev.k === 'chat' ? '查看原文' : '查看片段'}
        </button>
      )}
    </div>
  );
}
