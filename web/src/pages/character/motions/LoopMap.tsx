import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { gameClips } from '../../../design/gameClips.generated';
import { useGameClip } from '../../../ui';
import { Diamond } from '../../../ui/game';
import { still } from '../charMotion';
import { baseLabel, type GraphIndex } from './chainPath';
import { shortName } from './graph';
import type { Pool } from './pools';
import { along, rangeText, secText, TICKS, tickText } from './timing';
import styles from './Loop.module.css';

/** One idle tier's lane: its pool, how many chains it holds, how many of them cut hard, whether it was changed or not taken, agentd's pending proposals. */
export interface Lane {
  pool: Pool;
  n: number;
  hard: number;
  changed: boolean;
  bad: boolean;
  proposed: number;
}

export interface LoopMapProps {
  ix: GraphIndex;
  lanes: Lane[];
  sel: string | null;
  onSel: (key: string) => void;
}

const STANCE: Record<string, string> = { stand: '站', sit: '坐', floor: '坐地上', lie: '躺', boss: 'Boss' };
const WHEN: Record<string, string> = { sit: '坐着时', floor: '坐地上时', lie: '躺着时', boss: 'Boss 姿态时' };

export const tierName = (key: string) => `T${/^idle\.t(\d+)$/.exec(key)?.[1] ?? '?'}`;
export const stanceWord = (posture: string) => STANCE[posture] ?? posture;

/** 20–40 s 后 │ 每 25–60 s, with 坐着时 and alike before it off standing; null when the pack gives no times. */
export function laneText(p: Pool): string | null {
  if (!p.after_s) return null;
  return [WHEN[p.posture], `${rangeText(p.after_s)} 后`, p.interval_s ? `每 ${rangeText(p.interval_s)}` : null].filter(Boolean).join(' │ ');
}

const LANE = 30;
const TOP = 20;

/** The yellow arc breathes while she loops the stance (attributecell_selected_loop). */
function Arc() {
  const ref = useRef<SVGCircleElement>(null);
  useGameClip(gameClips.charMarkLoop, ref, { autoplay: !still() });
  return <circle ref={ref} data-g="root" cx="68" cy="68" r="57" fill="none" stroke="var(--ef-accent)" strokeWidth="2.4" strokeDasharray="40 318" transform="rotate(150 68 68)" />;
}

