// White decision papers inside a task's detail: approve a call, review a version, answer a question, accept a coding result.
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { AGENT_NAME, type Approval, type Delivery, type Question } from '../../domain';
import { verifyText } from '../../domain/errorText';
import { DiffPreview, QuestionBox, ruleLine } from '../../features/approval';
import { CmdBlock } from '../../features/approval/CmdBlock';
import { useCountdown } from '../../features/approval/useCountdown';
import { DECIDE_FAIL, RejectBox, type DecideFailCode, type TaskAction } from '../../features/task';
import { Btn, Kbd } from '../../ui';
import styles from './Paper.module.css';

/** A broker approval, or a role's exact-call approval (an interaction of kind approval). */
export type AskItem = Approval | (Question & { interaction_kind: 'approval' });

export type Verdict = 'allow' | 'allow_session' | 'deny';

/** agentd sends a role call's preview as indented JSON; the tool is its `tool` (or `server │ tool`). */
function callTool(preview: string | undefined): string | null {
  try {
    const o = JSON.parse(preview ?? '') as Record<string, unknown>;
    const parts = [o.server, o.tool].filter((x): x is string => typeof x === 'string' && x !== '');
    return parts.length > 0 ? parts.join(' │ ') : null;
  } catch {
    return null;
  }
}

const MODE_LABEL: Readonly<Record<string, string>> = { read_only: '只读', workspace_write: '可改工作区' };

export interface ApprovalPaperProps {
  item: AskItem;
  /** Who asks: the coding tool, or the role kernel's name. */
  kernelName?: string | undefined;
  /** 「这个任务里都允许」 for a role task, 「这次会话都允许」 for a coding session. */
  scopeLabel: string;
  onDecide: (verdict: Verdict, mode?: string) => void;
  /** ⏎ on a dangerous card. */
  onMouseOnly: () => void;
  /** Another decision on screen holds the one yellow button. */
  quiet?: boolean | undefined;
}

/** The approval paper: what she wants to call, the countdown, 批准 / 放开范围 / 拒绝; ⏎ on the paper approves, Esc never denies. */
export function ApprovalPaper({ item, kernelName, scopeLabel, onDecide, onMouseOnly, quiet }: ApprovalPaperProps) {
  const broker = item.kind === 'approval' ? item : null;
  const role = item.kind === 'question' ? item : null;
  const left = useCountdown(item.seconds_left);
  const windowS = broker ? broker.window_s : role?.expires_at != null ? Math.max(1, Math.round((role.expires_at - role.since) / 1000)) : null;
  const danger = !!item.dangerous;
  const scope = !danger && (broker ? !!broker.scope_ok && broker.options.includes('allow_session') : !!role?.approval_answers?.includes('allow_session'));
  const [mode, setMode] = useState(broker?.dispatch?.mode);
  const expired = left != null && left <= 0;
  const who = broker ? (AGENT_NAME[broker.agent] ?? broker.agent ?? '会话') : `${kernelName ?? '角色'} 内核`;
  const tool = broker ? broker.tool : callTool(role?.preview_text);
  const rule = item.danger_rule ? ruleLine(item.danger_rule) : null;
  const decide = (v: Verdict) => onDecide(v, broker?.dispatch ? mode : undefined);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target !== e.currentTarget || expired) return;
    e.preventDefault();
    if (danger) onMouseOnly();
    else decide('allow');
  };
  return (
    <div className={styles.paper} data-depth="" data-theme="light" data-warn={danger || undefined} tabIndex={0} onKeyDown={onKey} data-focus-card aria-label={danger ? `审批：${item.title}，只能用鼠标点批准` : `审批：${item.title}，回车批准`}>
      <h4>{item.title}</h4>
      <p>
        {who} 要调用 {tool ? <code>{tool}</code> : '一个工具'}，内容如下：
      </p>
      {rule && <p className={styles.rule}>{rule}</p>}
      {broker?.cmd && <CmdBlock cmd={broker.cmd} truncated={broker.summary_truncated} origLen={broker.orig_len} paper />}
      {broker?.content_preview && <DiffPreview preview={broker.content_preview} defaultOpen />}
      {broker?.dispatch && <pre className={styles.pv}>{broker.dispatch.prompt}</pre>}
      {role?.preview_text && <pre className={styles.pv}>{role.preview_text}</pre>}
      {broker?.dispatch && broker.dispatch.modes.length > 1 && (
        <div className={styles.btns} role="radiogroup" aria-label="运行模式">
          {broker.dispatch.modes.map((m) => (
            <Btn key={m} size="sm" variant={m === mode ? 'ghost' : 'text'} onClick={() => setMode(m)}>
              {MODE_LABEL[m] ?? m}
            </Btn>
          ))}
        </div>
      )}
      <div className={styles.cd}>
        <span className="num">{left == null ? '不限时' : expired ? '已过期' : `${left} 秒后失效`}</span>
        {left != null && windowS != null && <i style={{ '--left': `${Math.round((Math.max(0, left) / windowS) * 100)}%` } as CSSProperties} />}
      </div>
      {!expired && (
        <div className={styles.btns}>
          <Btn size="sm" variant={danger ? 'danger' : quiet ? 'ghost' : 'primary'} mouseOnly={danger} onClick={() => decide('allow')}>
            批准
          </Btn>
          {scope && (
            <Btn size="sm" variant="ghost" onClick={() => decide('allow_session')}>
              {scopeLabel}
            </Btn>
          )}
          <Btn size="sm" variant="secondary" onClick={() => decide('deny')}>
            拒绝
          </Btn>
          <span className={styles.sp} />
          <span className={styles.hint}>{danger ? '危险操作只能用鼠标点批准' : <><Kbd>⏎</Kbd>批准</>}</span>
        </div>
      )}
    </div>
  );
}

