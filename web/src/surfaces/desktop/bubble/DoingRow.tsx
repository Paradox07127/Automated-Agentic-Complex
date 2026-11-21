import { useMemo } from 'react';
import { readPresence } from '../tags/presence';
import { useNow } from '../tags/useNow';
import { doingOf, minutesSince } from './doing';
import styles from './Bubble.module.css';

/**
 * 正在做: the line in the bubble's header and the status chip's tip, updated on every presence push; while she runs, the
 * minutes since it began.
 */
export function DoingRow({ presence }: { presence: unknown }) {
  const doing = useMemo(() => doingOf(presence), [presence]);
  const sampledAt = useMemo(() => readPresence(presence).sampledAt, [presence]);
  // The minutes count on agentd's clock: its time at the snapshot, plus the local time since it arrived.
  const received = useMemo(() => Date.now(), [presence]);
  const now = useNow(30_000, doing.since != null);
  const at = sampledAt != null ? sampledAt + (now - received) / 1000 : now / 1000;
  const minutes = minutesSince(doing.since, at);
  return (
    <p className={styles.doing} data-bubble-doing="">
      <span aria-hidden="true">▸ </span>
      <span key={doing.text} className={`${styles.verb} ${styles.fade}`}>
        {doing.text}
      </span>
      {minutes != null && (
        <>
          {' │ '}
          <span className="num">{minutes}</span>
          {' 分钟'}
        </>
      )}
    </p>
  );
}
