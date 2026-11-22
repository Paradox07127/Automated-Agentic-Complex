import type { Dispatch, SetStateAction } from 'react';
import { getBridge } from '../../bridge';
import { AgentdCallError, CONFLICT_CODES, del, get, post, put, seg } from '../../bridge/agentd';
import { revealText } from '../../bridge/platformText';
import { serverFaultText } from '../../domain/errorText';
import { formatScheduleTime } from '../../domain/schedules';
import {
  conversationCancel,
  conversationCreate,
  conversationDelete,
  conversationPatch,
  deliveryDecision,
  formatClock,
  fromConversation,
  interactionAnswer,
  interactionDismiss,
  type ActiveRun,
  type Conversation,
  type Question,
  type Task,
  type WireConversation,
} from '../../domain';
import type { TaskAction } from '../../features/task';
import type { PushToast } from '../../shell/toast';
import type { TasksLocal, TasksView } from '../tasks/model';
import { navigate } from '../tasks/params';
import type { SendOptions } from './Composer';
import { clock, demoQuery, type ChatRuntime } from './useChatData';
import type { LiveReply } from './useChatFeed';

/** Reply of `POST /conversations/{id}/messages` (turns.py say()); run_id and runtime only with the role agent on.
 * A deterministic command other than `look` answers `{command, ...}` with no line_id: no reply streams. */
interface SayReply {
  line_id?: string;
  generation: number;
  run_id?: string;
  runtime?: string;
  scope_warning?: string;
  runtime_reason?: string;
  command?: string;
  commitment?: { text: string; due_at: number | null; trigger?: { kind: string; agent?: string | null } | null };
  reinforced?: boolean;
  skipped?: 'paused' | 'no_memory' | 'no_memory_store';
}

const SKIPPED: Record<NonNullable<SayReply['skipped']>, string> = { paused: '记忆已暂停，没记', no_memory: '这一轮不记，没记', no_memory_store: '没有记忆库，没记' };

/** The local confirmation of a command reply that brings no line. */
function commandNote(r: SayReply): string {
  if (r.command === 'remind' && r.commitment) {
    const { due_at, trigger, text } = r.commitment;
    if (due_at !== null) {
      const today = new Date(due_at * 1000).toDateString() === new Date().toDateString();
      return `好，${today ? formatClock(due_at * 1000) : formatScheduleTime(due_at * 1000)} 提醒你：${text}`;
    }
    return trigger?.kind === 'session_done' ? `好，等 ${trigger.agent ?? 'agent'} 做完提醒你：${text}` : `好，到时提醒你：${text}`;
  }
  if (r.command === 'remember') return r.skipped ? SKIPPED[r.skipped] : r.reinforced ? '这条已经记着了' : '记住了';
  if (r.command === 'dispatch') return '已开确认卡';
  return '好';
}

/** Ids of lines shown before their 202; a command reply keeps its id, as it brings no line_id. */
let localIds = 0;

export interface ChatDeps {
  conv: Conversation | null;
  /** The selected tab's character, whose conversations the page shows; null before the character list is read. */
  character: string | null;
  /** `/state` character, the one on the desktop; null before it is read. */
  present: string | null;
  /** Shows the swap card for a line to the selected character, who is not on the desktop; true once the user asks to bring her out. On no, the page puts the line back in the input. */
  askSwap: (text: string) => Promise<boolean>;
  task: Task | null;
  run: ActiveRun | null;
  view: TasksView | null;
  /** A foreground run is going (any conversation): a new line gets a read-only side answer. */
  busy: boolean;
  setLocal: Dispatch<SetStateAction<TasksLocal>>;
  setAnswered: Dispatch<SetStateAction<Record<string, string>>>;
  setCancelled: Dispatch<SetStateAction<Record<string, boolean>>>;
  setFailed: (f: { text: string; reason: string; code?: string; options?: SendOptions } | null) => void;
  setSending: (b: boolean) => void;
  setBusyDecide: (b: boolean) => void;
  setNotice: (n: string | null) => void;
  select: (id: string | null) => void;
  /** Opens the row's title box. */
  editTitle: (id: string) => void;
  addReply: (r: Omit<LiveReply, 'text' | 'items' | 'final' | 'error' | 'cancelled'>) => void;
  /** Puts the 202's fields on the entry added under a local id; `null` takes it back out. */
  settleReply: (id: string, r: Partial<LiveReply> | null) => void;
  /** `runtime(true)`: 重新检测, the rescanning read. */
  reload: { list: () => void; turns: () => void; tasks: () => void; present: () => void; runtime: (refresh?: boolean) => Promise<ChatRuntime | undefined> };
  push: PushToast;
  /** Demo `sendfail`: sends fail. */
  failSend: boolean;
}

