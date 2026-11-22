// The tray menu, the character menu, the app menu and the menu bar icon (src/main/menus/, src/common/menus.ts).
// Only templates are checked: no menu pops up and no tray icon changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iconState, MENU_STATE_DEFAULTS, type MenuBarStatus, type MenuState, processStatus, quietUntil } from '../src/common/menus.ts';
import { PLUGIN_IDS, type Plugins, shellPlan } from '../src/common/plugins.ts';
import { appMenu, pageShortcut } from '../src/main/menus/app.ts';
import { avatarMenu } from '../src/main/menus/avatar.ts';
import { iconBitmap, squareIcon } from '../src/main/menus/icon.ts';
import { type MenuItem, type MenuPorts, SettingsChanges } from '../src/main/menus/items.ts';
import { trayContextMenu, trayMenu } from '../src/main/menus/tray.ts';

/** MenuBarMenuState.sample, every plug-in on. */
const SAMPLE: MenuState = {
  ...MENU_STATE_DEFAULTS,
  plan: shellPlan(Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins),
  services: [{ name: '角色', detail: '运行中' }, { name: '后台', detail: '运行中' }, { name: '语音隧道', detail: '重连中 5 s' }],
  recent: [{ id: 'a1', text: 'claude:agentd 在等你批准', time: '14:35', unread: true },
    { id: 'a2', text: 'codex 会话没能启动', time: '14:40', unread: true },
    { id: 'a3', text: 'HostLink 的 click 已经接上', time: '14:32', unread: false },
    { id: 'a4', text: '已跳转到 Terminal', time: '14:20', unread: false },
    { id: 'a5', text: 'TTS 隧道断开', time: '14:03', unread: false }],
  characters: [{ id: 'aster', name: '示例甲' }, { id: 'birch', name: '示例乙' }],
  currentCharacter: 'aster',
  appearances: [{ id: 'standard', name: '标准制服' }, { id: 'field', name: '外勤' }, { id: 'dayoff', name: '休息日' }],
  currentAppearance: 'standard',
};

/** Every port, each recording its call; `without` leaves ports out. */
function ports(without: (keyof MenuPorts)[] = []) {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push(args.length ? `${name} ${args.map((a) => JSON.stringify(a)).join(' ')}` : name); };
  const all: MenuPorts = {
    openMain: rec('openMain'), quit: rec('quit'), log: rec('log'), look: rec('look'), quickInput: rec('quickInput'),
    openAnnouncement: rec('openAnnouncement'), markAllAnnouncementsRead: rec('markAllAnnouncementsRead'),
    setQuiet: async (until) => { calls.push(`setQuiet ${until}`); },
    toggleClickThroughAll: rec('toggleClickThroughAll'), toggleFreeRoam: rec('toggleFreeRoam'), settingsChanged: rec('settingsChanged'),
    toggleHidden: rec('toggleHidden'), resetPosition: rec('resetPosition'), switchCharacter: rec('switchCharacter'),
    switchAppearance: rec('switchAppearance'), toggleLayer: rec('toggleLayer'), setPose: rec('setPose'), togglePoseLock: rec('togglePoseLock'),
    restartChildren: rec('restartChildren'), openTune: rec('openTune'), beginCamera: rec('beginCamera'),
    capture: { take: async () => 'shot.png', saved: rec('captureSaved') },
    giveGift: rec('giveGift'), resetPanels: rec('resetPanels'), handClipboard: rec('handClipboard'), selectRegion: rec('selectRegion'),
    playSlot: rec('playSlot'), playPlaylist: rec('playPlaylist'), stopPlaylist: rec('stopPlaylist'), setPlaylistLoop: rec('setPlaylistLoop'),
    now: () => Date.UTC(2026, 10, 20, 6, 0, 0),
  };
  for (const key of without) delete all[key];
  return { calls, ports: all };
}

const titles = (menu: MenuItem[]) => menu.filter((i) => i.type !== 'separator').map((i) => i.label);
const deepTitles = (menu: MenuItem[]): string[] =>
  menu.flatMap((i) => (i.type === 'separator' ? [] : [i.label!, ...deepTitles((i.submenu as MenuItem[] | undefined) ?? [])]));
function find(menu: MenuItem[], label: string): MenuItem {
  const found = menu.find((i) => i.label === label);
  assert.ok(found, `no item ${label}`);
  return found;
}
const sub = (menu: MenuItem[], label: string) => find(menu, label).submenu as MenuItem[];
const click = (i: MenuItem) => (i.click as () => void)();
/** Lets a port's promise settle. */
const settle = () => new Promise((r) => setImmediate(r));

