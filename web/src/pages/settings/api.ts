// The settings page's agentd calls: literal paths through the shared helper, so check:routes sees each one.
import { AgentdCallError, CONFLICT_CODES, del, get, post, put, seg } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import { codeText, serverFaultText } from '../../domain/errorText';
import { getBridge, type PickedHandle } from '../../bridge';
import type { ObservationBriefsSettingsResponse } from '../../bridge/agentd-routes.generated';
import type { WireProductLogin, WireRuntimePublic, WireRuntimeSettings } from '../../domain/wire';
import type {
  AllowField,
  BlacklistField,
  WireBlacklist,
  WireCatalog,
  WireChatgpt,
  WireDiagSlice,
  WireModelSettings,
  WireModelTest,
  WireScope,
} from './wire';
import { RUNTIME_ERROR } from './fields';

export const clock = appNow;

/** PUT /character/runtime preserves omitted settings (bodies.runtimeSettings). */
export const saveRuntime = (body: Partial<WireRuntimeSettings>) => put<WireRuntimePublic>('/character/runtime', body);

export const readModels = () => get<WireModelSettings>('/model/settings');
export const saveModels = (body: Record<string, unknown>) => post<WireModelSettings>('/model/settings', body);
export const testModels = () => post<WireModelTest>('/model/test', {});

export interface MotionSource {
  backend: 'game' | 'generated';
  token_set: boolean;
}
export const readMotion = () => get<MotionSource>('/motion/settings');
/** A token `''` removes the saved one; no `token` key keeps it. */
export const saveMotion = (body: { backend: MotionSource['backend']; token?: string }) => put<MotionSource>('/motion/settings', body);
export const readCatalog = () => post<WireCatalog>('/model/catalog', {});
/** config.json's `services`, read through the shell. */
export const readServices = () => getBridge().services.read();
/** agentd opens the sign-in page in the browser itself and answers with the account state; a saved account's id signs that one in again, none adds one. */
export const chatgptStart = (profile_id?: string) => post<WireChatgpt>('/model/chatgpt/start', profile_id ? { profile_id } : {});
export const chatgptCancel = () => post<WireChatgpt>('/model/chatgpt/cancel', {});
export const chatgptSelect = (profile_id: string) => post<WireChatgpt>('/model/chatgpt/select', { profile_id });
/** agentd answers only whether the provider revoked the refresh token; the account state comes from a reload. */
export const chatgptLogout = (profile_id: string) => post<{ revoked: boolean }>('/model/chatgpt/logout', { profile_id });

/** Sign-in of the saved kernel in the app: agentd or the kernel opens the browser; the state comes back in `/character/runtime`. `method_id` picks an ACP agent's method. */
export const loginStart = (method_id?: string) => post<WireProductLogin>('/character/login/start', method_id ? { method_id } : {});
export const loginCancel = () => post<WireProductLogin>('/character/login/cancel', {});
export const loginLogout = () => post<WireProductLogin>('/character/login/logout', {});

/** integration.py acp_agents(): `probe` is set on local agents after a refresh only. */
export interface AcpAgent {
  id: string;
  name: string;
  version: string | null;
  source: 'local' | 'npx' | 'uvx';
  command: string[];
  probe: { ok: boolean; agent_info: unknown; auth_methods: Array<{ id?: string; name?: string; _meta?: Record<string, unknown> }> | null; error: string | null } | null;
  /** The kernel that runs this harness directly; settings offer it instead of the bridge. */
  native_backend: 'claude' | 'codex' | null;
}
export interface AcpAgents {
  agents: AcpAgent[];
  npx: boolean;
  uvx: boolean;
}
/** `refresh` runs initialize on each local agent (about 10 s). */
export const readAcpAgents = (refresh = false) => get<AcpAgents>(refresh ? '/character/acp/agents?refresh=1' : '/character/acp/agents');
/** `exit` is null when the install ran past agentd's time limit. */
export interface AcpInstall {
  ok: boolean;
  agent_id: string;
  command: string[];
  exit: number | null;
  output_tail: string;
}
/** A global `npm install -g` or `uv tool install` of a registry npx/uvx agent; it lists as local afterwards. */
export const installAcpAgent = (agent_id: string) => post<AcpInstall>('/character/acp/install', { agent_id });

export const readDiag = () => get<WireDiagSlice>('/diag/state');

/** Proactive line kinds turned off with the bubble's 关闭此类; PUT replaces the whole list. */
export const readMutes = () => get<{ muted: string[] }>('/proactive/mutes');
export const saveMutes = (muted: string[]) => put<{ muted: string[] }>('/proactive/mutes', { muted });

