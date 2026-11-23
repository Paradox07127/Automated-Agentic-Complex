// Settings page reads and writes in agentd's shapes, plus the demo stand-in for the native settings schema.
// `?demo=…` reaches these handlers only from the fake bridge.
import { PLUGINS } from '../bridge/plugins.generated';
import type { SettingValue } from '../bridge/protocol';
import { isoWithOffset } from '../domain/units';
import type { WireProductLogin, WireSummaryRun } from '../domain/wire';
import type { Native, SchemaRow } from '../pages/settings/native';
import { labelOf } from '../pages/settings/registry';
import { pluginKey } from '../shell/plugins';
import type { AllowField, BlacklistField, WireBlacklist, WireChatgpt, WireModelSettings, WireModelTest, WireScope } from '../pages/settings/wire';
import { at, atS, NOW } from './fixtures';
import { ACP_AGENTS, ACP_INSTALL } from './fixtures/acpAgents';
import { CATALOG, CHATGPT, MODELS } from './fixtures/modelSettings';
import { CAPABILITIES, runtime } from './runtime';
import type { MockResponse, MockRoute } from './types';

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const bad = (error: string): MockResponse => ({ status: 400, body: { error } });
const obj = (body: unknown): Record<string, unknown> => (body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {});

// ---- native settings (rows of the registry and the character page) ----
type Slide = Required<Pick<SchemaRow, 'min' | 'max' | 'step' | 'format'>>;
type Row = [id: string, group: string, label: string, def: SettingValue, restart: SchemaRow['restart'], options?: Array<[string, string]> | Slide];
const DEG = (max: number): Slide => ({ min: -max, max, step: 0.5, format: 'degrees' });
const NOTIFY: Array<[string, string]> = [['sound', '出声'], ['card', '只出卡'], ['silent', '不提示']];

