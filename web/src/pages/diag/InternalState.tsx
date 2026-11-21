import { useEffect, useRef } from 'react';
import { formatClock } from '../../domain';
import { fromCooldowns, fromTurnNow } from '../../domain/adapt';
import { isoToMs } from '../../domain/units';
import { RawFold } from '../../features/trace';
import { GatePanel, gateHolds } from './GatePanel';
import { sourceLabel } from './model';
import { NowPanel } from './NowPanel';
import { ObsPanel } from './ObsPanel';
import { PhaseStack } from './PhaseStack';
import type { WireDiagState } from '../../domain/wire';
import styles from './State.module.css';

export interface InternalStateProps {
  d: WireDiagState;
  /** When this /diag/state arrived. */
  readAt: number;
  now: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Scroll into view on open (deep link `item=state`). */
  focus: boolean;
  /** Observation request opened on mount. */
  obs?: string | null;
}

/** 05 内部状态（默认折叠）：phase bar, gate, observation and 现在 inside, the raw /diag/state folded last. */
export function InternalState({ d, readAt, now, open, onToggle, focus, obs }: InternalStateProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focus && open) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus, open]);
  const turn = fromTurnNow(d.turn);
  const live = turn != null && turn.phase != null && turn.phase !== 'ended';
  const phase = live ? turn.phases_ms.find((x) => x.key === turn.phase) : undefined;
  const holds = gateHolds(d.gate);
  const changed = Math.max(...Object.values(d).map((b) => isoToMs(b.updated_at)));
  const raw = JSON.stringify(d, null, 2);
  return (
    <details ref={ref} id="diag-state" className={styles.state} open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className={styles.stateSum}>
        <span className={styles.sumNo} aria-hidden="true">
          05
        </span>
        <b className={styles.sumTitle}>内部状态</b>
        <span className={styles.sumNote}>当前轮阶段 │ 主动发言闸门 │ 观察请求</span>
        <span className={styles.chev} aria-hidden="true">
          {open ? '收起' : '展开'}
        </span>
      </summary>
      <div className={styles.phaseRow}>
        <span className={styles.t3}>当前轮</span>
        {live && turn ? <PhaseStack turn={turn} /> : <span className={styles.t3}>{turn ? '空闲 │ 上一轮已结束' : '空闲'}</span>}
        <span className={`${styles.t3} ${styles.lang}`}>{`回答语言错配 ${d.turn.language.mismatched}/${d.turn.language.lines}`}</span>
      </div>
      <div className={styles.stateGrid}>
        <GatePanel cooldowns={fromCooldowns(d.gate)} gate={d.gate} />
        <ObsPanel observation={d.observation} readAt={readAt} now={now} open={obs} />
        <NowPanel d={d} />
      </div>
      <RawFold
        summary={[
          live && turn ? `当前轮（${sourceLabel(d.turn.source ?? '')}）在「${phase?.label ?? turn.phase}」阶段` : '现在没有进行中的轮次',
          holds.length ? `闸门：${holds.join('、')}` : '闸门：没有拦着的条件',
          `最近变化 ${formatClock(changed, { seconds: true })}`,
        ]}
        raw={raw}
        rawLabel="状态原文"
      />
    </details>
  );
}