export interface ProactiveTriggerStats {
  shown: number;
  replied: number;
  accepted: number;
  feedback: number;
}
export type ProactiveStats = Record<string, ProactiveTriggerStats>;
/** companion_mode without a stored choice follows 主动说话; quiet_start..quiet_end are local hours, equal for none. */
export interface ProactiveSettings {
  companion_mode: boolean;
  quiet_start: number;
  quiet_end: number;
}
export const readProactiveSettings = () => get<ProactiveSettings>('/proactive/settings');
/** Takes any non-empty subset of the settings and answers with all of them. */
export const saveProactiveSettings = (body: Partial<ProactiveSettings>) => put<ProactiveSettings>('/proactive/settings', body);
export const readProactiveStats = (days = 7) => get<ProactiveStats>(`/proactive/stats?days=${days}`);

export type BriefSettings = ObservationBriefsSettingsResponse;
export const readBriefSettings = () => get<BriefSettings>('/observation/briefs/settings');
/** Takes any subset of the settings keys and answers with all of them. */
export const saveBriefSettings = (body: Partial<BriefSettings>) => post<BriefSettings>('/observation/briefs/settings', body);

export const readBlacklist = () => get<WireBlacklist>('/blacklist');
export const addBlacklist = (field: BlacklistField, value: string, delete_existing: boolean) =>
  post<{ added: boolean; deleted: Record<string, number> }>('/blacklist', { field, value, delete_existing });
export const removeBlacklist = (field: BlacklistField, value: string) => del<{ removed: boolean }>('/blacklist', { field, value });
export const restoreBlacklist = () => post<{ added: number }>('/blacklist/defaults', {});
export const setBlacklistMode = (mode: WireBlacklist['mode']) => post<{ mode: WireBlacklist['mode'] }>('/blacklist/mode', { mode });
export const addAllow = (field: AllowField, value: string) => post<{ added: boolean }>('/blacklist', { list: 'allow', field, value });
export const removeAllow = (field: AllowField, value: string) => del<{ removed: boolean }>('/blacklist', { list: 'allow', field, value });

export type Range = '15m' | '1h' | 'today';
export const forgetRecent = (range: Range) => del<Record<string, number>>(`/observation?range=${range}`);
export const clearAttention = () => del<{ deleted: number; trace_deleted: number }>('/attention');

export const disconnectHooks = (target: 'claude' | 'codex') => post<{ target: string; removed: number }>('/integrations/hooks/disconnect', { target });

export const readScopes = () => get<{ scopes: WireScope[] }>('/agent/scopes');
/** The bridge swaps each picked handle for its path; a path string is refused (protocol/ui-bridge/CONTRACT.md step 7). */
export const createScope = (root: PickedHandle, output: PickedHandle) => post<WireScope>('/agent/scopes', { roots: [root], output_root: output });
export const revokeScope = (id: string) => post<{ revoked: boolean }>(`/agent/scopes/${seg(id)}/revoke`, {});

const REASON: Record<string, string> = {
  invalid_runtime_settings: '设置不合规',
  provider_not_supported_by_harness: '这个内核不支持该服务提供方',
  handle_required: '可执行文件要用「选择…」重新选一次',
  invalid_base_url: 'API 地址要以 https:// 开头（本机可用 http）',
  invalid_output_budget: '回复长度要在 128–32768 之间',
  invalid_pattern: '标题规则不是有效的正则',
  invalid_payload: '内容不合规',
  credentials_rejected: '凭据被拒绝',
  model_access_denied: '没有这个模型的权限',
  usage_limit: '用量已到上限',
  provider_unreachable: '连不上模型服务',
  provider_request_failed: '模型服务出错',
  sign_in_pending: '已有一次登录在进行',
  hook_file_unavailable: '后台还没找到这个工具的配置文件',
  hook_settings_unreadable_or_changed: '配置正在被别的程序修改',
  invalid_scope: '文件夹不可用',
  scope_expired: '这个范围已过期',
  no_attention: '后台的观察模块没有运行',
  acp_install_unsupported: '这个 agent 没有可安装的包',
  acp_installer_missing: '本机没有 npm 或 uv',
};

/** One short Chinese reason for a failed call: offline, a conflict, or the backend's reason. */
export function failure(e: unknown): { text: string; conflict: boolean } {
  if (!(e instanceof AgentdCallError)) return { text: '原生设置服务没有响应', conflict: false };
  if (e.code === 'offline') return { text: '后台已断开', conflict: false };
  const fault = serverFaultText(e);
  if (fault) return { text: fault, conflict: false };
  if (e.code === 'switching') return { text: codeText(e.code)!, conflict: false };
  if (e.status === 409 || CONFLICT_CODES.has(e.code)) return { text: '已在别处更新', conflict: true };
  return { text: REASON[e.code] ?? codeText(e.code) ?? RUNTIME_ERROR[e.code]?.label ?? '后台没有接受这次修改',
    conflict: false };
}
