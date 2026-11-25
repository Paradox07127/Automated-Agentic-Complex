import { getBridge } from '../../bridge';
import { AgentdCallError, get, post, seg } from '../../bridge/agentd';
import { formatScheduleTime } from '../../domain/schedules';
import { conversationCreate, formatClock, fromConversation, type WireConversation } from '../../domain';
import type { WireScope } from '../settings/wire';
import type { ChatDeps, SendTarget } from './actions';
import type { SendOptions, SendResult } from './Composer';
import { conflict, reasonOf } from './reasons';
import { clock, demoQuery } from './useChatData';

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

const SKIPPED: Record<NonNullable<SayReply['skipped']>, string> = { paused: '记忆已暂停，未记录', no_memory: '已开启「此轮不记录」，未记录', no_memory_store: '未配置记忆库，未记录' };

/** The local confirmation of a command reply that brings no line. */
function commandNote(r: SayReply): string {
  if (r.command === 'remind' && r.commitment) {
    const { due_at, trigger, text } = r.commitment;
    if (due_at !== null) {
      const today = new Date(due_at * 1000).toDateString() === new Date().toDateString();
      return `已设置提醒：${today ? formatClock(due_at * 1000) : formatScheduleTime(due_at * 1000)} 提醒「${text}」`;
    }
    return trigger?.kind === 'session_done' ? `已设置提醒：将在 ${trigger.agent ?? '任务'} 完成后提醒「${text}」` : `已设置提醒：到时将提醒「${text}」`;
  }
  if (r.command === 'remember') return r.skipped ? SKIPPED[r.skipped] : r.reinforced ? '该条目已存在于记忆中' : '已记入记忆';
  if (r.command === 'dispatch') return '已弹出派发确认卡';
  return '已处理';
}

/** Ids of lines shown before their 202; a command reply keeps its id, as it brings no line_id. */
let localIds = 0;

/** How long a swap may take before the line gives up, and how often /state is read meanwhile, in ms. */
const SWAP_WAIT_MS = 10_000;
const SWAP_POLL_MS = 250;

/** character.switchTo, then /state until it names her: agentd answers only the character on the desktop. */
export async function bringOut(id: string) {
  const r = await getBridge().character.switchTo(id);
  if (!r.ok) throw { code: 'switch_refused' };
  // performance.now: the page's tests freeze Date.
  const end = performance.now() + SWAP_WAIT_MS;
  while ((await get<{ character: string }>('/state')).character !== id) {
    if (performance.now() >= end) throw { code: 'switch_timeout' };
    await new Promise((done) => setTimeout(done, SWAP_POLL_MS));
  }
}

/** Sends `text` to `to` (the topic on screen); the swap card first when her character is not on the desktop. */
export const createDeliver = (d: ChatDeps) => async (text: string, options: Partial<SendOptions>, fail: boolean, to: SendTarget = { conv: d.conv?.id ?? null, character: d.character }): Promise<SendResult> => {
  const who = to.character;
  const away = who != null && d.present != null && who !== d.present;
  if (away && !(await d.askSwap(text))) return 'kept';
  d.setSending(true);
  let convId = to.conv;
  try {
    let scope_id = options.scope_id;
    // The handles are spent here, after the user has agreed to the swap.
    if (!scope_id && options.files?.length) {
      try {
        scope_id = (await post<WireScope>('/agent/scopes', { files: options.files })).scope_id;
      } catch (e) {
        if (d.shown() === convId) d.setNotice(`附件未能附加：${reasonOf(e)}`);
        return 'spent';
      }
    }
    const sent: SendOptions = { look: !!options.look, no_memory: !!options.no_memory, ...(scope_id ? { scope_id } : {}), ...(options.quote_turn ? { quote_turn: options.quote_turn } : {}) };
    const local = `local-${++localIds}`;
    d.addReply({ line_id: local, conversation_id: convId, run_id: null, generation: 0, said: text, options: sent, at: clock(), side: d.busy && !away });
    let swapped = false;
    try {
      for (let swap = away; ; swap = true) {
        try {
          if (swap && who) {
            await bringOut(who);
            swapped = true;
            d.settleReply(local, { side: false });
            d.reload.present();
            d.reload.list();
          }
          // With no conversation yet, the first line opens one (POST /conversations makes it her active one).
          if (!convId) {
            const made = fromConversation(await post<WireConversation>('/conversations', who ? conversationCreate(who) : {}), clock());
            convId = made.id;
            d.settleReply(local, { conversation_id: made.id });
            if (d.shown() === null) d.select(made.id);
            d.reload.list();
          }
          // A flag goes out only when on: an explicit look:false would also stop agentd's own 看一下 keyword.
          const body = { text, ...(sent.look ? { look: true } : {}), ...(sent.no_memory ? { no_memory: true } : {}), ...(scope_id ? { scope_id } : {}), ...(sent.quote_turn ? { quote_turn: sent.quote_turn } : {}) };
          const r = await post<SayReply>(`/conversations/${seg(convId)}/messages${demoQuery(fail, '?fail=1')}`, body);
          if (to.failed) d.dropFailed(to.failed);
          if (r.line_id) d.settleReply(local, { line_id: r.line_id, conversation_id: convId, run_id: r.run_id ?? null, generation: r.generation });
          else d.settleReply(local, { conversation_id: convId, side: false, note: commandNote(r) });
          if (d.shown() === convId) d.setNotice(r.scope_warning ? '工作目录已不可用，这次没有带上' : r.runtime_reason === 'temporary_read_only' ? '这次只读，不记入历史' : null);
          return 'sent';
        } catch (e) {
          if (!(e instanceof AgentdCallError && e.code === 'character_not_present') || swapped || !who) throw e;
          if (!(await d.askSwap(text))) {
            d.settleReply(local, null);
            return scope_id ? { message: 'kept', scope_id } : 'kept';
          }
        }
      }
    } catch (e) {
      d.settleReply(local, null);
      d.setFailed({ id: to.failed ?? local, text, reason: reasonOf(e), ...(e instanceof AgentdCallError ? { code: e.code } : {}), options: sent, conv: convId, character: who });
      if (e instanceof AgentdCallError && e.status === 503) void d.reload.runtime();
      if (e instanceof AgentdCallError && e.status === 409 && conflict(e)) d.reload.list();
      return 'sent';
    }
  } finally {
    d.setSending(false);
  }
};
