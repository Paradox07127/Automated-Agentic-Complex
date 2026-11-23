// `settings.*` over config.json: the rows the web pages edit, by web id, with the items behind them. Reading and writing the file is
// the caller's.
import type { ShellPlatform } from './config.ts';
import { PLUGINS, type PluginId } from './plugins.generated.ts';

/** A config.json value a setting stores. */
export type SettingValue = boolean | number | string;

const PLUGIN_LABELS: Readonly<Record<PluginId, string>> = {
  light_ai: '轻量 AI（对话、语音、记忆）', screen_awareness: '屏幕感知', screen_reading: '屏幕识读', daily_brief: '日报',
  coding_sessions: '编码会话', personal_agent: '个人代理', harness_bridge: 'harness 桥接', computer_use: '电脑操作',
  external_access: '外部接入', motion_generation: '动作生成',
};

/** config.json's top-level scalars, and each entry of its `plugins` object as `plugins.<id>`. */
export function settingValues(raw: Record<string, unknown>): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = Object.fromEntries(Object.entries(raw)
    .filter((e): e is [string, SettingValue] => ['boolean', 'number', 'string'].includes(typeof e[1])));
  const plugins = raw.plugins;
  if (typeof plugins === 'object' && plugins !== null && !Array.isArray(plugins)) {
    for (const [id, on] of Object.entries(plugins)) if (typeof on === 'boolean') values[`plugins.${id}`] = on;
  }
  return values;
}

/** `object` with `values` written in: a `plugins.<id>` key into its `plugins` object. */
export function withSettings(object: Record<string, unknown>, values: Record<string, SettingValue>): Record<string, unknown> {
  const out = { ...object };
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith('plugins.')) {
      out[key] = value;
      continue;
    }
    const plugins = typeof out.plugins === 'object' && out.plugins !== null && !Array.isArray(out.plugins) ? out.plugins : {};
    out.plugins = { ...plugins, [key.slice('plugins.'.length)]: value };
  }
  return out;
}

type Restart = 'none' | 'backend' | 'avatar';
type Control =
  | { kind: 'toggle'; value: boolean }
  | { kind: 'choice' | 'dropdown'; options: [string, string][]; value: string }
  | { kind: 'slider'; min: number; max: number; step: number; format: 'percent' | 'days' | 'degrees'; value: number }
  | { kind: 'hotkey'; value: string }
  | { kind: 'text'; value: string };

export interface Item { key: string; label: string; control: Control; restart: Restart }

const toggle = (key: string, label: string, value: boolean, restart: Restart = 'none'): Item =>
  ({ key, label, control: { kind: 'toggle', value }, restart });
const choice = (key: string, label: string, options: [string, string][], value: string, restart: Restart = 'none'): Item =>
  ({ key, label, control: { kind: 'choice', options, value }, restart });
const dropdown = (key: string, label: string, options: [string, string][], value: string, restart: Restart = 'none'): Item =>
  ({ key, label, control: { kind: 'dropdown', options, value }, restart });
const slider = (key: string, label: string, min: number, max: number, step: number, format: 'percent' | 'degrees', value: number): Item =>
  ({ key, label, control: { kind: 'slider', min, max, step, format, value }, restart: 'none' });
const hotkey = (key: string, label: string, value: string): Item => ({ key, label, control: { kind: 'hotkey', value }, restart: 'none' });
const text = (key: string, label: string, value: string): Item => ({ key, label, control: { kind: 'text', value }, restart: 'backend' });

const NOTIFY: [string, string][] = [['sound', '出声'], ['card', '只出卡'], ['silent', '不提示']];
const FILTERS: [string, string][] = [['none', '无'], ['sp_filter_1', '黑金'], ['sp_filter_2', '温暖'], ['sp_filter_3', '苍白'],
  ['sp_filter_4', '胶片'], ['sp_filter_5', '希望色彩'], ['sp_filter_6', '血忆'], ['sp_filter_7', '武陵印象'], ['filter_1', '明亮'],
  ['filter_2', '冷调'], ['filter_3', '清新'], ['filter_4', '暗色'], ['filter_5', '黑白'], ['filter_6', '春'], ['filter_7', '文艺'],
  ['filter_8', '蓝橙']];

