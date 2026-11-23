import type { SchedulesResponse } from '../bridge/agentd-routes.generated';
import { formatClock } from './time';
import { secToMsOrNull } from './units';

export type ScheduleTrigger =
  | { kind: 'daily'; at: string; weekdays: number[] }
  | { kind: 'weekly'; weekday: number; at: string }
  | { kind: 'session_done'; target: 'claude' | 'codex' | null; project: string | null };

export interface Schedule {
  schedule_id: string;
  title: string;
  instruction: string;
  trigger:
    | { kind: 'daily'; at: string; weekdays: number[] }
    | { kind: 'weekly'; weekday: number; at: string }
    | { kind: 'session_done'; target: 'claude' | 'codex' | null; project: string | null };
  enabled: boolean;
  created_from: 'user' | 'agent_proposal';
  next_run_at: number | null;
  last_run_at: number | null;
  last_job_id: string | null;
  scope_id: string | null;
  conversation_id: string | null;
  last_error: string | null;
}

export type WireScheduleTrigger =
  | SchedulesResponse['schedules'][number]['trigger']
  | ScheduleTrigger
  | { kind: string; at?: string; weekdays?: number[]; weekday?: number; target?: string | null; project?: string | null };

export type WireSchedule = Omit<SchedulesResponse['schedules'][number], 'trigger' | 'scope_id' | 'last_error'> & {
  trigger: WireScheduleTrigger;
  scope_id?: string | null;
  last_error?: string | null;
};

export const WEEKDAYS: ReadonlyArray<{ readonly day: number; readonly label: string }> = [
  { day: 1, label: '一' },
  { day: 2, label: '二' },
  { day: 3, label: '三' },
  { day: 4, label: '四' },
  { day: 5, label: '五' },
  { day: 6, label: '六' },
  { day: 7, label: '日' },
];

const WEEKDAY_MAP: Readonly<Record<number, string>> = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '日',
};

export function weekdayLabel(day: number): string {
  return WEEKDAY_MAP[day] ?? '一';
}

function adaptTrigger(w: WireScheduleTrigger): ScheduleTrigger {
  if (w.kind === 'session_done') {
    const t = 'target' in w ? w.target : null;
    const target = t === 'claude' || t === 'codex' ? t : null;
    const p = 'project' in w && typeof w.project === 'string' && w.project.trim() ? w.project.trim() : null;
    return { kind: 'session_done', target, project: p };
  }
  const at = 'at' in w && typeof w.at === 'string' ? w.at : '09:00';
  if (w.kind === 'weekly') {
    const raw = 'weekday' in w && typeof w.weekday === 'number' ? w.weekday : 1;
    const weekday = raw >= 1 && raw <= 7 ? raw : 1;
    return { kind: 'weekly', weekday, at };
  }
  const rawDays = 'weekdays' in w && Array.isArray(w.weekdays) ? w.weekdays : [1, 2, 3, 4, 5];
  const weekdays = [...new Set(rawDays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  return { kind: 'daily', at, weekdays: weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5] };
}

export function fromSchedule(w: WireSchedule): Schedule {
  return {
    schedule_id: w.schedule_id,
    title: w.title,
    instruction: w.instruction,
    trigger: adaptTrigger(w.trigger),
    enabled: Boolean(w.enabled),
    created_from: w.created_from === 'agent_proposal' ? 'agent_proposal' : 'user',
    next_run_at: secToMsOrNull(w.next_run_at),
    last_run_at: secToMsOrNull(w.last_run_at),
    last_job_id: w.last_job_id ?? null,
    scope_id: w.scope_id ?? null,
    conversation_id: w.conversation_id ?? null,
    last_error: w.last_error ?? null,
  };
}

export function formatTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'daily') {
    const days = [...new Set(trigger.weekdays)].sort((a, b) => a - b).map(weekdayLabel);
    return `周${days.join('、')} ${trigger.at}`;
  }
  if (trigger.kind === 'weekly') {
    return `每周${weekdayLabel(trigger.weekday)} ${trigger.at}`;
  }
  const target = trigger.target === 'claude' ? 'Claude Code' : trigger.target === 'codex' ? 'Codex' : '编码';
  const project = trigger.project ? ` │ ${trigger.project}` : '';
  return `${target}${project} 会话结束后`;
}

export function formatScheduleTime(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClock(ms)}`;
}

export interface ScheduleItemView {
  proposalTag: '角色提议' | null;
  actionKind: 'enable_button' | 'toggle';
  actionLabel: string;
  triggerText: string;
  nextRunText: string | null;
  lastRunText: string | null;
}

export function scheduleItemView(s: Schedule): ScheduleItemView {
  return {
    proposalTag: s.created_from === 'agent_proposal' ? '角色提议' : null,
    actionKind: s.enabled ? 'toggle' : 'enable_button',
    actionLabel: s.enabled ? '已启用' : '启用',
    triggerText: formatTrigger(s.trigger),
    nextRunText: formatScheduleTime(s.next_run_at),
    lastRunText: formatScheduleTime(s.last_run_at),
  };
}
