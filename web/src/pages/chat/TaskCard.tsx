import type { ActiveRun, Delivery, EffectiveState, PendingItem, Task } from '../../domain';
import { SegMeter } from '../../charts';
import { DeliveryChain, useDeliveryVisibility, type OnDeliveryReceipt } from '../../features/delivery';
import { statusLabel } from '../../features/task';
import { Pill } from '../../ui';
import styles from './Messages.module.css';
import tc from './TaskCard.module.css';

export interface TaskCardProps {
  task: Task;
  effective: EffectiveState;
  activeRun: ActiveRun | null;
  pending: PendingItem[];
  stoppedAt: number | null;
  /** Latest delivery of the task. */
  delivery?: Delivery | null;
  now: number;
  /** The right column shows this task. */
  selected?: boolean;
  onOpenTask: () => void;
  onReceipt?: OnDeliveryReceipt;
}

/** Category bar of the chat task card: waits on the user, runs, or anything else. */
function categoryOf(effective: EffectiveState, running: boolean): 'user' | 'run' | 'side' {
  if (effective === 'waiting') return 'user';
  return running || effective === 'running' ? 'run' : 'side';
}

/** Inline task card (snscontenttask), inserted when the run starts: category bar, Task · title · state with the go button, the step cells with the current step, the delivery chain. */
export function TaskCard({ task, effective, activeRun, pending, stoppedAt, delivery = null, now, selected, onOpenTask, onReceipt }: TaskCardProps) {
  const visible = useDeliveryVisibility(delivery, onReceipt, 'presented');
  const steps = activeRun?.plan?.steps ?? task.steps;
  const cur = steps.find((s) => s.status === 'in_progress') ?? steps[steps.length - 1];
  const label = statusLabel(task, effective, pending, stoppedAt);
  return (
    <div ref={visible} className={styles.msg} data-kind="task">
      <div className={`${styles.tcard} sns-task-stripes`} data-cat={categoryOf(effective, activeRun != null)} data-on={selected || undefined}>
        <span className={styles.tbar} aria-hidden="true" />
        <span className={styles.tico} aria-hidden="true">
          <span className={tc.taskK}>Task</span>
        </span>
        <span className={styles.tdiv} aria-hidden="true" />
        <div className={tc.main}>
          <button type="button" className={tc.taskH} onClick={onOpenTask} aria-label={`任务 ${task.title}，${label}，查看任务`}>
            <span className={tc.taskT}>{task.title}</span>
            <Pill tone={effective === 'waiting' ? 'attention' : 'neutral'}>{label}</Pill>
            <span className={tc.sp} />
            <span className={tc.cap}>查看任务</span>
            <span className={tc.go} aria-hidden="true" />
          </button>
          {steps.length > 0 && (
            <div className={tc.taskB}>
              <span className={tc.cap}>步骤</span>
              <SegMeter steps={steps} />
              {cur && <span className={`${tc.cap} ${tc.taskCur}`}>{activeRun ? '当前' : '最后步骤'}：{cur.text}</span>}
            </div>
          )}
          {delivery && (
            <div className={tc.taskD}>
              <span className={tc.cap}>
                交付 v<span className="num">{delivery.version}</span>
              </span>
              <DeliveryChain delivery={delivery} now={now} size="compact" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