test('menus: the tray menu has every title, submenus included', () => {
  const menu = trayMenu(SAMPLE, ports().ports);
  assert.deepEqual(deepTitles(menu), [
    '角色 · 运行中', '后台 · 运行中', '语音隧道 · 重连中 5 s',
    '打开主窗口', '对话', '待处理', '会话面板', '屏幕识读', '快速输入…',
    '最近播报', 'claude:agentd 在等你批准', 'codex 会话没能启动', 'HostLink 的 click 已经接上', '已跳转到 Terminal',
    'TTS 隧道断开', '全部标为已读',
    '记忆…', '日志与 Trace', '状态监控',
    '安静', '30 分钟', '1 小时', '到明早 7:00', '结束安静', '临时全部点穿', '自由活动',
    '隐藏角色 30 分钟', '放回默认位置', '切换角色', '示例甲', '示例乙', '角色卡…', '外观', '标准制服', '外勤', '休息日',
    '设置…', '重启子进程', '退出',
  ]);
  // Separators after the rows, 快速输入 › 最近播报, 状态监控, 自由活动, 外观.
  assert.deepEqual(menu.flatMap((i, n) => (i.type === 'separator' ? [menu[n - 1]!.label] : [])),
    ['语音隧道 · 重连中 5 s', '最近播报', '状态监控', '自由活动', '外观']);
  assert.ok(menu.slice(0, 3).every((i) => i.enabled === false && i.click === undefined), 'the rows are not commands');
});

test('menus: tray shortcuts, checks and greyed items follow the state', () => {
  const menu = trayMenu({ ...SAMPLE, quickInputHotkey: 'control+option+space', lookHotkey: 'control+option+l' }, ports().ports);
  const accel = Object.fromEntries(menu.filter((i) => i.accelerator).map((i) => [i.label, i.accelerator]));
  assert.deepEqual(accel, { 打开主窗口: 'Command+0', 对话: 'Command+J', 屏幕识读: 'Control+Alt+L', '快速输入…': 'Control+Alt+Space',
    临时全部点穿: 'Control+Alt+P', '设置…': 'Command+,', 退出: 'Command+Q' });
  const recent = sub(menu, '最近播报');
  assert.deepEqual(recent.slice(0, 5).map((i) => [i.checked, i.sublabel]),
    [[true, '14:35'], [true, '14:40'], [false, '14:32'], [false, '14:20'], [false, '14:03']]);
  assert.equal(find(recent, '全部标为已读').enabled, true);
  assert.equal(find(sub(trayMenu({ ...SAMPLE, recent: [] }, ports().ports), '最近播报'), '全部标为已读').enabled, false);
  assert.equal(find(menu, '自由活动').checked, true);
  assert.equal(find(trayMenu({ ...SAMPLE, freeRoam: false }, ports().ports), '自由活动').checked, false);
  assert.equal(find(menu, '临时全部点穿').checked, false);
  assert.equal(find(sub(menu, '切换角色'), '示例甲').checked, true);
  assert.equal(find(sub(menu, '外观'), '标准制服').checked, true);
  // A name that is no hot key, or right option, leaves the item without a shortcut.
  const bare = trayMenu({ ...SAMPLE, lookHotkey: 'right_option', quickInputHotkey: '' }, ports().ports);
  assert.equal(find(bare, '屏幕识读').accelerator, undefined);
  assert.equal(find(bare, '快速输入…').accelerator, undefined);
  // Hidden, switching, one appearance.
  const hidden = trayMenu({ ...SAMPLE, avatarHidden: true, characterSwitching: true }, ports().ports);
  assert.ok(titles(hidden).includes('显示角色'));
  assert.equal(find(hidden, '切换角色').enabled, false);
  assert.ok(sub(hidden, '切换角色').filter((i) => i.label !== '角色卡…' && i.type !== 'separator').every((i) => i.enabled === false));
  assert.equal(find(hidden, '外观').enabled, false);
  assert.ok(!titles(trayMenu({ ...SAMPLE, appearances: SAMPLE.appearances.slice(0, 1) }, ports().ports)).includes('外观'));
  const loading = sub(trayMenu({ ...SAMPLE, appearanceSwitchingTo: 'field' }, ports().ports), '外观');
  assert.deepEqual(loading.map((i) => [i.label, i.enabled]), [['标准制服', false], ['外勤 · 切换中…', false], ['休息日', false]]);
  // 诊断 stays out until the app has it, option or not.
  assert.deepEqual(titles(trayMenu({ ...SAMPLE, showsDiagnostics: true }, ports().ports)).slice(-4), ['切换角色', '外观', '设置…', '重启子进程', '退出'].slice(-4));
});

