import type { Dispatch, SetStateAction } from 'react';
import { getBridge } from '../../bridge';
import { AgentdCallError, CONFLICT_CODES, post, seg } from '../../bridge/agentd';
import { revealText } from '../../bridge/platformText';
import {
  approvalDecision,
  deliveryDecision,
  formatClock,
  goalState,
  interactionAnswer,
  interactionDismiss,
  runCancel,
  type Approval,
  type Artifact,
  type Delivery,
  type Goal,
  type Question,
  type Task,
  type WireInteraction,
} from '../../domain';
import { DECIDE_FAIL, notStopped, type DecideFailCode, type TaskAction } from '../../features/task';
import { codeText, failureText } from '../../domain/errorText';
import { isPluginOff } from '../../shell/plugins';
import type { PushToast } from '../../shell/toast';
import { nextAfter, stopMark, type TasksLocal, type TasksView } from './model';
import { navigate } from './params';
import { sendOpened } from './deliveryCalls';

export interface ActionDeps {
  view: TasksView;
  setLocal: Dispatch<SetStateAction<TasksLocal>>;
  push: PushToast;
  /** Ids in drawn order, for picking the item that takes a decided one's place. */
  order: string[];
  /** After a decision: the item that took the decided one's place. */
  select: (id: string | null) => void;
  /** Failure code the demo forces on delivery decisions. */
  failCode: DecideFailCode | null;
  setDecideFail: (c: DecideFailCode | null) => void;
  setBusy: (b: boolean) => void;
  askStop: (ids: string[]) => void;
  retrySteps: () => void;
  /** Reads the snapshot and the open detail again. */
  reload: () => void;
  now: () => number;
  /** The shell refused a native entry; the page disables it from now on. */
  nativeOff: (entry: NativeEntry) => void;
}

export type NativeEntry = 'artifact' | 'copy' | 'jump';

/** Why a native entry is disabled once the shell refused it. */
export const NATIVE_OFF: Readonly<Record<NativeEntry, string>> = {
  artifact: '当前客户端环境暂不支持打开文件',
  copy: '当前客户端环境暂不支持复制路径',
  jump: '当前客户端环境暂不支持跳转至终端',
};

export type NativeOff = Partial<Record<NativeEntry, string>>;

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Short reasons for codes the task page's writes return; others show their code. */
const REASON: Readonly<Record<string, string>> = {
  invalid_state: '当前任务状态不支持停止操作',
  task_not_active: '任务已结束，不在运行中',
  unknown_character_task: '未找到该角色任务',
  unknown_session: '未找到该会话',
  not_own: '外部编码会话不支持在此操作',
  idle: '会话当前未运行，无法发送消息',
  archived: '会话已归档',
  start_failed: '编码工具启动失败',
  character_busy: '角色正在执行，请稍后再试',
  personal_runtime_required: '执行内核尚未就绪',
  checkpoint_missing: '未找到可继续的断点进度',
  invalid_payload: '请求参数不完整',
  invalid_answers: '每个问题均须作答',
  invalid_approval: '审批仅支持选择「允许」或「拒绝」',
  approval_expired: '该请求已过期',
  invalid_goal_update: '不支持变更为该目标状态',
  goal_results_not_verified: '目标下仍有任务未通过校验',
  goal_results_not_current: '目标关联产物已变更，校验未通过',
  job_not_resumable: '该任务当前不可继续执行',
  goal_not_active: '所属目标当前未处于进行状态',
  job_store_unavailable: '任务存储暂不可用',
  not_found: '未找到该条目',
  unknown_artifact: '未找到该产物文件',
  no_previous_version: '该产物无可用的上一版本',
};

/** Toast text for a failed write: offline, someone else's change, or a short reason; null when its plug-in is off. */
export function failMessage(e: unknown): string | null {
  if (e instanceof RangeError) return '请为每个问题选择一项回答';
  if (!(e instanceof AgentdCallError)) return e instanceof Error && e.message ? `操作未完成：${e.message}` : '操作未完成';
  if (isPluginOff(e)) return null;
  if (e.code === 'offline') return '后台服务已断开';
  if (e.code === 'switching') return codeText(e.code)!;
  if (CONFLICT_CODES.has(e.code) || (e.status === 409 && !REASON[e.code])) return '已在其他位置更新';
  return REASON[e.code] ?? failureText(e).text;
}

