import { useLayoutEffect, useRef, useState } from 'react';
import { messageBlocks } from '../../../pages/chat/MessageText';
import type { Bar } from '../comm/commReducer';
import styles from './Bubble.module.css';

/** Her line as radio chatter: her name between two rules over the line. The full reply stays scrollable and can also open in the main window. */
export function Speech({ bar, name, onOpen }: { bar: Bar; name: string; onOpen: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) {
      setClamped(false);
      return;
    }
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bar.id, bar.phase, bar.text]);

  return (
    <>
      {name && <p className={styles.name}>{name}</p>}
      <div className={styles.main} data-kind="speech" data-phase={bar.phase} role="status" aria-live="polite">
        {bar.phase === 'thinking' ? (
          <p className={styles.note}>思考中</p>
        ) : (
          <div ref={body} key={bar.id} className={styles.say} tabIndex={clamped ? 0 : undefined} aria-label={clamped ? '完整回复，可滚动' : undefined}>
            {messageBlocks(bar.text, bar.phase === 'streaming', false)}
            {bar.phase === 'streaming' && <span className={styles.cursor} aria-hidden="true" />}
          </div>
        )}
        {bar.phase === 'error' && <p className={styles.err}>本轮回复出错，未能完整输出</p>}
        {bar.phase === 'interrupted' && <p className={styles.note}>已打断</p>}
        {clamped && (
          <button type="button" className={styles.more} data-region="" onClick={onOpen}>
            在对话页查看全文
          </button>
        )}
      </div>
    </>
  );
}