test('menus: on Windows the tray icon\'s menu is the Mac\'s popup with the helper\'s row under the children\'s', () => {
  const h = ports();
  const menu = trayContextMenu('windows', SAMPLE, h.ports, '系统助手 · 运行中');
  const mac = deepTitles(trayMenu(SAMPLE, h.ports));
  assert.deepEqual(deepTitles(menu), [...mac.slice(0, 3), '系统助手 · 运行中', ...mac.slice(3)]);
  assert.equal(menu[4]!.type, 'separator');
  assert.ok(menu.slice(0, 4).every((i) => i.enabled === false && i.click === undefined), 'the rows are not commands');
  for (const label of ['切换角色', '设置…', '退出']) assert.ok(titles(menu).includes(label), `no item ${label}`);
  click(find(sub(menu, '切换角色'), '示例乙'));
  click(find(menu, '设置…'));
  click(find(menu, '退出'));
  assert.deepEqual(h.calls, ['switchCharacter "birch"', 'openMain "/settings"', 'quit']);
  const failed = { ...SAMPLE, configError: '请查看设置' };
  assert.deepEqual(titles(trayContextMenu('windows', failed, h.ports, '系统助手 · 未启动')), titles(trayMenu(failed, h.ports)));
  assert.deepEqual(deepTitles(trayContextMenu('mac', SAMPLE, h.ports, '系统助手 · 运行中')), mac, 'the Mac\'s has no helper row');
});

test('menus: off the Mac the tray icon\'s menu has no Command+ shortcut, a config error\'s included; hot keys stay', () => {
  const deep = (menu: MenuItem[]): MenuItem[] => menu.flatMap((i) => [i, ...deep((i.submenu as MenuItem[] | undefined) ?? [])]);
  const h = ports();
  for (const s of [SAMPLE, { ...SAMPLE, configError: '请查看设置' }]) {
    const menu = trayContextMenu('windows', s, h.ports, '系统助手 · 运行中');
    assert.deepEqual(deep(menu).filter((i) => i.accelerator?.startsWith('Command+')).map((i) => i.label), []);
  }
  const accel = Object.fromEntries(trayContextMenu('windows', SAMPLE, h.ports, '系统助手 · 运行中')
    .filter((i) => i.accelerator).map((i) => [i.label, i.accelerator]));
  assert.deepEqual(accel, { 屏幕识读: 'Control+Alt+L', '快速输入…': 'Control+Space', 临时全部点穿: 'Control+Alt+P' });
  assert.equal(find(trayMenu(SAMPLE, h.ports), '退出').accelerator, 'Command+Q', 'the Mac keeps its own');
});

test('menus: a config error keeps only the error, the main window, 对话, 会话面板 and a grey 重启子进程', () => {
  const h = ports();
  const menu = trayMenu({ ...SAMPLE, configError: 'tts_url 不是有效地址' }, h.ports);
  assert.deepEqual(titles(menu), ['配置错误：tts_url 不是有效地址', '打开主窗口', '对话', '会话面板', '重启子进程', '退出']);
  assert.equal(menu.filter((i) => i.type === 'separator').length, 2);
  assert.equal(find(menu, '配置错误：tts_url 不是有效地址').enabled, false);
  assert.equal(find(menu, '重启子进程').enabled, false);
  for (const label of ['打开主窗口', '对话', '会话面板', '退出']) click(find(menu, label));
  assert.deepEqual(h.calls, ['openMain "/home"', 'openMain "/chat"', 'openMain "/overview?focus=running"', 'quit']);
});

