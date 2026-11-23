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
      { value: current === 'existing_login' ? 'existing_login' : 'api_key', label: 'AI 账号' },
      { value: 'local_no_auth', label: '本机无需密钥' },
    ];
  return [
    { value: 'existing_login', label: '复用本机工具登录' },
    ...(backend === 'claude' ? [] : [{ value: 'api_key', label: '使用 API 凭据' }]),
    { value: 'product_login', label: '在应用里登录' },
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
    return [{ value: '', label: 'AI 账号' }, svc('anthropic'), svc('openai'), ...profiles.map((p) => ({ value: p.id, label: p.title })), svc('compatible')];
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
  { value: 'keep', label: '不清理' },
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

const THINK_LABEL: Readonly<Record<ThinkingLevel, string>> = { off: '不思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

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
  const implied: Record<string, unknown> =
    patch.backend === 'acp' || patch.backend === 'claude' ? { runtime_source: 'local', auth_source: 'existing_login', provider: '' } : patch.backend ? { runtime_source: patch.backend === 'codex' ? 'local' : 'bundled' } : {};
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

const API_KEY = { row: 'apikey', action: '去填写 API Key' };
const API_BASE = { row: 'apiBase', action: '去改 API 地址' };
const ACCT = { row: 'acct', action: '去改账号来源' };
const LOGIN = { row: 'kernelLogin', action: '去登录' };
const PROVIDER = { row: 'provider', action: '去填写服务提供方和模型' };
const EXE = { row: 'exe', action: '去选可执行文件' };
const RUNSRC_FIX = { row: 'runsrc', action: '去改运行来源' };
const CONNECTION = { row: 'svc', action: '去 AI 账号' };
const ACP_AGENT = { row: 'acpAgent', action: '去选 ACP agent' };

/** Every code integration.py, settings.py and available_backends() send (character_agent). */
export const RUNTIME_ERROR: Readonly<Record<string, RuntimeError>> = {
  native_login_required: { label: '还没有登录这个内核' },
  missing_api_key: { label: '还没有保存这个服务的 API Key', fix: API_KEY },
  credentials_rejected: { label: '服务拒绝了当前凭据，请重新登录或填写 API Key' },
  usage_limit: { label: '当前服务的可用额度已用完或请求过于频繁' },
  subscription_sharing_usage_limit_exceeded: { label: '订阅共享额度已用完' },
  subscription_sharing_usage_unavailable: { label: '订阅共享额度暂不可用' },
  sign_in_required: { label: '请先登录 ChatGPT' },
  plan_usage_not_enabled: { label: 'ChatGPT 尚未授权订阅用量' },
  runtime_version_not_verified: { label: '内核兼容检查未通过' },
  runtime_protocol_unavailable: { label: '角色入口不可用，请到 设置 › 内核 点「重新检测」' },
  sdk_protocol_unavailable: { label: '内核缺少必要接口，请更新 CLI 后重新检测' },
  sdk_policy_capability_missing: { label: '内核缺少必要的工具权限控制能力' },
  sdk_effort_capability_missing: { label: '内核缺少本轮需要的推理设置能力' },
  codex_model_catalog_unavailable: { label: '读取不到内核的模型目录，请到 设置 › 内核 点「重新检测」' },
  provider_profile_requires_api_key: { label: '所选 AI 需要自己的 API Key', fix: API_KEY },
  local_runtime_missing: { label: '没找到本机的可执行文件', fix: EXE },
  bundled_runtime_missing: { label: '应用里没有带这个内核', fix: RUNSRC_FIX },
  runtime_missing: { label: '没有安装' },
  runtime_discovery_pending: { label: '正在检测本机的内核…' },
  runtime_probe_pending: { label: '正在检查所选的可执行文件…' },
  character_context_unavailable: { label: '角色对话还没有启动' },
  product_login_required: { label: '还没有在应用里登录这个内核，或登录已过期', fix: LOGIN },
  product_login_checking: { label: '正在检查登录状态…' },
  product_login_not_selected: { label: '账号来源不是「在应用里登录」', fix: ACCT },
  login_pending: { label: '已经有一个登录在进行，请先完成或取消它' },
  login_denied: { label: '登录没有完成：浏览器里取消了，或账号没有授权', fix: LOGIN },
  login_timeout: { label: '5 分钟内没有在浏览器里完成登录，请重新登录', fix: LOGIN },
  login_rejected: { label: '内核拒绝开始登录，请更新这个工具后再试' },
  login_failed: { label: '登录进程意外退出，请重新登录；仍不行就在终端里登录后改用「复用本机工具登录」', fix: LOGIN },
  browser_unavailable: { label: '打不开浏览器，请先设置系统默认浏览器' },
  deepseek_desktop_missing: { label: '没有找到 DeepSeek 客户端，请先从 deepseek.com 下载安装' },
  logout_failed: { label: '登出没有在 30 秒内完成，请重试' },
  logout_unsupported: { label: '这个 ACP agent 不支持在应用里登出，请用它自己的方式登出' },
  unknown_auth_method: { label: '这个 ACP agent 没有列出这种登录方式，请点「重新检测」后再登录' },
  local_node_missing: { label: '没找到本机的 Node 可执行文件', fix: EXE },
  pi_provider_model_required: { label: 'Pi 要写明服务提供方和模型', fix: PROVIDER },
  pi_connection_missing: { label: 'Pi 没有能用的连接：写明服务提供方，或在 AI 账号 里用 ChatGPT 订阅或 API Key', fix: CONNECTION },
  acp_agent_missing: { label: '没有选 ACP agent，或选的 agent 找不到了', fix: ACP_AGENT },
  acp_auth_required: { label: '这个 ACP agent 还没有登录', fix: LOGIN },
  missing_anthropic_api_key: { label: '还没有保存 Anthropic API Key', fix: API_KEY },
  missing_provider_api_key: { label: '还没有保存这个服务的 API Key', fix: API_KEY },
  unsupported_anthropic_endpoint: { label: 'API 凭据只能用 Anthropic 官方地址', fix: API_BASE },
  unsupported_openai_endpoint: { label: 'API 凭据只能用 OpenAI 官方地址', fix: API_BASE },
  secret_store_unavailable: { label: '系统凭据存储无法访问' },
  credential_permissions: { label: '本机的凭据文件读不了', fix: API_KEY },
  runtime_settings_unreadable: { label: '内核设置文件读不了' },
  local_no_auth_requires_compatible: { label: '「无需密钥」只能配兼容 API', fix: PROVIDER },
  unauthenticated_provider_requires_loopback: { label: '无需密钥时只能连本机地址', fix: API_BASE },
  native_login_requires_native_provider: { label: '兼容 API 不能复用本机工具登录', fix: ACCT },
  select_model: { label: '还没有选模型', fix: { row: 'chatModel', action: '去选模型' } },
  credentials_missing: { label: '这个连接还没有 API Key', fix: API_KEY },
  pi_model_unavailable: { label: 'Pi 找不到所选的模型' },
  pi_runtime_unavailable: { label: 'Pi 没能启动，请重新检测' },
  sdk_startup_timeout: { label: '内核启动超时，请重新检测' },
  pi_runner_error: { label: 'Pi 运行出错，请重新检测' },
  pi_node_version_mismatch: { label: 'Node 版本太旧，Pi 要 22.19 或更新', fix: RUNSRC_FIX },
};

/** An unknown code still reads as a sentence; the code itself goes into the tooltip. */
export const RUNTIME_ERROR_UNKNOWN: RuntimeError = { label: '后台报告这个内核还不能用' };