/** The items the web rows use (the first item of each key). */
const ITEMS: Item[] = [
  toggle('launch_at_login', '登录时启动', true),
  choice('stay_mode', '待在原地 / 自由活动', [['stay', '待在原地'], ['roam', '自由活动'], ['bust', '半身固定']], 'roam'),
  toggle('sit_on_windows', '坐在窗口顶上', true),
  toggle('lean_on_edges', '扶着窗沿', true),
  toggle('look_at_cursor', '看向鼠标', true),
  toggle('drag_inertia', '拖动惯性', true),
  toggle('render_secondary_motion', '头发衣物物理', true, 'avatar'),
  toggle('speech_expressions', '说话时有表情', true, 'avatar'),
  toggle('touch_regions', '点不同部位有不同反应', true),
  toggle('head_pat', '摸头', true),
  toggle('cheek_pinch', '捏脸（按住脸颊拖动）', false),
  toggle('greet_on_resume', '锁屏或睡眠回来时迎接', true),
  toggle('state_affects_behavior', '状态影响行为', true),
  choice('viewport', '活动范围', [['default', '默认'], ['window', '小窗口'], ['fullscreen', '整块屏']], 'default', 'avatar'),
  choice('scene_mode', '场景', [['off', '关'], ['box', '舞台盒'], ['stage', '展示台']], 'off', 'avatar'),
  toggle('scene_parallax', '背景视差', true, 'avatar'),
  toggle('hide_on_screen_capture', '录屏时隐藏角色', true),
  toggle('switch_title', '切换角色时的雷霆大字', true),
  dropdown('interaction_preset', '交互档位', [['quiet', '安静'], ['balanced', '均衡'], ['active', '主动']], 'balanced', 'backend'),
  toggle('render_ssaa', '2× SSAA', true, 'avatar'),
  dropdown('render_resolution', '渲染尺寸', [['authored', '原始尺寸'], ['display', '跟随显示像素（试验）']], 'authored', 'avatar'),
  dropdown('render_shadow', '自阴影精度', [['1024', '高 · 1024'], ['512', '中 · 512'], ['256', '低 · 256']], '1024', 'avatar'),
  dropdown('render_fps', '帧率上限（空闲自动节能在此之下）', [['60', '60 fps'], ['45', '45 fps'], ['30', '30 fps']], '60'),
  dropdown('render_outline', '角色边界', [['original', '原作'], ['subtle', '柔和外轮廓'], ['contrast', '增强外轮廓']], 'original'),
  dropdown('render_ground_shadow', '脚下阴影', [['off', '关'], ['contact', '接触阴影'], ['cast', '真实投影']], 'cast'),
  dropdown('render_ambient', '环境取色', [['off', '关'], ['wallpaper', '壁纸颜色'], ['screen', '屏幕取色']], 'off'),
  toggle('render_light_wrap', '边缘环境光', false),
  dropdown('render_filter', '滤镜', FILTERS, 'none'),
  dropdown('render_dof', '景深', [['off', '关'], ['closeup', '近景时']], 'off'),
  dropdown('render_light_yaw', '主光水平微调', [['-15', '左偏 15°'], ['0', '原作'], ['15', '右偏 15°']], '0'),
  dropdown('render_light_pitch', '主光俯仰微调', [['-10', '降低 10°'], ['0', '原作'], ['10', '抬高 10°']], '0'),
  dropdown('render_light_strength', '主光强度', [['0.5', '50 %'], ['0.75', '75 %'], ['1', '原作 · 100 %'], ['1.25', '125 %'], ['1.5', '150 %']], '1'),
  dropdown('render_facing_mode', '陪看朝向', [['auto', '由角色决定'], ['front', '面向用户'], ['side', '轻微侧身 · 30°'], ['back', '完全转身 · 180°']], 'auto'),
  dropdown('render_camera_mode', '原作镜头预设', [['show', '角色展示'], ['overview', '总览'], ['document', '档案']], 'show'),
  slider('render_camera_yaw', '水平朝向', -180, 180, 0.5, 'degrees', 0),
  slider('render_camera_pitch', '俯仰朝向', -20, 20, 0.5, 'degrees', 0),
  slider('render_camera_zoom', '镜头缩放', 1, 4, 0.05, 'percent', 1),
  toggle('render_camera_sway', '呼吸晃动', false),
  choice('render_camera_auto_closeup', '对话近景', [['off', '关'], ['session', '会话面板打开时']], 'off'),
  choice('render_camera_track', '动作相机轨', [['off', '不播'], ['stage', '舞台框里播']], 'stage'),
  toggle('idle_low_fps', '空闲时降到 30 fps', true),
  toggle('battery_low_fps', '电池供电时降帧', true),
  hotkey('hotkey_toggle_avatar', '显示 / 隐藏角色', 'control+option+h'),
  hotkey('hotkey_click_through', '临时全部点穿', 'control+option+p'),
  hotkey('hotkey_quick_input', '快速输入', 'control+option+space'),
  hotkey('hotkey_radial_menu', '角色快捷轮盘', 'control+option+r'),
  hotkey('hotkey_selection', '读取选中文字', 'control+option+s'),
  toggle('desktop_presence', '头顶任务与角色状态', true),
  toggle('desktop_hover_hints', '悬浮快捷键提示', true),
  hotkey('voice_hotkey', '按住说话', 'right_option'),
  choice('asr_locale', '识别语言', [['auto', '跟随系统'], ['zh-CN', '中文'], ['en-US', 'English']], 'auto'),
  toggle('mute', '只出字、不出声', false, 'backend'),
  toggle('proactive_speech', '主动说话', true, 'backend'),
  choice('break_reminder_minutes', '连续使用提醒', [['0', '关'], ['45', '45 分钟'], ['60', '60 分钟'], ['90', '90 分钟']], '0', 'backend'),
  choice('water_reminder_minutes', '喝水提醒', [['0', '关'], ['60', '60 分钟'], ['90', '90 分钟'], ['120', '120 分钟']], '90', 'backend'),
  dropdown('screen_context_level', '屏幕理解粒度', [['status', '仅读状态'], ['focused', '焦点语义'], ['window', '窗口摘要']], 'focused', 'backend'),
  toggle('share_page_text', '读取网页正文', false, 'backend'),
  toggle('share_window_text', '读取窗口文字', false, 'backend'),
  toggle('share_typed_text', '读取输入的文字', false, 'backend'),
  toggle('share_actions', '记录操作时间线', false, 'none'),
  toggle('share_agent_sessions', '读取编码会话', true, 'backend'),
  toggle('share_screenshots', '屏幕识读时附上截图', false, 'backend'),
  toggle('sense_input_counts', '键鼠计数', true, 'backend'),
  toggle('redact_sensitive', '发出前遮蔽敏感内容', true, 'backend'),
  toggle('system_notifications', '改走 macOS 系统通知', true),
  choice('notify_done', '完成', NOTIFY, 'card'),
  choice('notify_approval', '待批准', NOTIFY, 'sound'),
  choice('notify_error', '出错', NOTIFY, 'sound'),
  choice('notify_brief', '简短播报', NOTIFY, 'card'),
  choice('notify_reminder', '提醒', NOTIFY, 'sound'),
  choice('avatar_click', '点击角色', [['interact', '角色互动'], ['quick_input', '打开快速输入']], 'interact'),
  hotkey('hotkey_look', '屏幕识读', 'control+option+l'),
  // config.json's `plugins` object, one `plugins.<id>` item each.
  ...PLUGINS.map((p) => toggle(`plugins.${p.id}`, PLUGIN_LABELS[p.id], p.default, 'backend')),
];