test('menus: each tray item calls its port; a missing port greys its item', async () => {
  const h = ports();
  const menu = trayMenu(SAMPLE, h.ports);
  for (const label of ['打开主窗口', '对话', '待处理', '会话面板', '屏幕识读', '快速输入…', '记忆…', '日志与 Trace', '状态监控',
    '临时全部点穿', '自由活动', '隐藏角色 30 分钟', '放回默认位置', '设置…', '重启子进程', '退出']) click(find(menu, label));
  click(find(sub(menu, '最近播报'), 'codex 会话没能启动'));
  click(find(sub(menu, '最近播报'), '全部标为已读'));
  click(find(sub(menu, '切换角色'), '示例乙'));
  click(find(sub(menu, '切换角色'), '角色卡…'));
  click(find(sub(menu, '外观'), '外勤'));
  assert.deepEqual(h.calls, ['openMain "/home"', 'openMain "/chat"', 'openMain "/overview?focus=pending"', 'openMain "/overview?focus=running"',
    'look', 'quickInput', 'openMain "/memory"', 'openMain "/diag?tab=timeline"', 'openMain "/diag?tab=run"',
    'toggleClickThroughAll', 'toggleFreeRoam', 'settingsChanged ["stay_mode"]', 'toggleHidden', 'resetPosition',
    'openMain "/settings"', 'restartChildren', 'quit',
    'openAnnouncement "a2"', 'markAllAnnouncementsRead', 'switchCharacter "birch"', 'openMain "/character"', 'switchAppearance "field"']);

  const bare = trayMenu(SAMPLE, ports(['look', 'quickInput', 'setQuiet', 'toggleClickThroughAll', 'toggleFreeRoam', 'toggleHidden',
    'resetPosition', 'switchCharacter', 'switchAppearance', 'restartChildren', 'openAnnouncement', 'markAllAnnouncementsRead']).ports);
  for (const label of ['屏幕识读', '快速输入…', '临时全部点穿', '自由活动', '隐藏角色 30 分钟', '放回默认位置', '重启子进程']) {
    assert.equal(find(bare, label).enabled, false, label);
    assert.equal(find(bare, label).click, undefined, label);
  }
  assert.ok(sub(bare, '安静').every((i) => i.enabled === false));
  assert.ok(sub(bare, '最近播报').every((i) => i.type === 'separator' || i.enabled === false));
  assert.equal(find(sub(bare, '切换角色'), '示例甲').enabled, false);
  assert.equal(find(sub(bare, '切换角色'), '角色卡…').enabled, true);
  assert.equal(find(sub(bare, '外观'), '外勤').enabled, false);
  for (const label of ['打开主窗口', '对话', '待处理', '会话面板', '记忆…', '设置…', '退出']) assert.equal(find(bare, label).enabled, true);
  await settle();
});

test('menus: 安静 sets quiet for its span, 结束安静 only while quiet; a failure is logged', async () => {
  const h = ports();
  const now = h.ports.now!();
  const quiet = sub(trayMenu(SAMPLE, h.ports), '安静');
  assert.equal(find(trayMenu(SAMPLE, h.ports), '安静').checked, false);
  assert.equal(find(quiet, '结束安静').enabled, false);
  for (const label of ['30 分钟', '1 小时', '到明早 7:00']) click(find(quiet, label));
  const on = sub(trayMenu({ ...SAMPLE, quiet: true }, h.ports), '安静');
  assert.equal(find(trayMenu({ ...SAMPLE, quiet: true }, h.ports), '安静').checked, true);
  click(find(on, '结束安静'));
  await settle();
  assert.deepEqual(h.calls, [`setQuiet ${now / 1000 + 1800}`, `setQuiet ${now / 1000 + 3600}`,
    `setQuiet ${quietUntil('untilMorning', now)}`, 'setQuiet null']);
  const failing = ports();
  failing.ports.setQuiet = async () => { throw new Error('agentd 不在'); };
  click(find(sub(trayMenu(SAMPLE, failing.ports), '安静'), '1 小时'));
  await settle();
  assert.deepEqual(failing.calls, ['log "quiet span=hour failed: agentd 不在"']);
});

test('menus: 到明早 7:00 is the next local 07:00 strictly after now', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m, 0).getTime();
  assert.equal(quietUntil('untilMorning', at(6, 59)), new Date(2026, 10, 20, 7).getTime() / 1000);
  assert.equal(quietUntil('untilMorning', at(7)), new Date(2026, 10, 21, 7).getTime() / 1000);
  assert.equal(quietUntil('untilMorning', at(23, 30)), new Date(2026, 10, 21, 7).getTime() / 1000);
  assert.equal(quietUntil('halfHour', at(12)), at(12) / 1000 + 1800);
});

test('menus: 自由活动 from a menu tells the settings page (settings.onChange `change` with its ids)', () => {
  const changes = new SettingsChanges();
  const events: string[] = [];
  const cancel = changes.subscribe(null, (e) => events.push(`${e.event} ${e.data}`));
  const h = ports();
  h.ports.settingsChanged = (keys) => changes.changed(keys);
  click(find(sub(avatarMenu(SAMPLE, h.ports), '更多'), '自由活动'));
  click(find(trayMenu(SAMPLE, h.ports), '自由活动'));
  changes.changed(['no_such_key']);
  cancel();
  changes.changed(['stay_mode']);
  assert.deepEqual(h.calls, ['toggleFreeRoam', 'toggleFreeRoam']);
  assert.deepEqual(events, ['change {"ids":["beh.stay"]}', 'change {"ids":["beh.stay"]}']);
});