/** Short reasons for agentd's codes on this page; anything else says the request was refused. */
const REASONS: Record<string, string> = {
  busy: '角色正在执行，结束后再试',
  no_llm: '还没有可用的模型',
  no_history: '对话记录没有开启',
  archived: '对话已归档',
  conversation_not_active: '这不是当前对话',
  unknown_conversation: '对话已不存在',
  invalid_text: '内容为空或超过 8000 字',
  invalid_title: '标题要 1–80 个字',
  native_harness_required: '当前内核不能排成任务',
  character_runtime_unavailable: '角色内核没有启动',
  invalid_answers: '每个问题都要回答',
  invalid_approval: '审批只能选允许或拒绝',
  approval_expired: '审批已过期',
  not_implemented: '这台电脑暂不支持',
  no_reminder_time: '没听清时间或要提醒的事',
  // The say route's command refusals (turns.py say(), announce.py _remind()): nothing changed elsewhere.
  switching: '正在换角色，稍后再说',
  no_task: '现在没有在跑的任务',
  ambiguous_task: '有多个任务在跑，请在任务页选一个停下',
  no_cwd: '没有工作目录：先在会话里打开一个目录',
  no_memory_dispatch: '这一轮不记，不能派活',
  no_pending_approval: '没有待决的审批',
  ambiguous_approval: '有多张审批卡，请在卡片上选一张拒绝',
  scope_changed: '工作目录已变动或不可用',
  scope_revoked: '工作目录授权已撤销',
  scope_expired: '工作目录授权已过期',
  unknown_scope: '工作目录授权不存在',
  idempotency_conflict: '同一请求已用不同内容发过',
  character_not_present: '她不在桌面上',
  switch_refused: '没能换她出来',
  switch_timeout: '换角色超时，她还没出来',
};

/** 409 codes that say what the request lacked, not that something changed elsewhere: no conflict text, no reload. */
const REFUSALS: ReadonlySet<string> = new Set([
  'switching', 'no_task', 'ambiguous_task', 'no_cwd', 'no_memory_dispatch', 'no_reminder_time', 'no_pending_approval',
  'ambiguous_approval', 'scope_changed', 'scope_revoked', 'scope_expired', 'unknown_scope', 'idempotency_conflict',
]);

const conflict = (e: AgentdCallError) => !REFUSALS.has(e.code) && (e.status === 409 || CONFLICT_CODES.has(e.code));

export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return REASONS[(e as { code?: string } | null)?.code ?? ''] ?? '操作没有完成';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.status === 503 && (e.body as { runtime?: unknown } | null)?.runtime != null) return '角色内核未就绪';
  if (e.code !== 'busy' && conflict(e)) return '已在别处更新';
  return REASONS[e.code] ?? '后台拒绝了这次操作';
}

/** How long a swap may take before the line gives up, and how often /state is read meanwhile, in ms. */
const SWAP_WAIT_MS = 10_000;
const SWAP_POLL_MS = 250;

