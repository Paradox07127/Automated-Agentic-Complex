import { useState } from 'react';
import { formatMs } from '../../domain';
import { Icon } from '../../ui';
import styles from './Messages.module.css';

export interface ToolRowProps {
  label: string;
  ms: number;
  summary: string;
  code?: string;
  sessionAllowed?: boolean;
  /** Longest tool call in the stream: the duration bars share its scale. */
  maxMs?: number;
}

/** Tool call in the stream: a compact chat task card with a small duration bar; the output unfolds inside it. */
export function ToolRow({ label, ms, summary, code, sessionAllowed, maxMs = ms }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(code ?? summary);
  return (
    <div className={styles.msg} data-kind="tool">
      <div className={`${styles.tcard} sns-task-stripes`} data-cat="run" data-compact="">
        <span className={styles.tbar} aria-hidden="true" />
        {hasDetails ? <button type="button" className={styles.toolrow} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={styles.tico} aria-hidden="true"><Icon name="tool" size={16} /></span>
          <span className={styles.tdiv} aria-hidden="true" />
          <span className={styles.tl}>{label}</span>
          <span className={styles.tsum}>{summary}</span>
          {ms > 0 && (
            <>
              <span className={styles.f09} role="img" aria-label={`耗时 ${formatMs(ms)}`}>
                <i style={{ width: `${(ms / Math.max(1, maxMs)) * 100}%` }} />
              </span>
              <span className={styles.f09v}>{formatMs(ms)}</span>
            </>
          )}
          <span className={styles.tgo} aria-hidden="true"><Icon name={open ? 'chevd' : 'chev'} size={14} /></span>
        </button> : <div className={styles.toolrow}><span className={styles.tico} aria-hidden="true"><Icon name="tool" size={16} /></span><span className={styles.tdiv} aria-hidden="true" /><span className={styles.tl}>{label}</span></div>}
        {sessionAllowed && <p className={styles.tnote}>已按本对话设置允许</p>}
        {open && (
          <div className={styles.code} data-selectable="">
            {code ?? summary}
          </div>
        )}
      </div>
    </div>
  );
}
