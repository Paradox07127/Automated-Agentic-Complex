import type { AgentdResponse, BridgeError, HttpMethod } from '../protocol';
import { noBody } from '../agentd';
import type { MockRoute } from '../../mock/types';

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] ?? '';
    const val = s[i] ?? '';
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

/** The bridge's `error` for a non-2xx agentd reply (AgentdTransport `AgentdError`). */
function errorOf(status: number, body: unknown): BridgeError | undefined {
  if (status >= 200 && status < 300) return undefined;
  const o = body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const error: BridgeError = { code: typeof o.error === 'string' ? o.error : `http_${status}` };
  if (typeof o.detail === 'string') error.detail = o.detail;
  return error;
}

function reply<T>(status: number, body: unknown, error?: BridgeError): AgentdResponse<T> {
  const e = error ?? errorOf(status, body);
  return { status, body: (body ?? null) as T | null, ...(e ? { error: e } : {}) };
}

/** Dispatches by method + path like agentd: unknown route 404, then a write without a body 400; later routes win over earlier ones with the same pattern. `/state` names `character()` when given. */
export function createDispatcher(routes: MockRoute[], character?: () => string) {
  return async function request<T>(method: HttpMethod, fullPath: string, body?: unknown): Promise<AgentdResponse<T>> {
    const [path = '', qs = ''] = fullPath.split('?');
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (!r || r.method !== method) continue;
      const params = matchPath(r.path, path);
      if (!params) continue;
      if (body === undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH') && !noBody(method, path)) {
        return reply(400, { error: 'invalid_body_size' });
      }
      const res = await r.handler({ method, path, params, query: new URLSearchParams(qs), body });
      const out = reply<T>(res.status, res.body, res.error);
      return character && method === 'GET' && path === '/state' && out.body ? { ...out, body: { ...out.body, character: character() } } : out;
    }
    return reply(404, { error: 'not_found' });
  };
}
