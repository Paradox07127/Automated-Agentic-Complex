import type { CSSProperties } from 'react';
import { getBridge } from '../../bridge';
import { formatClock, fpsReadout } from '../../domain';
import { Icon, type IconName } from '../../ui';
import { CharMeta } from '../../ui/game';
import { Slab, type Pt } from '../../ui/game/Slab';
import { useRenderStats } from '../diag/useDiag';
import { Pip, type PipProps } from '../overview/Pip';
import { BAR, BAR_SLOTS, type Box, type KeyShape } from './geometry';
import styles from './Cards.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });

export interface BarAction {
  icon: IconName;
  title: string;
  onClick: () => void;
}

/** The bottom bar (HudBgShdow): its glow and two yellow slots cut from the ring, the game's TechtreeNode (icon first)
 *  and ReportNode (icon last). Without the right one the glow lies under the left alone. */
export function BottomBar({ left, right }: { left: BarAction; right: BarAction | undefined }) {
  const slot = (k: KeyShape, a: BarAction, end: boolean) => (
    <button type="button" className={styles.slot} style={at(k.box)} onClick={a.onClick}>
      <Slab pts={k.pts} w={k.box.width} h={k.box.height} depth={8} tone="yellow" band={0.64}>
        <span className={styles.actIn} style={{ left: k.mid[0], top: k.mid[1] }}>
          {!end && <Icon name={a.icon} size={16} />}
          {a.title}
          {end && <Icon name={a.icon} size={16} />}
        </span>
        <i className={styles.mark} data-end={end || undefined} aria-hidden="true" />
      </Slab>
    </button>
  );
  return (
    <div className={styles.barNode} data-g="hudBar">
      <span className={styles.band} style={at(right ? BAR : BAR_SLOTS[0].box)} aria-hidden="true" />
      {slot(BAR_SLOTS[0], left, false)}
      {right && slot(BAR_SLOTS[1], right, true)}
    </div>
  );
}

/** Her outfit and the renderer's frame rate; on its own so the once-a-second samples redraw only this line. */
export function LiveCharMeta({ outfit }: { outfit: string | null }) {
  const canAvatar = getBridge().capabilities.avatar;
  const fps = useRenderStats(canAvatar).at(-1)?.fps;
  if (!canAvatar) return null;
  return <CharMeta outfit={outfit} fps={fpsReadout(fps)} />;
}

/** What the clock card's status line says about the overview's reads. */
export type Conn = 'loading' | 'failed' | 'refused' | 'lost' | 'stale' | 'ok';

const CONN: Record<Conn, PipProps> = {
  loading: { tone: 'idle', label: '读取中' },
  failed: { tone: 'failed', label: '读取失败' },
  refused: { tone: 'failed', label: '后台拒绝访问' },
  lost: { tone: 'failed', label: '后台无响应' },
  stale: { tone: 'failed', label: '刷新失败' },
  ok: { tone: 'ok', label: '已连接' },
};

const WEEK = '日一二三四五六';
const dateZh = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
};

/** Top_RightNode: the time to the second, the date and the connection on a pill forward of the face, as the game's
 *  wallet bar. */
export function Counters({ box, now, conn }: { box: Box; now: number; conn: Conn }) {
  const r = box.height / 2;
  const end = (cx: number, from: number): Pt[] =>
    Array.from({ length: 9 }, (_, i) => {
      const a = from + (i / 8) * Math.PI;
      return [cx + r * Math.cos(a), r + r * Math.sin(a)];
    });
  const pill = [...end(box.width - r, -Math.PI / 2), ...end(r, Math.PI / 2)];
  return (
    <div className={styles.counters} style={at(box)} role="group" aria-label="时钟" data-g="wallet">
      <Slab pts={pill} w={box.width} h={box.height} depth={5} tone="dark">
        <span className={styles.countersIn}>
          <span className={styles.focus} aria-hidden="true" />
          <time className={`${styles.time} num`} dateTime={new Date(now).toISOString()}>
            {formatClock(now, { seconds: true })}
          </time>
          <span className={styles.date}>{dateZh(now)}</span>
          <span className={styles.conn}>
            <Pip {...CONN[conn]} />
          </span>
        </span>
      </Slab>
    </div>
  );
}