/** character.switchTo, then /state until it names her: agentd answers only the character on the desktop. */
async function bringOut(id: string) {
  const r = await getBridge().character.switchTo(id);
  if (!r.ok) throw { code: 'switch_refused' };
  // performance.now: the page's tests freeze Date.
  const end = performance.now() + SWAP_WAIT_MS;
  while ((await get<{ character: string }>('/state')).character !== id) {
    if (performance.now() >= end) throw { code: 'switch_timeout' };
    await new Promise((done) => setTimeout(done, SWAP_POLL_MS));
  }
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function createChatActions(d: ChatDeps) {
  const failed = (e: unknown, what: string) => {
    d.push(`${what}：${reasonOf(e)}`, { severity: 'warning' });
    if (e instanceof AgentdCallError && conflict(e)) {
      d.reload.list();
      d.reload.tasks();
    }
  };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      failed(e, what);
    }
  };

  /** A note after a return or for a running task: a role job resumes, a ledger task continues (http.py:157-206). */
  const carryOn = async (task: Task, note: string, useCurrentKernel: boolean) => {
    if (task.job_id) await post(`/agent/jobs/${seg(task.job_id)}/resume`, { text: note, use_current_backend: useCurrentKernel });
    else if (task.task_id) await post(`/tasks/${seg(task.task_id)}/continue`, { text: note });
  };

  /** `swap`: her character is not on the desktop, so the swap card asks first. */
  const deliver = async (text: string, options: Partial<SendOptions>, fail: boolean, swap = d.character != null && d.present != null && d.character !== d.present): Promise<void> => {
    if (swap && !(await d.askSwap(text))) return;
    d.setSending(true);
    const local = `local-${++localIds}`;
    const sent = { look: !!options.look, no_memory: !!options.no_memory, ...(options.scope_id ? { scope_id: options.scope_id } : {}) };
    d.addReply({ line_id: local, conversation_id: d.conv?.id ?? null, run_id: null, generation: 0, said: text, options: sent, at: clock(), side: d.busy });
    try {
      if (swap && d.character) {
        await bringOut(d.character);
        d.reload.present();
      }
      // With no conversation yet, the first line opens one (POST /conversations makes it her active one).
      const conv = d.conv ?? fromConversation(await post<WireConversation>('/conversations', d.character ? conversationCreate(d.character) : {}), clock());
      if (!d.conv) {
        d.settleReply(local, { conversation_id: conv.id });
        d.select(conv.id);
        d.reload.list();
      }
      // A flag goes out only when on: an explicit look:false would also stop agentd's own 看一下 keyword.
      const body = { text, ...(options.look ? { look: true } : {}), ...(options.no_memory ? { no_memory: true } : {}), ...(options.scope_id ? { scope_id: options.scope_id } : {}) };
      const r = await post<SayReply>(`/conversations/${seg(conv.id)}/messages${demoQuery(fail, '?fail=1')}`, body);
      d.setFailed(null);
      if (r.line_id) d.settleReply(local, { line_id: r.line_id, conversation_id: conv.id, run_id: r.run_id ?? null, generation: r.generation });
      else d.settleReply(local, { conversation_id: conv.id, side: false, note: commandNote(r) });
      d.setNotice(r.scope_warning ? '工作目录已不可用，这次没有带上' : r.runtime_reason === 'temporary_read_only' ? '这次只读，不记入历史' : null);
    } catch (e) {
      d.settleReply(local, null);
      if (e instanceof AgentdCallError && e.code === 'character_not_present') return deliver(text, options, fail, true);
      d.setFailed({ text, reason: reasonOf(e), ...(e instanceof AgentdCallError ? { code: e.code } : {}), options: sent });
      if (e instanceof AgentdCallError && e.status === 503) void d.reload.runtime();
      if (e instanceof AgentdCallError && e.status === 409 && conflict(e)) d.reload.list();
    } finally {
      d.setSending(false);
    }
  };

  return {
    send: (text: string, options: Partial<SendOptions> = {}) => deliver(text, options, d.failSend),
    resend: (text: string, options: Partial<SendOptions> = {}) => deliver(text, options, false),

    stop: (target: Pick<ActiveRun, 'run_id' | 'generation'> | null = d.run, title = d.task?.title) =>
      attempt('停止失败', async () => {
        if (!d.conv || !target) return;
        await post(`/conversations/${seg(d.conv.id)}/cancel`, conversationCancel(target));
        d.push(`已请求停止「${title ?? d.conv.title}」`);
        d.reload.tasks();
      }),

    answer: (q: Question, answers: Record<string, string[]>) =>
      attempt('回答没有送达', async () => {
        await post(`/agent/interactions/${seg(q.id)}/answer`, interactionAnswer(q, answers));
        const txt = Object.values(answers).flat().join(' │ ');
        d.setLocal((l) => ({ ...l, resolved: { ...l.resolved, [q.id]: true } }));
        d.setAnswered((m) => ({ ...m, [q.id]: txt }));
        d.push(`已回答：${txt}`);
        d.reload.tasks();
      }),

    /** Called by QuestionCard once its 5 s undo window has passed; the card itself shows the receipt. */
    dismiss: (q: Question) =>
      attempt('取消没有送达', async () => {
        await post(`/agent/interactions/${seg(q.id)}/dismiss`, interactionDismiss(q));
        d.setLocal((l) => ({ ...l, resolved: { ...l.resolved, [q.id]: true } }));
        d.setCancelled((m) => ({ ...m, [q.id]: true }));
        d.reload.tasks();
      }),

    queueSide: (text: string) =>
      attempt('没有派发任务', async () => {
        const title = clip(text, 16);
        await post('/agent/jobs', { title, text });
        d.push(`已派发任务：${title}`, { action: { label: '查看任务', onClick: () => navigate({ page: 'overview' }) } });
        d.reload.tasks();
      }),

    newConversation: (character = d.character) =>
      attempt('没有新建', async () => {
        const row = await post<WireConversation>('/conversations', character ? conversationCreate(character) : {});
        d.select(row.id);
        d.editTitle(row.id);
        d.reload.list();
      }),

    pin: (c: Conversation) =>
      attempt(c.pinned ? '没有取消置顶' : '没有置顶', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { pinned: !c.pinned }));
        d.reload.list();
      }),

    rename: (c: Conversation, title: string) =>
      attempt('没有改名', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { title }));
        d.reload.list();
        d.push(`已改名为「${title}」`);
      }),

    restore: (c: Conversation) =>
      attempt('没有恢复', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { archived: false }));
        d.reload.list();
        d.push(`已恢复「${c.title}」`);
      }),

    archive: (c: Conversation) =>
      attempt('没有归档', async () => {
        const row = await put<WireConversation>(`/conversations/${seg(c.id)}`, conversationPatch(c, { archived: true }));
        if (d.conv?.id === c.id) d.select(null);
        d.reload.list();
        const undo = () =>
          void attempt('没有撤销', async () => {
            await put(`/conversations/${seg(c.id)}`, conversationPatch(fromConversation(row, clock()), { archived: false }));
            d.reload.list();
          });
        d.push(`已归档「${c.title}」`, { action: { label: '撤销', onClick: undo } });
      }),

    remove: (c: Conversation) =>
      attempt('没有删除', async () => {
        await del(`/conversations/${seg(c.id)}`, conversationDelete(c));
        if (d.conv?.id === c.id) d.select(null);
        d.reload.list();
        d.push(`已删除「${c.title}」`);
      }),

    /** 换她出来 from her tab. */
    swap: (id: string, name: string) =>
      attempt('没有换出来', async () => {
        await bringOut(id);
        d.reload.present();
        d.push(`已换${name}出来`);
      }),

    /** Opening a topic or 继续此对话: make it its character's active one. */
    activate: (c: Conversation) =>
      attempt('没有切换', async () => {
        await post(`/conversations/${seg(c.id)}/activate`, conversationDelete(c));
        d.reload.list();
        d.reload.turns();
      }),

    async recheck() {
      const r = await d.reload.runtime(true).catch(() => undefined);
      if (r?.info.ready) d.push('内核已就绪', { severity: 'success' });
      else d.push(`重新检测：${r?.info.runtimes.find((x) => x.id === r.info.selected)?.name ?? '内核'} 仍未就绪`, { severity: 'warning' });
    },

    async onDrawer(a: TaskAction) {
      const bridge = getBridge();
      const task = d.task;
      switch (a.kind) {
        case 'accept':
        case 'reject': {
          const delivery = d.view?.deliveries.find((x) => x.id === a.deliveryId);
          if (!task || !delivery) return;
          d.setBusyDecide(true);
          await attempt(a.kind === 'accept' ? '没有接受' : '已退回未生效', async () => {
            if (a.kind === 'accept') await post(`/agent/tasks/${seg(task.id)}/accept`, deliveryDecision(delivery));
            else await post(`/agent/tasks/${seg(task.id)}/reject`, deliveryDecision(delivery));
            d.setLocal((l) => ({ ...l, decided: { ...l.decided, [delivery.id]: { state: a.kind === 'accept' ? 'accepted' : 'rejected', at: clock() } } }));
            d.push(a.kind === 'accept' ? `已接受 v${delivery.version}` : `已退回 v${delivery.version}`);
            d.reload.tasks();
            if (a.kind === 'reject' && a.note.trim()) {
              await attempt('已退回，补充要求没有送达', async () => {
                await carryOn(task, a.note.trim(), a.useCurrentKernel);
                d.reload.tasks();
              });
            }
          });
          d.setBusyDecide(false);
          return;
        }
        case 'continue':
          return attempt('补充要求没有送达', async () => {
            if (!task || (!task.job_id && !task.task_id)) throw { code: 'no_task' };
            await carryOn(task, a.note, a.useCurrentKernel);
            d.push('已提交补充要求');
            d.reload.tasks();
          });
        case 'open_artifact':
          return attempt('没有打开', async () => {
            await bridge.open.artifact(a.path);
            d.setLocal((l) => ({ ...l, opened: { ...l.opened, [a.path]: true } }));
            d.push(`已打开：${fileName(a.path)}`);
          });
        case 'reveal_artifact':
          return attempt('没有显示', async () => {
            await bridge.open.revealInFinder(a.path);
            d.push(revealText(`已在 Finder 中显示：${fileName(a.path)}`));
          });
        case 'copy_path':
          return attempt('没有复制', async () => {
            await bridge.clipboard.writeText(a.path);
            d.push(`已复制路径：${a.path}`);
          });
        case 'open_settings':
          navigate({ page: 'settings', group: a.group, ...(a.item ? { item: a.item } : {}) });
          return;
        default:
          if (task) navigate({ page: 'overview', sel: task.id });
      }
    },
  };
}