/** The raw code of a failure whose toast is a generic sentence; null when the sentence names the cause. */
function unmappedCode(e: unknown): string | null {
  if (!(e instanceof AgentdCallError) || REASON[e.code] || CONFLICT_CODES.has(e.code) || e.status === 409) return null;
  return failureText(e).code;
}

const isConflict = (e: unknown) => e instanceof AgentdCallError && !isPluginOff(e) && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** Stop by source: a job, a character ledger task, an own coding session's turn, else the live run. */
async function stopOne(t: Task, view: TasksView): Promise<void> {
  if (t.job_id) {
    const { cancelled } = await post<{ cancelled: boolean }>(`/agent/jobs/${seg(t.job_id)}/cancel`, {});
    if (!cancelled) throw new Error(notStopped(t));
    return;
  }
  if (t.target === 'character' && t.task_id) {
    await post(`/tasks/${seg(t.task_id)}/cancel`, {});
    return;
  }
  const session = view.sessions.find((s) => s.own && s.task_id === t.id);
  if (session) {
    await post(`/sessions/${seg(session.id)}/interrupt`);
    return;
  }
  const run = view.activeRuns[t.id];
  if (run) {
    await post(`/agent/runs/${seg(run.run_id)}/cancel`, runCancel(run));
    return;
  }
  throw new Error('这项任务没有可停止的运行');
}

/** The supplementary note after a reject or while running: a job resumes, a character ledger task continues. */
async function sendNote(t: Task, text: string, useCurrentKernel: boolean): Promise<void> {
  if (t.job_id) await post(`/agent/jobs/${seg(t.job_id)}/resume`, { text, use_current_backend: useCurrentKernel });
  else if (t.task_id) await post(`/tasks/${seg(t.task_id)}/continue`, { text });
  else throw new Error('这项任务不能补充要求');
}

