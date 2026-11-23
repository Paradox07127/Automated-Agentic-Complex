import { useRef, useState, type KeyboardEvent } from 'react';
import type { MotionPlaylist } from '../../bridge';
import { gameClips } from '../../design/gameClips.generated';
import { Btn } from '../../ui';
import { useGameClip } from '../../ui/fx/useGameClip';
import { Barcode, GameSeg, MicroLabel, YellowKey } from '../../ui/game';
import type { Setlist as SetlistState } from './useSetlist';
import styles from './Setlist.module.css';

const LOOPS = [
  { value: 'off', label: '不循环' },
  { value: 'one', label: '单曲' },
  { value: 'all', label: '全部' },
];
const SPEEDS = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
];

export interface SetlistCard {
  id: string;
  title: string;
  durationS: number | null;
}

export interface SetlistProps {
  /** Her name: the list is hers. */
  who: string;
  /** The list's dances in order. */
  cards: SetlistCard[];
  list: SetlistState;
  /** Why the list cannot change or play now; null when it can. */
  blocked: string | null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** The playing card's frame and line breathe (itembig_selectedbg_loop). */
function Playing() {
  const ref = useRef<HTMLSpanElement>(null);
  useGameClip(gameClips.snsCellSelectLoop, ref, { autoplay: true });
  return (
    <span ref={ref} className={styles.eq} aria-hidden="true">
      <i data-g="selLine" />
      <i data-g="selLine" />
      <i data-g="selLine" />
      <i data-g="selLine" />
    </span>
  );
}

/** 演出列表：舞台下的动作条。连播 / 停止一个黄键，循环、速度两个分段开关；右边是排好的曲目卡，拖动或 ◀ ▶ 排序、移出。 */
export function Setlist({ who, cards, list, blocked }: SetlistProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const off = blocked;
  const { items, now } = list;
  const total = cards.reduce((s, c) => s + (c.durationS ?? 0), 0);
  const drop = (to: number) => {
    if (drag == null || drag === to || off != null) return setDrag(null);
    const next = [...items];
    const [id] = next.splice(drag, 1);
    next.splice(to, 0, id!);
    setDrag(null);
    list.put(next);
  };
  const onKey = (i: number) => (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget || off != null) return;
    const by = !e.altKey ? null : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : null;
    if (by != null && i + by >= 0 && i + by < items.length) {
      e.preventDefault();
      list.move(i, by);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      list.put(items.filter((x) => x !== items[i]));
    }
  };

  return (
    <section className={styles.band} aria-label="MMD 列表" data-playlist="">
      <div className={styles.ctl}>
        <div className={styles.hdl}>
          <h3>演出列表</h3>
          <span className={styles.who}>{who}</span>
          <span className={styles.micro}>
            <MicroLabel>SETLIST / DESKTOP</MicroLabel>
          </span>
        </div>
        <div className={styles.keys}>
          <YellowKey
            vertical
            label={now.playing ? '停止' : '连播'}
            icon={now.playing ? 'stop' : 'play'}
            micro={now.playing ? 'PLAYING' : 'SETLIST'}
            disabled={off != null || (!now.playing && items.length === 0)}
            disabledReason={off ?? '先把动作加入列表'}
            onClick={list.toggle}
          />
          <div className={styles.segs}>
            <GameSeg variant="setting" label="循环" caption="循环" micro="LOOP" options={LOOPS.map((o) => ({ ...o, disabled: off != null, ...(off ? { title: off } : {}) }))} value={list.loop} onChange={(v) => list.setLoop(v as MotionPlaylist['loop'])} />
            <GameSeg variant="setting" label="连播速度" caption="速度" micro="SPEED" options={SPEEDS.map((o) => ({ ...o, disabled: off != null, ...(off ? { title: off } : {}) }))} value={String(list.speed)} onChange={(v) => list.setSpeed(Number(v) as MotionPlaylist['speed'])} />
          </div>
        </div>
      </div>
      <div className={styles.strip}>
        <div className={styles.sum}>
          <span>
            <span className="num">{items.length}</span> 首 │ 共 <span className="num">{total.toFixed(1)}</span> s
          </span>
          <i className={styles.ln} aria-hidden="true" />
          {now.playing && now.index != null && (
            <span role="status">
              桌面正在播第 <span className="num">{now.index + 1}</span> 首
            </span>
          )}
        </div>
        {cards.length === 0 ? (
          <p className={styles.ghost}>列表是空的：在右边曲库里点一支已同步的舞右端的 ＋</p>
        ) : (
          <ol className={styles.track} aria-label="演出曲目">
            {cards.map((c, i) => {
              const on = now.playing && now.id === c.id;
              return (
                <li
                  key={c.id}
                  className={styles.card}
                  data-playlist-row={c.id}
                  aria-current={on || undefined}
                  data-drag={drag === i || undefined}
                  tabIndex={0}
                  draggable={off == null}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag(i);
                  }}
                  onDragOver={(e) => drag != null && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(i);
                  }}
                  onDragEnd={() => setDrag(null)}
                  onKeyDown={onKey(i)}
                >
                  <span className={styles.no}>{two(i + 1)}</span>
                  {on ? <Playing /> : <span className={styles.id}><MicroLabel>{c.id}</MicroLabel></span>}
                  <span className={styles.nm} title={c.title}>
                    {c.title}
                  </span>
                  {c.durationS != null && <span className={styles.d}>{`${c.durationS.toFixed(1)} s`}</span>}
                  <span className={styles.bars} aria-hidden="true">
                    <Barcode width={40} height={9} />
                  </span>
                  <span className={styles.mv}>
                    <Btn variant="text" size="sm" dense label="前移" disabled={off != null || i === 0} disabledReason={off ?? '已在最前'} onClick={() => list.move(i, -1)}>
                      ◀
                    </Btn>
                    <Btn variant="text" size="sm" dense label="后移" disabled={off != null || i === items.length - 1} disabledReason={off ?? '已在最后'} onClick={() => list.move(i, 1)}>
                      ▶
                    </Btn>
                    <Btn variant="text" size="sm" dense disabled={off != null} disabledReason={off ?? ''} onClick={() => list.put(items.filter((x) => x !== c.id))}>
                      移出
                    </Btn>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <span className={styles.corner} aria-hidden="true">
        <MicroLabel>AGENTIC / MMD</MicroLabel>
      </span>
    </section>
  );
}
