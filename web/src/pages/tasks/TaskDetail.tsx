// One task's detail (MissionInfoNode): kind, title and state plate, the yellow location line, times; then failure, queue,
// result, the decision papers inside the step she waits on, the coding session's last lines, 产物 and the continue note.
import { useState, type ReactNode } from 'react';
import { getBridge } from '../../bridge';
import { formatClock, formatDuration, isCodingReview, isReviewableDelivery, type PendingItem, type Question, type Task } from '../../domain';
import { verifyText } from '../../domain/errorText';
import { useDeliveryVisibility } from '../../features/delivery';
import { RejectBox } from '../../features/task';
import { Btn, Field, Fold, Pill, SecHead, type PillProps } from '../../ui';
import { MicroLabel } from '../../ui/game';
import { MessageText } from '../chat/MessageText';
import { Artifacts } from './Artifacts';
import { Clock, Pin, Warn } from './Glyphs';
import { pendingOf } from './model';
import { ApprovalPaper, CodeReviewPaper, QuestionPaper, ReviewPaper, type AskItem, type Verdict } from './Papers';
import { endState } from './rows';
import { dayText } from './schedules';
import { SessionMenu } from './SessionMenu';
import { Steps } from './Steps';
import type { TaskDesk } from './useTaskDesk';
import { useSessionLines, useTaskExtras } from './useTasksData';
import page from './Page.module.css';
import paper from './Paper.module.css';
import styles from './Detail.module.css';

const isAsk = (p: PendingItem): p is AskItem => p.kind === 'approval' || (p.kind === 'question' && p.interaction_kind === 'approval');
const isQuestion = (p: PendingItem): p is Question => p.kind === 'question' && p.interaction_kind !== 'approval';
/** State plate: tone and the shape before the word (danger brings its own「!」). */
const CHIP: Record<'wait' | 'run' | 'done' | 'err' | 'off', [NonNullable<PillProps['tone']>, string]> = {
  wait: ['attention', '◆'],
  run: ['mission', '○'],
  done: ['success', '✓'],
  err: ['danger', ''],
  off: ['paper', '□'],
};

/** The option a role approval's answer names: its own 允许 / 拒绝 label, or `allow_session`. */
function askAnswer(q: Question, v: Verdict): Record<string, string[]> {
  const item = q.questions[0];
  const labels = item ? item.options.map((o) => o.label) : q.options;
  const pick = v === 'allow_session' ? 'allow_session' : (labels.find((l) => (v === 'allow' ? /允许/.test(l) && !/都/.test(l) : /拒绝/.test(l))) ?? (v === 'allow' ? '允许' : '拒绝'));
  return { [item?.id ?? '']: [pick] };
}

export interface TaskDetailProps {
  task: Task;
  desk: TaskDesk;
  /** The role's name on the location line. */
  who: string;
  convTitle: (id: string) => string | null;
  onGoChat: (id: string) => void;
  /** 补一句 from the bottom bar opens the note paper. */
  note: boolean;
  onNote: (open: boolean) => void;
}

