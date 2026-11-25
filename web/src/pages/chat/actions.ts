import type { Dispatch, SetStateAction } from 'react';
import { getBridge } from '../../bridge';
import { AgentdCallError, del, get, post, put, seg } from '../../bridge/agentd';
import { revealText } from '../../bridge/platformText';
import {
  conversationCancel,
  conversationCreate,
  conversationDelete,
  conversationPatch,
  deliveryDecision,
  fromConversation,
  interactionAnswer,
  interactionDismiss,
  type ActiveRun,
  type Conversation,
  type Question,
  type Task,
  type WireConversation,
  type WireInteraction,
} from '../../domain';
import type { TaskAction } from '../../features/task';
import type { PushToast } from '../../shell/toast';
import { sendOpened } from '../tasks/deliveryCalls';
import type { TasksLocal, TasksView } from '../tasks/model';
import { navigate } from '../tasks/params';
import type { SendOptions } from './Composer';
import { bringOut, createDeliver } from './deliver';
import { conflict, reasonOf } from './reasons';
import { clock, type ChatRuntime } from './useChatData';
import type { LiveReply } from './useChatFeed';


/** A line that failed to send, with where it was going: 「重新发送」 goes there, and only that topic shows it. */
export interface Failed {
  /** The send it came from; a resend that fails again keeps it. */
  id: string;
  text: string;
  reason: string;
  code?: string;
  options?: SendOptions;
  conv: string | null;
  character: string | null;
}

/** The topic and character a line is for; null topic: the first line opens one. */
export interface SendTarget {
  conv: string | null;
  character: string | null;
  /** The failed line this send retries. */
  failed?: string;
}

/** What 停止 stops, fixed when its dialog opens: a background job through its own cancel, else the run of `conv`. */
export interface StopTarget {
  conv: string;
  run_id: string;
  generation: number;
  job_id: string | null;
}

export interface ChatDeps {
  conv: Conversation | null;
  /** The topic on screen now (null: none); the actions are made per render, a request outlives them. */
  shown: () => string | null;
  /** The selected tab's character, whose conversations the page shows; null before the character list is read. */
  character: string | null;
  /** `/state` character, the one on the desktop; null before it is read. */
  present: string | null;
  /** Shows the swap card for a line to the selected character, who is not on the desktop; true once the user asks to bring her out. On no, the line stays in the input. */
  askSwap: (text: string) => Promise<boolean>;
  task: Task | null;
  run: ActiveRun | null;
  view: TasksView | null;
  /** A foreground run is going (any conversation): a new line gets a read-only side answer. */
  busy: boolean;
  setLocal: Dispatch<SetStateAction<TasksLocal>>;
  setAnswered: Dispatch<SetStateAction<Record<string, string>>>;
  setCancelled: Dispatch<SetStateAction<Record<string, boolean>>>;
  /** Keeps a failed line in its topic, in place of the one with its id. */
  setFailed: (f: Failed) => void;
  /** Takes back the failed line with this id. */
  dropFailed: (id: string) => void;
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

  const deliver = createDeliver(d);

