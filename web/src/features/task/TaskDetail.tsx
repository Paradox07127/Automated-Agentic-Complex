import { formatClock, formatDuration, isReviewableDelivery, type ActiveRun, type Delivery, type EffectiveState, type FileEffect, type PendingItem, type StepEvent, type Task, type ToolItem } from '../../domain';
import { Btn, ErrBar, Icon, StatusTag } from '../../ui';
import { DeliveryBox, useDeliveryVisibility, type OnDeliveryReceipt } from '../delivery';
import { RejectBox } from './RejectBox';
import { canContinue } from './StopConfirm';
import { TaskNeeds, type DecideFailCode } from './TaskNeeds';
import { TaskSections } from './TaskSections';
import { StatusLamp } from '../../ui/game/StatusLamp';
import { sourceLabel, statusKey, statusLabel } from './labels';
import styles from './TaskDetail.module.css';

/** Everything a task view can ask the page to do. Stop always goes through the shared confirm. */
export type TaskAction =
  | { kind: 'accept'; deliveryId: string }
  | { kind: 'reject'; deliveryId: string; note: string; useCurrentKernel: boolean }
  | { kind: 'continue'; note: string; useCurrentKernel: boolean }
  | { kind: 'stop' }
  | { kind: 'open_pending'; pendingId: string }
  /** The task's turn on 诊断 › 对话轮次; the turn list when the task has no run. */
  | { kind: 'open_timeline' }
  | { kind: 'jump_terminal'; sessionId: string }
  | { kind: 'open_artifact'; path: string }
  | { kind: 'reveal_artifact'; path: string }
  | { kind: 'copy_path'; path: string }
  | { kind: 'open_settings'; group: string; item?: string }
  | { kind: 'open_latest' }
  | { kind: 'send_session'; text: string }
  | { kind: 'retry_steps' };

/** 任务详情：「需要你做的」放最上；wait 态带审批的「等你决定」条「N 张 · 剩余 · 去批准 →」；状态读 effectiveState。 */
export interface TaskDetailProps {
  /** 任务 */
  task: Task;
  /** effectiveState(task, ctx) 的结果，由页面算好传入 */
  effective: EffectiveState;
  /** 当前时间 */
  now: number;
  /** 该任务的交付，按版本升序 */
  deliveries?: Delivery[];
  /** 该任务未处理的审批、提问、复核 */
  pending?: PendingItem[];
  /** 正在跑的运行 */
  activeRun?: ActiveRun | null;
  /** 步骤事件 */
  steps?: StepEvent[];
  /** 瀑布的工具刻度和工具耗时分布 */
  tools?: ToolItem[];
  /** 文件影响 */
  files?: FileEffect[];
  /** 步骤、工具、文件的读取状态 */
  stepsStatus?: 'ok' | 'loading' | 'error';
  /** 编码或外部会话 id（跳到终端） */
  sessionId?: string | null;
  /** 上一次决定失败的原因 */
  decideFail?: DecideFailCode | null;
  /** 正在提交决定 */
  decideBusy?: boolean;
  /** 桥有 revealInFinder 能力位 */
  canReveal?: boolean;
  /** 当前选中的内核名 */
  kernelName?: string;
  /** 工具耗时分布默认展开并选中这个工具族 */
  toolFocus?: string | null;
  /** 停止时间（停止后立即显示「已取消 · hh:mm」） */
  stoppedAt?: number | null;
  /** 操作 */
  onAction?: (action: TaskAction) => void;
  onReceipt?: OnDeliveryReceipt;
}

