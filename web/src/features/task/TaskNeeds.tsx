import { useState } from 'react';
import { formatDuration, formatRemaining, sortPending, type Approval, type Delivery, type PendingItem, type Question } from '../../domain';
import { Btn, ErrBar } from '../../ui';
import { DecisionBar } from '../approval';
import { RejectBox } from './RejectBox';
import type { TaskAction } from './TaskDetail';
import styles from './TaskNeeds.module.css';

/** Delivery decision failure codes and their copy (deliveries.py:240-283, http.py:42-43,64). */
export type DecideFailCode =
  | 'task_not_reviewable'
  | 'delivery_superseded'
  | 'delivery_already_decided'
  | 'delivery_scope_revoked'
  | 'invalid_delivery_revision'
  | 'delivery_version_changed'
  | 'delivery_revoked'
  | 'unknown_delivery'
  | 'unknown_task'
  | 'invalid_canonical_task'
  | 'invalid_delivery_payload';

export const DECIDE_FAIL: Record<DecideFailCode, { text: string; next?: string; action?: TaskAction }> = {
  task_not_reviewable: { text: '这项任务现在不能复核' },
  delivery_superseded: { text: '已有更新的一版', next: '看最新版', action: { kind: 'open_latest' } },
  delivery_already_decided: { text: '这一版已经处理过' },
  delivery_scope_revoked: { text: '资料授权已撤销，无法接受当前版本', next: '前往设置 › 能力', action: { kind: 'open_settings', group: 'perm', item: 'scope' } },
  invalid_delivery_revision: { text: '版本校验未通过', next: '查看最新版', action: { kind: 'open_latest' } },
  delivery_version_changed: { text: '当前版本已在其他位置更新', next: '查看最新版', action: { kind: 'open_latest' } },
  delivery_revoked: { text: '当前版本已撤回，无法操作' },
  unknown_delivery: { text: '未找到该交付版本' },
  unknown_task: { text: '未找到该任务' },
  invalid_canonical_task: { text: '任务标识无效' },
  invalid_delivery_payload: { text: '提交失败：请求内容不完整' },
};

export interface TaskNeedsProps {
  /** 等决定的那一版 */
  review: Delivery | null;
  /** 该任务未处理的审批和提问 */
  pending: PendingItem[];
  now: number;
  kernelName?: string;
  decideFail?: DecideFailCode | null;
  /** 正在提交决定 */
  busy?: boolean;
  /** 打开时就展开补充要求框 */
  rejecting?: boolean;
  onAction?: (action: TaskAction) => void;
}

/** "需要你做的" block on top of the detail: review decision, or the approval / question shortcut. */
export function TaskNeeds({ review, pending, now, kernelName, decideFail, busy, rejecting = false, onAction }: TaskNeedsProps) {
  const [rej, setRej] = useState(rejecting);
  const approvals = sortPending(pending.filter((p): p is Approval => p.kind === 'approval' && !p.resolved));
  const questions = pending.filter((p): p is Question => p.kind === 'question' && !p.resolved);
  const blocks = [];
  if (approvals.length > 0) {
    const first = approvals[0] as Approval;
    const danger = approvals.filter((a) => a.dangerous).length;
    blocks.push(
      <DecisionBar
        key="approval"
        kind="approval"
        title={first.title}
        meta={`${approvals.length} 张 │ ${formatRemaining(first.seconds_left)}${danger > 0 ? ` │ 其中 ${danger} 张危险` : ''}`}
        primary={{ label: '前往审批 →', onClick: () => onAction?.({ kind: 'open_pending', pendingId: first.id }) }}
      />,
    );
  }
  questions.forEach((q, i) => {
    blocks.push(
      <DecisionBar
        key={q.id}
        kind="question"
        title={q.title}
        meta={`${formatRemaining(q.seconds_left)} │ 等了 ${formatDuration(now - q.since)}`}
        secondaryEmphasis={approvals.length > 0 || i > 0}
        primary={{ label: '去回答 →', onClick: () => onAction?.({ kind: 'open_pending', pendingId: q.id }) }}
      />,
    );
  });
  if (review) {
    const opened = review.artifacts.filter((a) => a.opened).length;
    const fail = decideFail ? DECIDE_FAIL[decideFail] : null;
    blocks.push(
      <div key="review" className={styles.review}>
        <DecisionBar
          kind="review"
          title={`复核 v${review.version}`}
          meta={
            <>
              {review.verification_source === 'auto' ? '✓ 已自动检查' : '▲ 未验证'}
              {opened < review.artifacts.length && (
                <>
                  {' │ 产物 '}
                  <span className="num">{opened}</span>/<span className="num">{review.artifacts.length}</span> 打开过
                </>
              )}
            </>
          }
          secondaryEmphasis={approvals.length > 0 || questions.length > 0}
          primary={{ label: '接受这一版', loading: busy && !rej, onClick: () => onAction?.({ kind: 'accept', deliveryId: review.id }) }}
          secondary={[{ label: rej ? '收起补充要求' : '驳回这一版…', onClick: () => setRej(!rej) }]}
        />
        {fail && (
          <ErrBar
            message={fail.text}
            extra={
              fail.next && fail.action ? (
                <Btn size="sm" variant="ghost" onClick={() => fail.action && onAction?.(fail.action)}>
                  {fail.next}
                </Btn>
              ) : undefined
            }
          />
        )}
        {rej && (
          <div className={styles.reject}>
            <RejectBox
              kernelName={kernelName}
              busy={busy}
              onCancel={() => setRej(false)}
              onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'reject', deliveryId: review.id, note, useCurrentKernel })}
            />
          </div>
        )}
      </div>,
    );
  }
  if (blocks.length === 0) return null;
  return (
    <section className={styles.root} aria-label="待处理">
      {blocks}
    </section>
  );
}