function Ring({ ix }: { ix: GraphIndex }) {
  const bases = [...ix.bases.values()];
  const hub = bases.find((b) => b.hub) ?? bases[0];
  const clip = hub ? ix.clips.get(hub.clip) : undefined;
  const others = bases.filter((b) => b !== hub);
  const bridgeTo = (base: string) => [...ix.bridges].find(([, to]) => to === base)?.[0];
  const time = [clip?.length_s != null ? `一圈 ${secText(clip.length_s)}` : null, clip?.hold_s != null ? `保持 ${secText(clip.hold_s)}` : null].filter(Boolean).join(' │ ');
  return (
    <div className={styles.hub}>
      <div className={styles.ring} data-hub={hub?.clip}>
        <svg viewBox="0 0 136 136" aria-hidden="true">
          <circle cx="68" cy="68" r="64" fill="none" stroke="color-mix(in srgb, var(--ef-plate) 30%, transparent)" strokeWidth="1" />
          <circle cx="68" cy="68" r="53" fill="rgb(46 46 46 / 90%)" />
          <circle cx="68" cy="68" r="57" fill="none" stroke="var(--ef-plate)" strokeWidth="2" strokeDasharray="250 108" transform="rotate(-80 68 68)" />
          <Arc />
          <path d="M68 1v6M68 129v6M1 68h6M129 68h6" stroke="color-mix(in srgb, var(--ef-plate) 50%, transparent)" strokeWidth="1" />
          <path d="M117 28l10-2-3 10z" fill="var(--ef-accent)" stroke="var(--ef-plate)" strokeWidth="0.6" />
        </svg>
        {hub ? (
          <>
            <b>{baseLabel(hub)}</b>
            <span className={styles.clip} title={hub.clip}>
              {shortName(hub.clip)}
            </span>
            {time && <span className={styles.time}>{time}</span>}
          </>
        ) : (
          <b>没有基础站姿</b>
        )}
      </div>
      <ul className={styles.bases} aria-label="其他站姿">
        {others.map((b) => {
          const bridge = bridgeTo(b.clip);
          const e = bridge && hub ? ix.edges.get(`${hub.clip}>${bridge}`) : undefined;
          return (
            <li key={b.clip} data-base={b.clip}>
              <Diamond tone="hollow" size={7} />
              {baseLabel(b)}
              <span className={styles.e}>{bridge ? `经桥接${e?.blend_s != null ? ` │ ${Math.round(e.blend_s * 100) / 100} s` : ''}` : shortName(b.clip)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 待机循环：左边中心站姿环（一圈、保持）和其余站姿，右边每个空闲档一条泳道，横轴是空闲时长（平方根刻度），实心是第一次抽的时间窗，斜纹是之后每隔多久再抽。 */
export function LoopMap({ ix, lanes, sel, onSel }: LoopMapProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(0, lanes.findIndex((l) => l.pool.key === sel));
  const onKey = (e: KeyboardEvent) => {
    const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!by || lanes.length === 0) return;
    e.preventDefault();
    const next = (at + by + lanes.length) % lanes.length;
    onSel(lanes[next]!.pool.key);
    refs.current[next]?.focus();
  };
  const height = Math.max(172, TOP + lanes.length * LANE + 4);
  return (
    <div className={styles.map} style={{ '--map-h': `${height}px`, '--lanes': lanes.length } as CSSProperties}>
      <Ring ix={ix} />
      {lanes.length === 0 ? (
        <p className={styles.none}>角色包里没有空闲档</p>
      ) : (
        <div className={styles.lanes} role="radiogroup" aria-label="空闲档" onKeyDown={onKey}>
          <div className={styles.axis} aria-hidden="true">
            {TICKS.map((t) => (
              <span key={t} style={{ left: `${along(t) * 100}%` }}>
                {tickText(t)}
              </span>
            ))}
          </div>
          {lanes.map((l, i) => {
            const p = l.pool;
            const text = laneText(p);
            const on = p.key === sel;
            const full = [`${tierName(p.key)} ${stanceWord(p.posture)}`, text ?? '包里没有写抽取时间', `${l.n} 条`, l.hard > 0 ? `${l.hard} 条会硬切` : null, l.proposed > 0 ? `建议 ${l.proposed}` : null].filter(Boolean).join(' │ ');
            const a = p.after_s ? along(p.after_s[0]) : 0;
            const b = p.after_s ? along(p.after_s[1]) : 0;
            return (
              <button
                key={p.key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={full}
                title={full}
                tabIndex={i === at ? 0 : -1}
                className={styles.lane}
                data-lane={p.key}
                data-bad={l.bad || undefined}
                style={{ '--i': i } as CSSProperties}
                onClick={() => onSel(p.key)}
              >
                <span className={styles.lb}>
                  <b>{tierName(p.key)}</b>
                  {stanceWord(p.posture)}
                </span>
                <span className={styles.tr}>
                  {p.after_s && <i className={styles.first} style={{ left: `${a * 100}%`, width: `${Math.max(1, (b - a) * 100)}%` }} />}
                  {p.after_s && p.interval_s && <i className={styles.rep} style={{ left: `${b * 100}%` }} />}
                  <span className={styles.tx} style={1 - b >= a ? { left: `${b * 100 + 1.5}%` } : { right: `${100 - a * 100 + 1.5}%` }}>
                    {text ?? '包里没有写抽取时间'}
                  </span>
                  {(l.hard > 0 || l.proposed > 0) && (
                    <span className={styles.tags}>
                      {l.hard > 0 && <span className={styles.warn}>{l.hard} 硬切</span>}
                      {l.proposed > 0 && (
                        <span className={styles.pr} data-proposed="">
                          {l.proposed}
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <span className={styles.n}>
                  {l.n}
                  <small> 条</small>
                </span>
                <span className={styles.mk}>{l.changed && <Diamond tone="yellow" size={6} />}</span>
              </button>
            );
          })}
          <svg className={styles.links} aria-hidden="true">
            {lanes.map((l, i) =>
              l.pool.posture === 'stand' ? (
                <path key={l.pool.key} d={`M-46 64 C -20 64, -16 ${TOP + i * LANE + 13}, 0 ${TOP + i * LANE + 13}`} data-on={l.pool.key === sel || undefined} />
              ) : null,
            )}
          </svg>
        </div>
      )}
    </div>
  );
}

