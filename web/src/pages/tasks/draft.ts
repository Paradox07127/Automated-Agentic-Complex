// The editor's draft: dispatch a role task or coding session now, or create / edit a schedule; checks and sends it.
import type { PickedHandle } from '../../bridge/protocol';
import type { Schedule, ScheduleTrigger } from '../../domain/schedules';
import { draftProblem, submitDraft } from './create';
import { draftFor, type CodeMode, type CreateDraft } from './CreateForm';
import type { CreateKind } from './params';
import { nextRun, type SchedulePayload } from './schedules';

export interface EditDraft {
  /** The schedule being edited; null for a new one or a dispatch. */
  scheduleId: string | null;
  when: 'now' | 'repeat';
  type: 'role' | 'code';
  title: string;
  /** 要求 now, 指令 for a schedule. */
  brief: string;
  artifact: string;
  sections: string;
  agent: 'claude' | 'codex';
  cwd: PickedHandle | null;
  mode: CodeMode;
  scopeId: string | null;
  conversationId: string | null;
  trig: ScheduleTrigger['kind'];
  at: string;
  weekdays: number[];
  weekday: number;
  target: 'claude' | 'codex' | null;
  project: string;
}

const BASE: Omit<EditDraft, 'when' | 'type'> = {
  scheduleId: null,
  title: '',
  brief: '',
  artifact: '',
  sections: '',
  agent: 'claude',
  cwd: null,
  mode: 'read_only',
  scopeId: null,
  conversationId: null,
  trig: 'daily',
  at: '18:30',
  weekdays: [1, 2, 3, 4, 5],
  weekday: 5,
  target: null,
  project: '',
};

/** A fresh draft; `title` prefills 再派一次. */
export function newDraft(kind: CreateKind, title = ''): EditDraft {
  return { ...BASE, when: kind === 'sched' ? 'repeat' : 'now', type: kind === 'code' ? 'code' : 'role', title };
}

export function draftFromSchedule(s: Schedule): EditDraft {
  const t = s.trigger;
  return {
    ...BASE,
    scheduleId: s.schedule_id,
    when: 'repeat',
    type: 'role',
    title: s.title,
    brief: s.instruction,
    scopeId: s.scope_id,
    conversationId: s.conversation_id,
    trig: t.kind,
    at: t.kind === 'session_done' ? BASE.at : t.at,
    weekdays: t.kind === 'daily' ? [...t.weekdays] : BASE.weekdays,
    weekday: t.kind === 'weekly' ? t.weekday : BASE.weekday,
    target: t.kind === 'session_done' ? t.target : null,
    project: t.kind === 'session_done' ? (t.project ?? '') : '',
  };
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** The schedule trigger the draft names; null when the time is not HH:MM or no weekday is picked. */
export function triggerOf(d: EditDraft): ScheduleTrigger | null {
  if (d.trig === 'session_done') return { kind: 'session_done', target: d.target, project: d.project.trim() || null };
  const at = d.at.trim();
  if (!TIME_RE.test(at)) return null;
  if (d.trig === 'weekly') return d.weekday >= 1 && d.weekday <= 7 ? { kind: 'weekly', at, weekday: d.weekday } : null;
  const weekdays = [...new Set(d.weekdays)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  return weekdays.length > 0 ? { kind: 'daily', at, weekdays } : null;
}

/** The dispatch half as the create form's draft. */
function createDraft(d: EditDraft): CreateDraft {
  return { ...draftFor(d.type), title: d.title, brief: d.brief, artifact: d.artifact, sections: d.sections, agent: d.agent, cwd: d.cwd, mode: d.mode, scopeId: d.scopeId };
}

/** Why the draft cannot be sent yet; null when it can. */
export function problemOf(d: EditDraft, canPick: boolean): string | null {
  if (d.when === 'now') return draftProblem(createDraft(d), canPick);
  if (!d.title.trim()) return '先写标题';
  if (!d.brief.trim()) return '先写指令';
  return triggerOf(d) ? null : '时间写成 18:30 这样，至少选一天';
}

/** Next run of a schedule draft, for the preview line; null without one. */
export const draftNext = (d: EditDraft, now: number) => {
  const t = triggerOf(d);
  return t ? nextRun(t, now) : null;
};

export const sendNow = (d: EditDraft) => submitDraft(createDraft(d));

export function schedulePayload(d: EditDraft): SchedulePayload | null {
  const trigger = triggerOf(d);
  return trigger ? { title: d.title.trim(), instruction: d.brief.trim(), trigger, scope_id: d.scopeId, conversation_id: d.conversationId } : null;
}
