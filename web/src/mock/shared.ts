// Endpoints more than one page calls, in agentd's shapes; registered only here (mock-routes.test.ts checks
// that no method + path is registered twice).
import { isoWithOffset } from '../domain/units';
import type { WireRuntimeSettings } from '../domain/wire';
import { NOW, WIRE_APPROVALS, WIRE_SESSIONS, WIRE_TASK_ROWS } from './fixtures';
import type { MockResponse, MockRoute } from './types';

const PAUSE_MAX_MIN = 1440;
const NOW_S = NOW / 1000;
const bad = (error: string): MockResponse => ({ status: 400, body: { error } });
const iso = (s: number | null) => (s == null ? null : isoWithOffset(s * 1000));
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});

/** settings.py DEFAULTS keys; PUT /character/runtime refuses any other key. */
const RUNTIME_KEYS: ReadonlyArray<keyof WireRuntimeSettings> = [
  'backend',
  'runtime_source',
  'executable',
  'auth_source',
  'provider',
  'model',
  'max_budget_usd',
  'scope_id',
  'interactive_tools',
  'history_retention',
  'web_access',
  'routes',
  'acp_agent',
  'acp_launcher',
  'workspace_dir',
  'reply_language',
  'pi_tool_approval',
];

export const routes: MockRoute[] = [
  { method: 'GET', path: '/approvals', handler: () => ({ status: 200, body: { approvals: WIRE_APPROVALS } }) },
  { method: 'GET', path: '/sessions', handler: () => ({ status: 200, body: { sessions: WIRE_SESSIONS } }) },
  { method: 'POST', path: '/say', handler: () => ({ status: 202, body: { line_id: '5ay0c0ffee12', generation: 42 } }) },
  { method: 'POST', path: '/voice/reset', handler: () => ({ status: 200, body: { tts: { provider: 'remote-ws', state: 'ready', reason: null, retry_after_s: null } } }) },
  { method: 'POST', path: '/voice/test', handler: () => ({ status: 200, body: { ok: true, first_audio_ms: 320, total_ms: 1180, reason: null } }) },
  { method: 'POST', path: '/voice/token', handler: () => ({ status: 200, body: { ok: true } }) },
  {
    method: 'PUT',
    path: '/observation/paused',
    handler: ({ body }) => {
      const m = obj(body).minutes;
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > PAUSE_MAX_MIN) return bad('invalid_payload');
      return { status: 200, body: { paused_until: m ? iso(NOW_S + m * 60) : null } };
    },
  },
  {
    method: 'PUT',
    path: '/observation/quiet',
    handler: ({ body }) => {
      const b = obj(body);
      const until = b.until;
      // The fake clock is frozen at NOW while callers may use the real clock, so only the lower bound is checked.
      if (!('until' in b) || (until !== null && (typeof until !== 'number' || until <= NOW_S))) return bad('invalid_payload');
      return { status: 200, body: { quiet_until: iso(until) } };
    },
  },
  {
    method: 'PUT',
    path: '/observation/meeting',
    handler: ({ body }) => {
      const on = obj(body).on;
      return typeof on === 'boolean' ? { status: 200, body: { meeting: on } } : bad('invalid_payload');
    },
  },
  {
    method: 'PUT',
    path: '/character/runtime',
    handler: ({ body }) => {
      const keys = Object.keys(obj(body));
      if (body == null || typeof body !== 'object' || keys.some((k) => !RUNTIME_KEYS.includes(k as keyof WireRuntimeSettings))) return bad('invalid_runtime_settings');
      return { status: 200, body };
    },
  },
  /** ⌘K and the task page stop a role task through its job and a ledger task through `/tasks` (http.py:178-187). */
  // jobs.py cancel settles only a live job; a job waiting for review answers cancelled:false.
  {
    method: 'POST',
    path: '/agent/jobs/:id/cancel',
    handler: ({ params }) => {
      const state = WIRE_TASK_ROWS.find((r) => r.job_id === params.id)?.state;
      return { status: 202, body: { job_id: params.id, cancelled: state === 'queued' || state === 'running' || state === 'interrupted' || state === 'waiting_user' } };
    },
  },
  { method: 'POST', path: '/tasks/:id/cancel', handler: ({ params }) => ({ status: 202, body: { task_id: params.id, cancellation_requested: true } }) },
];
