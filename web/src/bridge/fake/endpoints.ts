import type { MockRoute } from '../../mock/types';

// Example agentd endpoints. Each method + path is registered once across these and src/mock/*.ts.

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
  {
    method: 'POST',
    path: '/user/coarse',
    handler: () => ({ status: 200, body: { presence: 'present', stage: 'normal', doing: 'idle', absence: null, revision: 1, typing: false } }),
  },
  { method: 'GET', path: '/health', handler: () => ({ status: 200, body: { status: 'ok', degraded: [], c6_contract: 'v1' } }) },
];
