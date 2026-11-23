// Diag view model: supervisor state, /diag/state blocks and /capabilities → process rows, link health and issues.
import type { AgentdConnection, ProcessState, ServiceId, SupervisorTarget } from '../../bridge/protocol';
import type { Health, VisualStateKey, WireRuntimePublic } from '../../domain';
import { composeHealth } from '../../domain/adapt';
import type { NavTarget } from '../overview/nav';
import type { WireDiagState } from '../../domain/wire';
import type { WireCapabilities } from './wire';

/** supervisor.state reports a service only under `ssh` or `local`; supervisor.restart takes none. */
export type ProcessKey = 'agentd' | 'avatar' | 'voice' | ServiceId;
/** The processes supervisor.state reports. */
export type ProcKey = SupervisorTarget | ServiceId;
type Supervised = Partial<Record<ProcKey, ProcessState>>;

/** The services' rows: name and what the shell's process is for. */
export const SERVICE_ROWS: readonly [ServiceId, string, string][] = [
  ['tts', '语音服务', '连语音'],
  ['motion', '动作服务', '连动作生成'],
  ['llm', '模型服务', '连兼容模型'],
];

/** One supervised child. */
export interface Child {
  kind: 'running' | 'starting' | 'stopped' | 'backoff' | 'portInUse' | 'gpuHold' | 'external' | 'failed' | 'unknown';
  /** Backoff seconds, for `backoff`. */
  backoff_s?: number;
  /** Failure text, for `failed`. */
  reason?: string;
}

export function parseChild(state: string | undefined): Child {
  if (state == null) return { kind: 'unknown' };
  const backoff = /^backoff\((\d+)\)$/.exec(state);
  if (backoff) return { kind: 'backoff', backoff_s: Number(backoff[1]) };
  const failed = /^failed\((.*)\)$/.exec(state);
  if (failed) return { kind: 'failed', reason: failed[1] ?? '' };
  return ['running', 'starting', 'stopped', 'portInUse', 'gpuHold', 'external'].includes(state) ? { kind: state as Child['kind'] } : { kind: 'unknown' };
}

const CHILD_TEXT: Record<Child['kind'], [VisualStateKey, string]> = {
  running: ['running', '运行中'],
  starting: ['waiting', '启动中'],
  stopped: ['stopped', '已停止'],
  backoff: ['warning', '重启中'],
  portInUse: ['failed', '端口被占用'],
  gpuHold: ['warning', 'GPU 暂停中'],
  external: ['running', '外部进程'],
  failed: ['failed', '启动失败'],
  unknown: ['idle', '未知'],
};

export interface DiagProcess {
  key: ProcKey;
  name: string;
  sub: string;
  tone: VisualStateKey;
  status_text: string;
  healthy: boolean;
  pid: number | null;
  /** Share of one core in percent, from supervisor.state; null when not read. */
  cpu_percent: number | null;
  memory_mb: number | null;
  backoff_s?: number;
  /** supervisor.restart accepts it. */
  restartable: boolean;
}

/** tts last result codes (server.py `_tts_last`), shown when the voice is not ready. */
const TTS_RESULT: Readonly<Record<string, string>> = {
  connection_lost: '连接断开',
  unreachable: '连不上',
  tts_unavailable: '服务不可用',
  timeout: '超时',
  bad_stream: '音频流坏了',
  empty_stream: '没回音频',
};
/** speech.py also reports `http_<status>` when the TTS answers with an error. */
export const ttsText = (code: string): string => TTS_RESULT[code] ?? (/^http_\d+$/.test(code) ? `服务返回错误 ${code.slice(5)}` : '其他原因');

/** 后台服务, 角色 and the `ssh` and `local` services from supervisor.state; agentd also from the bridge connection. */
export function processesOf(sup: Supervised | null, connection: AgentdConnection | null): DiagProcess[] {
  const row = (key: ProcKey, name: string, sub: string): DiagProcess => {
    const c = parseChild(sup?.[key]?.state);
    let [tone, text] = CHILD_TEXT[c.kind];
    if (c.kind === 'failed' && c.reason) text = `${text}：${c.reason}`;
    if (key === 'agentd' && connection != null && connection !== 'connected' && c.kind === 'running') [tone, text] = ['failed', connection === 'unauthorized' ? '拒绝连接' : '没有响应'];
    return {
      key,
      name,
      sub,
      tone,
      status_text: text,
      healthy: tone === 'running',
      pid: sup?.[key]?.pid ?? null,
      cpu_percent: sup?.[key]?.cpuPercent ?? null,
      memory_mb: sup?.[key]?.memoryMB ?? null,
      ...(c.kind === 'backoff' && sup?.[key]?.backoff != null ? { backoff_s: sup[key].backoff } : {}),
      restartable: key === 'agentd' || key === 'avatar',
    };
  };
  const services = SERVICE_ROWS.filter(([k]) => sup?.[k]).map(([k, name, sub]) => row(k, name, sub));
  return [row('agentd', '后台服务', 'agentd'), row('avatar', '角色', '渲染宿主'), ...services];
}

/** Attention and too-high lines per process: CPU as a share of one core in percent, memory in MB. */
export const LIMITS: Readonly<Record<ProcKey, { cpu: [number, number]; mem: [number, number] }>> = {
  agentd: { cpu: [50, 100], mem: [600, 1024] },
  avatar: { cpu: [120, 250], mem: [1536, 3072] },
  tts: { cpu: [20, 50], mem: [64, 128] },
  motion: { cpu: [20, 50], mem: [64, 128] },
  llm: { cpu: [20, 50], mem: [64, 128] },
};

