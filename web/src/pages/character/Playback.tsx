import type { CSSProperties } from 'react';
import type { AvatarAction } from '../../bridge';
import { Icon, OpenSec } from '../../ui';
import styles from './Operator.module.css';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Plays by hour: an ink ramp by count, the current hour yellow, later hours hatched. */
function HourDots({ vals, cur, dim, label }: { vals: number[]; cur: number; dim: boolean; label: string }) {
  const mx = Math.max(1, ...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  return (
    <div className={styles.hd} data-dim={dim || undefined} role="img" aria-label={`${label}：合计 ${total} 次，当前 ${pad2(cur)}:00 ${vals[cur] ?? 0} 次`}>
      <div className={styles.hdCells}>
        {vals.map((v, h) => (
          <i
            key={h}
            data-z={!v || undefined}
            data-now={h === cur || undefined}
            data-fut={h > cur || undefined}
            style={v ? ({ '--a': (0.3 + (0.7 * v) / mx).toFixed(2) } as CSSProperties) : undefined}
            title={`${pad2(h)}:00 │ ${h > cur ? '未到' : `${v} 次`}`}
          />
        ))}
      </div>
      <div className={styles.hdAx} aria-hidden="true">
        {[0, 6, 12, 18]
          .filter((h) => Math.abs(h - cur) > 1)
          .map((h) => (
            <span key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>
              {pad2(h)}
            </span>
          ))}
        <span data-now="" style={{ left: `${((cur + 0.5) / 24) * 100}%` }}>
          {pad2(cur)}
        </span>
      </div>
    </div>
  );
}

export interface PlaybackProps {
  motion: AvatarAction | undefined;
  no: string;
  /** Today's plays of the motion by hour; null where nobody counts them. */
  hours: number[] | null;
  hour: number;
  sparse: boolean;
}

/** 01 今日播放：按小时 24 格，合计与峰值；没有播放计数时不画。桌面预览在底部操作条。 */
export function Playback(p: PlaybackProps) {
  if (!p.hours || !p.motion) return null;
  const today = p.hours.reduce((a, b) => a + b, 0);
  const peak = today > 0 ? `${pad2(p.hours.indexOf(Math.max(...p.hours)))}:00` : null;
  const missing = !!p.motion.missing;
  return (
    <OpenSec no="01" title="今日播放" right={<span className={styles.k}>{`${p.no} ${p.motion.label}`}</span>}>
      <div className={styles.pb} data-g="skills">
        <HourDots vals={p.hours} cur={p.hour} dim={missing} label={`${p.motion.label} 今日按小时播放`} />
        <div className={styles.read}>
          {missing ? (
            <span className={styles.k}>缺资源，不能播放</span>
          ) : (
            <span className={styles.attr}>
              <span className={styles.attrIc} aria-hidden="true"><Icon name="play" size={16} /></span>
              <b className={styles.attrV}>{today}</b>
              <span className={styles.attrN}>次</span>
            </span>
          )}
          {!p.sparse && peak && (
            <span className={styles.attr}>
              <span className={styles.attrIc} aria-hidden="true"><Icon name="clock" size={16} /></span>
              <b className={styles.attrV}>{peak}</b>
              <span className={styles.attrN}>峰值</span>
            </span>
          )}
        </div>
      </div>
    </OpenSec>
  );
}