const REGISTRY_ROWS: [string, string, string][] = [
  ['mute', 'speak', 'mute'], ['asr', 'speak', 'asr_locale'],
  ['proactive', 'speak', 'interaction_preset'],
  ['speakUp', 'speak', 'proactive_speech'], ['rest', 'speak', 'break_reminder_minutes'], ['water', 'speak', 'water_reminder_minutes'],
  ['n_done', 'speak', 'notify_done'],
  ['n_appr', 'speak', 'notify_approval'], ['n_err', 'speak', 'notify_error'], ['n_brief', 'speak', 'notify_brief'],
  ['n_remind', 'speak', 'notify_reminder'],
  ['sysnotify', 'speak', 'system_notifications'], ['capHide', 'speak', 'hide_on_screen_capture'], ['switchTitle', 'speak', 'switch_title'],
  ['hk_ptt', 'keys', 'voice_hotkey'], ['hk_quick', 'keys', 'hotkey_quick_input'], ['hk_look', 'keys', 'hotkey_look'],
  ['hk_hide', 'keys', 'hotkey_toggle_avatar'], ['hk_pass', 'keys', 'hotkey_click_through'],
  ['hk_wheel', 'keys', 'hotkey_radial_menu'], ['hk_sel', 'keys', 'hotkey_selection'],
  ['wintext', 'privacy', 'share_window_text'],
  ['grain', 'privacy', 'screen_context_level'], ['web', 'privacy', 'share_page_text'], ['typing', 'privacy', 'share_typed_text'],
  ['actions', 'privacy', 'share_actions'],
  ['agent_sessions', 'privacy', 'share_agent_sessions'],
  ['shot', 'privacy', 'share_screenshots'], ['keys', 'privacy', 'sense_input_counts'],
  ['mask', 'privacy', 'redact_sensitive'],
  ['login', 'about', 'launch_at_login'],
  ['beh.stay', '@character', 'stay_mode'], ['beh.range', '@character', 'viewport'], ['rnd.fps', '@character', 'render_fps'],
  ...PLUGINS.map((p): [string, string, string] => [`plugins.${p.id}`, 'plugins', `plugins.${p.id}`]),
];

