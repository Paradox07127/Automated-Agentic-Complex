import type { NavTarget } from '../../../shell/nav';
import { Btn } from '../../../ui/Btn';
import { StopAct } from '../bubble/Acts';
import { failOf, type Bar } from './commReducer';
import bubble from '../bubble/Bubble.module.css';
import styles from './Subtitle.module.css';

/**
 * 字幕条: while she is hidden or full screen covers her, her line under the
 * menu bar beside the deco column; 在想 until its first word. An error says why, as the bubble does.
 */
export function Subtitle({ bar, name, onOpen, go, onStop = null }: { bar: Bar; name: string; onOpen: () => void; go: (to: NavTarget) => void; onStop?: (() => void) | null }) {
  const fail = bar.phase === 'error' ? failOf(bar) : null;
  const next = fail?.next ?? null;
  return (
    <div className={styles.bar} data-region="" data-subtitle="" role="status" aria-live="polite">
      <span className={styles.deco} aria-hidden="true" />
      <div className={styles.body}>
        {name && <span className={styles.name}>{name}</span>}
        <div className={styles.text}>
          <p className={styles.lines}>
            <span key={bar.id} className={styles.line}>
              {bar.phase === 'thinking' ? '思考中' : fail ? fail.reason : bar.text}
              {bar.phase === 'streaming' && <span className={bubble.cursor} aria-hidden="true" />}
            </span>
            {bar.phase === 'interrupted' && (
              <>
                <br />
                <span className={styles.line}>已打断</span>
              </>
            )}
          </p>
        </div>
        {(onStop || next || bar.phase !== 'thinking') && (
          <span className={bubble.acts}>
            {onStop && <StopAct onStop={onStop} />}
            {next && <Btn variant="ghost" size="sm" onClick={() => go(next.to)}>{next.label}</Btn>}
            {bar.phase !== 'thinking' && (
              <button type="button" className={styles.open} onClick={onOpen}>
                在对话页打开 ↗
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
