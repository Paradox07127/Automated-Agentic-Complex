// Work-memory endpoints (worklog_http.py) served from the C6 fixtures; PATCH changes this module's copy.
import memorySessions from '../../../protocol/C6-agentd-api/fixtures/memory-sessions.json';
import memoryTasks from '../../../protocol/C6-agentd-api/fixtures/memory-tasks.json';
import memoryTask from '../../../protocol/C6-agentd-api/fixtures/memory-task.json';
import memoryDays from '../../../protocol/C6-agentd-api/fixtures/memory-days.json';
import { paused } from './memory';
import type { MockResponse, MockRoute } from './types';

const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
const bad = (error: string, status = 400, extra: object = {}): MockResponse => ({ status, body: { error, ...extra } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** `?demo=absent`, which the 今天 page sends to the fake bridge only: an agentd without these routes. */
const absent = (query: URLSearchParams): MockResponse | null => (query.get('demo') === 'absent' ? { status: 0, body: null, error: { code: 'unclassified_route' } } : null);

const workTasks = memoryTasks.tasks.map((task) => ({ ...task }));
const workStatuses = ['active', 'done', 'parked', 'uncertain'];
const workDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const routes: MockRoute[] = [
  {
    method: 'GET', path: '/memory/sessions',
    handler: ({ query }) => {
      const no = absent(query);
      if (no) return no;
      const day = query.get('day') ?? memorySessions.day;
      if (!workDate(day)) return bad('invalid_date');
      return ok({ day, sessions: paused || day !== memorySessions.day ? [] : memorySessions.sessions });
    },
  },
  {
    method: 'GET', path: '/memory/tasks',
    handler: ({ query }) => {
      const no = absent(query);
      if (no) return no;
      const statuses = query.has('status') ? query.get('status')!.split(',') : workStatuses;
      if (statuses.some((status) => !workStatuses.includes(status))) return bad('invalid_status');
      const tasks = paused ? [] : workTasks;
      return ok({ tasks: tasks.filter((task) => statuses.includes(task.status)),
        counts: Object.fromEntries(workStatuses.map((status) => [status, tasks.filter((task) => task.status === status).length])) });
    },
  },
  {
    method: 'GET', path: '/memory/tasks/:task_id',
    handler: ({ params }) => {
      const task = paused ? undefined : workTasks.find((task) => task.id === params.task_id);
      return task ? ok({ task, sessions: memoryTask.sessions.filter((session) => session.task_id === task.id) }) : bad('task_not_found', 404);
    },
  },
  {
    method: 'PATCH', path: '/memory/tasks/:task_id',
    handler: ({ params, body }) => {
      const task = paused ? undefined : workTasks.find((task) => task.id === params.task_id);
      if (!task) return bad('task_not_found', 404);
      const b = obj(body);
      if (!isInt(b.expected_revision) || b.expected_revision < 0 ||
        Object.keys(b).some((key) => !['expected_revision', 'status', 'title', 'goal'].includes(key)) ||
        !['status', 'title', 'goal'].some((key) => key in b)) return bad('invalid_payload');
      if ('status' in b && (typeof b.status !== 'string' || !workStatuses.includes(b.status))) return bad('invalid_status');
      if (['title', 'goal'].some((key) => key in b && (typeof b[key] !== 'string' || !b[key].trim()))) return bad('invalid_payload');
      if (task.revision !== b.expected_revision) return bad('revision_conflict', 409, { task });
      Object.assign(task, { ...('status' in b ? { status: b.status } : {}), ...('title' in b ? { title: b.title } : {}),
        ...('goal' in b ? { goal: b.goal, goal_authority: 'user_corrected' } : {}), edited: true, revision: task.revision + 1 });
      return ok({ ...task });
    },
  },
  {
    method: 'GET', path: '/memory/days',
    handler: ({ query }) => {
      const no = absent(query);
      if (no) return no;
      const from = query.get('from') ?? memoryDays.days[0]!.date;
      const to = query.get('to') ?? memoryDays.days[0]!.date;
      if (!workDate(from) || !workDate(to)) return bad('invalid_date');
      const span = (Date.parse(to) - Date.parse(from)) / 86400000;
      if (span < 0 || span >= 31) return bad('invalid_range');
      return ok({ days: paused ? [] : memoryDays.days.filter((day) => day.date >= from && day.date <= to) });
    },
  },
  {
    method: 'GET', path: '/memory/days/:date',
    handler: ({ params, query }) => {
      if (!workDate(params.date ?? '')) return bad('invalid_date');
      const period = query.get('period') ?? 'day';
      if (period !== 'day' && period !== 'week') return bad('invalid_period');
      const day = paused ? undefined : memoryDays.days.find((day) => day.date === params.date && day.period === period);
      return day ? ok(day) : bad('day_not_found', 404);
    },
  },
];
