import { formatMs, type TurnNow } from '../../domain';
import styles from './State.module.css';

/** Current turn phases as a stacked bar with 2 px gaps; the running phase carries the cursor. */
export function PhaseStack({ turn }: { turn: TurnNow }) {
  const p = turn.phases_ms;
  return (
    <span className={styles.f21} role="img" aria-label={`当前轮 ${p.map((x) => `${x.label} ${formatMs(x.ms)}`).join('，')}`}>
      <span className={styles.f21Bar}>
        {p.map((x) => (
          <i key={x.key} data-cur={x.key === turn.phase || undefined} style={{ flexGrow: x.ms }} title={`${x.label} │ ${formatMs(x.ms)}${x.key === turn.phase ? '（进行中）' : ''}`} />
        ))}
      </span>
      <span className={styles.f21Lab}>
        {p.map((x) => (
          <span key={x.key} data-cur={x.key === turn.phase || undefined}>
            {x.label} <span className="num">{formatMs(x.ms)}</span>
            {x.key === turn.phase && ' │ 进行中'}
          </span>
        ))}
      </span>
    </span>
  );
}
