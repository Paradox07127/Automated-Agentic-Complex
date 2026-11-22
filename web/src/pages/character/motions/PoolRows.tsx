import { Fragment, useState, type ReactNode } from 'react';
import type { MotionPoolEntry } from '../../../bridge';
import { DarkRow, Stepper, TitleBar, WhiteCapsule } from '../../../ui/game';
import { useCompact } from '../compact';
import { chainPath, gapBand, type GraphIndex } from './chainPath';
import { shortName, type MotionGraph } from './graph';
import { HARD, POSTURE_BREAKS, type Junction } from './joints';
import { asWeight, candidates, type Pool } from './pools';
import { secText, segTime } from './timing';
import styles from './Pool.module.css';

export const MAX_ENTRIES = 64;

export interface PoolRowsProps {
  graph: MotionGraph;
  ix: GraphIndex;
  pool: Pool;
  /** 「T1 站姿待机」 or the event key. */
  title: string;
  /** The pool key, its no-repeat rule and the weight sum, split by │. */
  detail: string;
  /** The pool shown: the draft or stored override, else the pack's. */
  entries: MotionPoolEntry[];
  /** The override is in the draft or the store. */
  overridden: boolean;
  /** Why the avatar did not take this pool at the last save. */
  adjusted: string | null;
  /** Chain key → why the avatar did not take its switch at the last save. */
  adjustedChain: Record<string, string>;
  labelOf: (clip: string) => string;
  /** The pack's joints of a chain. */
  joints: (key: string) => Junction[];
  /** The chain's switch as shown. */
  value: (key: string) => boolean;
  open: string | null;
  onOpen: (key: string | null) => void;
  lock: string | null;
  onPreview: (key: string) => void;
  onPool: (entries: MotionPoolEntry[] | null) => void;
  /** The open row's inspector, right under it. */
  inspector: ReactNode;
  /** agentd's proposals and refusals for the pool, under its rows. */
  extra?: ReactNode;
}

const WHERE: Record<Junction['where'], string> = { entry: '进入', inner: '段间', exit: '回站姿' };
const cm = (gap: number) => `${Math.round(gap * 10) / 10} cm`;

/** The worst joint of a chain in words: red when it cuts hard or breaks the posture, orange from 25 to 40 cm. */
function flagOf(J: Junction[]): { tone: 'red' | 'orange'; text: string } | null {
  const hard = J.find((j) => j.flags.includes(HARD));
  if (hard) return { tone: 'red', text: `${HARD} ${cm(hard.gap!)}` };
  if (J.some((j) => j.flags.includes(POSTURE_BREAKS))) return { tone: 'red', text: POSTURE_BREAKS };
  const far = J.find((j) => gapBand(j.gap) === 3);
  return far ? { tone: 'orange', text: `${WHERE[far.where]} ${cm(far.gap!)}` } : null;
}

/** 迷你链条：进入菱形和段间细线按衔接色，段宽按时长，循环段黄斜纹；右边是一共多久。 */
function Mini({ g, ix, chain }: { g: MotionGraph; ix: GraphIndex; chain: string }) {
  const segs = g.chains[chain];
  if (!segs) return <span className={styles.mini} />;
  const path = chainPath(ix, chain, segs);
  const total = path.segs.reduce((s, x) => s + segTime(x.seg), 0);
  return (
    <span className={styles.mini} aria-hidden="true">
      <i className={styles.me} data-band={gapBand(path.entry[0]?.joint.gap)} />
      {path.segs.map((s, i) => (
        <Fragment key={`${s.seg.clip}:${i}`}>
          {i > 0 && <i className={styles.mj} data-band={gapBand(s.joint?.gap)} />}
          <i className={styles.ms} data-loop={s.seg.loop || undefined} style={{ flexGrow: Math.max(0.2, segTime(s.seg)) }} />
        </Fragment>
      ))}
      <span className={styles.mt}>{secText(total)}</span>
    </span>
  );
}