export function TaskDetail(props: TaskDetailProps) {
  const { task, effective, now, deliveries = [], pending = [], activeRun = null, stoppedAt = null, decideFail, decideBusy, canReveal, kernelName, sessionId = null, onAction } = props;
  const latest = [...deliveries].sort((a, b) => b.version - a.version)[0] ?? null;
  const visible = useDeliveryVisibility<HTMLElement>(latest, props.onReceipt, 'viewed');
  const review = latest && isReviewableDelivery(latest, task) && effective === 'waiting' ? latest : null;
  const stopped = task.status === 'cancelled' || stoppedAt != null;
  const live = ['running', 'queued', 'needs_review'].includes(task.status) && !stopped;
  // A running coding session has its own stop button next to the log.
  const codeLive = task.source === 'code' && task.status === 'running';
  const started = task.started_at;
  // Only a task waiting on the user keeps the yellow block; every other state is a lamp.
  const status = statusKey(task, effective, stoppedAt);
  const statusText = statusLabel(task, effective, pending, stoppedAt);
  return (
    <article ref={visible} data-stub="TaskDetail" data-effective={effective} className={styles.root} aria-label={task.title} tabIndex={-1}>
      <header className={styles.head}>
        <h2 className={styles.title}>{task.title}</h2>
        {status === 'waiting' ? <StatusTag state={status} label={statusText} /> : <StatusLamp state={status} label={statusText} />}
      </header>
      <p className={styles.sub}>
        <span className={styles.loc} aria-hidden="true">
          <Icon name="loc" size={14} />
        </span>
        <span>{sourceLabel(task)}</span>
        {started != null && (
          <span className="num">
            │ {formatClock(started)} 开始 │ {task.ended_at != null ? `用时 ${formatDuration(task.ended_at - started)}` : `已 ${formatDuration(now - started)}`}
          </span>
        )}
        {activeRun?.state.startsWith('awaiting') && <span className={styles.wait}>│ 运行待处理</span>}
      </p>
      {stopped && (
        <div className={styles.note} role="status">
          <span>
            已停止 │ <span className="num">{stoppedAt != null ? formatClock(stoppedAt) : task.ended_at != null ? formatClock(task.ended_at) : '—'}</span> │{' '}
            {canContinue(task) ? '已生成的产物会保留，可在下方继续补充指令。' : '已生成的产物会保留，停止后无法恢复执行。'}
          </span>
        </div>
      )}
      {task.summary && <p className={styles.desc}>{task.summary}</p>}
      {!stopped && <TaskNeeds review={review} pending={pending} now={now} kernelName={kernelName} decideFail={decideFail} busy={decideBusy} onAction={onAction} />}
      {task.failure && (
        <ErrBar
          message={task.failure.reason}
          extra={
            task.failure.fix ? (
              <Btn size="sm" variant="ghost" onClick={() => onAction?.({ kind: 'open_settings', group: 'perm', item: 'scope' })}>
                {task.failure.fix}
              </Btn>
            ) : undefined
          }
        />
      )}
      {deliveries.length > 0 && (
        <DeliveryBox
          deliveries={deliveries}
          now={now}
          secondaryEmphasis={!stopped && (review != null || pending.some((p) => (p.kind === 'approval' || p.kind === 'question') && !p.resolved))}
          canReveal={canReveal}
          onOpen={(path) => onAction?.({ kind: 'open_artifact', path })}
          onReveal={(path) => onAction?.({ kind: 'reveal_artifact', path })}
          onCopyPath={(path) => onAction?.({ kind: 'copy_path', path })}
        />
      )}
      <TaskSections {...props} />
      {task.source === 'ext' && (
        <div className={styles.note}>
          <span>外部会话并非由本应用派发，此处仅展示状态，不提供运行瀑布流。</span>
          <Btn size="sm" variant="text" icon="ext" disabled={!sessionId} disabledReason="未找到关联会话" onClick={() => sessionId && onAction?.({ kind: 'jump_terminal', sessionId })}>
            跳转至终端
          </Btn>
        </div>
      )}
      {task.source === 'role' && ['running', 'failed', 'rejected', 'interrupted'].includes(task.status) && !stopped && (
        <div className={styles.cont}>
          <RejectBox mode="continue" kernelName={kernelName} onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'continue', note, useCurrentKernel })} />
        </div>
      )}
      {live && task.source !== 'ext' && !codeLive && (
        <div className={styles.stop}>
          <Btn variant="ghost" icon="stop" onClick={() => onAction?.({ kind: 'stop' })}>
            停止任务
          </Btn>
        </div>
      )}
    </article>
  );
}
