// The motion source switch in agentd's shapes (agent/agentd/motion/settings.py); the demo starts on the `game` backend.
import type { MotionSource } from '../pages/settings/api';
import type { MockResponse, MockRoute } from './types';

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const bad = (error: string): MockResponse => ({ status: 400, body: { error } });

const SAVED: { backend: MotionSource['backend']; token: string } = { backend: 'game', token: '' };

const pub = (): MotionSource => ({ backend: SAVED.backend, token_set: SAVED.token !== '' });

export const routes: MockRoute[] = [
  { method: 'GET', path: '/motion/settings', handler: () => ok(pub()) },
  {
    method: 'PUT',
    path: '/motion/settings',
    handler: ({ body }) => {
      const b = (body != null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (!('backend' in b) || Object.keys(b).some((k) => !['backend', 'token'].includes(k))) return bad('invalid_payload');
      if (b.backend !== 'game' && b.backend !== 'generated') return bad('invalid_backend');
      if ('token' in b && (typeof b.token !== 'string' || b.token.length > 4096)) return bad('invalid_token');
      Object.assign(SAVED, { backend: b.backend }, typeof b.token === 'string' ? { token: b.token } : {});
      return ok(pub());
    },
  },
];
