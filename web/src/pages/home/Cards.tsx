import type { CSSProperties } from 'react';
import { formatClock } from '../../domain';
import { Icon, type IconName } from '../../ui';
import { Pip, type PipProps } from '../overview/Pip';
import { BAR, BAR_SLOTS, type Box } from './geometry';
import styles from './Cards.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });

/** The today card, absent while its page is not offered. */
export interface BarCard {
  label: string;
  counts: { pending: number | null; running: number | null };
  onClick: () => void;
}

/** The bottom bar (HudBgShdow): its glow band, the briefing's counts in the left slot (the game's ReportNode) and an action in the right one. */
export function BottomBar({ card, action }: { card: BarCard | undefined; action: { icon: IconName; title: string; onClick: () => void } }) {
  return (
    <div className={styles.barNode} data-g="hudBar">
      <span className={styles.band} style={at(BAR)} aria-hidden="true" />
      {card && <TodayCard {...card} />}
      <button type="button" className={`${styles.slot} ${styles.act}`} style={at(BAR_SLOTS[1])} aria-label={action.title} onClick={action.onClick}>
        <span className={styles.actIn} aria-hidden="true">
          <Icon name={action.icon} size={20} />
          {action.title}
        </span>
      </button>
    </div>
  );
}

function TodayCard({ label, counts, onClick }: BarCard) {
  const pending = `待办 ${counts.pending ?? "—"}`;
  const running = `在做 ${counts.running ?? "—"}`;
  const line = `${pending} │ ${running}`;
  return (
    <button type="button" className={`${styles.slot} ${styles.card}`} style={at(BAR_SLOTS[0])} aria-label={`${label}：${line}`} onClick={onClick}>
      <span className={styles.face} aria-hidden="true">
        <Icon name="clock" size={24} />
      </span>
      <span className={styles.who} aria-hidden="true">
        <b>{label}</b>
        {/* A hairline in place of the full-width │ keeps two-digit counts whole. */}
        <span className="num">
          {pending}
          <i className={styles.sep} />
          {running}
        </span>
      </span>
    </button>
  );
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
  return `${d.getMonth() + 1}月${d.getDate()}日周${WEEK[d.getDay()]}`;
};

/** Date, the time to the second and the connection, where the game keeps its wallet bar. */
export function ClockCard({ box, now, conn }: { box: Box; now: number; conn: Conn }) {
  return (
    <div className={styles.clock} style={at(box)} role="group" aria-label="时钟" data-g="wallet">
      <span className={styles.date}>{dateZh(now)}</span>
      <time className={`${styles.time} num`} dateTime={new Date(now).toISOString()}>
        {formatClock(now, { seconds: true })}
      </time>
      <span className={styles.conn}>
        <Pip {...CONN[conn]} />
      </span>
    </div>
  );
}
