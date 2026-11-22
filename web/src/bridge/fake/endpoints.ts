import type { MockRoute } from '../../mock/types';

// Example agentd endpoints. Each method + path is registered once across these and src/mock/*.ts.

const runs = [
  { id: 'run-0142', title: '整理本周周报', source: 'role', status: 'running', startedAt: '2026-10-29T14:20:00+08:00' },
  { id: 'run-0141', title: '修复构建脚本', source: 'code', status: 'waiting', startedAt: '2026-10-29T13:58:00+08:00' },
  { id: 'run-0140', title: '归档下载目录', source: 'role', status: 'succeeded', startedAt: '2026-10-29T11:05:00+08:00' },
];

export const exampleRoutes: MockRoute[] = [
  {
    method: 'GET',
    path: '/user/now',
    handler: () => ({
      status: 200,
      body: {
        snapshot: {
          revision: 0, presence: 'unknown', doing: 'idle', input_active: false, typing: null,
          flags: { fullscreen: false, music: false, late_night: false, user_speaking: false, focused: null },
          overrides: { meeting_manual: false, dnd_until: null, focus_timer: false },
          stage: 'normal', absence: null, paused: false,
        },
        events: [],
      },
    }),
  },
  { method: 'GET', path: '/health', handler: () => ({ status: 200, body: { status: 'ok', degraded: [], c6_contract: 'v1' } }) },
  {
    method: 'GET',
    path: '/agent/runs/:id',
    handler: ({ params }) => {
      const run = runs.find((r) => r.id === params.id);
      return run ? { status: 200, body: run } : { status: 404, body: null, error: { code: 'run_not_found' } };
    },
  },
  {
    method: 'GET',
    path: '/presence',
    handler: () => ({ status: 200, body: { observing: true, app: 'Terminal', pausedUntil: null } }),
  },
];