const CHARACTER_ROWS: [string, string][] = [
  ['beh.sit', 'sit_on_windows'], ['beh.lean', 'lean_on_edges'], ['beh.mouse', 'look_at_cursor'],
  ['beh.touch', 'touch_regions'], ['beh.pat', 'head_pat'], ['beh.pinch', 'cheek_pinch'], ['beh.greet', 'greet_on_resume'],
  ['beh.inertia', 'drag_inertia'], ['beh.mood', 'state_affects_behavior'], ['beh.face', 'speech_expressions'], ['beh.watch', 'render_facing_mode'],
  ['beh.rail', 'desktop_presence'], ['beh.hint', 'desktop_hover_hints'], ['rnd.cam', 'render_camera_mode'],
  ['rnd.yaw', 'render_camera_yaw'], ['rnd.pitch', 'render_camera_pitch'], ['rnd.aa', 'render_ssaa'],
  ['rnd.size', 'render_resolution'], ['rnd.shadow', 'render_shadow'], ['rnd.idle', 'idle_low_fps'],
  ['rnd.batt', 'battery_low_fps'], ['rnd.outline', 'render_outline'], ['rnd.lightYaw', 'render_light_yaw'],
  ['rnd.lightPitch', 'render_light_pitch'], ['rnd.lightStrength', 'render_light_strength'],
  ['avatar_click', 'avatar_click'], ['beh.physics', 'render_secondary_motion'],
  ['rnd.ground', 'render_ground_shadow'], ['rnd.ambient', 'render_ambient'], ['rnd.wrap', 'render_light_wrap'],
  ['rnd.filter', 'render_filter'], ['rnd.dof', 'render_dof'],
  ['scn.mode', 'scene_mode'], ['scn.parallax', 'scene_parallax'],
  ['rnd.zoom', 'render_camera_zoom'], ['rnd.sway', 'render_camera_sway'], ['rnd.closeup', 'render_camera_auto_closeup'],
  ['rnd.track', 'render_camera_track'],
];

export interface Row { id: string; group: string; item: Item }

/** Schema order: the registry's native rows, then the character page's. */
export const ROWS: Row[] = [...REGISTRY_ROWS, ...CHARACTER_ROWS.map(([id, key]): [string, string, string] => [id, '@character', key])]
  .map(([id, group, key]) => ({ id, group, item: ITEMS.find((i) => i.key === key)! }));

/** Defaults that differ by platform: Windows shows her in screenshots and recordings unless the user turns hiding on. */
const PLATFORM_DEFAULTS: Record<ShellPlatform, Record<string, SettingValue>> = { mac: {}, windows: { hide_on_screen_capture: false } };
const defaultOf = (item: Item, platform: ShellPlatform): SettingValue => PLATFORM_DEFAULTS[platform][item.key] ?? item.control.value;

export const rowById = (id: string) => ROWS.find((r) => r.id === id);
const rowByKey = (key: string) => ROWS.find((r) => r.item.key === key);
const isHotkey = (row: Row) => row.item.control.kind === 'hotkey';
/** Only push-to-talk may be right Option alone. */
export const allowsRightOption = (row: Row) => row.id === 'hk_ptt';

export const DESTRUCTIVE_IDS: ReadonlySet<string> = new Set(['wintext', 'web', 'typing', 'agent_sessions']);
/** agentd's `POST /context/privacy/sync` revoke kind of each destructive id. */
export const REVOKE_KINDS: Readonly<Record<string, string>> = { wintext: 'window_text', web: 'page_text', typing: 'typed_text',
  agent_sessions: 'agent_sessions' };
/** config.json keys that start the app's processes: only the file may change them. */
const LAUNCH_KEYS: ReadonlySet<string> = new Set(['avatar_app', 'avatar_executable', 'python', 'agentd_dir', 'avatar_args', 'support_dir',
  'agentd_state_dir', 'character_catalog']);
/** Choice rows whose config.json value is the option as an integer. */
const INTEGER_CHOICE_KEYS: ReadonlySet<string> = new Set(['break_reminder_minutes', 'water_reminder_minutes']);

// MARK: hot keys