test('menus: the character menu follows MenuBarMenuModel.character', () => {
  const h = ports();
  const menu = avatarMenu(SAMPLE, h.ports);
  assert.deepEqual(titles(menu), ['示例甲 · 运行中', '打开对话', '快速输入…', '给她看', '送礼物', '角色', '安静', '隐藏角色 30 分钟', '更多']);
  assert.equal(menu.filter((i) => i.type === 'separator').length, 2);
  assert.equal(menu[0]!.enabled, false);
  assert.ok(!deepTitles(menu).includes('重启子进程') && !deepTitles(menu).includes('退出'));
  const show = sub(menu, '给她看'), roles = sub(menu, '角色'), more = sub(menu, '更多'), open = sub(more, '打开');
  assert.deepEqual(titles(show), ['把剪贴板交给她', '框选给她看…', '屏幕识读']);
  assert.deepEqual(titles(roles), ['示例甲', '示例乙', '角色卡…', '外观']);
  assert.equal(find(roles, '示例甲').checked, true);
  assert.deepEqual(titles(sub(roles, '外观')), ['标准制服', '外勤', '休息日']);
  assert.deepEqual(titles(sub(menu, '安静')), ['30 分钟', '1 小时', '到明早 7:00', '结束安静']);
  assert.deepEqual(titles(more), ['待处理', '镜头与动作…', '拍照模式…', '保存截图', '自由活动', '放回默认位置', '复位浮窗', '临时全部点穿', '打开']);
  assert.equal(find(more, '自由活动').checked, true);
  assert.equal(find(more, '保存截图').enabled, false, 'grey unless the avatar lists capture');
  assert.deepEqual(titles(open), ['主页', '记忆', '角色', '诊断', '设置…']);

  for (const label of ['打开对话', '快速输入…', '送礼物', '隐藏角色 30 分钟']) click(find(menu, label));
  for (const i of show) click(i);
  click(find(roles, '示例乙'));
  click(find(roles, '角色卡…'));
  for (const label of ['待处理', '镜头与动作…', '拍照模式…', '自由活动', '放回默认位置', '复位浮窗', '临时全部点穿']) click(find(more, label));
  for (const i of open) click(i);
  assert.deepEqual(h.calls, ['openMain "/chat"', 'quickInput', 'giveGift', 'toggleHidden',
    'handClipboard', 'selectRegion', 'look', 'switchCharacter "birch"', 'openMain "/character"',
    'openMain "/overview?focus=pending"', 'openTune', 'openMain "/character?view=photo"', 'toggleFreeRoam', 'settingsChanged ["stay_mode"]',
    'resetPosition', 'resetPanels', 'toggleClickThroughAll',
    'openMain "/home"', 'openMain "/memory"', 'openMain "/character"', 'openMain "/diag?tab=run"', 'openMain "/settings"']);
  assert.ok(titles(menu).length <= 10);
});

test('menus: the character menu header, 角色 and 更多 follow the state', async () => {
  const header = (s: Partial<MenuState>) => avatarMenu({ ...SAMPLE, ...s }, ports().ports)[0]!.label;
  assert.equal(header({ characterSwitching: true, avatarHidden: true }), '示例甲 · 切换中');
  assert.equal(header({ avatarHidden: true, quiet: true }), '示例甲 · 已隐藏');
  assert.equal(header({ quiet: true }), '示例甲 · 安静中');
  assert.equal(header({ services: [] }), '示例甲 · 待命');
  assert.equal(header({ currentCharacter: null }), '角色 · 运行中');
  assert.equal(find(avatarMenu({ ...SAMPLE, characterSwitching: true }, ports().ports), '角色').enabled, false);
  assert.ok(titles(avatarMenu({ ...SAMPLE, avatarHidden: true }, ports().ports)).includes('显示角色'));
  // 调整镜头… right after 镜头与动作… only with camera_free; 保存截图 with capture.
  const h = ports();
  const more = sub(avatarMenu({ ...SAMPLE, cameraFree: true, canCapture: true }, h.ports), '更多');
  assert.equal(titles(more).indexOf('调整镜头…'), titles(more).indexOf('镜头与动作…') + 1);
  assert.equal(find(more, '保存截图').enabled, true);
  click(find(more, '调整镜头…'));
  click(find(more, '保存截图'));
  await settle();
  assert.deepEqual(h.calls, ['beginCamera', 'captureSaved "shot.png"']);
  const failing = ports();
  failing.ports.capture = { take: async () => { throw new Error('unsupported'); }, saved: () => assert.fail('not saved') };
  click(find(sub(avatarMenu({ ...SAMPLE, canCapture: true }, failing.ports), '更多'), '保存截图'));
  await settle();
  assert.deepEqual(failing.calls, ['log "capture failed: unsupported"']);
  // Ports other blocks have not wired yet are greyed.
  const bare = avatarMenu({ ...SAMPLE, cameraFree: true, canCapture: true },
    ports(['handClipboard', 'selectRegion', 'giveGift', 'openTune', 'beginCamera', 'capture', 'resetPanels']).ports);
  for (const label of ['把剪贴板交给她', '框选给她看…']) assert.equal(find(sub(bare, '给她看'), label).enabled, false);
  assert.equal(find(bare, '送礼物').enabled, false);
  for (const label of ['镜头与动作…', '调整镜头…', '保存截图', '复位浮窗']) assert.equal(find(sub(bare, '更多'), label).enabled, false, label);
});

