import { useState } from 'react';
import { formatClock, isReviewableDelivery, type ActiveRun, type Delivery, type EffectiveState, type PendingItem, type Task } from '../../domain';
import { Btn, Icon, IconBtn, StatusTag } from '../../ui';
import { DecisionBar } from '../approval';
import { ArtifactList, DeliveryChain, VersionChain, useDeliveryVisibility, type OnDeliveryReceipt } from '../delivery';
import { PlanProgress } from '../plan';
import { StatusLamp } from '../../ui/game/StatusLamp';
import { sourceLabel, statusKey, statusLabel } from './labels';
import { RejectBox } from './RejectBox';
import { canContinue } from './StopConfirm';
import type { TaskAction } from './TaskDetail';
import styles from './TaskDrawer.module.css';

/** 对话页任务抽屉：任务详情栏——标题、黄色地点行、目标带（状态、步骤）、奖励条（产物、版本）；退回先展开补充要求框；停止后只在 agentd 能接着做时给「继续」。 */
export interface TaskDrawerProps {
  /** 任务 */
  task: Task;
  /** effectiveState 结果 */
  effective: EffectiveState;
  /** 当前时间 */
  now: number;
  /** 最新一版交付 */
  delivery?: Delivery | null;
  /** 同一任务的全部交付（版本链） */
  deliveries?: Delivery[];
  /** 正在跑的运行 */
  activeRun?: ActiveRun | null;
  /** 该任务未处理的审批、提问、复核 */
  pending?: PendingItem[];
  /** 计划来源 */
  planSource?: 'live' | 'snapshot';
  /** 补充要求框已展开 */
  rejecting?: boolean;
  /** 停止时间：停止后不再给接受 / 退回 */
  stoppedAt?: number | null;
  /** 桥有 revealInFinder 能力位 */
  canReveal?: boolean;
  /** 当前选中的内核名 */
  kernelName?: string;
  /** 正在提交决定 */
  busy?: boolean;
  /** 放在 Sheet 里：标题由 Sheet 给，抽屉不再画自己的标题行 */
  inSheet?: boolean;
  /** 关闭 */
  onClose?: () => void;
  /** 在任务页打开 */
  onOpenTask?: () => void;
  /** 操作 */
  onAction?: (action: TaskAction) => void;
  onReceipt?: OnDeliveryReceipt;
}