const ROWS: Row[] = [
  // 轻量 AI has a row but no registry entry: the 插件 group shows no switch for it.
  ...PLUGINS.map((p): Row => [pluginKey(p.id), 'plugins', p.id === 'light_ai' ? '轻量 AI' : labelOf(pluginKey(p.id)), p.default, 'backend']),
  ['mute', 'speak', '只出字、不出声', false, 'backend'],
  ['asr', 'speak', '识别语言', 'auto', 'none', [['auto', '跟随系统'], ['zh-CN', '中文'], ['en-US', 'English']]],
  ['proactive', 'speak', '交互档位', 'balanced', 'backend', [['quiet', '安静'], ['balanced', '均衡'], ['active', '主动']]],
  ['speakUp', 'speak', '主动说话', true, 'backend'],
  ['rest', 'speak', '连续使用提醒', '0', 'backend', [['0', '关'], ['45', '45 分钟'], ['60', '60 分钟'], ['90', '90 分钟']]],
  ['water', 'speak', '喝水提醒', '90', 'backend', [['0', '关'], ['60', '60 分钟'], ['90', '90 分钟'], ['120', '120 分钟']]],
  ['n_done', 'speak', '完成', 'card', 'none', NOTIFY],
  ['n_appr', 'speak', '待批准', 'sound', 'none', NOTIFY],
  ['n_err', 'speak', '出错', 'sound', 'none', NOTIFY],
  ['n_brief', 'speak', '简短播报', 'card', 'none', NOTIFY],
  ['n_remind', 'speak', '提醒', 'sound', 'none', NOTIFY],
  ['sysnotify', 'speak', '改走 macOS 系统通知', true, 'none'],
  ['capHide', 'speak', '录屏时隐藏角色', true, 'none'],
  ['switchTitle', 'speak', '切换角色时的雷霆大字', true, 'none'],
  ['avatar_click', '@character', '点击角色', 'interact', 'none', [['interact', '角色互动'], ['quick_input', '打开快速输入']]],
  ['hk_ptt', 'keys', '按住说话', '右⌥', 'none'],
  ['hk_quick', 'keys', '快速输入', '⌃Space', 'none'],
  ['hk_look', 'keys', '屏幕识读', '⌃⌥L', 'none'],
  ['hk_hide', 'keys', '显示 / 隐藏角色', '⌃⌥H', 'none'],
  ['hk_pass', 'keys', '临时全部点穿', '⌃⌥P', 'none'],
  ['hk_wheel', 'keys', '角色快捷轮盘', '⌃⌥R', 'none'],
  ['hk_sel', 'keys', '读取选中文字', '⌃⌥S', 'none'],
  ['wintext', 'privacy', '读取窗口文字', false, 'backend'],
  ['grain', 'privacy', '屏幕理解粒度', 'focused', 'backend', [['status', '仅读状态'], ['focused', '焦点语义'], ['window', '窗口摘要']]],
  ['web', 'privacy', '读取网页正文', false, 'backend'],
  ['typing', 'privacy', '读取输入的文字', false, 'backend'],
  ['actions', 'privacy', '记录操作时间线', false, 'none'],
  ['agent_sessions', 'privacy', '读取编码会话', true, 'backend'],
  ['shot', 'privacy', '屏幕识读时附上截图', false, 'backend'],
  ['keys', 'privacy', '键鼠计数', true, 'backend'],
  ['mask', 'privacy', '发出前遮蔽敏感内容', true, 'backend'],
  ['login', 'about', '登录时启动', true, 'none'],
  ['beh.stay', '@character', '待在原地 / 自由活动', 'roam', 'none', [['stay', '待在原地'], ['roam', '自由活动'], ['bust', '半身固定']]],
  ['beh.range', '@character', '活动范围', 'default', 'avatar', [['default', '默认'], ['window', '小窗口'], ['fullscreen', '整块屏']]],
  ['rnd.fps', '@character', '帧率上限（空闲自动节能在此之下）', '60', 'none', [['60', '60 fps'], ['45', '45 fps'], ['30', '30 fps']]],
  ['beh.sit', '@character', '坐在窗口顶上', true, 'none'], ['beh.lean', '@character', '扶着窗沿', true, 'none'], ['beh.mouse', '@character', '看向鼠标', true, 'none'],
  ['beh.touch', '@character', '点不同部位有不同反应', true, 'none'], ['beh.pat', '@character', '摸头', true, 'none'],
  ['beh.pinch', '@character', '捏脸（按住脸颊拖动）', false, 'none'], ['beh.greet', '@character', '锁屏或睡眠回来时迎接', true, 'none'],
  ['beh.inertia', '@character', '拖动惯性', true, 'none'], ['beh.physics', '@character', '头发衣物物理', true, 'avatar'],
  ['beh.mood', '@character', '状态影响行为', true, 'none'], ['beh.face', '@character', '说话时有表情', true, 'avatar'],
  ['beh.watch', '@character', '陪看朝向', 'auto', 'none', [['auto', '由角色决定'], ['front', '面向用户'], ['side', '轻微侧身 · 30°'], ['back', '完全转身 · 180°']]],
  ['beh.rail', '@character', '头顶任务与角色状态', true, 'none'], ['beh.hint', '@character', '悬浮快捷键提示', true, 'none'],
  ['rnd.cam', '@character', '原作镜头预设', 'show', 'none', [['show', '角色展示'], ['overview', '总览'], ['document', '档案']]],
  ['rnd.yaw', '@character', '水平朝向', 0, 'none', DEG(180)], ['rnd.pitch', '@character', '俯仰朝向', 0, 'none', DEG(20)], ['rnd.aa', '@character', '2× SSAA', true, 'avatar'],
  ['rnd.size', '@character', '渲染尺寸', 'authored', 'avatar', [['authored', '原始尺寸'], ['display', '跟随显示像素（试验）']]],
  ['rnd.shadow', '@character', '自阴影精度', '1024', 'avatar', [['1024', '高 · 1024'], ['512', '中 · 512'], ['256', '低 · 256']]],
  ['rnd.idle', '@character', '空闲时降到 30 fps', true, 'none'], ['rnd.batt', '@character', '电池供电时降帧', true, 'none'],
  ['rnd.outline', '@character', '角色边界', 'original', 'none', [['original', '原作'], ['subtle', '柔和外轮廓'], ['contrast', '增强外轮廓']]],
  ['rnd.lightYaw', '@character', '主光水平微调', '0', 'none', [['-15', '左偏 15°'], ['0', '原作'], ['15', '右偏 15°']]], ['rnd.lightPitch', '@character', '主光俯仰微调', '0', 'none', [['-10', '降低 10°'], ['0', '原作'], ['10', '抬高 10°']]],
  ['rnd.lightStrength', '@character', '主光强度', '1', 'none', [['0.5', '50 %'], ['0.75', '75 %'], ['1', '原作 · 100 %'], ['1.25', '125 %'], ['1.5', '150 %']]],
  ['rnd.ground', '@character', '脚下阴影', 'contact', 'none', [['off', '关'], ['contact', '接触阴影']]], ['rnd.wrap', '@character', '边缘环境光', false, 'none'],
  ['rnd.filter', '@character', '滤镜', 'none', 'none', [['none','无'],['sp_filter_1','黑金'],['sp_filter_2','温暖'],['sp_filter_3','苍白'],['sp_filter_4','胶片'],['sp_filter_5','希望色彩'],['sp_filter_6','血忆'],['sp_filter_7','武陵印象'],['filter_1','明亮'],['filter_2','冷调'],['filter_3','清新'],['filter_4','暗色'],['filter_5','黑白'],['filter_6','春'],['filter_7','文艺'],['filter_8','蓝橙']]],
  ['rnd.dof', '@character', '景深', 'off', 'none', [['off', '关'], ['closeup', '近景时']]], ['rnd.ambient', '@character', '环境取色', 'off', 'none', [['off', '关'], ['wallpaper', '壁纸颜色'], ['screen', '屏幕取色']]],
  ['scn.mode', '@character', '场景', 'off', 'avatar', [['off', '关'], ['box', '舞台盒'], ['stage', '展示台']]], ['scn.parallax', '@character', '背景视差', true, 'avatar'],
  ['rnd.zoom', '@character', '镜头缩放', 1, 'none', { min: 1, max: 4, step: 0.05, format: 'percent' }], ['rnd.sway', '@character', '呼吸晃动', false, 'none'],
  ['rnd.closeup', '@character', '对话近景', 'off', 'none', [['off', '关'], ['session', '会话面板打开时']]], ['rnd.track', '@character', '动作相机轨', 'stage', 'none', [['off', '不播'], ['stage', '舞台框里播']]],
];

