// What the icon ring shows: one icon per kind of live thing, in a fixed order.
import type { DesktopState } from '../../../bridge/protocol';
import { formatClock } from '../../../domain';
import type { CardAction } from '../../stack/actions';
import type { StackCard } from '../../stack/model';
import { isResultCard } from '../hud/rows';
import { readPresence } from '../tags/presence';

export type RingKey = 'reminders' | 'results' | 'background' | 'quiet' | 'passthrough' | 'voice' | 'observation';

export interface ReminderItem {
  /** The commitment id. */
  id: string;
  /** Id and due time: a snoozed reminder comes back under a new key. */
  key: string;
  text: string;
  /** Epoch ms. */
  dueAt: number;
  /** Already rung (`triggered`). */
  due: boolean;
}

export interface ResultItem {
  id: string;
  /** Id and revision for a presence row, which 不用了 only hides here. */
  key: string;
  title: string;
  sub: string;
  /** 打开; null when the card has nowhere to open. */
  open: CardAction | null;
  /** 不用了; null for a presence row with no card, which only leaves this ring. */
  drop: CardAction | null;
}

export interface BackgroundItem {
  runId: string;
  generation: number;
  title: string;
}

export interface RingModel {
  reminders: { items: ReminderItem[]; count: number } | null;
  results: { items: ResultItem[]; count: number } | null;
  /** Her active background runs. */
  background: { items: BackgroundItem[]; count: number } | null;
  quiet: { until: number } | null;
  passthrough: boolean;
  /** Voice trouble: agentd cannot reach the voice service, or it is muted. */
  voice: 'unreachable' | 'muted' | null;
  observationPaused: boolean;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);
const num = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const NOTICE_SUB: Record<string, string> = { done: '完成', brief: '简报', look: '屏幕识读', resume: '回答已保存' };

function cardItem(c: StackCard): ResultItem | null {
  switch (c.kind) {
    case 'delivery':
      return { id: c.id, key: c.id, title: c.title, sub: '交付', open: { type: 'open', to: { page: 'overview', sel: c.delivery.task_id }, message: '已打开交付 │ 已发送查看回执' }, drop: { type: 'archive', id: c.id } };
    case 'review':
      return { id: c.id, key: c.id, title: c.item.title, sub: '待复核', open: { type: 'open', to: { page: 'overview', sel: c.item.task_id }, message: `已在主窗口打开：任务 › ${c.item.title}` }, drop: { type: 'collapse', id: c.id } };
    case 'notice': {
      const open: CardAction | null =
        c.variant === 'resume' || (c.variant === 'done' && c.task_id)
          ? { type: 'open', to: { page: 'overview', sel: c.task_id ?? undefined }, message: '已在主窗口打开：任务' }
          : c.variant === 'brief'
            ? // The 今日简报 plate's region on 今天 is its only landing.
              { type: 'open', to: { page: 'overview', focus: 'reminders' }, message: '已在主窗口打开：简报' }
            : null;
      return { id: c.id, key: c.id, title: c.title, sub: NOTICE_SUB[c.variant] ?? '', open, drop: { type: 'archive', id: c.id } };
    }
    default:
      return null;
  }
}

/** The delivery a result card is about, to drop presence's row for the same delivery. */
function deliveryOf(c: StackCard): string | null {
  if (c.kind === 'delivery') return c.delivery.id;
  if (c.kind === 'review' && c.source === 'delivery') return c.item.delivery_id;
  return null;
}

/**
 * Reminders and results from presence (`pending`), results also from the info cards, background runs, voice and observation from presence, 免打扰 and
 * 全局点穿 from the desktop state. `gone` holds the keys settled here, which stay out until presence drops them too.
 */
export function ringModel(presence: unknown, state: DesktopState | null, cards: readonly StackCard[], now: number, gone: ReadonlySet<string>): RingModel {
  const p = rec(presence);
  const pending = rec(p.pending);

  const reminders = list(pending.reminders)
    .map((r): ReminderItem => ({ id: str(r.id), key: `${str(r.id)}:${String(r.due_at)}`, text: str(r.text), dueAt: (typeof r.due_at === 'number' ? r.due_at : 0) * 1000, due: r.state === 'triggered' }))
    .filter((r) => r.id && !gone.has(r.key));
  const remindersCount = reminders.length + num(pending.reminders_more);

  const shown = cards.filter((c) => isResultCard(c) && !c.collapsed);
  const delivered = new Set(shown.map(deliveryOf).filter((d): d is string => d != null));
  const results = [
    ...shown.flatMap((c) => cardItem(c) ?? []),
    ...list(pending.results)
      .filter((r) => str(r.id) && !delivered.has(str(r.id)) && !gone.has(`${str(r.id)}:${String(r.revision)}`))
      .map((r): ResultItem => ({
        id: str(r.id),
        key: `${str(r.id)}:${String(r.revision)}`,
        title: str(r.title),
        sub: '交付',
        open: str(r.canonical_task_id) ? { type: 'open', to: { page: 'overview', sel: str(r.canonical_task_id) }, message: '已在主窗口打开：任务' } : null,
        drop: null,
      })),
  ];
  const resultsCount = results.length + num(pending.results_more);

  const quietUntil = state?.quietUntil ?? null;
  const view = readPresence(presence);

  return {
    reminders: remindersCount > 0 ? { items: reminders, count: remindersCount } : null,
    results: resultsCount > 0 ? { items: results, count: resultsCount } : null,
    background: view.role && view.role.backgroundRuns > 0 ? { items: view.role.background, count: view.role.backgroundRuns } : null,
    quiet: quietUntil != null && quietUntil > now ? { until: quietUntil } : null,
    passthrough: state?.clickThroughAll === true,
    voice: view.voice?.state === 'unreachable' ? 'unreachable' : view.voice?.muted ? 'muted' : null,
    observationPaused: view.observation.paused,
  };
}

/** The live icons, in the ring's order. */
export function ringKeys(m: RingModel): RingKey[] {
  const keys: RingKey[] = [];
  if (m.reminders) keys.push('reminders');
  if (m.results) keys.push('results');
  if (m.background) keys.push('background');
  if (m.quiet) keys.push('quiet');
  if (m.passthrough) keys.push('passthrough');
  if (m.voice) keys.push('voice');
  if (m.observationPaused) keys.push('observation');
  return keys;
}

export const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** The one-line tip beside a hovered icon. */
export function ringTip(key: RingKey, m: RingModel): string {
  switch (key) {
    case 'reminders': {
      const first = m.reminders?.items[0];
      return `${m.reminders?.count ?? 0} 条提醒${first ? `，最近：${first.text}` : ''}`;
    }
    case 'results': {
      const first = m.results?.items[0];
      return `${m.results?.count ?? 0} 条结果${first ? `，最近：${first.title}` : ''}`;
    }
    case 'background':
      return `后台 ${m.background?.count ?? 0}`;
    case 'quiet':
      return `免打扰 │ 到 ${formatClock(m.quiet?.until ?? 0)}`;
    case 'passthrough':
      return '全局点穿开着，点击会穿过浮窗';
    case 'voice':
      return m.voice === 'unreachable' ? '语音连不上，她先用文字说' : '语音已静音';
    case 'observation':
      return '观察已暂停，她现在看不到屏幕';
  }
}
