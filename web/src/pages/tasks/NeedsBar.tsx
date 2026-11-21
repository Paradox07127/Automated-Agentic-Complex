import { useState } from 'react';
import { formatDuration, formatRemaining, sortPending, type Approval, type Delivery, type PendingItem, type Question } from '../../domain';
import { DecisionBar, type DecisionBarProps } from '../../features/approval';
import { DECIDE_FAIL, RejectBox, type DecideFailCode, type TaskAction } from '../../features/task';
import { Btn, ErrBar } from '../../ui';
import styles from './TaskView.module.css';

export interface NeedsBarProps {
  /** The version waiting for a decision. */
  review: Delivery | null;
  /** The task's open approvals and questions. */
  pending: PendingItem[];
  now: number;
  kernelName?: string;
  decideFail?: DecideFailCode | null;
  busy?: boolean;
  onAction?: (action: TaskAction) => void;
}

const waited = (q: Question, now: number) => (q.seconds_left == null ? `等了 ${formatDuration(now - q.since)}` : formatRemaining(q.seconds_left));

/** The one 「等你决定」 bar of a task: review first, else approvals, else a question; the others sit above it as lines. */
export function NeedsBar({ review, pending, now, kernelName, decideFail, busy, onAction }: NeedsBarProps) {
  const [rej, setRej] = useState(false);
  const approvals = sortPending(pending.filter((p): p is Approval => p.kind === 'approval' && !p.resolved));
  const questions = pending.filter((p): p is Question => p.kind === 'question' && !p.resolved);
  const first = approvals[0];
  const open = (id: string) => onAction?.({ kind: 'open_pending', pendingId: id });

  let bar: DecisionBarProps;
  if (review) {
    const seen = review.artifacts.filter((a) => a.opened).length;
    bar = {
      kind: 'review',
      title: `复核 v${review.version}`,
      meta: (
        <>
          {review.verification_source === 'auto' ? '已自动检查' : '未验证'}
          {review.artifacts.length > 0 && <> │ 产物 <span className="num">{seen}</span>/<span className="num">{review.artifacts.length}</span> 已看</>}
        </>
      ),
      primary: { label: `接受 v${review.version}`, disabled: busy, disabledReason: '正在提交', onClick: () => onAction?.({ kind: 'accept', deliveryId: review.id }) },
      secondary: [{ label: rej ? '收起' : '驳回…', onClick: () => setRej(!rej) }],
    };
  } else if (first) {
    const danger = approvals.filter((a) => a.dangerous).length;
    bar = {
      kind: 'approval',
      title: first.title,
      meta: [formatRemaining(first.seconds_left), approvals.length > 1 ? `共 ${approvals.length} 张` : '', danger > 0 ? `${danger} 张危险` : ''].filter(Boolean).join(' │ '),
      primary: { label: '前往审批', onClick: () => open(first.id) },
    };
  } else if (questions[0]) {
    const q = questions[0];
    bar = { kind: 'question', title: q.title, meta: waited(q, now), primary: { label: '回答', onClick: () => open(q.id) } };
  } else {
    return null;
  }

  const lines = [
    ...(review && first
      ? [{ id: first.id, text: `批准 ${approvals.length} 张：${first.title}`, meta: formatRemaining(first.seconds_left), label: '去批准' }]
      : []),
    ...questions.filter((q) => bar.kind !== 'question' || q !== questions[0]).map((q) => ({ id: q.id, text: `问：${q.title}`, meta: waited(q, now), label: '回答' })),
  ];
  const fail = review && decideFail ? DECIDE_FAIL[decideFail] : null;

  return (
    <section className={styles.needs} data-boxed={lines.length > 0 || undefined} aria-label="待处理">
      {lines.map((l) => (
        <div key={l.id} className={styles.needLine}>
          <span className={styles.needText} title={l.text}>
            {l.text}
          </span>
          <span className={styles.needMeta}>{l.meta}</span>
          <Btn size="sm" variant="secondary" onClick={() => open(l.id)}>
            {l.label}
          </Btn>
        </div>
      ))}
      <DecisionBar {...bar} inset={lines.length > 0} />
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
      {review && rej && (
        <RejectBox
          kernelName={kernelName}
          busy={busy}
          onCancel={() => setRej(false)}
          onSubmit={(note, useCurrentKernel) => onAction?.({ kind: 'reject', deliveryId: review.id, note, useCurrentKernel })}
        />
      )}
    </section>
  );
}