/** 选中池子：标题条（池、抽法、权重和、已改、用包里的），每条链一行深色行（▶ 在舞台预览、名字、迷你链条、问题、占比、权重、展开），末行加一条同姿态的链。 */
export function PoolRows(p: PoolRowsProps) {
  const { graph: g, ix, pool } = p;
  const [adding, setAdding] = useState(false);
  const compact = useCompact();
  const total = p.entries.reduce((s, e) => s + e.weight, 0);
  const pack = new Map(pool.entries.map((e) => [e.clip, asWeight(e.weight)]));
  const set = (i: number, w: number) => p.onPool(p.entries.map((e, j) => (j === i ? { ...e, weight: w } : e)));
  const off = p.lock != null;
  const more = candidates(g, pool.posture, p.entries);
  const full = p.entries.length >= MAX_ENTRIES;
  const addBlock = p.lock ?? (full ? `一个池子最多 ${MAX_ENTRIES} 条` : more.length === 0 ? '没有可加的同姿态链起头' : null);
  return (
    <section className={styles.pool} aria-label={`池子 ${pool.key}`} data-pool={pool.key}>
      <TitleBar
        title={p.title}
        {...(full ? { count: p.entries.length, total: MAX_ENTRIES } : {})}
        {...(compact ? {} : { note: p.detail })}
        actions={
          <>
            {p.overridden && <span className={styles.tag}>已改</span>}
            {p.overridden && !off && <WhiteCapsule label="用包里的" icon="refresh" onClick={() => p.onPool(null)} />}
          </>
        }
      />
      {p.adjusted && (
        <p className={styles.why} data-adjusted="">
          上次保存没有生效：{p.adjusted}
        </p>
      )}
      <div className={styles.rows}>
        {p.entries.map((e, i) => {
          const key = e.clip;
          const label = p.labelOf(key);
          const on = p.value(key);
          const open = p.open === key;
          const flag = flagOf(p.joints(key));
          const why = p.adjustedChain[key];
          // Compact rows keep only a red line (why it was not taken, a hard cut).
          const sub = why ? (
            <span className={styles.red}>{why}</span>
          ) : compact && flag?.tone !== 'red' ? undefined : !on ? (
            '已关 │ 抽到跳过'
          ) : flag ? (
            <span className={flag.tone === 'red' ? styles.red : styles.orange}>{flag.text}</span>
          ) : (
            shortName(key)
          );
          const share = total > 0 ? Math.round((e.weight / total) * 100) : 0;
          return (
            <Fragment key={key}>
              <div className={styles.row} data-chain={key} data-off={!on || undefined} data-open={open || undefined}>
                <DarkRow
                  title={label}
                  {...(sub != null ? { sub } : {})}
                  compact={compact}
                  selected={open}
                  onPress={() => p.onPreview(key)}
                  end={
                    <>
                      <Mini g={g} ix={ix} chain={key} />
                      <span className={styles.share} title="抽中比例">
                        <span className={styles.bar}>
                          <i style={{ width: `${share}%` }} />
                        </span>
                        <span className={styles.pct}>{share}%</span>
                      </span>
                      <Stepper
                        label={`「${label}」的权重`}
                        value={e.weight}
                        min={1}
                        max={100000}
                        step={1}
                        big={10}
                        changed={pack.get(key) !== e.weight}
                        disabled={off}
                        compact={compact}
                        onChange={(w) => set(i, w)}
                      />
                      {g.chains[key] ? (
                        <button
                          type="button"
                          className={styles.exp}
                          aria-expanded={open}
                          aria-label={open ? `收起「${label}」` : `展开「${label}」`}
                          onClick={() => p.onOpen(open ? null : key)}
                        >
                          <i aria-hidden="true" />
                        </button>
                      ) : (
                        <span className={styles.exp} />
                      )}
                    </>
                  }
                />
              </div>
              {open && p.inspector}
            </Fragment>
          );
        })}
        <div className={styles.add}>
          <button
            type="button"
            className={styles.addKey}
            aria-expanded={adding}
            aria-label={`往 ${pool.key} 加链`}
            disabled={addBlock != null}
            title={addBlock ?? undefined}
            onClick={() => setAdding(!adding)}
          >
            <span className={styles.plus} aria-hidden="true">
              +
            </span>
            {addBlock ?? '加一条同姿态的链起头…'}
          </button>
          {adding && addBlock == null && (
            <ul className={styles.addList} aria-label="能加的链起头">
              {more.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      p.onPool([...p.entries, { clip: k, weight: 1 }]);
                    }}
                  >
                    <b>{p.labelOf(k)}</b>
                    <small>{shortName(k)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {p.extra}
      </div>
    </section>
  );
}
