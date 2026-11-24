// Local schedules (api/sessions.py `_schedules_*`, personal/schedules.py): GET/POST /schedules, PUT/DELETE /schedules/:id, POST /schedules/:id/run.
import type { ScheduleTrigger, WireSchedule } from '../domain/schedules';
import { NOW } from './fixtures';
import type { MockResponse, MockRoute } from './types';

const NOW_S = NOW / 1000;
const NEXT_S = 1793835000.0;
const BASE_S = 1793811600.0;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const INITIAL_SCHEDULES: readonly WireSchedule[] = [
  {
    schedule_id: 'schedule-1',
    title: '日报',
    instruction: '总结仓库变化',
    trigger: { kind: 'daily', at: '18:30', weekdays: [1, 2, 3, 4, 5] },
    enabled: true,
    created_from: 'user',
    conversation_id: 'conversation-1',
    scope_id: null,
    next_run_at: NEXT_S,
    last_run_at: BASE_S,
    last_job_id: 'job-1',
    last_error: null,
    created_at: BASE_S,
    updated_at: BASE_S,
    accepted_at: BASE_S,
  },
  {
    schedule_id: 'schedule-2',
    title: '每周五整理周报',
    instruction: '汇总本周完成的任务与草稿',
    trigger: { kind: 'weekly', weekday: 5, at: '17:00' },
    enabled: false,
    created_from: 'agent_proposal',
    conversation_id: null,
    scope_id: null,
    next_run_at: null,
    last_run_at: null,
    last_job_id: null,
    last_error: null,
    created_at: BASE_S,
    updated_at: BASE_S,
    accepted_at: null,
  },
];

let schedules: WireSchedule[] = INITIAL_SCHEDULES.map((s) => ({ ...s, trigger: { ...s.trigger } }));
let seq = 3;

export function resetSchedules(): void {
  schedules = INITIAL_SCHEDULES.map((s) => ({ ...s, trigger: { ...s.trigger } }));
  seq = 3;
}

const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
const bad = (error: string, status = 400): MockResponse => ({ status, body: { error } });
const isText = (v: unknown, limit: number): v is string => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= limit;

function parseTrigger(raw: unknown): ScheduleTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const kind = t.kind;
  const fields: Record<string, readonly string[]> = {
    daily: ['kind', 'at', 'weekdays'],
    weekly: ['kind', 'at', 'weekday'],
    session_done: ['kind', 'target', 'project'],
  };
  if (typeof kind !== 'string' || !(kind in fields)) return null;
  if (Object.keys(t).some((k) => !fields[kind]!.includes(k))) return null;
  if (kind === 'session_done') {
    const target = t.target ?? null;
    const project = t.project ?? null;
    if (target !== null && target !== 'claude' && target !== 'codex') return null;
    if (project !== null && !isText(project, 4096)) return null;
    return { kind: 'session_done', target, project };
  }
  if (typeof t.at !== 'string' || !TIME_RE.test(t.at)) return null;
  if (kind === 'daily') {
    if (!Array.isArray(t.weekdays) || t.weekdays.length < 1 || t.weekdays.length > 7) return null;
    if (t.weekdays.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 7)) return null;
    const weekdays = [...new Set(t.weekdays as number[])].sort((a, b) => a - b);
    return { kind: 'daily', at: t.at, weekdays };
  }
  if (typeof t.weekday !== 'number' || !Number.isInteger(t.weekday) || t.weekday < 1 || t.weekday > 7) return null;
  return { kind: 'weekly', at: t.at, weekday: t.weekday };
}

