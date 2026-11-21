import { useState, type KeyboardEvent } from 'react';
import type { Approval, PendingItem, Question } from '../../domain';
import { ApprovalCard, QuestionBox } from '../../features/approval';
import { RawFold } from '../../features/trace';
import { Btn, InfoTip } from '../../ui';
import styles from './Detail.module.css';

export interface PendingDetailProps {
  item: Approval | Question;
  /** All unresolved items, sorted (for the card's "1/5"). */
  pending: PendingItem[];
  now: number;
  /** `mode` only for a dispatch card; `reason` only with a deny. */
  onApprove: (ids: string[], decision: 'allow' | 'deny' | 'allow_session', mode?: string, reason?: string) => void;
  /** Answers for every question id. */
  onAnswer: (question: Question, answers: Record<string, string[]>) => void;
  onCancelQuestion: (question: Question) => void;
  onOpenSession: (approval: Approval) => void;
  /** Why the session link is off (the shell refused to jump to a terminal). */
  sessionOff?: string;
  onOpenChat: (conversationId: string) => void;
  /** Enter on a dangerous card. */
  onMouseOnly: () => void;
}

/** Keep only approval choices, translating the conversation choice to its wire answer. */
function approvalAnswers(a: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.filter((x) => x === '允许' || x === '拒绝' || x === '本对话都允许').slice(0, 1).map((x) => x === '本对话都允许' ? 'allow_session' : x)]));
}

/** agentd sends the preview as indented JSON (interactions.py list); the summary names its server and tool. */
function previewSummary(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    const o = v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const parts = [o.server, o.tool].filter((x): x is string => typeof x === 'string' && x !== '');
    if (parts.length > 0) return parts.join(' │ ');
  } catch {
    // Not JSON: the generic line below.
  }
  return '要批准的操作';
}

/** Detail for an approval or a question; the card carries the title, so there is no second heading. */
export function PendingDetail({ item, pending, now, onApprove, onAnswer, onCancelQuestion, onOpenSession, sessionOff, onOpenChat, onMouseOnly }: PendingDetailProps) {
  const [answer, setAnswer] = useState<{ selected: string | null; text: string }>({ selected: null, text: '' });
  if (item.kind === 'question') {
    return (
      <article className={styles.root} aria-label={`提问 │ ${item.title}`} tabIndex={-1} data-focus-card>
        {item.preview_text && (
          <RawFold summary={[previewSummary(item.preview_text)]} raw={item.preview_text} rawLabel="操作内容" />
        )}
        <QuestionBox
          question={item}
          now={now}
          selected={answer.selected}
          text={answer.text}
          onChange={setAnswer}
          onAnswer={(a) => onAnswer(item, item.interaction_kind === 'approval' ? approvalAnswers(a) : a)}
          onCancel={() => onCancelQuestion(item)}
        />
        <div>
          <Btn size="sm" variant="ghost" icon="ext" disabled={item.conversation_id == null} disabledReason="这次提问不属于任何对话" onClick={() => item.conversation_id && onOpenChat(item.conversation_id)}>
            在对话中打开
          </Btn>
        </div>
      </article>
    );
  }
  const approvals = pending.filter((p): p is Approval => p.kind === 'approval');
  const same = approvals.filter((a) => !a.dangerous && a.session_id === item.session_id);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (item.dangerous) onMouseOnly();
      else onApprove([item.id], 'allow');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onApprove([item.id], 'deny');
    }
  };
  return (
    <article className={styles.root} aria-label={`审批 │ ${item.title}`}>
      <p className={styles.sub}>
        <span>
          会话 <span className={styles.mono}>{item.session_id}</span>
        </span>
        {item.dangerous ? (
          <span className={styles.rule}>
            危险：只能单次批准
            <InfoTip>危险操作不提供「本会话都允许同类操作」；只能用鼠标点「批准」，回车、双击或长按都不会批准。倒计时不会因悬停暂停。</InfoTip>
          </span>
        ) : (
          <InfoTip>卡片聚焦时：回车批准，esc 拒绝。倒计时不会因悬停暂停。</InfoTip>
        )}
        {item.scope_ok && item.session_scope && <span>本会话都允许时放行：{item.session_scope.detail}</span>}
        {sessionOff && <span>{sessionOff}</span>}
      </p>
      <div className={styles.cardWrap} tabIndex={0} onKeyDown={onKey} data-focus-card aria-label={item.dangerous ? '审批卡：危险操作只能用鼠标点批准，esc 拒绝' : '审批卡：回车批准，esc 拒绝'}>
        <ApprovalCard
          approval={item}
          position={{ index: pending.findIndex((p) => p.id === item.id) + 1, total: pending.length }}
          onDecide={(d, mode, reason) => onApprove([item.id], d, mode, reason)}
          onOpenSession={() => onOpenSession(item)}
          sessionReason={sessionOff}
        />
      </div>
      {!item.dangerous && same.length > 1 && (
        <div className={styles.batch}>
          <span>
            同一会话还有 <span className="num">{same.length - 1}</span> 张非危险审批
          </span>
          <span className={styles.sp} />
          <Btn size="sm" variant="secondary" onClick={() => onApprove(same.map((a) => a.id), 'allow')}>
            一起批准 {same.length} 张
          </Btn>
        </div>
      )}
    </article>
  );
}