test('menus: 姿态 shows only with poses; a slot without material is grey, the lock and the current pose are checked', () => {
  assert.ok(!titles(avatarMenu(SAMPLE, ports().ports)).includes('姿态'));
  const posed: MenuState = { ...SAMPLE, poses: [{ slot: 'stand', title: '站', id: 'pose_stand', available: true },
    { slot: 'sit', title: '坐', id: 'pose_sit', available: true }, { slot: 'lie', title: '躺', id: null, available: false }] };
  const h = ports();
  const menu = avatarMenu(posed, h.ports);
  assert.deepEqual(titles(menu).slice(3, 6), ['给她看', '姿态', '送礼物']);
  const poses = sub(menu, '姿态');
  assert.deepEqual(poses.map((i) => i.type === 'separator' ? '-' : `${i.label} ${i.checked} ${i.enabled}`),
    ['自动 true true', '站 false true', '坐 false true', '躺（缺素材） false false', '-', '锁定当前姿态 false true']);
  const held = sub(avatarMenu({ ...posed, currentPose: 'pose_sit', poseLocked: true }, h.ports), '姿态');
  assert.deepEqual(held.filter((i) => i.checked).map((i) => i.label), ['坐', '锁定当前姿态']);
  click(find(held, '站'));
  click(find(held, '自动'));
  click(find(held, '锁定当前姿态'));
  assert.deepEqual(h.calls, ['setPose "pose_stand"', 'setPose null', 'togglePoseLock']);
  const bare = sub(avatarMenu(posed, ports(['setPose', 'togglePoseLock']).ports), '姿态');
  assert.ok(bare.every((i) => i.type === 'separator' || i.enabled === false));
});

test('menus: 角色 › 服装分层 and MMD show only with layers and slots', () => {
  assert.deepEqual(titles(sub(avatarMenu(SAMPLE, ports().ports), '角色')), ['示例甲', '示例乙', '角色卡…', '外观']);
  assert.ok(!deepTitles(trayMenu({ ...SAMPLE, layers: [{ id: 'coat', name: '外套', visible: true }] }, ports().ports)).includes('服装分层'));
  const h = ports();
  const s: MenuState = { ...SAMPLE, layers: [{ id: 'coat', name: '外套', visible: true }, { id: 'hat', name: '帽子', visible: false }],
    motionSlots: [{ id: 'mmd_a', name: '舞一' }, { id: 'mmd_b', name: '舞二' }], playingSlot: 'mmd_b', playlistLoop: 'one' };
  const roles = sub(avatarMenu(s, h.ports), '角色');
  assert.deepEqual(titles(roles), ['示例甲', '示例乙', '角色卡…', '外观', '服装分层', 'MMD']);
  const layers = sub(roles, '服装分层');
  assert.deepEqual(layers.map((i) => [i.label, i.checked, i.enabled]), [['外套', true, true], ['帽子', false, true]]);
  const mmd = sub(roles, 'MMD');
  assert.deepEqual(mmd.map((i) => (i.type === 'separator' ? '-' : i.label)), ['舞一', '舞二', '-', '连播', '循环', '停止']);
  assert.equal(find(mmd, '舞二').checked, true);
  assert.equal(find(mmd, '停止').enabled, false);
  assert.deepEqual(sub(mmd, '循环').map((i) => [i.label, i.checked]), [['不循环', false], ['单曲', true], ['全部', false]]);
  click(find(layers, '帽子'));
  click(find(mmd, '舞一'));
  click(find(mmd, '连播'));
  click(find(sub(mmd, '循环'), '全部'));
  click(find(sub(roles, 'MMD').concat(), '停止'));
  assert.deepEqual(h.calls, ['toggleLayer "hat"', 'playSlot "mmd_a"', 'playPlaylist', 'setPlaylistLoop "all"', 'stopPlaylist']);
  assert.equal(find(sub(sub(avatarMenu({ ...s, playlistPlaying: true }, h.ports), '角色'), 'MMD'), '停止').enabled, true);
  for (const busy of [{ layersSwitching: true }, { appearanceSwitchingTo: '' }, { characterSwitching: true }]) {
    const group = find(sub(avatarMenu({ ...s, ...busy }, h.ports), '角色'), '服装分层');
    assert.equal(group.enabled, false);
    assert.ok((group.submenu as MenuItem[]).every((i) => i.enabled === false));
  }
});

