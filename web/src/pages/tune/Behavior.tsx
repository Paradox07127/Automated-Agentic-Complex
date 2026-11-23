import { useState } from 'react';
import { BracketMeter } from '../../charts';
import { useWidth } from '../../charts/useWidth';
import { formatClock, type CharacterState, type StatePoint } from '../../domain';
import { navigate } from '../../shell/nav';
import { Btn, SecHead, Skel } from '../../ui';
import { GameFrame, GameSeg, ReadoutPlate, StatusLamp, type ReadoutCell } from '../../ui/game';
import type { Beat } from '../character/api';
import { doing, stateWord } from '../character/labels';
import { attrName, causeName, signed, StateDecisionChart } from './StateDecisionChart';
import styles from './Tune.module.css';

export type Range = 'today' | '24h';

export interface BehaviorProps {
  /** undefined while the first read runs; null without a state (503 no_state). */
  state: CharacterState | null | undefined;
  log: StatePoint[];
  beats: Beat[];
  /** The decision read came back full: older ones in the window are left out. */
  capped: number | null;
  range: Range;
  onRange: (r: Range) => void;
  t0: number;
  now: number;
  /** Where the curves stop when agentd went away. */
  stoppedAt?: number | undefined;
  /** The character's host is not running: nothing is being done. */
  offline: boolean;
}

const RANGES = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '24 小时' },
];

/** The plate's cells: energy, mood, engagement, what she does, and whether the state steers her behavior; `compact` (925) drops the words, the engagement meter and the link. */
function stateCells(s: CharacterState | null, offline: boolean, compact: boolean): ReadoutCell[] {
  const size = compact ? 'mini' : 'sm';
  const word = (w: string) => (compact ? undefined : w);
  const on = s?.affects_behavior ?? false;
  return [
    s?.energy != null
      ? { label: '精神', meter: <BracketMeter value={s.energy} max={1} tone="level" size={size} marks={[0.35]} readout="" label="精神" />, value: s.energy.toFixed(2), word: word(stateWord('energy', s.labels.energy)) }
      : { label: '精神', value: '—' },
    s?.valence != null
      ? { label: '心情', meter: <BracketMeter value={s.valence} max={0.6} center={s.baseline ?? 0} size={size} readout="" label="心情" />, value: signed(s.valence), word: word(stateWord('mood', s.labels.mood)) }
      : { label: '心情', value: '—' },
    s?.engagement != null
      ? { label: '投入', meter: compact ? undefined : <BracketMeter value={s.engagement} max={1} tone="level" size={size} readout="" label="投入" />, value: s.engagement.toFixed(2), word: word(stateWord('engagement', s.labels.engagement)) }
      : { label: '投入', value: '—' },
    { label: '在做', word: <span className={styles.doing}>{(!offline && doing(s?.activity ?? null)) || '—'}</span> },
    {
      label: null,
      end: true,
      word: s ? (
        <span className={styles.aff}>
          <StatusLamp state={on ? 'ok' : 'idle'} label={`状态影响行为 ${on ? '开' : '关'}`} />
          {!compact && (
            <Btn size="sm" onClick={() => navigate({ page: 'character', tab: 'behavior', row: 'beh.mood' })}>
              角色页
            </Btn>
          )}
        </span>
      ) : null,
    },
  ];
}

/** 行为：她现在的状态，精神与心情曲线和三条决策泳道同轴，旁边列出变化原因；点原因或决策固定光标。 */
export function Behavior(p: BehaviorProps) {
  const s = p.state;
  const latest = p.beats.at(-1)?.at ?? null;
  const [picked, setPicked] = useState<number | null>(null);
  const pick = picked ?? latest;
  const causes = s?.causes ?? [];
  const micro = p.range === 'today' ? 'TODAY' : '24H';
  const span = p.range === 'today' ? '今天' : '近 24 小时';
  // The 925 layout; the same limit as the page's container rules.
  const [root, width] = useWidth<HTMLDivElement>(1200);
  const compact = width < 1000;

  return (
    <div ref={root} className={styles.behavior}>
      {s === undefined ? (
        <Skel rows={1} shape="block" />
      ) : (
        <ReadoutPlate label="她现在的状态" eyebrow="STATE CURRENT" cells={stateCells(s, p.offline, compact)} compact={compact} />
      )}
      <section className={styles.sec} aria-label="状态与决策">
        <SecHead
          title="状态与决策"
          micro="STATE & DECISIONS"
          right={
            <span className={styles.headR}>
              <span className={styles.legend} aria-hidden="true">
                <span>
                  <i data-k="e" />
                  精神
                </span>
                <span>
                  <i data-k="v" />
                  心情
                </span>
                {!compact && (
                  <span>
                    <i data-k="c" />
                    变化原因
                  </span>
                )}
              </span>
              <GameSeg variant="setting" size="compact" label="时间范围" value={p.range} options={RANGES} onChange={(v) => p.onRange(v as Range)} />
            </span>
          }
        />
        <div className={styles.grid}>
          <GameFrame title="精神与心情 │ 行为决策" micro={micro} foot={`AIC BEHAVIOR ${micro}`} label="精神与心情 │ 行为决策">
            {p.capped != null && <span className={styles.capped}>只显示最近 {p.capped} 条决策</span>}
            {s === undefined ? (
              <div className={styles.chartSkel}>
                <Skel rows={1} shape="chart" />
              </div>
            ) : (
              <StateDecisionChart
                log={s ? p.log : []}
                causes={causes}
                beats={p.beats}
                t0={p.t0}
                t1={p.now}
                step={p.range === 'today' ? 3 : 4}
                stoppedAt={p.stoppedAt}
                noCurve={s ? undefined : '状态还没开始记录 │ 她第一次活动后开始画'}
                noBeats={`${span}还没有行为决策 │ 她每次选动作时记一次`}
                pick={pick}
                onPick={setPicked}
                label={`精神和心情曲线，下面是同一时间轴上的行为决策，${span}`}
              />
            )}
          </GameFrame>
          <GameFrame title="变化原因" micro={`LAST ${causes.length}`} label="变化原因">
            <div className={styles.causes}>
              {causes.length === 0 ? (
                <p className={styles.empty}>还没有变化原因</p>
              ) : (
                <ol>
                  {causes.map((c) => (
                    <li key={`${c.at}${c.attr}`}>
                      <button type="button" aria-pressed={pick === c.at} onClick={() => setPicked(c.at)}>
                        <span className={styles.tm}>{formatClock(c.at)}</span>
                        <span className={styles.at}>{attrName(c)}</span>
                        <span className={styles.cz}>{causeName(c)}</span>
                        <span className={styles.dl}>{signed(c.delta)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </GameFrame>
        </div>
      </section>
    </div>
  );
}