const HOTKEY_KEYS = new Set(['space', ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const MODIFIER_CAPS: [string, string][] = [['⌃', 'control'], ['⌥', 'option'], ['⇧', 'shift'], ['⌘', 'command']];

/** Lower case, full modifier names in a fixed order, each once; null for a name it refuses. */
export function canonicalHotkey(hotkey: string): string | null {
  const lower = hotkey.toLowerCase();
  if (lower === 'right_option') return lower;
  const parts = lower.split('+');
  const key = parts.at(-1)!;
  if (!HOTKEY_KEYS.has(key)) return null;
  const held = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const name = ({ control: 'control', ctrl: 'control', option: 'option', alt: 'option', shift: 'shift', command: 'command', cmd: 'command' } as Record<string, string>)[part];
    if (!name) return null;
    held.add(name);
  }
  return [...['control', 'option', 'shift', 'command'].filter((m) => held.has(m)), key].join('+');
}

/** The page's key caps (`⌃⌥H`, `右⌥`) for a config.json name; null when `canonicalHotkey` refuses it. */
export function webHotkey(name: string): string | null {
  const canonical = canonicalHotkey(name);
  if (canonical === null) return null;
  if (canonical === 'right_option') return '右⌥';
  const caps = canonical.split('+').map((p) => ({ control: '⌃', option: '⌥', command: '⌘', shift: '⇧', space: 'Space' } as Record<string, string>)[p] ?? p.toUpperCase());
  const mods = new Set(['⌃', '⌥', '⌘', '⇧']);
  return caps.filter((c) => mods.has(c)).join('') + caps.filter((c) => !mods.has(c)).join('');
}

const WINDOWS_CAPS: Readonly<Record<string, string>> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Win' };

/** web/src/bridge/platformText.ts `hotkeyText`: `Ctrl+Alt+H`, `右Alt`, `带 Ctrl、Alt 或 Win 的`. */
const windowsCaps = (caps: string) => caps.replace(/[⌃⌥⇧⌘]/g, (cap, at: number) => WINDOWS_CAPS[cap] + (/^[^\s、，。）)]/.test(caps.slice(at + 1)) ? '+' : ''));

/** `desktop.onState`'s `hotkeys`: these rows' key caps by web id, in words on Windows; a name that is no hot key is left out. */
export function desktopHotkeys(saved: Record<string, unknown>, platform: ShellPlatform = 'mac'): Record<string, string> {
  const caps: Record<string, string> = {};
  for (const id of ['hk_ptt', 'hk_quick', 'hk_look', 'hk_hide', 'hk_pass', 'hk_wheel']) {
    const item = rowById(id)!.item, stored = saved[item.key];
    const web = webHotkey(typeof stored === 'string' ? stored : String(defaultOf(item, platform)));
    if (web !== null) caps[id] = platform === 'windows' ? windowsCaps(web) : web;
  }
  return caps;
}

/** The config.json name for the page's `combo`: modifiers (each once) and Space, a letter, a digit or F1–F12, with ⌃, ⌥ or
 *  ⌘ unless the key is a function key; `右⌥` alone only with `rightOption`. */
export function hotkeyName(combo: string, rightOption: boolean): string | null {
  if (combo === '右⌥') return rightOption ? 'right_option' : null;
  const held = new Set<string>();
  let rest = [...combo];
  for (let m = MODIFIER_CAPS.find(([cap]) => cap === rest[0]); m; m = MODIFIER_CAPS.find(([cap]) => cap === rest[0])) {
    if (held.has(m[1])) return null;
    held.add(m[1]);
    rest = rest.slice(1);
  }
  const key = rest.join('').toLowerCase();
  const fn = /^f([1-9]|1[0-2])$/.test(key);
  const single = rest.length === 1 && /^[a-z0-9]$/.test(key);
  if (key !== 'space' && !single && !fn) return null;
  if (!fn && !['control', 'option', 'command'].some((m) => held.has(m))) return null;
  return canonicalHotkey([...MODIFIER_CAPS.map(([, n]) => n).filter((n) => held.has(n)), key].join('+'));
}

const storedHotkey = (name: string, rightOption: boolean) => {
  const web = webHotkey(name);
  return web === null ? null : hotkeyName(web, rightOption);
};

// MARK: rows

function accepts(item: Item, value: SettingValue): boolean {
  const c = item.control;
  switch (c.kind) {
    case 'toggle': return typeof value === 'boolean';
    case 'choice': case 'dropdown': return typeof value === 'string' && c.options.some(([k]) => k === value);
    case 'slider': return typeof value === 'number' && value >= c.min && value <= c.max;
    default: return typeof value === 'string';
  }
}

const webValue = (row: Row, value: SettingValue): SettingValue => (isHotkey(row) && typeof value === 'string' ? webHotkey(value) ?? value : value);

/** protocol.ts `SettingSchema[]`, plus `default` and `restart`. */
export function schema(platform: ShellPlatform = 'mac'): Record<string, unknown>[] {
  return ROWS.map((row) => {
    const c = row.item.control;
    const entry: Record<string, unknown> = { id: row.id, group: row.group, label: row.item.label, default: webValue(row, defaultOf(row.item, platform)) };
    if (c.kind === 'toggle') entry.kind = 'toggle';
    else if (c.kind === 'choice' || c.kind === 'dropdown') {
      entry.kind = 'select';
      entry.options = c.options.map(([value, label]) => ({ value, label }));
    } else if (c.kind === 'text') entry.kind = 'text';
    else if (c.kind === 'slider') Object.assign(entry, { kind: 'slider', min: c.min, max: c.max, step: c.step, format: c.format });
    else entry.kind = 'hotkey';
    entry.restart = row.item.restart;
    if (DESTRUCTIVE_IDS.has(row.id)) entry.destructive = true;
    return entry;
  });
}