export function TaskDetail({ task, desk, who, convTitle, onGoChat, note, onNote }: TaskDetailProps) {
  const view = desk.view!;
  const actions = desk.actions!;
  const extras = useTaskExtras(task, false, desk.retry, 1).data;
  const deliveries = view.deliveries.filter((d) => d.task_id === task.id).sort((a, b) => a.version - b.version);
  const latest = deliveries.at(-1) ?? null;
  const visible = useDeliveryVisibility<HTMLDivElement>(latest, desk.receipt, 'viewed');
  const eff = view.effective[task.id] ?? 'running';
  const stoppedAt = view.stopped[task.id] ?? null;
  const stopped = task.status === 'cancelled' || stoppedAt != null;
  const session = view.sessions.find((s) => s.task_id === task.id) ?? null;
  const codeLive = task.source === 'code' && task.status === 'running' && !stopped;
  const lines = useSessionLines(codeLive && session?.own ? session.id : null, desk.retry);
  const [msg, setMsg] = useState('');
  const open = stopped ? [] : pendingOf(view, task.id).filter((p) => !p.resolved);
  const asks = open.filter(isAsk);
  const questions = open.filter(isQuestion);
  const review = latest && latest.id === task.delivery?.id && isReviewableDelivery(latest, task) && eff === 'waiting' ? latest : null;
  const codeReview = !stopped && isCodingReview(task);
  const steps = task.steps.length > 0 ? task.steps : (extras?.plan?.steps ?? []);
  const failure = task.failure ?? extras?.failure ?? null;
  const ended = ['done', 'failed', 'stopped'].includes(eff);
  const end = endState(task, view);
  const code = task.source === 'code';
  // A role grant is keyed by the run's conversation when it has one (interactions.py), else by the run.
  const scopeLabel = (a: AskItem) => (code ? '当前会话均允许' : a.kind === 'question' && a.conversation_id ? '当前对话均允许' : '当前任务均允许');

  const decide = (a: AskItem, v: Verdict, mode?: string) => {
    if (a.kind === 'approval') void actions.approve([a.id], v, mode);
    else void actions.answer(a, askAnswer(a, v));
  };
  const mouseOnly = () => desk.push('危险操作仅支持鼠标点击「批准」；回车键不会触发批准');
  const papers: ReactNode[] = [
    // One yellow button: a question's 提交 first, then the first approval, then the review.
    ...asks.map((a, i) => <ApprovalPaper key={a.id} item={a} kernelName={desk.kernel.data ?? undefined} scopeLabel={scopeLabel(a)} onDecide={(v, m) => decide(a, v, m)} onMouseOnly={mouseOnly} quiet={i > 0 || questions.length > 0} />),
    ...questions.map((q) => <QuestionPaper key={q.id} question={q} now={desk.now} onAnswer={(ans) => void actions.answer(q, ans)} onCancel={() => void actions.cancelQuestion(q)} />),
  ];
  const first = asks[0] ?? questions[0];
  const decision = first ? { title: first.title, note: asks.length ? '待批准 │ 当前步骤已暂停' : '待回答 │ 当前步骤已暂停', papers } : null;

  const chip: { k: keyof typeof CHIP; text: string } = eff === 'waiting'
    ? { k: 'wait', text: asks.length ? '待批准' : review || codeReview ? '待复核' : questions.length ? '待回答' : '待处理' }
    : ended
      ? { k: end.err ? 'err' : end.shape === 'ok' ? 'done' : 'off', text: end.text }
      : task.status === 'queued'
        ? { k: 'off', text: '排队中' }
        : { k: 'run', text: '进行中' };
  const conv = task.conversation_id;
  const where = code ? (
    <span>
      {task.agent ?? '编码'} │ 编码会话{task.cwd ? <> │ <span className="num">{task.cwd}</span></> : null}
    </span>
  ) : (
    <span>
      {who} │ 角色任务 │{' '}
      {conv ? (
        <>
          来自对话{' '}
          <Btn size="sm" variant="text" onClick={() => onGoChat(conv)}>
            「{convTitle(conv) ?? '对话'}」
          </Btn>
        </>
      ) : (
        '独立任务'
      )}
    </span>
  );
  const endAt = stoppedAt ?? task.ended_at ?? (ended ? task.updated_at : null);
  const v = task.verify ?? null;
  const checkText = v ? `${verifyText(v)}${v.exit_code != null ? ` │ 退出码 ${v.exit_code}` : ''}` : '';
  const summary = task.summary?.replace(/^(?:\s*\[(?:int(?:ent)?|motion|point):[^\]\r\n]{1,200}\])+\s*/, '');

  return (
    <>
      <div className={styles.head}>
        <div className={styles.kind}>
          <i aria-hidden="true" />
          <MicroLabel>{`${code ? 'Coding Session' : 'Role Task'} / ${task.id.slice(-6)}`}</MicroLabel>
        </div>
        <div className={styles.trow}>
          <h2 title={task.title}>{task.title}</h2>
          {code && session?.own && <SessionMenu sessionId={session.id} />}
          <Pill size="lg" tone={CHIP[chip.k][0]}>
            {CHIP[chip.k][1] && <span aria-hidden="true">{CHIP[chip.k][1]}</span>}
            {chip.text}
          </Pill>
        </div>
        <div className={styles.where}>
          <Pin />
          {where}
        </div>
        <div className={styles.meta}>
          {ended && endAt != null ? (
            <span>
              <b>{dayText(endAt, desk.now)}</b> {end.text === '已完成' || end.text === '已接受' ? '已完成' : end.text}
            </span>
          ) : task.started_at != null ? (
            <span>
              <b>{formatClock(task.started_at)}</b> 开始
            </span>
          ) : (
            <span>尚未开始</span>
          )}
          {task.started_at != null && (
            <span>
              {ended ? '总耗时' : '已耗时'} <b>{formatDuration((endAt ?? desk.now) - task.started_at)}</b>
            </span>
          )}
        </div>
        <div className={styles.sep} />
      </div>
      <div className={styles.scroll} data-detail-scroll="">
        {failure && (
          <div className={page.tipsR} role="status">
            <Warn />
            <span>
              <b>{failure.reason}</b>
            </span>
            {failure.fix && (
              <Btn size="sm" variant="ghost" onClick={() => actions.onTask(task)({ kind: 'open_settings', group: 'perm', item: 'scope' })}>
                {failure.fix}
              </Btn>
            )}
          </div>
        )}
        {stopped && (
          <p className={styles.desc} data-dim="" role="status">
            已停止 │ <span className="num">{endAt != null ? formatClock(endAt) : '—'}</span> │ 已写入的文件将保留，无法继续执行此任务
          </p>
        )}
        {task.status === 'interrupted' && (
          <p className={styles.desc} data-dim="" role="status">
            后台服务重启时已中断 │ <span className="num">{endAt != null ? formatClock(endAt) : '—'}</span>
          </p>
        )}
        {task.status === 'queued' && (
          <div className={styles.timer}>
            <Clock size={22} />
            <span>排队中：等待当前前台任务结束后自动开始</span>
          </div>
        )}
        {summary && (
          <section className={styles.res} aria-label="任务结果">
            <MessageText text={summary} />
          </section>
        )}
        {codeReview && <CodeReviewPaper verify={v} onReview={(r) => void actions.review(task, r)} />}
        {review && <ReviewPaper review={review} kernelName={desk.kernel.data ?? undefined} busy={desk.busy} decideFail={desk.decideFail} onAction={actions.onTask(task)} quiet={asks.length + questions.length > 0} />}
        {codeLive && session?.own && (
          <>
            <SecHead
              title="会话"
              right={
                lines.isError ? (
                  <Btn size="sm" variant="text" onClick={() => void lines.refetch()}>
                    重试
                  </Btn>
                ) : (
                  '最近 6 行 │ 完整输出请在终端中查看'
                )
              }
            />
            <pre className={styles.logs}>{lines.isError ? '未能读取会话输出' : lines.data == null ? '正在读取会话输出…' : lines.data.length ? lines.data.slice(-6).map((l) => `› ${l}`).join('\n') : '尚无输出'}</pre>
            <div className={styles.send}>
              <Field label="给编码会话发消息" placeholder="向该会话发送补充指令…" value={msg} onChange={setMsg} />
              <Btn size="sm" variant="ghost" disabled={!msg.trim()} disabledReason="请先输入发送内容" onClick={async () => {
                const sent = msg;
                if (await actions.onTask(task)({ kind: 'send_session', text: sent.trim() })) setMsg((m) => (m === sent ? '' : m));
              }}>
                发送
              </Btn>
            </div>
          </>
        )}
        <Steps steps={steps} decision={decision} folded={ended && eff !== 'failed'} />
        {v && !codeReview && (v.output_tail || v.exit_code != null) && (
          v.output_tail ? (
            <Fold variant="head" id="check" label="检查" right={checkText}>
              <pre className={styles.logs}>{v.output_tail}</pre>
            </Fold>
          ) : (
            <section aria-label="检查">
              <SecHead title="检查" right={checkText} />
            </section>
          )
        )}
        {/* A display: contents node has no box, so it would never be seen intersecting. */}
        {deliveries.length > 0 && (
          <div ref={visible} style={{ display: 'grid', gap: 'inherit' }}>
            <Artifacts
              deliveries={deliveries}
              canReveal={getBridge().capabilities.revealInFinder}
              nativeOff={desk.nativeOff}
              onOpen={(path) => actions.onTask(task)({ kind: 'open_artifact', path })}
              onReveal={(path) => actions.onTask(task)({ kind: 'reveal_artifact', path })}
              onCopy={(path) => actions.onTask(task)({ kind: 'copy_path', path })}
              onRevert={(d, a) => void actions.revert(d, a)}
            />
          </div>
        )}
        {note && (
          <div className={paper.paper} data-depth="" data-theme="light" data-task-note="">
            <h4>{ended ? '补充说明并继续执行' : '向任务补充说明'}</h4>
            <p>{ended ? '角色将结合以下补充说明，从中断位置继续执行该任务。' : '角色收到以下补充说明后将据此调整执行。'}</p>
            <RejectBox
              mode="continue"
              kernelName={desk.kernel.data ?? undefined}
              onSubmit={async (text, useCurrentKernel) => {
                if (await actions.onTask(task)({ kind: 'continue', note: text, useCurrentKernel })) onNote(false);
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}