export function TaskDrawer({ task, effective, now, delivery: latest = null, deliveries, activeRun = null, pending = [], planSource = 'live', rejecting = false, stoppedAt = null, canReveal, kernelName, busy, inSheet, onClose, onOpenTask, onAction, onReceipt }: TaskDrawerProps) {
  const [rej, setRej] = useState(rejecting);
  const [shown, setShown] = useState<string | null>(null);
  const versions = deliveries ?? (latest ? [latest] : []);
  // The picked version replaces the latest one in 产物, 版本 and the decision row, as in DeliveryBox.
  const delivery = versions.find((d) => d.id === shown) ?? latest;
  const visible = useDeliveryVisibility<HTMLDivElement>(delivery, onReceipt, 'viewed');
  const stopped = stoppedAt != null || task.status === 'cancelled';
  const resumable = canContinue(task);
  const jobRunning = task.job_id != null && task.status === 'running';
  // A running foreground task takes no note: agentd answers character_busy (routes/http.py).
  const carryOn = task.source === 'role' && (task.job_id || task.task_id) && ['failed', 'interrupted', 'rejected'].includes(task.status);
  const stopTime = stoppedAt ?? task.ended_at;
  const undecided = delivery != null && delivery.id === latest?.id && isReviewableDelivery(delivery, task);
  // Only a task waiting on the user keeps the yellow block; every other state is a lamp.
  const status = statusKey(task, effective, stoppedAt);
  const statusText = statusLabel(task, effective, pending, stoppedAt);
  return (
    <aside data-stub="TaskDrawer" data-effective={effective} data-rejecting={rej || undefined} data-in-sheet={inSheet || undefined} className={styles.root} aria-label={`任务 │ ${task.title}`}>
      {!inSheet && (
        <header className={styles.head}>
          <h2 className={styles.title}>{task.title}</h2>
          {onClose && <IconBtn icon="close" label="关闭任务抽屉" onClick={onClose} />}
        </header>
      )}
      <p className={styles.sub}>
        <span className={styles.loc} aria-hidden="true">
          <Icon name="loc" size={14} />
        </span>
        {sourceLabel(task)} │ 来自这段对话
      </p>
      <dl className={styles.dl}>
        <div className={styles.obj}>
          <dt>状态</dt>
          <dd>
            {status === 'waiting' ? <StatusTag state={status} label={statusText} /> : <StatusLamp state={status} label={statusText} />}
          </dd>
        </div>
        <div className={styles.obj}>
          <dt>步骤</dt>
          <dd>
            <PlanProgress plan={activeRun ? activeRun.plan : task.steps.length > 0 ? { revision: 1, steps: task.steps } : null} source={activeRun ? planSource : 'snapshot'} completed={task.status === 'succeeded'} ended={!activeRun && (task.ended_at != null || task.status === 'needs_review')} hasRun={task.run_count > 0} />
          </dd>
        </div>
        {delivery && (
          <>
            {/* 'viewed' goes when the delivery's own rows are on screen, not the drawer's head. */}
            <div ref={visible} className={styles.reward}>
              <dt>产物</dt>
              <dd>
                <ArtifactList
                  artifacts={delivery.artifacts}
                  layout="rows"
                  canReveal={canReveal}
                  onOpen={(path) => onAction?.({ kind: 'open_artifact', path })}
                  onReveal={(path) => onAction?.({ kind: 'reveal_artifact', path })}
                  onCopyPath={(path) => onAction?.({ kind: 'copy_path', path })}
                />
              </dd>
            </div>
            <div className={styles.reward}>
              <dt>版本</dt>
              <dd className={styles.ver}>
                <VersionChain deliveries={versions} selected={delivery.id} onPick={setShown} />
                <DeliveryChain delivery={delivery} now={now} size="compact" />
              </dd>
            </div>
          </>
        )}
      </dl>
      {stopped ? (
        <>
          <div className={styles.stopped} role="status">
            <span className={styles.timerIc} aria-hidden="true">
              <Icon name="stop" size={14} />
            </span>
            <span>
              已停止 │ <span className="num">{stopTime != null ? formatClock(stopTime) : '—'}</span> │ 已写出的产物保留。这一版不能再接受或驳回。
            </span>
          </div>
          {resumable && <RejectBox mode="continue" kernelName={kernelName} onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'continue', note, useCurrentKernel })} />}
        </>
      ) : undecided && delivery ? (
        <>
          <DecisionBar
            kind="review"
            primary={{ label: '接受这一版', loading: busy && !rej, disabled: busy, onClick: () => onAction?.({ kind: 'accept', deliveryId: delivery.id }) }}
            secondary={[{ label: rej ? '收起' : '驳回…', disabled: busy, onClick: () => setRej(!rej) }]}
          />
          {rej && (
            <RejectBox
              kernelName={kernelName}
              busy={busy}
              onCancel={() => setRej(false)}
              onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'reject', deliveryId: delivery.id, note, useCurrentKernel })}
            />
          )}
        </>
      ) : (
        <>
          {/* The picked version's decision; running and 继续 are the task's, whatever version is shown. */}
          {delivery?.decided_at != null && (
            <p className={styles.done} role="status">
              ✓ 当前版本{delivery.state === 'accepted' ? '已接受' : '已驳回'}
            </p>
          )}
          {jobRunning ? (
            <p className={styles.timer}>
              <span className={styles.timerIc} aria-hidden="true">
                <Icon name="clock" size={14} />
              </span>
              后台任务执行中，结束后可以补充要求。
            </p>
          ) : carryOn ? (
            <RejectBox mode="continue" kernelName={kernelName} onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'continue', note, useCurrentKernel })} />
          ) : null}
        </>
      )}
      {onOpenTask && (
        <div className={styles.foot}>
          <Btn size="sm" variant="text" icon="ext" onClick={onOpenTask}>
            在任务中打开
          </Btn>
        </div>
      )}
    </aside>
  );
}