export interface Current {
  values: Record<string, SettingValue>;
  /** Web ids of unusable stored hot keys, with what was stored. */
  broken: Record<string, string>;
  /** Web ids of stored hot keys the system refused, with their names. */
  unregistered: Record<string, string>;
  loginFromSystem: boolean;
}

/** Every row's value by config key: a stored value the row accepts, else its default; the login item's system state when
 *  there is one. An empty hot key is no hot key, and so is one in `refused` (the names that did not register, by config key). */
export function current(saved: Record<string, SettingValue>, login: boolean | null, platform: ShellPlatform = 'mac',
  refused: Record<string, string> = {}): Current {
  const values: Record<string, SettingValue> = {}, broken: Record<string, string> = {}, unregistered: Record<string, string> = {};
  for (const row of ROWS) {
    const key = row.item.key, fallback = defaultOf(row.item, platform);
    let stored: SettingValue | undefined = saved[key];
    if (INTEGER_CHOICE_KEYS.has(key)) stored = typeof stored === 'number' && Number.isInteger(stored) ? String(stored) : undefined;
    if (isHotkey(row)) {
      const name = typeof stored === 'string' ? (stored === '' ? '' : storedHotkey(stored, allowsRightOption(row))) : null;
      if (name !== null) {
        values[key] = name;
        // Saving the same name again then counts as a change, which registers it again.
        if (name !== '' && refused[key] === name) {
          values[key] = '';
          unregistered[row.id] = name;
        }
      } else {
        values[key] = fallback;
        if (stored !== undefined) broken[row.id] = String(stored);
      }
    } else {
      values[key] = stored !== undefined && accepts(row.item, stored) ? stored : fallback;
    }
  }
  if (login !== null) values.launch_at_login = login;
  return { values, broken, unregistered, loginFromSystem: login !== null };
}

/** protocol.ts `SettingsSnapshot`. */
export function snapshot(saved: Record<string, SettingValue>, login: boolean | null, cameraBust: boolean,
  platform: ShellPlatform = 'mac', refused: Record<string, string> = {}): Record<string, unknown> {
  const state = current(saved, login, platform, refused);
  const statuses: Record<string, string> = {};
  for (const [id, raw] of Object.entries(state.broken)) statuses[id] = `配置里的「${raw}」不是有效热键，按默认显示`;
  const caps = (name: string) => (platform === 'windows' ? windowsCaps(webHotkey(name) ?? name) : webHotkey(name) ?? name);
  for (const [id, name] of Object.entries(state.unregistered)) statuses[id] = `「${caps(name)}」没设上，可能被别的程序占用，请换一个`;
  if (!state.loginFromSystem) statuses.login = '测试实例不改系统登录项';
  if (!cameraBust) statuses['beh.stay'] = '这个版本的角色还不支持半身固定';
  const values = Object.fromEntries(ROWS.map((row) => [row.id, webValue(row, state.values[row.item.key]!)]));
  return { saved: values, statuses };
}

function describe(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean' || typeof raw === 'number') return String(raw);
  return JSON.stringify(raw) ?? String(raw);
}

/** A `services` `ssh_host` ssh would read as an option, or one with a space or control character. */
export const unsafeSshHost = (host: string) => /^-|[\s\p{Cc}]/u.test(host);

/** A refused save batch; `message` is the page's `error`. */
export class Rejection extends Error {}

/** `changes` by config key; refuses launch keys, ids outside the schema and values a row does not take. null is the row's
 *  default; "" clears a hot key. */
export function parseChanges(changes: Record<string, unknown>, log: (line: string) => void,
  platform: ShellPlatform = 'mac'): Record<string, SettingValue> {
  const ids = Object.keys(changes).sort();
  const launch = ids.find((id) => LAUNCH_KEYS.has(id));
  if (launch !== undefined) {
    log(`settings save refused launch key ${launch}`);
    throw new Rejection(`「${launch}」是启动参数，只能在配置文件里改`);
  }
  const values: Record<string, SettingValue> = {};
  for (const id of ids) {
    const row = rowById(id);
    if (!row) throw new Rejection(`「${id}」不是可以在这里改的设置`);
    values[row.item.key] = parseValue(changes[id], row, platform);
  }
  return values;
}

