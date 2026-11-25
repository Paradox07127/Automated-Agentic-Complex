import { formatMs } from '../../domain';
import { Icon } from '../../ui';
import { ExpandRow } from '../../ui/game';
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

/** Tool call in the stream: a slim task plate with a small duration bar; the output unfolds inside it. */
export function ToolRow({ label, ms, summary, code, sessionAllowed, maxMs = ms }: ToolRowProps) {
  const hasDetails = Boolean(code ?? summary);
  return (
    <div className={styles.msg} data-kind="tool">
      <div className={styles.stack}>
        <div className={styles.tool}>
          <ExpandRow body={hasDetails ? <div className={styles.code} data-selectable="">{code ?? summary}</div> : undefined}>
            <Icon name="tool" size={16} />
            <span className={styles.tl}>{label}</span>
            {hasDetails && <span className={styles.tsum}>{summary}</span>}
            {hasDetails && ms > 0 && (
              <>
                <span className={styles.f09} role="img" aria-label={`耗时 ${formatMs(ms)}`}>
                  <i style={{ width: `${(ms / Math.max(1, maxMs)) * 100}%` }} />
                </span>
                <span className={styles.f09v}>{formatMs(ms)}</span>
              </>
            )}
          </ExpandRow>
          {sessionAllowed && <p className={styles.tnote}>已按本对话设置允许</p>}
        </div>
      </div>
    </div>
  );
}