const DESTRUCTIVE = new Set(['wintext', 'web', 'typing', 'agent_sessions']);

export const DEMO_SCHEMA: SchemaRow[] = ROWS.map(([id, group, label, def, restart, options]) => ({
  id,
  group,
  label,
  kind: Array.isArray(options) ? 'select' : options ? 'slider' : typeof def === 'boolean' ? 'toggle' : 'hotkey',
  ...(Array.isArray(options) ? { options: options.map(([value, l]) => ({ value, label: l })) } : options),
  ...(DESTRUCTIVE.has(id) ? { destructive: true } : {}),
  default: def,
  restart,
}));

/** What the demo user changed from the defaults: reads text from windows and pages, attaches screenshots. */
const DEMO_SAVED: Record<string, SettingValue> = { wintext: true, web: true, shot: true, rest: '45' };

/** The native settings a shell would serve; `configerr` fails like an unreadable config.json. */
export async function demoNative(demo: string | null): Promise<Native> {
  if (demo === 'configerr') throw { code: 'config_unreadable', detail: 'config.json' };
  const saved = { ...Object.fromEntries(DEMO_SCHEMA.map((r) => [r.id, r.default])), ...DEMO_SAVED, ...(demo === 'pending' ? { web: false } : {}) };
  return { rows: Object.fromEntries(DEMO_SCHEMA.map((r) => [r.id, r])), saved, statuses: {} };
}

