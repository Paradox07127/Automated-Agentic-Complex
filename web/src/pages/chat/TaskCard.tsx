import type { ActiveRun, Delivery, EffectiveState, PendingItem, Task } from '../../domain';
import { SegMeter } from '../../charts';
import { DeliveryChain, useDeliveryVisibility, type OnDeliveryReceipt } from '../../features/delivery';
import { statusLabel } from '../../features/task';
import { Icon } from '../../ui';
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

/** Category of the card's left edge: waits on the user, runs, or anything else. */
function categoryOf(effective: EffectiveState, running: boolean): 'user' | 'run' | 'side' {
  if (effective === 'waiting') return 'user';
  return running || effective === 'running' ? 'run' : 'side';
}

/** Inline task card (proto `.task`), inserted when the run starts: task mark, title and state over the step cells with the current step, then the delivery chain. */
export function TaskCard({ task, effective, activeRun, pending, stoppedAt, delivery = null, now, selected, onOpenTask, onReceipt }: TaskCardProps) {
  const visible = useDeliveryVisibility(delivery, onReceipt, 'presented');
  const steps = activeRun?.plan?.steps ?? task.steps;
  const cur = steps.find((s) => s.status === 'in_progress') ?? steps[steps.length - 1];
  const label = statusLabel(task, effective, pending, stoppedAt);
  return (
    <div ref={visible} className={styles.msg} data-kind="task">
      <div className={styles.stack}>
        <div className={tc.card} data-cat={categoryOf(effective, activeRun != null)} data-on={selected || undefined}>
          <button type="button" className={tc.head} onClick={onOpenTask} aria-label={`任务 ${task.title}，${label}，查看任务`}>
            <Icon name="g-task" size={20} />
            <b className={tc.title}>{task.title}</b>
            <span className={tc.st} data-wait={effective === 'waiting' || undefined}>{label}</span>
            <span className={tc.sp} />
            <span className={tc.go}>查看任务</span>
          </button>
          {steps.length > 0 && (
            <div className={tc.steps}>
              <SegMeter steps={steps} />
              {cur && <span className={`${tc.cap} ${tc.cur}`}>{activeRun ? '当前' : '最后步骤'}：{cur.text}</span>}
            </div>
          )}
          {delivery && (
            <div className={tc.delivery}>
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