test('menus: the app menu has ⌘, ⌘0–⌘4, ⌘W, ⌘M, ⌘Q and the edit items', () => {
  const h = ports();
  const menu = appMenu(h.ports, Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins);
  assert.deepEqual(menu.map((m) => m.label), ['Agentic Complex', '文件', '编辑', '前往', '窗口']);
  const rows = (m: MenuItem) => (m.submenu as MenuItem[]).map((i) => (i.type === 'separator' ? '-' : `${i.label} ${i.accelerator}${i.role ? ` ${i.role}` : ''}`));
  assert.deepEqual(menu.map(rows), [
    ['设置… Command+,', '-', '退出 Agentic Complex Command+Q'],
    ['关闭窗口 Command+W close'],
    ['撤销 Command+Z undo', '重做 Shift+Command+Z redo', '-', '剪切 Command+X cut', '复制 Command+C copy', '粘贴 Command+V paste',
      '全选 Command+A selectAll'],
    ['主页 Command+0', '工业简报 Command+1', '对话 Command+2', '记忆 Command+3', '角色 Command+4'],
    ['最小化 Command+M minimize'],
  ]);
  for (const m of [menu[0]!, menu[3]!]) for (const i of m.submenu as MenuItem[]) if (i.click) click(i);
  assert.deepEqual(h.calls, ['openMain "/settings"', 'quit', 'openMain "/home"', 'openMain "/overview"', 'openMain "/chat"', 'openMain "/memory"',
    'openMain "/character"']);
});

test('menus: 前往 leaves out the page of a plug-in that is off; 今天 is nowhere', () => {
  const on = Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins;
  const go = (plugins: Plugins) => (appMenu(ports().ports, plugins)[3]!.submenu as MenuItem[]).map((i) => i.label);
  assert.deepEqual(go({ ...on, daily_brief: false }), ['主页', '对话', '记忆', '角色']);
  assert.ok(!deepTitles(appMenu(ports().ports, on)).includes('今天'));
});

test('menus: on Windows Ctrl+0–4 and Ctrl+, open the app menu\'s pages, gated by the plug-ins alike; the Mac\'s menu has its own', () => {
  const on = Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins;
  const key = (k: string, mods: Partial<Record<'control' | 'alt' | 'shift' | 'meta', boolean>> = { control: true }, type = 'keyDown') =>
    ({ type, key: k, control: false, alt: false, shift: false, meta: false, ...mods });
  const routes = ['0', '1', '2', '3', '4', ',', '5', '7'].map((k) => pageShortcut('windows', key(k), on));
  assert.deepEqual(routes, ['/home', '/overview', '/chat', '/memory', '/character', '/settings', null, null]);
  const h = ports();
  for (const m of [appMenu(h.ports, on)[0]!, appMenu(h.ports, on)[3]!]) for (const i of m.submenu as MenuItem[]) if (i.id !== 'quit' && i.click) click(i);
  assert.deepEqual(h.calls.map((c) => JSON.parse(c.slice('openMain '.length)) as string).sort(), routes.filter((r) => r !== null).sort(),
    'the same pages as the menu');
  assert.equal(pageShortcut('windows', key('1'), { ...on, daily_brief: false }), null, 'its plug-in is off');
  for (const mods of [{}, { control: true, shift: true }, { control: true, alt: true }, { meta: true }]) {
    assert.equal(pageShortcut('windows', key('2', mods), on), null, JSON.stringify(mods));
  }
  assert.equal(pageShortcut('windows', key('2', { control: true }, 'keyUp'), on), null);
  assert.equal(pageShortcut('mac', key('2'), on), null);
});

const status = (s: Partial<MenuBarStatus> = {}): MenuBarStatus => ({ agentdConnected: true, childFailed: false, restarting: false,
  pendingApprovals: 0, recording: false, avatarHidden: false, switching: false, observationPaused: false, meetingMode: false,
  clickThroughAll: false, quietUntil: null, ...s });