function parseValue(raw: unknown, row: Row, platform: ShellPlatform): SettingValue {
  const c = row.item.control;
  if (raw === null) return defaultOf(row.item, platform);
  if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') {
    const value: SettingValue = raw;
    if (isHotkey(row)) {
      if (typeof value === 'string') {
        const name = value === '' ? '' : hotkeyName(value, allowsRightOption(row));
        if (name !== null) return name;
      }
    } else if (accepts(row.item, value)) {
      return value;
    }
  }
  let allowed: string;
  if (c.kind === 'choice' || c.kind === 'dropdown') allowed = '可选 ' + c.options.map(([k, l]) => `${k}（${l}）`).join(' / ');
  else if (c.kind === 'hotkey') allowed = '要用带 ⌃、⌥ 或 ⌘ 的组合键，或 F1–F12' + (allowsRightOption(row) ? '，或 右⌥' : '');
  else if (c.kind === 'slider') allowed = `范围 ${c.min.toFixed(1)}…${c.max.toFixed(1)}`;
  else allowed = '可选 true / false';
  const shown = c.kind === 'hotkey' && platform === 'windows' ? windowsCaps : (s: string) => s;
  throw new Rejection(`「${row.item.label}」不能设成 ${shown(describe(raw))}：${shown(allowed)}`);
}

/** protocol.ts `HotkeyCheck` of `combo` for row `id` against the other hot keys in `saved` and the page's fixed ⌘K. */
export function validateHotkey(id: string, combo: unknown, load: () => Record<string, SettingValue>, login: boolean | null,
  refused: Record<string, string> = {}): { ok: true } | { ok: false; conflictWith: string } | { error: 'invalid_hotkey' } {
  const row = rowById(id)!;
  const name = typeof combo === 'string' ? hotkeyName(combo, allowsRightOption(row)) : null;
  if (name === null) return { error: 'invalid_hotkey' };
  if (name === 'command+k') return { ok: false, conflictWith: '命令面板' };
  const values = current(load(), login, 'mac', refused).values;
  if (values[row.item.key] !== name) {
    const other = ROWS.find((r) => isHotkey(r) && r.item.key !== row.item.key && values[r.item.key] === name);
    if (other) return { ok: false, conflictWith: other.item.label };
  }
  return { ok: true };
}

export const isHotkeyRow = (id: string) => {
  const row = rowById(id);
  return row !== undefined && isHotkey(row);
};

/** What a save does beyond config.json that this shell runs. */
export type SaveEffect =
  | { kind: 'revoke'; revoke: string; key: string }
  | { kind: 'loginItem'; on: boolean }
  /** `drag_inertia` or `look_at_cursor` changed; `id` is the action switch it sets. */
  | { kind: 'actionSwitch'; id: string; on: boolean }
  | { kind: 'stateAffectsBehavior'; on: boolean }
  | { kind: 'behaviorSwitches'; keys: string[] }
  /** The renderer takes these settings only at launch. */
  | { kind: 'restartAvatar' }
  /** `render_fps`, `battery_low_fps` or `idle_low_fps` changed. */
  | { kind: 'fps' }
  /** Each changed hot key with its new name, sorted by key; one moved onto another changed one's old key again after them. */
  | { kind: 'hotkeys'; saved: [string, string][] }
  /** The changed ones of LIVE_RENDER_KEYS in that order, then `stay_mode` into or out of `bust`; only without `restartAvatar`. */
  | { kind: 'renderLive'; keys: string[] }
  /** `touch_regions`, `head_pat`, `cheek_pinch` or `greet_on_resume` changed. */
  | { kind: 'touch' };

/** What the running renderer takes in a `set_render`. */
const LIVE_RENDER_KEYS = ['render_outline', 'render_light_yaw', 'render_light_pitch', 'render_light_strength', 'render_camera_mode',
  'render_camera_yaw', 'render_camera_pitch', 'render_facing_mode', 'render_ground_shadow', 'render_ambient', 'render_light_wrap',
  'render_camera_zoom', 'render_camera_sway', 'render_camera_track', 'render_filter', 'render_dof'];

export interface SavePlan {
  /** Changed values to write, as config.json keeps them; empty when nothing changed. */
  write: Record<string, SettingValue>;
  effects: SaveEffect[];
  restart: Restart;
  /** A refused batch's message. */
  error?: string;
}

const resolveViewport = (raw: SettingValue | undefined) => (raw === 'window' || raw === 'fullscreen' ? raw : 'fullscreen');

/** Merges `changes` into the current values of `saved`. A broken stored hot key stays the old value, so saving the default
 *  writes over it. */