function nextRunAt(trigger: ScheduleTrigger, enabled: boolean): number | null {
  if (!enabled || trigger.kind === 'session_done') return null;
  return NEXT_S;
}

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/schedules',
    handler: ({ query }) => {
      if (query.get('fail') === '1') return bad('internal_error', 500);
      return ok({ schedules });
    },
  },
  {
    method: 'POST',
    path: '/schedules',
    handler: ({ body }) => {
      if (!body || typeof body !== 'object') return bad('invalid_schedule');
      const b = body as Record<string, unknown>;
      const allowed = ['title', 'instruction', 'trigger', 'enabled', 'conversation_id', 'scope_id'];
      if (Object.keys(b).some((k) => !allowed.includes(k))) return bad('invalid_schedule');
      if (!('title' in b) || !('instruction' in b) || !('trigger' in b)) return bad('invalid_schedule');
      const enabled = 'enabled' in b ? b.enabled : false;
      const convId = b.conversation_id ?? null;
      const scopeId = b.scope_id ?? null;
      if (!isText(b.title, 200) || !isText(b.instruction, 8000) || typeof enabled !== 'boolean') return bad('invalid_schedule');
      if (convId !== null && !isText(convId, 128) || scopeId !== null && !isText(scopeId, 128)) return bad('invalid_schedule');
      const trigger = parseTrigger(b.trigger);
      if (!trigger) return bad('invalid_schedule_trigger');
      const item: WireSchedule = {
        schedule_id: `schedule-${seq++}`,
        title: b.title,
        instruction: b.instruction,
        trigger,
        enabled,
        created_from: 'user',
        conversation_id: convId,
        scope_id: scopeId,
        next_run_at: nextRunAt(trigger, enabled),
        last_run_at: null,
        last_job_id: null,
        last_error: null,
        created_at: NOW_S,
        updated_at: NOW_S,
        accepted_at: enabled ? NOW_S : null,
      };
      schedules = [...schedules, item];
      return ok({ schedule: item }, 201);
    },
  },
  {
    method: 'PUT',
    path: '/schedules/:id',
    handler: ({ params, body }) => {
      if (!body || typeof body !== 'object') return bad('invalid_schedule');
      const b = body as Record<string, unknown>;
      const keys = Object.keys(b);
      if (keys.length === 0 || keys.some((k) => !['title', 'instruction', 'trigger', 'enabled', 'conversation_id', 'scope_id'].includes(k))) {
        return bad('invalid_schedule');
      }
      const idx = schedules.findIndex((s) => s.schedule_id === params.id);
      if (idx < 0) return bad('unknown_schedule', 404);
      const current = schedules[idx]!;
      const title = 'title' in b ? b.title : current.title;
      const instruction = 'instruction' in b ? b.instruction : current.instruction;
      const enabled = 'enabled' in b ? b.enabled : current.enabled;
      const convId = 'conversation_id' in b ? b.conversation_id : current.conversation_id;
      const scopeId = 'scope_id' in b ? b.scope_id : current.scope_id ?? null;
      if (!isText(title, 200) || !isText(instruction, 8000) || typeof enabled !== 'boolean') {
        return bad('invalid_schedule');
      }
      if (convId !== null && !isText(convId, 128) || scopeId !== null && !isText(scopeId, 128)) return bad('invalid_schedule');
      const trigger = 'trigger' in b ? parseTrigger(b.trigger) : parseTrigger(current.trigger);
      if (!trigger) return bad('invalid_schedule_trigger');
      const next = 'trigger' in b || 'enabled' in b ? nextRunAt(trigger, enabled) : current.next_run_at;
      const updated: WireSchedule = {
        ...current,
        title,
        instruction,
        trigger,
        enabled,
        conversation_id: convId,
        scope_id: scopeId,
        next_run_at: next,
        updated_at: NOW_S,
        accepted_at: current.accepted_at ?? (enabled ? NOW_S : null),
      };
      schedules = schedules.map((s, i) => (i === idx ? updated : s));
      return ok({ schedule: updated });
    },
  },
  {
    method: 'DELETE',
    path: '/schedules/:id',
    handler: ({ params }) => {
      const idx = schedules.findIndex((s) => s.schedule_id === params.id);
      if (idx < 0) return bad('unknown_schedule', 404);
      schedules = schedules.filter((s) => s.schedule_id !== params.id);
      return ok({ deleted: true });
    },
  },
  {
    method: 'POST',
    path: '/schedules/:id/run',
    handler: ({ params }) => {
      const idx = schedules.findIndex((s) => s.schedule_id === params.id);
      if (idx < 0) return bad('unknown_schedule', 404);
      const jobId = `job-run-${seq++}`;
      const current = schedules[idx]!;
      const updated: WireSchedule = {
        ...current,
        last_run_at: NOW_S,
        last_job_id: jobId,
        updated_at: NOW_S,
      };
      schedules = schedules.map((s, i) => (i === idx ? updated : s));
      return ok({ job_id: jobId }, 202);
    },
  },
];
