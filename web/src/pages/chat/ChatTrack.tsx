import { formatClock, formatDuration } from '../../domain';
import { useDevMode } from '../../shell/devMode';
import styles from './Chat.module.css';

export interface ChatTrackProps {
  now: number;
  /** The foreground run of this conversation, while it runs. */
  front: { id: string; title: string; started_at: number } | null;
  /** Side-session answers (read-only) of the last 10 minutes. */
  side: Array<{ id: string; t0: number; t1: number }>;
  onFront: () => void;
  onSide: (id: string) => void;
}

const SPAN = 10 * 60_000;
const MIN = 60_000;
/** A side answer draws at least this long so it can be clicked. */
const SIDE_MIN = 4000;

/** One 28 px row over the last 10 minutes, shown in 开发者模式 only while a run or a side answer is in it: 前台 and 旁路 lanes, minute ticks, the current time in yellow. */
export function ChatTrack({ now, front, side, onFront, onSide }: ChatTrackProps) {
  const dev = useDevMode();
  const t0 = now - SPAN;
  const t1 = now + 20_000;
  const recent = side.filter((x) => x.t1 >= t0);
  if (!dev || (!front && recent.length === 0)) return null;
  const at = (t: number) => `${((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * 100}%`;
  const width = (a: number, b: number) => `${((Math.min(b, t1) - Math.max(a, t0)) / (t1 - t0)) * 100}%`;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / MIN) * MIN; t <= now; t += MIN) ticks.push(t);
  return (
    <div className={styles.track}>
      <span className={styles.cap}>最近 10 分钟</span>
      <div className={styles.trackTl} role="group" aria-label={`最近 10 分钟前台与旁路：前台 ${front ? 1 : 0} 项，旁路 ${recent.length} 项`}>
        <div className={styles.lanes}>
          {ticks.map((t) => (
            <i key={t} className={styles.tick} style={{ left: at(t) }} aria-hidden="true" />
          ))}
          {front && (
            <button
              type="button"
              className={styles.blk}
              data-lane="f"
              style={{ left: at(front.started_at), width: width(front.started_at, now) }}
              aria-label={`前台 │ ${front.title} │ ${formatClock(front.started_at)} 到现在，查看任务`}
              onClick={onFront}
            />
          )}
          {recent.map((x) => (
            <button
              key={x.id}
              type="button"
              className={styles.blk}
              data-lane="s"
              style={{ left: at(x.t0), width: width(x.t0, Math.max(x.t1, x.t0 + SIDE_MIN)) }}
              aria-label={`旁路只读 │ ${formatClock(x.t0)}，定位到这条回答`}
              onClick={() => onSide(x.id)}
            />
          ))}
          <i className={styles.nowLine} style={{ left: at(now) }} aria-hidden="true" />
        </div>
        <div className={styles.ticks} aria-hidden="true">
          {ticks
            .filter((t) => (t / MIN) % 2 === 0)
            .map((t) => (
              <span key={t} style={{ left: at(t) }}>
                {formatClock(t)}
              </span>
            ))}
        </div>
      </div>
      <span className={styles.trackR}>
        {front && (
          <span className={styles.trackFront}>
            ▶ 前台 <span className={styles.num}>{formatDuration(now - front.started_at)}</span>
          </span>
        )}
        <span className={styles.cap}>
          旁路只读 <span className={styles.num}>{recent.length}</span> 次
        </span>
      </span>
    </div>
  );
}
