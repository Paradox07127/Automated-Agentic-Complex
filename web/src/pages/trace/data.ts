// 对话轮次's reads beside the turn rows (chat/useTurnData.ts): one turn's events with their text, its run items, the
// conversation titles; and the words the list and the detail share.
import { useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import type { VisualStateKey } from '../../domain';
import type { WireConversation, WireRunItem, WireTraceTurn } from '../../domain/wire';
import type { ChatDemoSource } from '../chat/demoTypes';
import type { TraceEvent } from '../chat/turnTrace';

/** `/trace/turns/{id}?with_text=1` event: `text` holds the full text of the fields the store keeps (TEXT_MAX). */
export type TextEvent = TraceEvent & { text?: Record<string, unknown> };

export function useTurnEvents(row: WireTraceTurn | null, src: ChatDemoSource | null) {
  return useQuery({
    queryKey: ['trace-turn-text', row?.trace_id ?? null, src ? 'demo' : 'live'],
    queryFn: async (): Promise<{ events: TextEvent[]; skew_ms?: Record<string, number> }> =>
      src ? { events: src.events[row?.trace_id ?? ''] ?? [] } : get(`/trace/turns/${seg(row?.trace_id ?? '')}?with_text=1`),
    enabled: row != null,
    retry: false,
    staleTime: 3_000,
    refetchInterval: row?.result === 'open' ? 3_000 : false,
  });
}

/** The ledger's items of the turn's run (the run id is the turn id); none for a turn without a run. */
export function useTurnItems(row: WireTraceTurn | null, enabled: boolean) {
  return useQuery({
    queryKey: ['chat-run-items', row?.turn_id ?? null],
    queryFn: async () => (await get<{ items: WireRunItem[] }>(`/agent/runs/${seg(row?.turn_id ?? '')}/items`)).items,
    enabled: enabled && row != null,
    retry: false,
    staleTime: 5_000,
    refetchInterval: row?.result === 'open' ? 3_000 : false,
  });
}

export function useConvTitles(enabled: boolean) {
  return useQuery({
    queryKey: ['trace-conv-titles'],
    queryFn: async () => new Map((await get<{ conversations: WireConversation[] }>('/conversations')).conversations.map((c) => [c.id, c.title])),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Who started a turn, by `input.received` source. */
export const SRC_LABEL: Readonly<Record<string, string>> = {
  text: '你说', voice: '你说（语音）', desktop: '桌面输入', quick: '桌面输入', gift: '你递来东西', proactive: '主动发起', announce: '主动发起', ritual: '主动发起',
  tap: '你碰角色', background: '后台任务',
};
export const srcLabel = (s: string) => SRC_LABEL[s] ?? '你说';

/** The list's source filter groups. */
export type SrcGroup = 'all' | 'user' | 'proactive' | 'tap' | 'background';
export const SRC_GROUPS: ReadonlyArray<[SrcGroup, string]> = [['all', '全部来源'], ['user', '你说（含语音）'], ['proactive', '主动发起'], ['tap', '你碰角色'], ['background', '后台任务']];
export function groupOf(s: string): Exclude<SrcGroup, 'all'> {
  if (s === 'background') return 'background';
  if (s === 'tap') return 'tap';
  if (s === 'proactive' || s === 'announce' || s === 'ritual') return 'proactive';
  return 'user';
}

/** A turn's state as a shape and words. */
export type Shape = 'ok' | 'fail' | 'cut' | 'run' | 'wait' | 'skip' | 'text' | 'unk';
export const SHAPE_LABEL: Readonly<Record<Shape, string>> = { ok: '完成', fail: '出错了', cut: '打断', run: '在跑', wait: '待批准', skip: '跳过', text: '只出了文字', unk: '回执不全' };
/** The lamp for a result; the words stay the page's own. */
export const LAMP: Readonly<Record<Shape, VisualStateKey>> = { ok: 'done', fail: 'failed', cut: 'interrupted', run: 'running', wait: 'awaiting_approval', skip: 'skipped', text: 'idle', unk: 'warning' };
export function shapeOf(r: Pick<WireTraceTurn, 'result' | 'turn_state'>): Shape {
  if (r.turn_state === 'waiting_user') return 'wait';
  switch (r.result) {
    case 'ok':
    case 'completed':
      return 'ok';
    case 'failed':
      return 'fail';
    case 'interrupted':
      return 'cut';
    case 'open':
      return 'run';
    case 'skipped':
    case 'blocked':
      return 'skip';
    case 'text_generated':
      return 'text';
    default:
      return 'unk';
  }
}

/** The list's result filter. */
export type ResFilter = 'all' | 'fail' | 'cut' | 'live';
export const inFilter = (f: ResFilter, s: Shape) => f === 'all' || (f === 'fail' ? s === 'fail' : f === 'cut' ? s === 'cut' || s === 'unk' : s === 'run' || s === 'wait');

const WEEK = '日一二三四五六';
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const clockOf = (t: number, ms = false) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? `.${pad(d.getMilliseconds(), 3)}` : ''}`;
};
export const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}.${d.getDate()} 周${WEEK[d.getDay()]}`;
};
export const hourOf = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())} 时`;
};
export const no4 = (n: number) => pad(n, 4);

/** `12.9k` above ten thousand. */
export const fmtK = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
