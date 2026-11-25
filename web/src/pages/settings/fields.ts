// Page ids backed by agentd: which wire key each one is, the option sets of the old settings page, and the request bodies.
import type { PickedHandle, SettingValue } from '../../bridge';
import { runtimeSettings } from '../../domain/bodies';
import type { WireRoute, WireRoutePurpose, WireRuntimePublic, WireRuntimeSettings } from '../../domain/wire';
import type { ModelProvider, ThinkingLevel, WireBackendConfig, WireCatalogModel, WireModelSettings, WireModelTest } from './wire';

export type Vals = Record<string, SettingValue>;
export type Opt = { value: string; label: string; disabled?: boolean };
export type Target = 'runtime' | 'models';

/** settings.py ROUTES in table order, less `quick`: it runs on Pi only and has no row. */
export type TableRoute = Exclude<WireRoutePurpose, 'quick'>;
export const ROUTES: readonly TableRoute[] = ['chat', 'background', 'judge', 'understand', 'memory', 'computer'];

/** Draft ids of a route row: its kernel ('' follows the main kernel, `acp:<id>` a local ACP agent), model and effort. */
export const routeIds = (p: WireRoutePurpose) => ({ kernel: `route_${p}`, model: `route_${p}_model`, effort: `route_${p}_effort` });

/** PUT /character/runtime keys (settings.py DEFAULTS); every route cell writes `routes`. */
export const RUNTIME_FIELD: Readonly<Record<string, keyof WireRuntimeSettings>> = {
  kernel: 'backend',
  runsrc: 'runtime_source',
  exe: 'executable',
  acct: 'auth_source',
  provider: 'provider',
  mainModel: 'model',
  ...Object.fromEntries(ROUTES.flatMap((p) => Object.values(routeIds(p)).map((id) => [id, 'routes' as const]))),
  maxCost: 'max_budget_usd',
  scope: 'scope_id',
  k_ask: 'interactive_tools',
  archive: 'history_retention',
  acpAgent: 'acp_agent',
  acpLauncher: 'acp_launcher',
  workspace: 'workspace_dir',
  replyLang: 'reply_language',
  piApproval: 'pi_tool_approval',
};

/** POST /model/settings keys of the chosen provider's connection; `svc` is the provider, and its `model` is pi's default. */
const MODEL_FIELD: Readonly<Record<string, keyof WireBackendConfig>> = {
  apiBase: 'base_url',
  chatModel: 'model',
  think: 'reasoning_effort',
  ctxWindow: 'context_window',
  maxOut: 'max_output_tokens',
  images: 'supports_images',
  reasoning: 'reasoning',
  piProvider: 'pi_provider',
};
const MODEL_IDS = new Set(['svc', ...Object.keys(MODEL_FIELD)]);

export function targetOf(id: string): Target | null {
  if (id in RUNTIME_FIELD) return 'runtime';
  if (MODEL_IDS.has(id)) return 'models';
  return null;
}

export const KERNEL_LABEL: Readonly<Record<string, string>> = { codex: 'Codex', pi: 'Pi', acp: 'ACP', claude: 'Claude Code' };

export const RUNSRC: Opt[] = [
  { value: 'bundled', label: '随应用提供' },
  { value: 'local', label: '本机已安装' },
];

/** Pi reads only the credentials Agentic Complex holds, which its existing_login also means. Claude Code takes no API key. */
export function acctOptions(backend: string, current?: unknown): Opt[] {
  if (backend === 'deepseek-harness')
    return [
      { value: 'existing_login', label: 'DeepSeek 账号' },
      { value: 'api_key', label: '使用 API 凭据' },
    ];
  if (backend === 'pi')
    return [
      { value: current === 'existing_login' ? 'existing_login' : 'api_key', label: '模型服务账号' },
      { value: 'local_no_auth', label: '本地无需密钥' },
    ];
  return [
    { value: 'existing_login', label: '复用本机 CLI 登录' },
    ...(backend === 'claude' ? [] : [{ value: 'api_key', label: '使用 API 凭据' }]),
    { value: 'product_login', label: '在应用内登录' },
  ];
}