export function planSave(saved: Record<string, SettingValue>, login: boolean | null, changes: Record<string, SettingValue>,
  platform: ShellPlatform = 'mac', refused: Record<string, string> = {}): SavePlan {
  const state = current(saved, login, platform, refused);
  const old = { ...state.values };
  for (const row of ROWS) if (state.broken[row.id] !== undefined) old[row.item.key] = saved[row.item.key]!;
  const next = { ...old, ...changes };
  const hotkeys = ROWS.filter(isHotkey);
  for (const row of hotkeys) {
    if (changes[row.item.key] === undefined) continue;
    const name = next[row.item.key];
    if (typeof name !== 'string' || name === '') continue;
    const other = hotkeys.find((r) => r.item.key !== row.item.key && next[r.item.key] === name);
    if (other) return { write: {}, effects: [], restart: 'none', error: `${webHotkey(name) ?? name} 已被「${other.item.label}」占用` };
  }
  const changed = Object.keys(next).filter((k) => old[k] !== next[k]);
  if (changed.length === 0) return { write: {}, effects: [], restart: 'none' };
  const write: Record<string, SettingValue> = {};
  for (const key of changed) {
    const v = next[key]!;
    write[key] = INTEGER_CHOICE_KEYS.has(key) ? Number(v) : v;
  }
  const effects: SaveEffect[] = [];
  for (const [key, revoke] of [['share_page_text', 'page_text'], ['share_typed_text', 'typed_text'], ['share_agent_sessions', 'agent_sessions']]) {
    if (old[key!] === true && next[key!] === false) effects.push({ kind: 'revoke', revoke: revoke!, key: key! });
  }
  if (typeof old.launch_at_login === 'boolean' && typeof next.launch_at_login === 'boolean' && old.launch_at_login !== next.launch_at_login) {
    effects.push({ kind: 'loginItem', on: next.launch_at_login });
  }
  for (const [key, id] of [['drag_inertia', 'drag_sway'], ['look_at_cursor', 'look_cursor']]) {
    if (changed.includes(key!) && typeof next[key!] === 'boolean') effects.push({ kind: 'actionSwitch', id: id!, on: next[key!] as boolean });
  }
  if (changed.includes('state_affects_behavior') && typeof next.state_affects_behavior === 'boolean') {
    effects.push({ kind: 'stateAffectsBehavior', on: next.state_affects_behavior });
  }
  const behavior = ['stay_mode', 'sit_on_windows', 'lean_on_edges'].filter((k) => changed.includes(k));
  if (behavior.length > 0) effects.push({ kind: 'behaviorSwitches', keys: behavior });
  if (['render_fps', 'battery_low_fps', 'idle_low_fps'].some((k) => changed.includes(k))) effects.push({ kind: 'fps' });
  const hotkeysChanged = hotkeys.map((r) => r.item.key).filter((k) => changed.includes(k) && typeof next[k] === 'string').sort();
  if (hotkeysChanged.length > 0) {
    const retries = hotkeysChanged.filter((k) => {
      const key = canonicalHotkey(next[k] as string);
      return key !== null && hotkeysChanged.some((o) => o !== k && typeof old[o] === 'string' && canonicalHotkey(old[o] as string) === key);
    });
    effects.push({ kind: 'hotkeys', saved: [...hotkeysChanged, ...retries].map((k) => [k, next[k] as string]) });
  }
  const restartAvatar = ['render_ssaa', 'render_resolution', 'render_shadow', 'render_secondary_motion', 'speech_expressions'].some((k) => changed.includes(k))
    || resolveViewport(old.viewport) !== resolveViewport(next.viewport)
    || (platform === 'windows' && changed.includes('hide_on_screen_capture'));
  if (restartAvatar) effects.push({ kind: 'restartAvatar' });
  const live = LIVE_RENDER_KEYS.filter((k) => changed.includes(k));
  // 半身固定 frames her from the waist up (C3 v27 rule 49 (i)).
  if ((old.stay_mode === 'bust') !== (next.stay_mode === 'bust')) live.push('stay_mode');
  if (live.length > 0 && !restartAvatar) effects.push({ kind: 'renderLive', keys: live });
  if (['touch_regions', 'head_pat', 'cheek_pinch', 'greet_on_resume'].some((k) => changed.includes(k))) effects.push({ kind: 'touch' });
  const backend = changed.some((k) => rowByKey(k)?.item.restart === 'backend');
  return { write, effects, restart: backend ? 'backend' : restartAvatar ? 'avatar' : 'none' };
}

/** `PUT /behavior/switches`'s body from config.json; dockOpen, her hover buttons are open: she starts no free walk. */
export function behaviorSwitches(raw: Record<string, unknown>, dockOpen: boolean): Record<string, boolean> {
  const mode = raw.stay_mode;
  const body: Record<string, boolean> = {
    stay_in_place: mode === 'stay' || mode === 'bust',
    sit_window_top: typeof raw.sit_on_windows === 'boolean' ? raw.sit_on_windows : true,
    hold_window_edge: typeof raw.lean_on_edges === 'boolean' ? raw.lean_on_edges : true,
    fullscreen_give_way: true,
  };
  if (mode === 'bust') body.bust_framing = true;
  if (dockOpen) body.hold_free_walks = true;
  return body;
}

/** notApplied: the web ids of the config keys whose effect failed, in schema order. */
export const idsOfKeys = (keys: string[]) => ROWS.filter((r) => keys.includes(r.item.key)).map((r) => r.id);