  return {
    send: (text: string, options: Partial<SendOptions> = {}) => deliver(text, options, d.failSend),
    resend: (text: string, options: Partial<SendOptions> = {}, to?: SendTarget) => deliver(text, options, false, to),

    stop: (t: StopTarget, title: string) =>
      attempt('停止失败', async () => {
        // agentd's conversation cancel leaves the conversation's jobs running (integration.py _cancel_conversation).
        if (t.job_id) {
          const { cancelled } = await post<{ cancelled: boolean }>(`/agent/jobs/${seg(t.job_id)}/cancel`, {});
          if (!cancelled) throw { code: 'not_stopped' };
        } else await post(`/conversations/${seg(t.conv)}/cancel`, conversationCancel(t));
        d.push(`已请求停止「${title}」`);
        d.reload.tasks();
      }),

    answer: (q: Question, answers: Record<string, string[]>) =>
      attempt('回答未能送达', async () => {
        const reply = await post<WireInteraction & { resume_required?: boolean }>(`/agent/interactions/${seg(q.id)}/answer`, interactionAnswer(q, answers));
        const txt = Object.values(answers).flat().join(' │ ');
        d.setLocal((l) => ({ ...l, resolved: { ...l.resolved, [q.id]: true } }));
        d.setAnswered((m) => ({ ...m, [q.id]: txt }));
        // An answer that lands while another turn runs waits for an explicit 继续 (interactions.py respond).
        const resume = () =>
          attempt('未能继续执行', async () => {
            // A continue refused as busy has still moved the revision on (claimed, then settled back).
            const now = (await get<{ requests: WireInteraction[] }>('/agent/interactions')).requests.find((r) => r.request_id === q.id);
            if (!now) throw { code: 'interaction_version_changed' };
            await post(`/agent/interactions/${seg(q.id)}/continue`, { expected_version: now.revision });
            d.push('已继续执行');
            d.reload.tasks();
          });
        d.push(`已回答：${txt}`, reply.resume_required ? { action: { label: '继续', onClick: () => void resume() } } : undefined);
        d.reload.tasks();
      }),

    /** Called by QuestionCard once its 5 s undo window has passed; the card itself shows the receipt. */
    dismiss: (q: Question) =>
      attempt('取消操作未能送达', async () => {
        await post(`/agent/interactions/${seg(q.id)}/dismiss`, interactionDismiss(q));
        d.setLocal((l) => ({ ...l, resolved: { ...l.resolved, [q.id]: true } }));
        d.setCancelled((m) => ({ ...m, [q.id]: true }));
        d.reload.tasks();
      }),

    queueSide: (text: string) =>
      attempt('未能派发任务', async () => {
        // /agent/jobs names no conversation: it works for the character on the desktop.
        if (d.character != null && d.present != null && d.character !== d.present) throw { code: 'character_not_present' };
        const title = clip(text, 16);
        await post('/agent/jobs', { title, text });
        d.push(`已派发任务：${title}`, { action: { label: '查看任务', onClick: () => navigate({ page: 'overview' }) } });
        d.reload.tasks();
      }),

    newConversation: (character = d.character) =>
      attempt('未能新建对话', async () => {
        const row = await post<WireConversation>('/conversations', character ? conversationCreate(character) : {});
        d.select(row.id);
        d.editTitle(row.id);
        d.reload.list();
      }),

    pin: (c: Conversation) =>
      attempt(c.pinned ? '未能取消置顶' : '未能置顶', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { pinned: !c.pinned }));
        d.reload.list();
      }),

    rename: (c: Conversation, title: string) =>
      attempt('未能重命名', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { title }));
        d.reload.list();
        d.push(`已重命名为「${title}」`);
      }),

    restore: (c: Conversation) =>
      attempt('未能恢复对话', async () => {
        await put(`/conversations/${seg(c.id)}`, conversationPatch(c, { archived: false }));
        d.reload.list();
        d.push(`已恢复「${c.title}」`);
      }),

    archive: (c: Conversation) =>
      attempt('未能归档', async () => {
        const row = await put<WireConversation>(`/conversations/${seg(c.id)}`, conversationPatch(c, { archived: true }));
        if (d.conv?.id === c.id) d.select(null);
        d.reload.list();
        const undo = () =>
          void attempt('未能撤销', async () => {
            await put(`/conversations/${seg(c.id)}`, conversationPatch(fromConversation(row, clock()), { archived: false }));
            d.reload.list();
          });
        d.push(`已归档「${c.title}」`, { action: { label: '撤销', onClick: undo } });
      }),

    remove: (c: Conversation) =>
      attempt('未能删除', async () => {
        await del(`/conversations/${seg(c.id)}`, conversationDelete(c));
        if (d.conv?.id === c.id) d.select(null);
        d.reload.list();
        d.push(`已删除「${c.title}」`);
      }),

    /** 换她出来 from her tab. */
    swap: (id: string, name: string) =>
      attempt('未能切换出场角色', async () => {
        await bringOut(id);
        d.reload.present();
        d.reload.list();
        d.push(`已切换「${name}」出场`);
      }),

    /** Opening a topic or 继续此对话: make it its character's active one. */
    activate: (c: Conversation) =>
      attempt('未能切换对话', async () => {
        await post(`/conversations/${seg(c.id)}/activate`, conversationDelete(c));
        d.reload.list();
        d.reload.turns();
      }),

    async recheck() {
      const r = await d.reload.runtime(true).catch(() => undefined);
      // agentd answers a line through the quick route or the chat route, whatever the main kernel is.
      const off = r ? ([['chat', '主执行内核'], ['quick', '快速回复']] as const).find(([route]) => !r.wire.routes[route].ready) : undefined;
      if (r && !off) d.push('执行内核已就绪', { severity: 'success' });
      else d.push(`重新检测：${off?.[1] ?? '执行内核'}仍未就绪`, { severity: 'warning' });
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
          await attempt(a.kind === 'accept' ? '未能接受' : '驳回未生效', async () => {
            if (a.kind === 'accept') await post(`/agent/tasks/${seg(task.id)}/accept`, deliveryDecision(delivery));
            else await post(`/agent/tasks/${seg(task.id)}/reject`, deliveryDecision(delivery));
            d.setLocal((l) => ({ ...l, decided: { ...l.decided, [delivery.id]: { state: a.kind === 'accept' ? 'accepted' : 'rejected', at: clock() } } }));
            d.push(a.kind === 'accept' ? `已接受 v${delivery.version}` : `已驳回 v${delivery.version}`);
            d.reload.tasks();
            if (a.kind === 'reject' && a.note.trim()) {
              await attempt('已驳回，补充要求未能送达', async () => {
                await carryOn(task, a.note.trim(), a.useCurrentKernel);
                d.reload.tasks();
              });
            }
          });
          d.setBusyDecide(false);
          return;
        }
        case 'continue':
          return attempt('补充要求未能送达', async () => {
            if (!task || (!task.job_id && !task.task_id)) throw { code: 'no_task' };
            await carryOn(task, a.note, a.useCurrentKernel);
            d.push('已提交补充要求');
            d.reload.tasks();
          });
        case 'open_artifact':
          return attempt('未能打开文件', async () => {
            await bridge.open.artifact(a.path);
            d.push(`已打开：${fileName(a.path)}`);
            const view = d.view;
            if (!task || !view) return;
            await attempt('未能记录已打开状态', async () => {
              if (await sendOpened(view.deliveries, task.id, a.path)) d.reload.tasks();
            });
          });
        case 'reveal_artifact':
          return attempt('未能在文件管理器中显示', async () => {
            await bridge.open.revealInFinder(a.path);
            d.push(revealText(`已在 Finder 中显示：${fileName(a.path)}`));
          });
        case 'copy_path':
          return attempt('未能复制路径', async () => {
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