/** providers.py catalog() row of `/character/runtime` `provider_profiles`. */
export interface ProviderProfile {
  id: string;
  title: string;
  auth_source: string;
}

/** Codex and Claude Code take only their own provider or none; Pi takes its connection page's, a built-in one or a catalog profile. */
export function providerOptions(backend: string, profiles: readonly ProviderProfile[] = []): Opt[] {
  if (backend === 'pi') {
    const svc = (v: string) => ({ value: v, label: SVC.find((o) => o.value === v)?.label ?? v });
    return [{ value: '', label: '默认账号' }, svc('anthropic'), svc('openai'), ...profiles.map((p) => ({ value: p.id, label: p.title })), svc('compatible')];
  }
  const own = backend === 'claude' ? 'anthropic' : 'openai';
  return [
    { value: '', label: '沿用内核配置' },
    { value: own, label: own },
  ];
}

export const ARCHIVE: Opt[] = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'keep', label: '长期保留' },
];

export const REPLY_LANGUAGE: Opt[] = [
  { value: 'auto', label: '跟随对话' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'harness', label: '按内核设置' },
];

export const RUNTIME_EFFORT: Opt[] = [
  { value: '', label: '应用默认' },
  { value: 'inherit', label: '沿用内核配置' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export const SVC: Opt[] = [
  { value: 'anthropic', label: 'Anthropic API' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'xai', label: 'Grok / xAI' },
  { value: 'openai', label: 'OpenAI API' },
  { value: 'compatible', label: '兼容 API' },
  { value: 'pi_catalog', label: '其他（Pi 目录）' },
  { value: 'chatgpt', label: 'ChatGPT 订阅' },
];

/** model_backends.py LISTS_OWN_MODELS: the services whose list is their own /models; Pi's offline catalog lists the others. */
export const listsOwnModels = (svc: string) => svc === 'compatible' || svc === 'chatgpt';

/** The API key row of a compatible API on this machine: a key, or Pi's runtime auth_source local_no_auth. */
export const keyOptions = (acct: unknown): Opt[] => [
  { value: acct === 'existing_login' ? 'existing_login' : 'api_key', label: 'API Key' },
  { value: 'local_no_auth', label: '无需密钥' },
];

/** The hosts integration.py takes a keyless connection on. */
export function isLoopback(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Token counts as 128k or 1M. */
export const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

/** The 模型 row's line for a catalog model: context │ output │ images │ thinking │ priced. */
export function modelCaps(m: WireCatalogModel): string {
  if (m.context_window == null) return '';
  return [
    `上下文 ${tokens(m.context_window)}`,
    m.max_tokens != null && `最大输出 ${tokens(m.max_tokens)}`,
    m.input?.includes('image') && '图像输入',
    m.reasoning && '思考',
    m.priced ? '有目录价格' : '不计价',
  ]
    .filter(Boolean)
    .join(' │ ');
}

/** The 测试连接 result: kernel │ service │ model │ time │ tokens │ cost, the null ones left out. */
export function modelTestText(r: WireModelTest): string {
  const t = r.tokens;
  return [
    KERNEL_LABEL[r.kernel] ?? r.kernel,
    r.provider && (SVC.find((o) => o.value === r.provider)?.label ?? r.provider),
    r.model,
    `${r.elapsed_ms} ms`,
    t && `${t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens + t.output_tokens} tokens`,
    r.cost_usd != null && `$${r.cost_usd.toFixed(4)}`,
  ]
    .filter(Boolean)
    .join(' │ ');
}

const THINK_LABEL: Readonly<Record<ThinkingLevel, string>> = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

/** 思考强度: the model's own levels, after 模型默认 (the route's effort, else off). */
export const thinkOptions = (levels: readonly ThinkingLevel[]): Opt[] => [{ value: '', label: '模型默认' }, ...levels.map((l) => ({ value: l, label: THINK_LABEL[l] }))];

/** pi-ai getSupportedThinkingLevels of a thinking model without a level map, which a compatible API's model is. */
export const COMPATIBLE_THINKING: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

export function runtimeVals(w: WireRuntimePublic): Vals {
  const routes = Object.fromEntries(
    ROUTES.flatMap((p) => {
      const r = w.routes[p];
      const id = routeIds(p);
      const kernel = r.follows_main ? '' : r.backend === 'acp' ? `acp:${r.acp_agent ?? ''}` : r.backend;
      return [[id.kernel, kernel], [id.model, r.follows_main ? '' : (r.model ?? '')], [id.effort, r.follows_main ? '' : (r.effort ?? '')]];
    }),
  );
  return { ...Object.fromEntries(Object.entries(RUNTIME_FIELD).filter(([, key]) => key !== 'routes').map(([id, key]) => [id, w[key]])), ...routes } as Vals;
}

/** The saved `routes` of the route cells: a row on 跟随主内核 has no entry, and an empty model or effort is null. */
function routesBody(v: Vals): Partial<Record<WireRoutePurpose, WireRoute>> {
  const out: Partial<Record<WireRoutePurpose, WireRoute>> = {};
  for (const p of ROUTES) {
    const id = routeIds(p);
    const kernel = String(v[id.kernel] ?? '');
    if (!kernel) continue;
    const acp = kernel.startsWith('acp:');
    out[p] = {
      backend: (acp ? 'acp' : kernel) as WireRoute['backend'],
      acp_agent: acp ? kernel.slice(4) : null,
      model: String(v[id.model] ?? '') || null,
      effort: (String(v[id.effort] ?? '') || null) as WireRoute['effort'],
    };
  }
  return out;
}

/** The connection rows show the provider picked in `svc` (a draft may name another one than the saved). */
export function modelVals(w: WireModelSettings, provider: ModelProvider = w.provider): Vals {
  const cfg = w.backends[provider];
  return {
    svc: provider,
    apiBase: cfg?.base_url ?? '',
    chatModel: cfg?.model ?? '',
    think: cfg?.reasoning_effort ?? '',
    ctxWindow: cfg?.context_window ?? null,
    maxOut: cfg?.max_output_tokens ?? null,
    images: cfg?.supports_images ?? null,
    reasoning: cfg?.reasoning ?? null,
    piProvider: cfg?.pi_provider ?? '',
  };
}

/** Picked files and folders go into the body as the bridge's handle, which it swaps for the path. */
export type Handles = Partial<Record<string, PickedHandle>>;

export function runtimeBody(w: WireRuntimePublic, changes: Vals, handles: Handles = {}): Partial<WireRuntimeSettings> {
  const patch: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(changes)) {
    const key = RUNTIME_FIELD[id];
    if (key && key !== 'routes') patch[key] = handles[id] ?? v;
  }
  // `routes` is written whole: the changed cells over the saved rows.
  if (Object.keys(changes).some((id) => RUNTIME_FIELD[id] === 'routes')) patch.routes = routesBody({ ...runtimeVals(w), ...changes });
  // agentd refuses Codex, ACP and Claude Code with the bundled source, and an app has no local Pi; an ACP agent and Claude Code sign in by themselves.
  // Codex takes no provider but OpenAI and no 本机无需密钥, so Pi's others are dropped.
  const implied: Record<string, unknown> =
    patch.backend === 'acp' || patch.backend === 'claude'
      ? { runtime_source: 'local', auth_source: 'existing_login', provider: '' }
      : patch.backend === 'codex'
        ? { runtime_source: 'local', ...(w.provider === 'openai' ? {} : { provider: '' }), ...(w.auth_source === 'local_no_auth' ? { auth_source: 'existing_login' } : {}) }
        : patch.backend
          ? { runtime_source: 'bundled' }
          : {};
  for (const [key, v] of Object.entries(implied)) if (!(key in patch)) patch[key] = v;
  // Only DeepSeek Harness runs on another auth source than the agent's own login.
  if (patch.acp_agent != null && patch.acp_agent !== 'deepseek-harness') patch.auth_source = 'existing_login';
  return runtimeSettings(w, patch as Partial<WireRuntimeSettings>);
}

/** POST /model/settings: the provider always and the connection keys that changed. */
export function modelsBody(w: WireModelSettings, changes: Vals): Record<string, unknown> {
  const provider = String(changes.svc ?? w.provider);
  const body: Record<string, unknown> = { provider };
  for (const [id, key] of Object.entries(MODEL_FIELD)) if (id in changes) body[key] = changes[id];
  return body;
}

/** A readiness code `/character/runtime` reports in `error`: what it means, and the row that fixes it. */
export interface RuntimeError {
  label: string;
  fix?: { row: string; action: string };
}

const API_KEY = { row: 'apikey', action: '填写 API Key' };
const API_BASE = { row: 'apiBase', action: '修改 API 地址' };
const ACCT = { row: 'acct', action: '切换账号来源' };
const LOGIN = { row: 'kernelLogin', action: '前往登录' };
const PROVIDER = { row: 'provider', action: '填写服务提供方与模型' };
const EXE = { row: 'exe', action: '选择可执行文件' };
const RUNSRC_FIX = { row: 'runsrc', action: '切换运行来源' };
const CONNECTION = { row: 'svc', action: '选择模型提供方' };
const ACP_AGENT = { row: 'acpAgent', action: '选择 ACP 智能体' };

/** Every code integration.py, settings.py and available_backends() send (character_agent). */
export const RUNTIME_ERROR: Readonly<Record<string, RuntimeError>> = {
  native_login_required: { label: '尚未登录该执行内核' },
  missing_api_key: { label: '尚未保存该服务的 API Key', fix: API_KEY },
  credentials_rejected: { label: '服务端拒绝当前凭据，请重新登录或更新 API Key' },
  usage_limit: { label: '当前服务可用额度已耗尽或请求过于频繁' },
  subscription_sharing_usage_limit_exceeded: { label: '订阅共享额度已用尽' },
  subscription_sharing_usage_unavailable: { label: '订阅共享额度暂不可用' },
  sign_in_required: { label: '请先登录 ChatGPT' },
  plan_usage_not_enabled: { label: 'ChatGPT 尚未授权订阅用量' },
  runtime_version_not_verified: { label: '内核兼容性检查未通过' },
  runtime_protocol_unavailable: { label: '内核通信入口不可用，请前往 设置 › 内核 点击「重新检测」' },
  sdk_protocol_unavailable: { label: '内核缺少必要接口，请更新 CLI 后重新检测' },
  sdk_policy_capability_missing: { label: '内核缺少必要的工具权限控制能力' },
  sdk_effort_capability_missing: { label: '内核缺少本轮所需的推理强度设置能力' },
  codex_model_catalog_unavailable: { label: '无法读取内核模型目录，请前往 设置 › 内核 点击「重新检测」' },
  provider_profile_requires_api_key: { label: '所选模型服务需要配置 API Key', fix: API_KEY },
  local_runtime_missing: { label: '未找到本机可执行文件', fix: EXE },
  bundled_runtime_missing: { label: '应用未内置该执行内核', fix: RUNSRC_FIX },
  runtime_missing: { label: '未安装' },
  plugin_off: { label: '需重启后台服务后生效' },
  runtime_discovery_pending: { label: '正在检测本地执行内核…' },
  runtime_probe_pending: { label: '正在检查所选可执行文件…' },
  character_context_unavailable: { label: '角色对话上下文尚未就绪' },
  product_login_required: { label: '尚未在应用内登录该内核，或登录已过期', fix: LOGIN },
  product_login_checking: { label: '正在检查登录状态…' },
  product_login_not_selected: { label: '当前账号来源未设置为「在应用内登录」', fix: ACCT },
  login_pending: { label: '已有登录流程进行中，请先完成或取消' },
  login_denied: { label: '登录未完成：已在浏览器取消或未授权', fix: LOGIN },
  login_timeout: { label: '登录超时（5 分钟内未在浏览器完成），请重试', fix: LOGIN },
  login_rejected: { label: '执行内核拒绝发起登录，请更新该工具后重试' },
  login_failed: { label: '登录进程异常退出，请重试；若仍失败，可在终端登录后改用「复用本机 CLI 登录」', fix: LOGIN },
  browser_unavailable: { label: '无法打开系统浏览器，请先设置默认浏览器' },
  deepseek_desktop_missing: { label: '未检测到 DeepSeek 客户端，请先前往 deepseek.com 下载安装' },
  logout_failed: { label: '登出超时（30 秒内未完成），请重试' },
  logout_unsupported: { label: '该 ACP 智能体不支持在应用内登出，请使用其原生方式登出' },
  unknown_auth_method: { label: '该 ACP 智能体未提供此登录方式，请点击「重新检测」后重试' },
  local_node_missing: { label: '未找到本机 Node 可执行文件', fix: EXE },
  pi_provider_model_required: { label: 'Pi 需要同时指定服务提供方与模型', fix: PROVIDER },
  pi_connection_missing: { label: 'Pi 缺少可用连接：请填写服务提供方，或在 设置 › 内核 中配置 ChatGPT 订阅或 API Key', fix: CONNECTION },
  acp_agent_missing: { label: '未选择 ACP 智能体，或所选智能体已失效', fix: ACP_AGENT },
  acp_auth_required: { label: '该 ACP 智能体尚未登录', fix: LOGIN },
  missing_anthropic_api_key: { label: '尚未保存 Anthropic API Key', fix: API_KEY },
  missing_provider_api_key: { label: '尚未保存该服务的 API Key', fix: API_KEY },
  unsupported_anthropic_endpoint: { label: 'API 凭据仅支持 Anthropic 官方地址', fix: API_BASE },
  unsupported_openai_endpoint: { label: 'API 凭据仅支持 OpenAI 官方地址', fix: API_BASE },
  secret_store_unavailable: { label: '系统凭据存储无法访问' },
  credential_permissions: { label: '无法读取本地凭据文件', fix: API_KEY },
  runtime_settings_unreadable: { label: '无法读取执行内核配置文件' },
  local_no_auth_requires_compatible: { label: '「本地无需密钥」仅支持兼容 API', fix: PROVIDER },
  unauthenticated_provider_requires_loopback: { label: '无密钥连接仅支持本地回环地址', fix: API_BASE },
  native_login_requires_native_provider: { label: '兼容 API 不支持复用本机 CLI 登录', fix: ACCT },
  select_model: { label: '尚未选择模型', fix: { row: 'chatModel', action: '选择模型' } },
  credentials_missing: { label: '该连接尚未配置 API Key', fix: API_KEY },
  pi_model_unavailable: { label: 'Pi 未找到所选模型' },
  pi_runtime_unavailable: { label: 'Pi 启动失败，请重新检测' },
  sdk_startup_timeout: { label: '执行内核启动超时，请重新检测' },
  pi_runner_error: { label: 'Pi 运行异常，请重新检测' },
  pi_node_version_mismatch: { label: 'Node 版本过低，Pi 需要 22.19 或更高版本', fix: RUNSRC_FIX },
};

/** An unknown code still reads as a sentence; the code itself goes into the tooltip. */
export const RUNTIME_ERROR_UNKNOWN: RuntimeError = { label: '后台服务报告该执行内核暂不可用' };