export interface ReviewPaperProps {
  review: Delivery;
  kernelName?: string | undefined;
  busy: boolean;
  decideFail: DecideFailCode | null;
  onAction: (a: TaskAction) => void;
  quiet?: boolean | undefined;
}

/** 复核 v2: accept it, or 驳回 with a note she continues from. */
export function ReviewPaper({ review, kernelName, busy, decideFail, onAction, quiet }: ReviewPaperProps) {
  const [rej, setRej] = useState(false);
  const seen = review.artifacts.filter((a) => a.opened).length;
  const fail = decideFail ? DECIDE_FAIL[decideFail] : null;
  const first = review.artifacts[0]?.name;
  return (
    <div className={styles.paper} data-depth="" data-theme="light">
      <h4>
        复核 v{review.version}
        {first ? `：${first}` : ''}
      </h4>
      <p>
        {review.verification_source === 'auto' ? '已自动检查' : '未验证'}
        {review.artifacts.length > 0 && (
          <>
            {' │ 产物 '}
            <b className="num">
              {seen} / {review.artifacts.length}
            </b>{' '}
            已看
          </>
        )}
        。接受后任务记为完成；驳回时写一句要改什么，角色按补充要求再做一版。
      </p>
      <div className={styles.btns}>
        <Btn size="sm" variant={quiet ? 'ghost' : 'primary'} disabled={busy} disabledReason="正在提交" onClick={() => onAction({ kind: 'accept', deliveryId: review.id })}>
          接受 v{review.version}
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => setRej(!rej)}>
          {rej ? '收起' : '驳回…'}
        </Btn>
      </div>
      {fail && (
        <p className={styles.err} role="alert">
          {fail.text}
          {fail.next && fail.action && (
            <>
              {' '}
              <Btn size="sm" variant="text" onClick={() => fail.action && onAction(fail.action)}>
                {fail.next}
              </Btn>
            </>
          )}
        </p>
      )}
      {rej && (
        <RejectBox
          kernelName={kernelName}
          busy={busy}
          onCancel={() => setRej(false)}
          onSubmit={(note, useCurrentKernel) => onAction({ kind: 'reject', deliveryId: review.id, note, useCurrentKernel })}
        />
      )}
    </div>
  );
}

/** A coding task that needs 验收: its check result, 验收 or 驳回. */
export function CodeReviewPaper({ verify, onReview }: { verify: { exit_code: number | null; reason: string | null } | null; onReview: (v: 'accept' | 'reject') => void }) {
  return (
    <div className={styles.paper} data-depth="" data-theme="light">
      <h4>验收编码结果</h4>
      <p>{verify ? (verify.reason === 'no_verify_cmd' ? `${verifyText(verify)}，结果待复核` : verifyText(verify)) : '没有检查结果'}</p>
      <div className={styles.btns}>
        <Btn size="sm" variant="primary" onClick={() => onReview('accept')}>
          验收
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => onReview('reject')}>
          驳回
        </Btn>
      </div>
    </div>
  );
}

/** Her question: QuestionBox on paper. */
export function QuestionPaper({ question, now, onAnswer, onCancel }: { question: Question; now: number; onAnswer: (a: Record<string, string[]>) => void; onCancel: () => void }) {
  return (
    <div className={styles.paper} data-depth="" data-theme="light" data-focus-card tabIndex={-1}>
      <QuestionBox question={question} now={now} onAnswer={onAnswer} onCancel={onCancel} />
    </div>
  );
}