/** Past the attention line → warn, past the too-high line → bad. */
export const levelOf = (v: number | null, [warn, bad]: [number, number]): 'warn' | 'bad' | null => (v == null ? null : v >= bad ? 'bad' : v >= warn ? 'warn' : null);

/** The lamp of a process row: a running one is green, the rest keep their state. */
export const lampOf = (p: DiagProcess): VisualStateKey => (p.tone === 'running' ? 'ok' : p.tone);

/** Link health; the avatar node carries the supervisor's backoff seconds. */
export function healthOf(
  connection: AgentdConnection,
  runtime: WireRuntimePublic | null,
  sup: Partial<Record<SupervisorTarget, ProcessState>> | null,
  d: WireDiagState | null,
  fps: number | null,
): Health {
  const h = composeHealth(connection, runtime, sup, d, fps);
  const c = parseChild(sup?.avatar?.state);
  return c.kind === 'backoff' ? { ...h, avatar: { child: { backoff: sup?.avatar?.backoff ?? 0 }, fps: null } } : h;
}

export interface DiagIssue {
  id: string;
  title: string;
  detail: string;
  /** agentd's reason code, for the tooltip. */
  code?: string;
  to: NavTarget | null;
}

const CAP_LABEL: Readonly<Record<string, string>> = {
  generation: '对白模型',
  mouth: '对话',
  voice: '语音',
  personal_agent: '角色运行',
};
const CAP_ORDER = ['generation', 'mouth', 'voice'];

/** Capability reason codes from agentd (capabilities.py, trace_format.py). */
export const CAP_REASON: Readonly<Record<string, string>> = {
  missing_api_key: '没有 API key',
  sign_in_required: 'ChatGPT 没登录',
  plan_usage_not_enabled: '没授权订阅额度',
  secret_store_unavailable: '系统凭据存储无法访问',
  credential_permissions: '设置文件权限不是 600',
  settings_unreadable: '设置文件读不出来',
  no_tts: '没配置 TTS，台词只出文字',
  no_llm: '角色运行环境没准备好',
  tts_unavailable: 'TTS 服务不可用',
  unreachable: '连不上 TTS 服务',
  bad_stream: 'TTS 回的音频流坏了',
  empty_stream: 'TTS 没回音频',
  not_running: '没在运行',
  // personal_agent / generation: the runtime status error (character_agent/integration.py).
  runtime_missing: '内核没有安装',
  local_runtime_missing: '没找到本机的内核程序',
  bundled_runtime_missing: '应用自带的内核不完整',
  runtime_discovery_pending: '正在检测内核',
  runtime_probe_pending: '正在检查内核程序',
  local_node_missing: '没找到本机的 Node',
  runtime_version_not_verified: '内核兼容检查未通过',
  runtime_protocol_unavailable: '角色入口不可用',
  sdk_protocol_unavailable: '内核缺少必要接口',
  sdk_policy_capability_missing: '内核缺少必要的权限控制能力',
  sdk_effort_capability_missing: '内核缺少需要的推理设置能力',
  codex_model_catalog_unavailable: '读取不到内核的模型目录',
  native_login_required: '还没登录内核',
  pi_connection_missing: 'Pi 没有能用的模型连接',
  acp_agent_missing: '没选 ACP agent',
  acp_auth_required: 'ACP agent 还没登录',
  product_login_required: '还没在应用里登录内核',
  product_login_checking: '正在检查登录状态',
  pi_provider_model_required: '没填服务提供方和模型',
  character_context_unavailable: '角色资料没准备好',
  unsupported_openai_endpoint: '这个接口地址不受支持',
  missing_provider_api_key: '没有 API key',
  local_no_auth_requires_compatible: '免密钥连接只用于本机兼容服务',
  unauthenticated_provider_requires_loopback: '免密钥连接只能连本机地址',
  native_login_requires_native_provider: '本机登录要配本机工具的服务',
  exited: '端侧模型进程退出了',
  timeout: '超时没有响应',
};

const CAP_FIX: Readonly<Record<string, NavTarget>> = {
  generation: { page: 'settings', group: 'kernel', item: 'kernel' },
  personal_agent: { page: 'settings', group: 'kernel', item: 'kernel' },
  mouth: { page: 'settings', group: 'kernel', item: 'kernel' },
  voice: { page: 'settings', group: 'speak', item: 'tts' },
};
/** Reasons fixed on another row than their capability's. */
const REASON_FIX: Readonly<Record<string, NavTarget>> = {
  native_login_required: { page: 'settings', group: 'kernel', item: 'kernelLogin' },
  product_login_required: { page: 'settings', group: 'kernel', item: 'kernelLogin' },
  llm_service_off: { page: 'settings', group: 'services', item: 'svc_llm' },
};

/** Degraded or unavailable /capabilities items; sharing the user turned off and a muted voice are not problems. */
export function issuesOf(caps: WireCapabilities | null): DiagIssue[] {
  if (!caps) return [];
  const rank = (k: string) => (CAP_ORDER.includes(k) ? CAP_ORDER.indexOf(k) : CAP_ORDER.length);
  return Object.entries(caps.items)
    .filter(([name, it]) => (it.state === 'degraded' || it.state === 'unavailable') && !(name.startsWith('share_') && it.reason === 'off') && !(name === 'voice' && it.reason === 'muted'))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, it]) => ({
      id: name,
      title: `${CAP_LABEL[name] ?? name}${it.state === 'unavailable' ? '不可用' : '受限'}`,
      detail: it.reason ? (CAP_REASON[it.reason] ?? '其他原因') : '后台没给原因',
      ...(it.reason ? { code: it.reason } : {}),
      to: (it.reason ? REASON_FIX[it.reason] : undefined) ?? CAP_FIX[name] ?? null,
    }));
}
