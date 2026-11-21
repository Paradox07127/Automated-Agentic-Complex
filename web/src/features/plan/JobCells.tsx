import { stateVisual, type EffectiveState, type PlanStep, type StepStatus, type Task } from '../../domain';
import { SegMeter } from '../../charts';
import { Fraction } from '../../ui';
import styles from './JobCells.module.css';

/** 目标的任务分格：每个 job 一格，按 effectiveState 编码；全满才可「核验并完成」。 */
export interface JobCellsProps {
  /** 目标下的任务和各自的 effectiveState，按目标里的顺序 */
  jobs: Array<{ task: Pick<Task, 'id' | 'title'>; effective: EffectiveState }>;
}

const CELL: Record<EffectiveState, StepStatus> = {
  done: 'completed',
  running: 'in_progress',
  waiting: 'waiting',
  failed: 'failed',
  idle: 'pending',
  stopped: 'pending',
};

/** Done cells over all cells; the goal can be verified only when they are equal. */
export function jobsDone(jobs: JobCellsProps['jobs']): number {
  return jobs.filter((j) => j.effective === 'done').length;
}

export function JobCells({ jobs }: JobCellsProps) {
  const steps: PlanStep[] = jobs.map((j) => ({ text: `${j.task.title} │ ${stateVisual(j.effective).label}`, status: CELL[j.effective], since: null }));
  return (
    <span data-stub="JobCells" className={styles.root}>
      <SegMeter steps={steps} label="任务" hideFraction />
      <Fraction value={jobsDone(jobs)} total={jobs.length} label="任务完成" />
    </span>
  );
}
