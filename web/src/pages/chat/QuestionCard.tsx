import { useEffect, useRef, useState } from 'react';
import { formatClock, type Question } from '../../domain';
import { DecisionBar, QuestionBox } from '../../features/approval';
import { CodeBlock } from '../../features/trace';
import { Btn, OptionRow, Pill, Receipt } from '../../ui';
import { Head, Who } from './TextMessage';
import styles from './Messages.module.css';
import qc from './QuestionCard.module.css';

/** Same wording as the desktop stack's cancel receipt. */
export const CANCEL_RECEIPT = '已取消这次提问';
/** Seconds a cancel can still be undone before it is sent. */
export const UNDO_S = 5;

export interface QuestionCardProps {
  at: number;
  /** The request while it still waits; null once handled. */
  question: Question | null;
  /** The request as listed, also after it was handled: its kind, job and preview. */
  request?: Question | null;
  roleName: string;
  now: number;
  /** Answer text once answered here. */
  answered: string | null;
  /** Cancelled here (after the undo window). */
  cancelled?: boolean;
  /** Every question id with 1–2 answers (option, text). */
  onAnswer: (answers: Record<string, string[]>) => void;
  /** Sent once the 5 s undo window has passed. */
  onCancel: () => void;
  /** Her head picture; without it the first character of `roleName`. */
  headUrl?: string | undefined;
  /** First of consecutive messages by this speaker. */
  first?: boolean;
}

/** Question or approval request from the role, inline in the stream beside her head: a plate with one dark option bar each (yellow diamond at the left); a question also takes free text (QuestionBox). 发送 below keeps the one yellow button. */
export function QuestionCard({ at, question, request = question, roleName, now, answered, cancelled, onAnswer, onCancel, headUrl, first }: QuestionCardProps) {
  const [v, setV] = useState<{ selected: string | null; text: string }>({ selected: null, text: '' });
  const [undoing, setUndoing] = useState(false);
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  });
  useEffect(() => {
    if (!undoing) return;
    const id = setTimeout(() => {
      setUndoing(false);
      cancel.current();
    }, UNDO_S * 1000);
    return () => clearTimeout(id);
  }, [undoing]);

  const approval = request?.interaction_kind === 'approval';
  const pending = question != null && !answered && !cancelled;
  return (
    <div className={styles.msg} data-kind="question" data-first={first || undefined} data-pending={pending || undefined}>
      <Who name={roleName} at={at} />
      {first && <Head name={roleName} url={headUrl} />}
      <div className={styles.stack}>
        <div className={qc.qcard}>
          <div className={qc.qhead}>
            <span className={qc.qicon} aria-hidden="true" />
            <span className={qc.qkind}>{approval ? '审批' : '提问'}</span>
            {request?.job_id && <Pill tone="neutral">后台任务的请求</Pill>}
            {/* While it waits, the decision bar below carries the yellow 待回答 / 待批准 block. */}
            {!pending && <Pill tone={answered ? 'success' : 'neutral'}>{answered ? '已回答' : cancelled ? '已取消' : approval ? '待批准' : '待回答'}</Pill>}
          </div>
          {approval && question?.preview_text && (
            <div className={qc.preview}>
              <CodeBlock code={question.preview_text} preview={6} label="请求内容" />
            </div>
          )}
          {!question && !answered && !cancelled && <p className={qc.qtitle}>这次请求已处理，或已随任务停止</p>}
          {answered ? (
            <Receipt>已回答：{answered}</Receipt>
          ) : cancelled ? (
            <Receipt tone="neutral">{CANCEL_RECEIPT}</Receipt>
          ) : undoing ? (
            <div className={qc.undo}>
              <Receipt tone="neutral">{CANCEL_RECEIPT}</Receipt>
              <Btn variant="text" size="sm" onClick={() => setUndoing(false)}>
                撤销
              </Btn>
              <span className={styles.cap}>{UNDO_S} 秒内可撤销</span>
            </div>
          ) : question && approval ? (
            <ApprovalChoice question={question} selected={v.selected} onSelect={(selected) => setV({ selected, text: '' })} onAnswer={onAnswer} onCancel={() => setUndoing(true)} />
          ) : question ? (
            <QuestionBox question={question} now={now} secondaryEmphasis selected={v.selected} text={v.text} onChange={setV} onAnswer={onAnswer} onCancel={() => setUndoing(true)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ApprovalChoiceProps {
  question: Question;
  selected: string | null;
  onSelect: (option: string | null) => void;
  onAnswer: (answers: Record<string, string[]>) => void;
  onCancel: () => void;
}

/** Approval answers come from the product offer; no free text. */
function ApprovalChoice({ question, selected, onSelect, onAnswer, onCancel }: ApprovalChoiceProps) {
  const item = question.questions[0];
  const id = item?.id ?? 'decision';
  const options = (item ? item.options.map((o) => o.label) : question.options).filter((o) => o !== '本对话都允许');
  const allowSession = question.approval_answers?.includes('allow_session') && !question.dangerous && !question.danger_rule;
  return (
    <>
      <p className={qc.qtitle}>{item?.question ?? question.title}</p>
      <div className={qc.aopts} role="listbox" aria-label="选项">
        {options.map((o) => (
          <OptionRow key={o} label={o} selected={o === selected} onClick={() => onSelect(o === selected ? null : o)} />
        ))}
      </div>
      <DecisionBar
        inset
        secondaryEmphasis
        kind="approval"
        meta={question.expires_at != null ? `${formatClock(question.expires_at)} 前有效` : undefined}
        primary={{ label: '提交决定', disabled: selected == null, disabledReason: '选「允许」或「拒绝」', onClick: () => selected && onAnswer({ [id]: [selected] }) }}
        secondary={[{ label: '取消请求', onClick: onCancel }, ...(allowSession ? [{ label: '本对话都允许', onClick: () => onAnswer({ [id]: ['allow_session'] }) }] : [])]}
      />
    </>
  );
}
