// Shared agentd request helper: body defaults and the thrown error shape every page uses.
import { getBridge } from './index';
import type { AgentdResponse, HttpMethod } from './protocol';
import type { WireVoice, WireVoiceTest } from '../domain/wire';

/** POST routes agentd answers without reading a body (server.py do_POST); a body sent there would stay on the keep-alive connection. */
export const NO_BODY: readonly RegExp[] = [
  /^\/sessions\/[^/]{1,200}\/interrupt$/,
  /^\/tasks\/[^/]{1,64}\/(accept|reject)$/,
  /^\/commitments\/[^/]{1,64}\/(cancel|complete)$/,
];

/** 409 codes meaning someone else changed the row first; reload and show「已在别处更新」. */
export const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'generation_mismatch',
  'already_decided',
  'expired',
  'cancelled',
  'abandoned',
  'interaction_version_changed',
  'delivery_version_changed',
  'delivery_revoked',
  'version_conflict',
  'busy',
  'run_changed',
  'run_finished',
  'character_changed',
  'goal_version_changed',
]);

/** Status-0 codes of a request the bridge refused to send. `offline` is not one: it alone means agentd is unreachable. */
export const BRIDGE_REFUSED: ReadonlySet<string> = new Set([
  'invalid_method',
  'invalid_path',
  'unclassified_route',
  'route_class',
  'surface_not_allowed',
  'invalid_body',
  'handle_required',
  'declined',
]);

/** True when agentd does not read a body on this route. */
export function noBody(method: HttpMethod, path: string): boolean {
  const route = path.split('?')[0] ?? '';
  return method === 'POST' && NO_BODY.some((r) => r.test(route));
}

/** One path segment (ids such as `own:…` or `job:…`). The colon stays literal: /sessions does not unquote and matches `own:` as is. */
export const seg = (id: string): string => encodeURIComponent(id).replace(/%3A/gi, ':');

/** A non-2xx reply or a request the bridge did not complete. `body` is agentd's whole error JSON (409 extras such as `current_version` live there); null when status is 0. */
export class AgentdCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly body: unknown;
  constructor(status: number, code: string, detail: string | undefined, body: unknown, message: string) {
    super(message);
    this.name = 'AgentdCallError';
    this.status = status;
    this.code = code;
    if (detail != null) this.detail = detail;
    this.body = body;
  }
}

/** Raw bridge request with the body defaults: POST/PUT/PATCH without a body send `{}` except on `NO_BODY` routes; GET and DELETE send none. */
export function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<AgentdResponse<T>> {
  const sent = body === undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH') && !noBody(method, path) ? {} : body;
  return getBridge().agentd.request<T>(method, path, sent);
}

/** agentd call; resolves with the 2xx body, else throws AgentdCallError whose message is the backend detail for a toast. */
export async function call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const res = await request<T>(method, path, body);
  if (res.status < 200 || res.status >= 300 || res.body == null) {
    const message = res.error?.detail ?? res.error?.code ?? `HTTP ${res.status}`;
    throw new AgentdCallError(res.status, res.error?.code ?? `http_${res.status}`, res.error?.detail, res.body, message);
  }
  return res.body;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body);
export const patch = <T>(path: string, body?: unknown) => call<T>('PATCH', path, body);
export const del = <T>(path: string, body?: unknown) => call<T>('DELETE', path, body);

/** Clears the TTS negative cache and probes the voice again (main surface only). */
export const resetVoice = () => post<{ tts: WireVoice }>('/voice/reset', {});

/** Synthesizes a short line on `url` (or the running address) without playing it (main surface only). */
export const testVoice = (body: { url?: string; token?: string }) => post<WireVoiceTest>('/voice/test', body);

/** Stores the external voice service's token for the running agentd and later starts (main surface only). */
export const saveVoiceToken = (token: string) => post<{ ok: true }>('/voice/token', { token });

/** The voice a character speaks with, from her effective binding; null when neither her package nor the user names one (main surface only). */
export const readVoiceBinding = (character: string) =>
  get<{ voice: { voice_id: string; language: string } | null }>(`/characters/${seg(character)}/binding`).then((b) => (b.voice ? { voiceId: b.voice.voice_id, language: b.voice.language } : null));
