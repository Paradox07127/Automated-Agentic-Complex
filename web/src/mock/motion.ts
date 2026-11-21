// The motion source switch in agentd's shapes (agent/agentd/motion/settings.py); the demo starts on the `game` backend.
import type { MotionSource } from '../pages/settings/api';
import type { MockResponse, MockRoute } from './types';

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const bad = (error: string): MockResponse => ({ status: 400, body: { error } });

const SAVED: { backend: MotionSource['backend']; service_url: string | null; token: string } = { backend: 'game', service_url: null, token: '' };

const pub = (): MotionSource => ({ backend: SAVED.backend, service_url: SAVED.service_url, token_set: SAVED.token !== '' });

const urlOk = (url: unknown) => url === null || (typeof url === 'string' && /^https?:\/\/[^/?#]+/.test(url));

export const routes: MockRoute[] = [
  { method: 'GET', path: '/motion/settings', handler: () => ok(pub()) },
  {
    method: 'PUT',
    path: '/motion/settings',
    handler: ({ body }) => {
      const b = (body != null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (!('backend' in b && 'service_url' in b) || Object.keys(b).some((k) => !['backend', 'service_url', 'token'].includes(k))) return bad('invalid_payload');
      if (b.backend !== 'game' && b.backend !== 'generated') return bad('invalid_backend');
      if (!urlOk(b.service_url)) return bad('invalid_service_url');
      if ('token' in b && (typeof b.token !== 'string' || b.token.length > 4096)) return bad('invalid_token');
      Object.assign(SAVED, { backend: b.backend, service_url: b.service_url }, typeof b.token === 'string' ? { token: b.token } : {});
      return ok(pub());
    },
  },
];
