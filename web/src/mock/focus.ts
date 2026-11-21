// 陪我专注 (focus.py): one session at a time, 5–120 minutes; POST answers 409 focus_running while one runs, DELETE 409 no_focus without one.
import { NOW } from './fixtures';
import type { MockRoute } from './types';

let session: { started_at: number; until: number; minutes: number; started_by: string } | null = null;

export const routes: MockRoute[] = [
  { method: 'GET', path: '/focus', handler: () => ({ status: 200, body: { focus: session } }) },
  {
    method: 'POST',
    path: '/focus',
    handler: ({ body }) => {
      const minutes = (body as { minutes?: unknown } | null)?.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return { status: 400, body: { error: 'invalid_payload', field: 'minutes' } };
      if (minutes < 5 || minutes > 120) return { status: 400, body: { error: 'invalid_minutes' } };
      if (session) return { status: 409, body: { error: 'focus_running' } };
      session = { started_at: NOW / 1000, until: NOW / 1000 + minutes * 60, minutes, started_by: 'user' };
      return { status: 200, body: { focus: session } };
    },
  },
  {
    method: 'DELETE',
    path: '/focus',
    handler: () => {
      if (!session) return { status: 409, body: { error: 'no_focus' } };
      session = null;
      return { status: 200, body: { focus: null } };
    },
  },
];
