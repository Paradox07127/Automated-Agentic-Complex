import { useState, type KeyboardEvent } from 'react';
import { ChartState, LineChart, Timeline, type ChartStatus, type TimelineItem } from '../../charts';
import { formatClock, type StateCause, type StatePoint } from '../../domain';
import type { Beat } from './api';
import { BEAT_SOURCE, BEHAVIOR, CAUSE_SHORT, CAUSES } from './labels';
import styles from './Operator.module.css';

export type PanelTab = 'state' | 'beat';

export interface StatePanelProps {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  /** `/character/state/history` over the last 24 h. */
  log: StatePoint[];
  logStatus: ChartStatus;
  causes: StateCause[];
  beats: Beat[];
  beatStatus: ChartStatus;
  now: number;
  stoppedAt?: number;
}

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
/** Causes closer than this share one mark. */
const NEAR = 30 * 60_000;

/** The two largest causes in range, one per half hour, as marks on the curve. */
export function causeMarks(causes: StateCause[], t0: number, t1: number): Array<{ t: number; label: string }> {
  const picked: StateCause[] = [];
  for (const c of [...causes].filter((x) => x.at >= t0 && x.at <= t1).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    if (picked.length < 2 && !picked.some((p) => Math.abs(p.at - c.at) < NEAR)) picked.push(c);
  }
  return picked.sort((a, b) => a.at - b.at).map((c) => ({ t: c.at, label: CAUSE_SHORT[c.cause] ?? CAUSES[c.cause] ?? c.cause }));
}

/** 02 状态 / 行为决策：精神和心情 24 小时折线，竖线是变化原因；行为决策按来源分三条泳道。 */
export function StatePanel(p: StatePanelProps) {
  const t0 = p.now - DAY;
  const first = p.log[0]?.at;
  const late = first != null && first > t0 + HOUR;
  const caption =
    p.tab === 'state'
      ? late && first != null
        ? `${formatClock(first)} 起记录`
        : '竖线标记状态变化的原因'
      : `今日 ${p.beats.length} 次决策`;
  const tabs: Array<[PanelTab, string]> = [
    ['state', '状态'],
    ['beat', '行为决策'],
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    p.onTab(p.tab === 'state' ? 'beat' : 'state');
  };
  const stop = p.stoppedAt != null ? { stoppedAt: p.stoppedAt } : {};
  return (
    <section aria-label="状态与行为决策">
      <div className={styles.ptH}>
        <span className={styles.ptNo} aria-hidden="true">
          02
        </span>
        <div className={styles.ptabs} role="tablist" aria-label="状态与行为决策" onKeyDown={onKey}>
          {tabs.map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              id={`chr-pt-${k}`}
              aria-selected={p.tab === k}
              aria-controls="chr-pt-p"
              tabIndex={p.tab === k ? 0 : -1}
              className={styles.ptab}
              onClick={() => p.onTab(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <span className={styles.ptCap}>{caption}</span>
      </div>
      <div id="chr-pt-p" role="tabpanel" aria-labelledby={`chr-pt-${p.tab}`}>
        {p.tab === 'state' ? (
          <ChartState state={p.logStatus === 'ok' && p.log.length === 0 ? 'empty' : p.logStatus} emptyText="状态还没开始记录 │ 曲线从第一次记录开始画" height={104} {...stop}>
            <LineChart
              h={104}
              t0={late && first != null ? Math.floor(first / HOUR) * HOUR : t0}
              t1={p.now}
              now={p.now}
              yMin={-0.4}
              yMax={1}
              label="精神和心情 24 小时"
              fmtY={(v) => (v == null ? '—' : v.toFixed(1))}
              emph="e"
              marks={causeMarks(p.causes, t0, p.now)}
              series={[
                { id: 'e', label: '精神', pts: p.log.map((x) => [x.at, x.energy]) },
                { id: 'v', label: '心情', pts: p.log.map((x) => [x.at, x.valence]) },
              ]}
            />
          </ChartState>
        ) : (
          <ChartState state={p.beatStatus === 'ok' && p.beats.length === 0 ? 'empty' : p.beatStatus} emptyText="今天还没有行为决策 │ 角色每次选择动作时记录一次" height={104} {...stop}>
            <Beats beats={p.beats} now={p.now} />
          </ChartState>
        )}
      </div>
    </section>
  );
}

/** behavior.ticked as ticks in three lanes by who decided; the picked one is in the emphasis colour. */
function Beats({ beats, now }: { beats: Beat[]; now: number }) {
  const [sel, setSel] = useState<string | null>(null);
  const it = beats.find((b) => b.id === sel) ?? beats[beats.length - 1];
  // At least the last six hours, from the hour of the first decision.
  const t0 = Math.floor(Math.min(now - 6 * HOUR, beats[0]?.at ?? now) / HOUR) * HOUR;
  const lanes = (Object.keys(BEAT_SOURCE) as Array<keyof typeof BEAT_SOURCE>).map((k) => {
    const items: TimelineItem[] = beats
      .filter((b) => b.source === k)
      .map((b) => ({ id: b.id, t: b.at, tip: `${formatClock(b.at)} │ 选择「${BEHAVIOR[b.chosen] ?? b.chosen}」\n${BEAT_SOURCE[k]}` }));
    return { id: k, label: `${BEAT_SOURCE[k]} ${items.length}`, kind: 'ticks' as const, items };
  });
  return (
    <div>
      <Timeline lanes={lanes} t0={t0} t1={now} now={now} labelW={64} sel={it?.id ?? null} onPick={(x) => x.id && setSel(x.id)} label="行为决策" />
      {it && (
        <div className={styles.beatF}>
          <span className={styles.num}>{formatClock(it.at)}</span>
          <b>{BEHAVIOR[it.chosen] ?? it.chosen}</b>
          <span className={styles.beatD}>{BEAT_SOURCE[it.source]}</span>
        </div>
      )}
    </div>
  );
}