test('menus: the icon state follows MenuBarIconState.resolve', () => {
  assert.equal(iconState(status()), 'normal');
  assert.equal(iconState(status({ pendingApprovals: 2 })), 'pendingApproval');
  assert.equal(iconState(status({ agentdConnected: false, pendingApprovals: 2 })), 'error');
  assert.equal(iconState(status({ childFailed: true, recording: true })), 'recording');
  assert.equal(iconState(status({ pendingApprovals: 1, switching: true })), 'pendingApproval');
  assert.equal(iconState(status({ switching: true, meetingMode: true })), 'switching');
  assert.equal(iconState(status({ meetingMode: true, clickThroughAll: true })), 'clickThroughAll');
  assert.equal(iconState(status({ avatarHidden: true, observationPaused: true })), 'observationPaused');
  assert.equal(iconState(status({ avatarHidden: true })), 'hidden');
  assert.equal(iconState(status({ agentdConnected: false, restarting: true, pendingApprovals: 1 })), 'restarting');
  assert.equal(iconState(status({ restarting: true, pendingApprovals: 1 })), 'pendingApproval');
  assert.equal(iconState(status({ restarting: true, switching: true })), 'restarting');
  assert.equal(iconState(status({ childFailed: true, restarting: true })), 'error');
  assert.equal(iconState(status({ agentdConnected: false })), 'error');
  assert.equal(iconState(status({ quietUntil: 1, meetingMode: true, observationPaused: true })), 'quiet');
  // The process part of the menu bar status.
  const running = { kind: 'running' } as const;
  assert.deepEqual(processStatus(false, running, running, [running, running]), { agentdConnected: true, childFailed: false, restarting: false });
  assert.deepEqual(processStatus(false, { kind: 'backoff', seconds: 5 }, running, [running]), { agentdConnected: false, childFailed: false, restarting: true });
  assert.deepEqual(processStatus(false, running, { kind: 'portInUse' }, [{ kind: 'portInUse' }, running]),
    { agentdConnected: true, childFailed: true, restarting: false });
  assert.equal(processStatus(true, running, running, []).childFailed, true);
});

test('menus: each icon is 18 pt high, as wide as its mark or badge, black with alpha only', () => {
  const widths = Object.fromEntries((['normal', 'error', 'hidden', 'recording', 'switching', 'restarting', 'observationPaused',
    'meetingMode', 'quiet', 'clickThroughAll', 'pendingApproval'] as const).map((s) => [s, iconBitmap(s, 3).width]));
  assert.deepEqual(widths, { normal: 36, error: 36, hidden: 36, recording: 56, switching: 56, restarting: 56, observationPaused: 56,
    meetingMode: 56, quiet: 56, clickThroughAll: 56, pendingApproval: 54 });
  const alpha = (b: ReturnType<typeof iconBitmap>, x: number, y: number) => b.pixels[(Math.round(y * 2) * b.width + Math.round(x * 2)) * 4 + 3]!;
  const normal = iconBitmap('normal');
  assert.equal(normal.height, 36);
  assert.ok(normal.pixels.every((v, i) => i % 4 === 3 || v === 0));
  assert.equal(alpha(normal, 9, 15.5), 255, 'the base line');
  assert.equal(alpha(normal, 9, 10), 0, 'hollow');
  assert.equal(alpha(iconBitmap('error'), 9, 9.5), 255, 'the error bar');
  // The dashed triangle has gaps along its base.
  const hidden = iconBitmap('hidden');
  const base = Array.from({ length: 24 }, (_, i) => alpha(hidden, 3 + i * 0.5, 15.5));
  assert.ok(base.some((a) => a < 200) && base.some((a) => a === 255));
  assert.equal(alpha(iconBitmap('recording'), 24, 9), 255, 'the filled dot');
  // The badge: the capsule is filled, the count knocked out of it, a gap cut around it.
  const pending = iconBitmap('pendingApproval', 3);
  assert.equal(alpha(pending, 16.5, 6), 255);
  assert.equal(alpha(pending, 21, 2.5), 0, 'the 3 is knocked out');
  assert.equal(iconBitmap('pendingApproval', 12).width, 2 * 27);
});

test('menus: on Windows each icon is centred on a square, white on a dark taskbar and black on a light one', () => {
  const at = (b: { width: number; pixels: Uint8Array }, x: number, y: number) => [...b.pixels.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4)];
  const quiet = iconBitmap('quiet'), dark = squareIcon(quiet, true), light = squareIcon(quiet, false);
  assert.deepEqual([dark.width, dark.height, dark.pixels.length], [56, 56, 56 * 56 * 4]);
  // The base line's pixel (18, 31), moved down by (56 - 36) / 2.
  assert.deepEqual(at(quiet, 18, 31), [0, 0, 0, 255]);
  assert.deepEqual(at(dark, 18, 41), [255, 255, 255, 255]);
  assert.deepEqual(at(light, 18, 41), [0, 0, 0, 255]);
  assert.deepEqual(at(dark, 18, 5), [0, 0, 0, 0], 'the padding is clear');
  const normal = squareIcon(iconBitmap('normal'), true);
  assert.deepEqual([normal.width, normal.height], [36, 36]);
  assert.deepEqual(normal.pixels, iconBitmap('normal').pixels.map((v, i, p) => (i % 4 === 3 ? v : p[i - (i % 4) + 3]!)));
});
