import type { ReactNode } from 'react';
import { formatClock, formatDuration, isCodingReview, isReviewableDelivery } from '../../domain';
import { ArtifactChecks, useDeliveryVisibility } from '../../features/delivery';
import { verifyText } from '../../domain/errorText';
import { DecisionBar } from '../../features/approval';
import { RejectBox, sourceLabel, statusKey, statusLabel, type TaskDetailProps } from '../../features/task';
import { Btn, InfoTip, StatusTag } from '../../ui';
import { MessageText } from '../chat/MessageText';
import { DeliverySection } from './DeliverySection';
import { stoppable } from './model';
import { NeedsBar } from './NeedsBar';
import { RunSections, type RunExtras } from './RunSections';
import styles from './TaskView.module.css';

export interface TaskViewExtras {
  /** ⋯ beside the title (own coding session management). */
  menu?: ReactNode;
  /** 验收 / 退回 of a coding task that needs review. */
  onReview?: (verdict: 'accept' | 'reject') => void;
}

/** Task detail: title and one meta line, the 等你决定 bar, summary, then steps, artifacts, tools, files and meta. */
export function TaskView(props: TaskDetailProps & RunExtras & TaskViewExtras) {
  const { task, effective, now, deliveries = [], pending = [], stoppedAt = null, decideFail, decideBusy, canReveal, kernelName, sessionId = null, onAction, nativeOff = {} } = props;
  const latest = [...deliveries].sort((a, b) => b.version - a.version)[0] ?? null;
  const visible = useDeliveryVisibility<HTMLElement>(latest, props.onReceipt, 'viewed');
  const review = latest && latest.id === task.delivery?.id && isReviewableDelivery(latest, task) && effective === 'waiting' ? latest : null;
  const stopped = task.status === 'cancelled' || stoppedAt != null;
  const codeReview = !stopped && isCodingReview(task) && props.onReview != null;
  const live = stoppable(task) && !stopped;
  const codeLive = task.source === 'code' && task.status === 'running';
  const open = pending.filter((p) => !p.resolved && p.kind !== 'review');
  // The bar's own state tag says 等你; the header tag would repeat it.
  const deciding = !stopped && (review != null || open.length > 0 || codeReview);
  const started = task.started_at;
  const summary = task.summary?.replace(/^(?:\s*\[(?:int(?:ent)?|motion|point):[^\]\r\n]{1,200}\])+\s*/, '');
  return (
    <article ref={visible} data-stub="TaskView" data-effective={effective} className={styles.root} aria-label={task.title} tabIndex={-1}>
      <header className={styles.head}>
        <h2 className={styles.title}>{task.title}</h2>
        {!deciding && <StatusTag state={statusKey(task, effective, stoppedAt)} label={statusLabel(task, effective, pending, stoppedAt)} />}
        {task.failure?.fix && (
          <Btn size="sm" variant="secondary" onClick={() => onAction?.({ kind: 'open_settings', group: 'perm', item: 'scope' })}>
            {task.failure.fix}
          </Btn>
        )}
        {props.menu}
      </header>
      <p className={styles.meta}>
        {sourceLabel(task)}
        {started != null && (
          <span className="num">
            {' '}
            │ {formatClock(started)} 开始 │ {task.ended_at != null ? `用时 ${formatDuration(task.ended_at - started)}` : `已 ${formatDuration(now - started)}`}
          </span>
        )}
      </p>
      {stopped && (
        <div className={styles.note} role="status">
          <span>
            已停止 │ <span className="num">{stoppedAt != null ? formatClock(stoppedAt) : task.ended_at != null ? formatClock(task.ended_at) : '—'}</span> │ 产物保留，不能恢复执行
          </span>
        </div>
      )}
      {codeReview && (
        <section className={styles.needs} aria-label="待处理">
          <DecisionBar
            kind="review"
            title="验收编码结果"
            meta={task.verify ? (task.verify.reason === 'no_verify_cmd' ? `${verifyText(task.verify)}，结果待复核` : verifyText(task.verify)) : '没有检查结果'}
            primary={{ label: '验收', onClick: () => props.onReview?.('accept') }}
            secondary={[{ label: '驳回', onClick: () => props.onReview?.('reject') }]}
          />
        </section>
      )}
      {!stopped && <NeedsBar review={review} pending={pending} now={now} kernelName={kernelName} decideFail={decideFail} busy={decideBusy} onAction={onAction} />}
      {summary && <section className={styles.summary} aria-label="任务结果"><MessageText text={summary} /></section>}
      {latest && <ArtifactChecks artifacts={latest.artifacts} />}
      {deliveries.length > 0 && (
        <DeliverySection
          deliveries={deliveries}
          countInBar={review != null}
          canReveal={canReveal}
          onOpen={(path) => onAction?.({ kind: 'open_artifact', path })}
          onReveal={(path) => onAction?.({ kind: 'reveal_artifact', path })}
          onCopyPath={(path) => onAction?.({ kind: 'copy_path', path })}
          nativeOff={nativeOff}
        />
      )}
      <RunSections {...props} />
      {task.source === 'ext' && (
        <div className={styles.note}>
          <span className={styles.inline}>
            外部会话：这里只显示状态
            <InfoTip>外部会话不是本 app 交派的，不画运行瀑布，也不能在这里停止。</InfoTip>
          </span>
          <Btn size="sm" variant="secondary" icon="ext" disabled={!sessionId || nativeOff.jump != null} disabledReason={nativeOff.jump ?? '没有找到会话'} onClick={() => sessionId && onAction?.({ kind: 'jump_terminal', sessionId })}>
            跳到终端
          </Btn>
        </div>
      )}
      {task.source === 'role' && ['running', 'failed', 'rejected', 'interrupted'].includes(task.status) && !stopped && (
        <RejectBox mode="continue" kernelName={kernelName} onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'continue', note, useCurrentKernel })} />
      )}
      {live && task.source !== 'ext' && !codeLive && !codeReview && (
        <div>
          <Btn variant="ghost" icon="stop" onClick={() => onAction?.({ kind: 'stop' })}>
            停止任务
          </Btn>
        </div>
      )}
    </article>
  );
}