/** `plugins=all` or `plugins=daily_brief,personal_agent` in the page URL: those plug-ins read as on. */
export function demoPlugins(q: string | null): Record<string, boolean> {
  if (!q) return {};
  const on = q === 'all' ? PLUGINS.map((p) => p.id as string) : q.split(',');
  return Object.fromEntries(PLUGINS.filter((p) => on.includes(p.id)).map((p) => [pluginKey(p.id), true]));
}

// ---- agentd ----

/** `GET /model/settings`; `demo=chatgpt` uses the subscription with the saved accounts. */
function models(demo: string | null): WireModelSettings {
  return demo === 'chatgpt' ? { ...MODELS, provider: 'chatgpt', chatgpt: CHATGPT } : MODELS;
}

/** `POST /model/test` (api/settings.py _model_test): Pi calls its main connection and reports usage; another kernel runs a review task without it. */
function modelTest(kernel: string): WireModelTest {
  const pi = kernel === 'pi';
  return {
    ok: true,
    kernel,
    provider: pi ? MODELS.provider : null,
    model: MODELS.backends[MODELS.provider].model,
    elapsed_ms: 812,
    tokens: pi ? { input_tokens: 1180, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : null,
    cost_usd: pi ? 0.0012 : null,
  };
}

/** model_auth.py: an unknown id is refused, a known one acts on that account only. */
function account(body: unknown, act: (p: WireChatgpt['profiles'][number]) => void, answer: unknown = CHATGPT): MockResponse {
  const id = obj(body).profile_id;
  const p = CHATGPT.profiles.find((x) => x.id === id);
  if (!p) return bad('unknown_profile');
  act(p);
  return ok(answer);
}

const BLACKLIST: WireBlacklist = {
  version: 1,
  bundle_ids: ['com.1password.1password', 'com.apple.keychainaccess', 'com.tencent.xinWeChat'],
  app_names: ['明日方舟：终末地'],
  domains: ['icbc.com.cn', 'alipay.com', 'mail.qq.com'],
  title_patterns: [],
  incognito: true,
  mode: 'deny',
  allow: { bundle_ids: ['com.microsoft.VSCode'], app_names: ['Terminal'], domains: ['github.com'] },
};
const FIELDS: BlacklistField[] = ['bundle_ids', 'app_names', 'domains', 'title_patterns'];
const ALLOW_FIELDS: AllowField[] = ['bundle_ids', 'app_names', 'domains'];
const MODES: Array<WireBlacklist['mode']> = ['allow', 'deny'];

const SCOPES: WireScope[] = [
  {
    scope_id: '5c0be1f2a3d4e5f60718293a4b5c6d7e',
    revision: 1,
    roots: [{ path: '/Users/lin/Documents/周报' }],
    output: { path: '/Users/lin/Documents/Endfield 产物' },
    created_at: atS(9, 10),
    expires_at: atS(9, 10) + 86_400,
    revoked: false,
  },
];

// ---- today's events for the outbound and gate charts ----
// The diag mock answers `/summary/runs` and `/trace/decisions` first, so the preview reads these through demoInit.

/** Vision runs per hour, the first at 10:00 one the user asked for; 37 in all, the `/diag/state` screenshots.used. */
const SHOT_HR: Record<number, number> = { 9: 4, 10: 6, 11: 5, 12: 3, 13: 2, 14: 17 };
const SHOT_HR_SPARSE: Record<number, number> = { 14: 2 };
/** Released screenshots (budget.released), drawn as ✕. */
const SHOT_RELEASED: Array<[number, number]> = [[11, 40], [13, 52], [14, 26]];

const shotRun = (id: string, t: number, outcome: string, kind = 'observation_vision'): WireSummaryRun => ({
  run_id: id,
  kind,
  started_at: isoWithOffset(t),
  span_start: null,
  span_end: null,
  outcome,
  error: outcome === 'released' ? 'released' : null,
  attempt: 1,
  duration_ms: 1800,
  backend: 'anthropic',
  model: 'claude-haiku-5-5',
  episode_id: null,
  reasons: [],
});

/** `/summary/runs?kinds=observation_vision,user_vision` for today; the current hour stops at NOW. */
export function demoShotRuns(demo: string | null): WireSummaryRun[] {
  const hours = demo === 'sparse' ? SHOT_HR_SPARSE : SHOT_HR;
  const nowH = new Date(NOW).getHours();
  const nowM = new Date(NOW).getMinutes();
  const runs = Object.entries(hours).flatMap(([h, n]) =>
    Array.from({ length: n }, (_, i) =>
      shotRun(`ov-${h}-${i}`, at(+h, Math.floor((i * (+h === nowH ? nowM : 60)) / n)), 'committed', +h === 10 && i === 0 ? 'user_vision' : undefined),
    ),
  );
  const released = demo === 'sparse' ? [] : SHOT_RELEASED.map(([h, m], i) => shotRun(`ov-r${i}`, at(h, m), 'released'));
  return [...runs, ...released].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

const SIGNED_OUT: WireProductLogin = { pending: null, error: null, accounts: {} };

export const routes: MockRoute[] = [
  { method: 'GET', path: '/character/runtime', handler: ({ query }) => ok(runtime(query.get('demo'))) },
  { method: 'GET', path: '/character/capabilities', handler: () => ok(CAPABILITIES) },
  { method: 'GET', path: '/character/acp/agents', handler: () => ok(ACP_AGENTS) },
  {
    method: 'POST',
    path: '/character/acp/install',
    handler: ({ body }) => {
      const id = obj(body).agent_id;
      return ACP_AGENTS.agents.some((a) => a.id === id && a.source !== 'local') ? ok({ ...ACP_INSTALL, agent_id: id }) : bad('acp_install_unsupported');
    },
  },
  { method: 'POST', path: '/character/login/start', handler: () => ok({ ...SIGNED_OUT, pending: { backend: 'codex', acp_agent: null } }) },
  { method: 'POST', path: '/character/login/cancel', handler: () => ok(SIGNED_OUT) },
  { method: 'POST', path: '/character/login/logout', handler: () => ok(SIGNED_OUT) },
  { method: 'GET', path: '/model/settings', handler: ({ query }) => ok(models(query.get('demo'))) },
  {
    method: 'POST',
    path: '/model/settings',
    handler: ({ body }) => {
      const b = obj(body);
      if (typeof b.provider !== 'string' || !(b.provider in MODELS.backends)) return bad('invalid_provider');
      return ok({ ...MODELS, provider: b.provider });
    },
  },
  { method: 'POST', path: '/model/test', handler: ({ query }) => ok(modelTest(runtime(query.get('demo')).backend)) },
  { method: 'POST', path: '/model/catalog', handler: () => ok(CATALOG) },
  {
    method: 'POST',
    path: '/model/chatgpt/start',
    handler: ({ body }) => {
      const id = obj(body).profile_id;
      if (id != null && !CHATGPT.profiles.some((p) => p.id === id)) return bad('unknown_profile');
      return ok({ ...MODELS.chatgpt, pending: true });
    },
  },
  { method: 'POST', path: '/model/chatgpt/cancel', handler: () => ok(MODELS.chatgpt) },
  { method: 'POST', path: '/model/chatgpt/select', handler: ({ body }) => account(body, (p) => void (CHATGPT.active = p.id)) },
  { method: 'POST', path: '/model/chatgpt/logout', handler: ({ body }) => account(body, (p) => Object.assign(p, { connected: false, sharing: false }), { revoked: true }) },
  { method: 'GET', path: '/blacklist', handler: () => ok(BLACKLIST) },
  {
    method: 'POST',
    path: '/blacklist',
    handler: ({ body }) => {
      const b = obj(body);
      if (b.list === 'allow') {
        if (!ALLOW_FIELDS.includes(b.field as AllowField) || typeof b.value !== 'string') return bad('invalid_payload');
        const list = BLACKLIST.allow[b.field as AllowField];
        if (!list.includes(b.value)) list.push(b.value);
        return ok({ added: true, deleted: { events: 0, context: 0, observations: 0 } });
      }
      if (!FIELDS.includes(b.field as BlacklistField) || typeof b.value !== 'string' || typeof b.delete_existing !== 'boolean') return bad('invalid_payload');
      const list = BLACKLIST[b.field as BlacklistField];
      if (!list.includes(b.value)) list.push(b.value);
      const n = b.delete_existing ? 3 : 0;
      return ok({ added: true, deleted: { events: n, context: 0, observations: n ? 1 : 0 } });
    },
  },
  {
    method: 'DELETE',
    path: '/blacklist',
    handler: ({ body }) => {
      const b = obj(body);
      const allow = b.list === 'allow';
      if (!(allow ? ALLOW_FIELDS : FIELDS).includes(b.field as AllowField) || typeof b.value !== 'string') return bad('invalid_payload');
      const list = allow ? BLACKLIST.allow[b.field as AllowField] : BLACKLIST[b.field as BlacklistField];
      const i = list.indexOf(b.value);
      if (i >= 0) list.splice(i, 1);
      return ok({ removed: i >= 0 });
    },
  },
  { method: 'POST', path: '/blacklist/defaults', handler: () => ok({ added: 2 }) },
  {
    method: 'POST',
    path: '/blacklist/mode',
    handler: ({ body }) => {
      const m = obj(body).mode;
      if (!MODES.includes(m as WireBlacklist['mode'])) return bad('invalid_payload');
      BLACKLIST.mode = m as WireBlacklist['mode'];
      return ok({ mode: BLACKLIST.mode });
    },
  },
  {
    method: 'DELETE',
    path: '/observation',
    handler: ({ query }) => {
      const range = query.get('range');
      if (range !== '15m' && range !== '1h' && range !== 'today') return bad('invalid_range');
      const n = { '15m': 4, '1h': 17, today: 63 }[range];
      return ok({ events: n, context: Math.round(n / 2), observations: range === '15m' ? 0 : 2, facts: range === 'today' ? 1 : 0, episodes: 0 });
    },
  },
  { method: 'DELETE', path: '/attention', handler: () => ok({ deleted: 1180, trace_deleted: 96 }) },
  {
    method: 'POST',
    path: '/integrations/hooks/disconnect',
    handler: ({ body }) => {
      const b = obj(body);
      if (Object.keys(b).length !== 1 || (b.target !== 'claude' && b.target !== 'codex')) return bad('invalid_target');
      return ok({ target: b.target, removed: 3 });
    },
  },
  { method: 'GET', path: '/agent/scopes', handler: () => ok({ scopes: SCOPES }) },
  {
    method: 'POST',
    path: '/agent/scopes',
    handler: ({ body }) => {
      const b = obj(body);
      // workspace.py create_scope: roots or files, the output folder optional.
      if (Object.keys(b).some((k) => !['roots', 'output_root', 'files'].includes(k)) || !(b.roots ?? b.files)) return bad('invalid_scope');
      return { status: 201, body: { files: [], ...SCOPES[0], unsupported: [], scope_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', created_at: NOW / 1000, expires_at: NOW / 1000 + 86_400 } };
    },
  },
  { method: 'POST', path: '/agent/scopes/:id/revoke', handler: () => ok({ revoked: true }) },
];
