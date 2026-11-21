import type { KeyboardEvent } from 'react';
import { formatElapsed, runTiming, stateVisual, type ActiveRun, type EffectiveState, type Task } from '../../domain';
import { NodeChain, RunRing, SegMeter, type ChainNode } from '../../charts';
import { Fraction } from '../../ui';
import styles from './RunStepTrack.module.css';

/** 总览「进行中」行的步骤轨：有 plan 画 SegMeter，没有 plan 画节点链；行尾「工具 · <名> 00:42」；已用时间与卡点同源。 */
export interface RunStepTrackProps {
  /** 任务 */
  task: Task;
  /** 正在跑的运行 */
  run: ActiveRun;
  /** effectiveState 结果（等你时环换 attention） */
  effective: EffectiveState;
  /** 当前时间 */
  now: number;
  /** 重连后 plan 丢失：退回节点链并标「逐步状态待重连」 */
  lost?: boolean;
  /** 点行：去任务详情，或 wait 态选中第一张审批 */
  onOpen?: () => void;
}

const CHAIN = ['开始', '能力检查', '首字', '工具', '验证'] as const;
const PHASE_AT: Record<NonNullable<ActiveRun['phase']>, number> = { prepare: 1, tool: 3, verify: 4, awaiting: 3 };

/** No-plan fallback: "等你" rides on the current node instead of being a fixed node. */
function chainOf(run: ActiveRun, waiting: boolean): ChainNode[] {
  const at = run.phase ? PHASE_AT[run.phase] : 0;
  return CHAIN.map((label, i) => ({
    label: i === 3 && run.tools != null ? `工具 ×${run.tools}` : label,
    state: i < at ? 'done' : i === at ? 'current' : 'todo',
    waiting: i === at && waiting,
    sub: i === at && waiting ? '待处理' : undefined,
  }));
}

export function RunStepTrack({ task, run, effective, now, lost, onOpen }: RunStepTrackProps) {
  const step = run.plan?.steps.find((s) => s.status === 'in_progress' || s.status === 'waiting');
  const timing = runTiming(run.started_at, step?.since ?? run.since, now);
  const waiting = effective === 'waiting' || run.state.startsWith('awaiting');
  // Awaiting runs already read 等你批准 in the tail; the tag covers waits the run state does not show.
  const waitTag = effective === 'waiting' && !run.state.startsWith('awaiting') ? (task.status === 'needs_review' ? '待复核' : '待处理') : null;
  const category = task.source === 'role' ? 'mission' : 'neutral';
  const segments = run.plan != null && !lost;
  const done = run.plan?.steps.filter((s) => s.status === 'completed').length ?? null;
  const tail = run.tool ? `工具 │ ${run.tool}` : waiting ? stateVisual(run.state).label : (step?.text ?? stateVisual(run.state).label);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen?.();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-stub="RunStepTrack"
      data-mode={segments ? 'segments' : 'chain'}
      data-effective={effective}
      data-state={run.state}
      className={styles.root}
      onClick={onOpen}
      onKeyDown={onKey}
      aria-label={`${task.title}${waitTag ? ` │ ${waitTag}` : ''} │ ${stateVisual(run.state).label} │ 已运行 ${formatElapsed(timing.elapsed_ms)}`}
    >
      <RunRing state={run.state} phase={run.phase ?? undefined} category={category} />
      <span className={styles.main}>
        <span className={styles.title}>{task.title}</span>
        <span className={styles.track}>
          {segments && run.plan ? (
            <>
              <SegMeter steps={run.plan.steps} category={category} label="步骤" hideFraction />
              <Fraction value={done} total={run.plan.steps.length} label="步骤" />
            </>
          ) : (
            <NodeChain nodes={chainOf(run, waiting)} size="compact" category={category} label="运行进度" />
          )}
          {lost && <span className={styles.lost}>逐步状态待重连</span>}
        </span>
      </span>
      <span className={styles.read}>
        <span className={styles.tail} data-waiting={waiting || undefined}>
          {tail} <span className="num">{formatElapsed(timing.stall_ms ?? timing.elapsed_ms)}</span>
        </span>
        <span className={styles.elapsed}>
          已运行 <span className="num">{formatElapsed(timing.elapsed_ms)}</span>
        </span>
      </span>
      {waitTag && (
        <span className={styles.waitTag} title={waitTag}>
          ◆ 待处理
        </span>
      )}
    </div>
  );
}