export function createTasksActions(d: ActionDeps) {
  const leave = (id: string) => d.select(nextAfter(d.order, id));
  const resolve = (ids: string[]) => d.setLocal((l) => ({ ...l, resolved: { ...l.resolved, ...Object.fromEntries(ids.map((i) => [i, true as const])) } }));
  const copyCode = (code: string | null) => (code ? { action: { label: '复制错误码', onClick: () => void getBridge().clipboard.writeText(code) } } : {});
  const fail = (e: unknown) => {
    const text = failMessage(e);
    if (text === null) return;
    d.push(text, { severity: 'danger', ...copyCode(unmappedCode(e)) });
    if (isConflict(e)) d.reload();
  };
  /** Native ops reject when the shell lacks them (not_implemented, op_not_allowed); then the entry goes off. */
  const native = async (entry: NativeEntry | null, op: () => Promise<void>, done: string) => {
    try {
      await op();
      d.push(done);
      return true;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if ((code === 'not_implemented' || code === 'op_not_allowed') && entry) {
        d.nativeOff(entry);
        d.push(NATIVE_OFF[entry], { severity: 'danger' });
      } else {
        const known = codeText(code);
        d.push(known ?? '客户端未完成该操作', { severity: 'danger', ...copyCode(known ? null : (code ?? null)) });
      }
      return false;
    }
  };
  const jump = (sessionId: string) => native('jump', async () => {
    await getBridge().open.jumpToSession(sessionId);
    await post('/desktop/sessions/seen', { session_id: sessionId });
  }, `已跳转至终端 │ ${sessionId}`);

  const stopNow = async (ids: string[]) => {
    const tasks = ids.flatMap((id) => d.view.tasks.filter((t) => t.id === id));
    const results = await Promise.allSettled(tasks.map((t) => stopOne(t, d.view)));
    const ok = tasks.filter((_, i) => results[i]?.status === 'fulfilled');
    const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    const at = d.now();
    if (ok.length > 0) {
      d.setLocal((l) => ({ ...l, stopped: { ...l.stopped, ...Object.fromEntries(ok.map((t) => [t.id, at])) }, stopMark: { ...l.stopMark, ...Object.fromEntries(ok.map((t) => [t.id, stopMark(t, d.view)])) } }));
      const name = ok.length === 1 && ok[0] ? `「${ok[0].title}」` : `选中的 ${ok.length} 个任务`;
      d.push(`已停止${name} │ ${formatClock(at)}`);
    }
    if (bad) fail(bad.reason);
    d.reload();
  };

  const decide = async (task: Task, a: Extract<TaskAction, { kind: 'accept' | 'reject' }>) => {
    const delivery = d.view.deliveries.find((x) => x.id === a.deliveryId);
    if (!delivery) return;
    // `?fail=` picks the mock's failure demo; it never goes to agentd.
    const demo = d.failCode && !window.agenticComplex ? d.failCode : null;
    const id = seg(task.id);
    const body = deliveryDecision(delivery);
    d.setBusy(true);
    try {
      if (a.kind === 'accept') await (demo ? post(`/agent/tasks/${id}/accept?fail=${demo}`, body) : post(`/agent/tasks/${id}/accept`, body));
      else await (demo ? post(`/agent/tasks/${id}/reject?fail=${demo}`, body) : post(`/agent/tasks/${id}/reject`, body));
    } catch (e) {
      d.setBusy(false);
      const code = e instanceof AgentdCallError ? e.code : '';
      if (code in DECIDE_FAIL) {
        d.setDecideFail(code as DecideFailCode);
        if (isConflict(e)) d.reload();
      } else fail(e);
      return;
    }
    d.setBusy(false);
    d.setDecideFail(null);
    d.setLocal((l) => ({ ...l, decided: { ...l.decided, [a.deliveryId]: { state: a.kind === 'accept' ? 'accepted' : 'rejected', at: d.now() } } }));
    leave(`r-${a.deliveryId}`);
    if (a.kind === 'accept') d.push(`已接受 v${delivery.version}`);
    else {
      try {
        if (a.note) await sendNote(task, a.note, a.useCurrentKernel);
        d.push(a.note ? `已驳回 v${delivery.version}，角色将按补充要求继续执行` : `已驳回 v${delivery.version}`);
      } catch (e) {
        const text = failMessage(e);
        if (text !== null) d.push(`已驳回 v${delivery.version}；补充说明未能送达：${text}`, { severity: 'danger' });
      }
    }
    d.reload();
  };

  /** 验收 / 驳回 of a coding task that needs review: the ledger id, no body (server.py _task_review). */
  const review = async (task: Task, verdict: 'accept' | 'reject') => {
    if (!task.task_id) return;
    try {
      await (verdict === 'accept' ? post(`/tasks/${seg(task.task_id)}/accept`) : post(`/tasks/${seg(task.task_id)}/reject`));
    } catch (e) {
      fail(e);
      return;
    }
    resolve([`c-${task.task_id}`]);
    d.push(`${verdict === 'accept' ? '已验收' : '已驳回'}「${task.title}」`);
    d.reload();
  };

  /** Resolves true once a note or a session message was taken, so its composer can clear. */
  const onTask = (task: Task) => async (a: TaskAction): Promise<boolean | void> => {
    const bridge = getBridge();
    switch (a.kind) {
      case 'accept':
      case 'reject':
        await decide(task, a);
        return;
      case 'continue':
        try {
          await sendNote(task, a.note, a.useCurrentKernel);
          d.push('已将补充说明发送至任务');
          d.reload();
          return true;
        } catch (e) {
          fail(e);
        }
        return;
      case 'stop':
        d.askStop([task.id]);
        return;
      case 'open_pending':
        d.select(a.pendingId);
        return;
      case 'open_timeline':
        // 对话轮次 selects a turn by its run id (the running generation's, else the task's own); without one, the turn list.
        navigate({ page: 'diag', tab: 'turns', turn: d.view.activeRuns[task.id]?.run_id ?? task.run_id ?? undefined });
        return;
      case 'jump_terminal':
        await jump(a.sessionId);
        return;
      case 'open_artifact':
        if (!(await native('artifact', () => bridge.open.artifact(a.path), `已打开：${fileName(a.path)}`))) return;
        try {
          if (await sendOpened(d.view.deliveries, task.id, a.path)) d.reload();
        } catch (e) {
          fail(e);
        }
        return;
      case 'reveal_artifact':
        // Gated by capabilities.revealInFinder, so a refusal does not turn off opening.
        await native(null, () => bridge.open.revealInFinder(a.path), revealText(`已在 Finder 中显示：${fileName(a.path)}`));
        return;
      case 'copy_path':
        await native('copy', () => bridge.clipboard.writeText(a.path), `已复制路径：${a.path}`);
        return;
      case 'open_settings':
        navigate({ page: 'settings', group: a.group, ...(a.item ? { item: a.item } : {}) });
        return;
      case 'open_latest':
        d.setDecideFail(null);
        d.select(task.id);
        d.reload();
        d.push('已切换至最新版本');
        return;
      case 'send_session': {
        const session = d.view.sessions.find((s) => s.own && s.task_id === task.id);
        if (!session) {
          d.push('未找到该任务的编码会话', { severity: 'danger' });
          return;
        }
        try {
          await post(`/sessions/${seg(session.id)}/messages`, { text: a.text });
          d.push('已发送至编码会话');
          d.reload();
          return true;
        } catch (e) {
          // 409 busy: the session is still running its turn (own.py message), not someone else's change.
          if (e instanceof AgentdCallError && e.code === 'busy') d.push('会话正在执行当前轮次，请等待结束后发送', { severity: 'danger' });
          else fail(e);
        }
        return;
      }
      case 'retry_steps':
        d.retrySteps();
        d.push('正在重新读取步骤…');
        return;
    }
  };

  const approve = async (ids: string[], decision: 'allow' | 'deny' | 'allow_session', mode?: string, reason?: string) => {
    const cards = ids.flatMap((id) => d.view.pending.filter((p): p is Approval => p.id === id && p.kind === 'approval'));
    const results = await Promise.allSettled(cards.map((a) => post(`/approvals/${seg(a.id)}/decision`, approvalDecision(a, decision, mode, reason))));
    const done = cards.filter((_, i) => results[i]?.status === 'fulfilled').map((a) => a.id);
    const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (done.length > 0) {
      resolve(done);
      const first = done[0] ?? '';
      const order = d.order.filter((x) => !done.slice(1).includes(x));
      d.select(nextAfter(order, first));
      const sess = cards.find((a) => a.id === first)?.session_id ?? '';
      d.push(`${decision === 'deny' ? '已拒绝' : '已批准'}${done.length > 1 ? ` ${done.length} 张` : ''} │ ${sess}`);
    }
    if (bad) fail(bad.reason);
    else d.reload();
  };

  const answer = async (q: Question, answers: Record<string, string[]>) => {
    let reply: WireInteraction & { resume_required?: boolean };
    try {
      reply = await post(`/agent/interactions/${seg(q.id)}/answer`, interactionAnswer(q, answers));
    } catch (e) {
      fail(e);
      return;
    }
    resolve([q.id]);
    leave(q.id);
    const text = Object.values(answers).flat()[0] ?? '';
    // An answer that lands while another turn runs waits for an explicit 继续 (interactions.py respond).
    const resume = async () => {
      try {
        await post(`/agent/interactions/${seg(q.id)}/continue`, { expected_version: reply.revision });
        d.push('任务已继续执行');
        d.reload();
      } catch (e) {
        fail(e);
      }
    };
    d.push(`已回答：${text}`, reply.resume_required ? { action: { label: '继续', onClick: () => void resume() } } : undefined);
    d.reload();
  };

  const cancelQuestion = async (q: Question) => {
    try {
      await post(`/agent/interactions/${seg(q.id)}/dismiss`, interactionDismiss(q));
    } catch (e) {
      fail(e);
      return;
    }
    resolve([q.id]);
    leave(q.id);
    d.push('已取消本次提问');
    d.reload();
  };

  const goal = async (g: Goal, action: 'pause' | 'resume' | 'complete') => {
    const status: Goal['status'] = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'completed';
    try {
      await post(`/agent/goals/${seg(g.id)}`, goalState(g, status));
    } catch (e) {
      fail(e);
      return;
    }
    d.setLocal((l) => ({ ...l, goalStatus: { ...l.goalStatus, [g.id]: status } }));
    d.push(action === 'pause' ? '目标已暂停' : action === 'resume' ? '目标已恢复 │ 已中断的任务不会自动重新运行' : '目标已校验并完成');
    d.reload();
  };

  /** POST /agent/artifacts/revert writes the kept previous version back as a new version. */
  const revert = (delivery: Delivery, a: Artifact) =>
    post('/agent/artifacts/revert', { run_id: delivery.run_id, path: a.path, expected_version: a.version }).then(() => {
      d.push(`已恢复版本：${a.name} 现为 v${a.version + 1}，内容与 v${a.version - 1} 一致`);
      d.reload();
    }, fail);

  return { onTask, review, approve, answer, cancelQuestion, goal, stopNow, jump, revert };
}
