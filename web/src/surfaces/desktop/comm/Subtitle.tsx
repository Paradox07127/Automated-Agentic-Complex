import type { Bar } from './commReducer';
import bubble from '../bubble/Bubble.module.css';
import styles from './Subtitle.module.css';

/**
 * 字幕条: while she is hidden or full screen covers her, her line under the
 * menu bar beside the deco column; 在想 until its first word.
 */
export function Subtitle({ bar, name, onOpen }: { bar: Bar; name: string; onOpen: () => void }) {
  return (
    <div className={styles.bar} data-region="" data-subtitle="" role="status" aria-live="polite">
      <span className={styles.deco} aria-hidden="true" />
      <div className={styles.body}>
        {name && <span className={styles.name}>{name}</span>}
        <div className={styles.text}>
          <p className={styles.lines}>
            <span key={bar.id} className={styles.line}>
              {bar.phase === 'thinking' ? '思考中' : bar.text}
              {bar.phase === 'streaming' && <span className={bubble.cursor} aria-hidden="true" />}
            </span>
          </p>
        </div>
        {bar.phase !== 'thinking' && (
          <button type="button" className={styles.open} onClick={onOpen}>
            在对话页打开 ↗
          </button>
        )}
      </div>
    </div>
  );
}
