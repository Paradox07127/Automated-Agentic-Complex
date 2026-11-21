import { useEffect, useState, type CSSProperties } from 'react';
import { formatClock } from '../../domain';
import { CharacterArt, Icon, type IconName } from '../../ui';
import { Pip, type PipProps } from '../overview/Pip';
import { BAR, BAR_SLOTS, type Box, type KeyShape } from './geometry';
import { BANNER as BANNER_BG } from './outlines';
import { Slab, unit, type Pt } from './Slab';
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

/** The player card: her head, her name and what she is doing; it opens her page. */
export function CharCard({ box, name, en, head, id, doing, onClick }: {
  box: Box;
  name: string;
  en: string | null;
  head: string | null;
  id: string | null;
  doing: string;
  onClick: () => void;
}) {
  const notch = [[0, 0], [box.width - 14, 0], [box.width, 14], [box.width, box.height], [0, box.height]] as const;
  return (
    <button type="button" className={styles.char} style={at(box)} aria-label={`角色：${name}`} onClick={onClick} data-g="home">
      <Slab pts={notch} w={box.width} h={box.height} depth={8} tone="dark">
        <span className={styles.charIn}>
          <span className={styles.charHead} aria-hidden="true">
            <CharacterArt src={head ?? undefined} id={id ?? undefined} art="card" kind="head" w={56} h={56} fallback={<Icon name="user" size={24} />} />
          </span>
          <span className={styles.charText}>
            <b className={styles.charName}>{name}</b>
            {en && <span className={styles.charEn}>{en}</span>}
            {doing && <span className={styles.charDoing} title={doing}>{doing}</span>}
          </span>
          <span className={styles.charGo} aria-hidden="true">
            <Icon name="chev" size={14} />
          </span>
        </span>
      </Slab>
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

export interface NewsItem {
  kind: string;
  title: string;
  /** When, as the overview writes it. */
  at: string;
  go: () => void;
}

/** How long each banner item stays, as the game's banner turns. */
const NEWS_MS = 6000;

/** BannerNode: the next reminder and today's latest delivery, one at a time; it turns by itself and by its arrows. */
export function Banner({ box, items, still }: { box: Box; items: readonly NewsItem[]; still: boolean }) {
  const [i, setI] = useState(0);
  // Turning by hand restarts the wait, so the item just picked stays its full time.
  const [turned, setTurned] = useState(0);
  useEffect(() => {
    if (still || items.length < 2) return;
    const t = window.setInterval(() => setI((v) => v + 1), NEWS_MS);
    return () => window.clearInterval(t);
  }, [still, items.length, turned]);
  const n = Math.max(items.length, 1);
  const at0 = ((i % n) + n) % n;
  const item = items[at0];
  const step = (d: 1 | -1) => {
    setI((v) => v + d);
    setTurned((v) => v + 1);
  };
  return (
    <div className={styles.bannerNode} style={at(box)} data-g="banner">
      <Slab pts={unit(BANNER_BG, box.width, box.height)} w={box.width} h={box.height} depth={7} tone="dark" accent>
        <button type="button" className={styles.banner} onClick={item?.go} disabled={!item} aria-label={item ? `${item.kind}：${item.title} ${item.at}` : '没有新消息'}>
          <span className={styles.bannerIn} aria-hidden="true">
            {item ? (
              <>
                <span className={styles.news}>
                  <b>{item.kind}</b>
                  <span className="num">{item.at}</span>
                </span>
                <span className={styles.newsTitle}>{item.title}</span>
              </>
            ) : (
              <span className={styles.newsCalm}>没有新消息</span>
            )}
          </span>
        </button>
        {items.length > 1 && (
          <span className={styles.pages}>
            <button type="button" className={styles.turn} aria-label="上一条" onClick={() => step(-1)}>
              <Icon name="chev" size={12} />
            </button>
            {items.map((x, j) => (
              <i key={x.kind} data-on={j === at0 || undefined} />
            ))}
            <button type="button" className={styles.turn} aria-label="下一条" onClick={() => step(1)}>
              <Icon name="chev" size={12} />
            </button>
          </span>
        )}
      </Slab>
    </div>
  );
}
