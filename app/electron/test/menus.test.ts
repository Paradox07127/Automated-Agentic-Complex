// The tray menu, the app menu and the menu bar icon (src/main/menus/, src/common/menus.ts).
// Only templates are checked: no menu pops up and no tray icon changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow } from 'electron';
import { iconState, MENU_STATE_DEFAULTS, type MenuBarStatus, type MenuState, processStatus, quietUntil } from '../src/common/menus.ts';
import { PLUGIN_IDS, type Plugins } from '../src/common/plugins.ts';
import { appMenu, pageShortcut } from '../src/main/menus/app.ts';
import { makeOverlay } from '../src/main/platform/index.ts';
import { iconBitmap, squareIcon } from '../src/main/menus/icon.ts';
import { type MenuItem, type MenuPorts, SettingsChanges } from '../src/main/menus/items.ts';
import { trayContextMenu, trayMenu } from '../src/main/menus/tray.ts';

/** MenuBarMenuState.sample. */
const SAMPLE: MenuState = {
  ...MENU_STATE_DEFAULTS,
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
    openMain: rec('openMain'), quit: rec('quit'), log: rec('log'),
    openAnnouncement: rec('openAnnouncement'), markAllAnnouncementsRead: rec('markAllAnnouncementsRead'),
    setQuiet: async (until) => { calls.push(`setQuiet ${until}`); },
    toggleFreeRoam: rec('toggleFreeRoam'), settingsChanged: rec('settingsChanged'),
    resetPosition: rec('resetPosition'), switchCharacter: rec('switchCharacter'), switchAppearance: rec('switchAppearance'),
    restartChildren: rec('restartChildren'), resetPanels: rec('resetPanels'),
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
    '打开主页', '对话',
    '最近播报', '● claude:agentd 在等你批准', '● codex 会话没能启动', 'HostLink 的 click 已经接上', '已跳转到 Terminal',
    'TTS 隧道断开', '全部标为已读',
    '免打扰', '30 分钟', '1 小时', '到明早 7:00', '结束免打扰', '自由活动', '放回默认位置', '复位浮窗',
    '切换角色', '示例甲', '示例乙', '角色卡…', '外观', '标准制服', '外勤', '休息日',
    '设置…', '诊断', '对话轮次', '重启后台和角色', '退出 Agentic Complex',
  ]);
  // Separators after 对话, 最近播报, 复位浮窗, 外观.
  assert.deepEqual(menu.flatMap((i, n) => (i.type === 'separator' ? [menu[n - 1]!.label] : [])), ['对话', '最近播报', '复位浮窗', '外观']);
  assert.deepEqual(sub(menu, '免打扰').map((i) => i.type ?? i.label), ['30 分钟', '1 小时', '到明早 7:00', 'separator', '结束免打扰']);
});

test('menus: tray shortcuts, checks and greyed items follow the state; unread 最近播报 lead with a dot, not a check', () => {
  const menu = trayMenu(SAMPLE, ports().ports);
  const accel = Object.fromEntries(menu.filter((i) => i.accelerator).map((i) => [i.label, i.accelerator]));
  assert.deepEqual(accel, { 打开主页: 'Command+0', 对话: 'Command+J', '设置…': 'Command+,', '退出 Agentic Complex': 'Command+Q' });
  const recent = sub(menu, '最近播报');
  assert.deepEqual(recent.slice(0, 5).map((i) => [i.label, i.type, i.checked, i.sublabel]), [
    ['● claude:agentd 在等你批准', undefined, undefined, '14:35'], ['● codex 会话没能启动', undefined, undefined, '14:40'],
    ['HostLink 的 click 已经接上', undefined, undefined, '14:32'], ['已跳转到 Terminal', undefined, undefined, '14:20'],
    ['TTS 隧道断开', undefined, undefined, '14:03']]);
  assert.equal(find(recent, '全部标为已读').enabled, true);
  assert.equal(find(sub(trayMenu({ ...SAMPLE, recent: [] }, ports().ports), '最近播报'), '全部标为已读').enabled, false);
  assert.equal(find(menu, '自由活动').checked, true);
  assert.equal(find(trayMenu({ ...SAMPLE, freeRoam: false }, ports().ports), '自由活动').checked, false);
  assert.equal(find(sub(menu, '切换角色'), '示例甲').checked, true);
  assert.equal(find(sub(menu, '外观'), '标准制服').checked, true);
  // Switching, one appearance.
  const switching = trayMenu({ ...SAMPLE, characterSwitching: true }, ports().ports);
  assert.equal(find(switching, '切换角色').enabled, false);
  assert.ok(sub(switching, '切换角色').filter((i) => i.label !== '角色卡…' && i.type !== 'separator').every((i) => i.enabled === false));
  assert.equal(find(switching, '外观').enabled, false);
  assert.ok(!titles(trayMenu({ ...SAMPLE, appearances: SAMPLE.appearances.slice(0, 1) }, ports().ports)).includes('外观'));
  const loading = sub(trayMenu({ ...SAMPLE, appearanceSwitchingTo: 'field' }, ports().ports), '外观');
  assert.deepEqual(loading.map((i) => [i.label, i.enabled]), [['标准制服', false], ['外勤 · 切换中…', false], ['休息日', false]]);
});

test('menus: on Windows the tray icon\'s menu is the Mac\'s without its Command+ shortcuts, a config error\'s included', () => {
  const deep = (menu: MenuItem[]): MenuItem[] => menu.flatMap((i) => [i, ...deep((i.submenu as MenuItem[] | undefined) ?? [])]);
  const h = ports();
  for (const s of [SAMPLE, { ...SAMPLE, configError: '请查看设置' }]) {
    const menu = trayContextMenu('windows', s, h.ports);
    assert.deepEqual(deepTitles(menu), deepTitles(trayMenu(s, h.ports)));
    assert.deepEqual(deep(menu).filter((i) => i.accelerator).map((i) => i.label), []);
  }
  const menu = trayContextMenu('windows', SAMPLE, h.ports);
  click(find(sub(menu, '切换角色'), '示例乙'));
  click(find(menu, '设置…'));
  click(find(menu, '退出 Agentic Complex'));
  assert.deepEqual(h.calls, ['switchCharacter "birch"', 'openMain "/settings"', 'quit']);
  assert.equal(find(trayContextMenu('mac', SAMPLE, h.ports), '退出 Agentic Complex').accelerator, 'Command+Q', 'the Mac keeps its own');
});

test('menus: a config error keeps only the error, 打开主页, 诊断, a grey 重启后台和角色 and 退出', () => {
  const h = ports();
  const menu = trayMenu({ ...SAMPLE, configError: '服务 tts 的地址无效' }, h.ports);
  assert.deepEqual(titles(menu), ['配置错误：服务 tts 的地址无效', '打开主页', '诊断', '重启后台和角色', '退出 Agentic Complex']);
  assert.equal(menu.filter((i) => i.type === 'separator').length, 2);
  assert.equal(find(menu, '配置错误：服务 tts 的地址无效').enabled, false);
  assert.equal(find(menu, '重启后台和角色').enabled, false);
  for (const label of ['打开主页', '诊断', '退出 Agentic Complex']) click(find(menu, label));
  assert.deepEqual(h.calls, ['openMain "/home"', 'openMain "/diag"', 'quit']);
});

test('menus: each tray item calls its port; a missing port greys its item', async () => {
  const h = ports();
  const menu = trayMenu(SAMPLE, h.ports);
  for (const label of ['打开主页', '对话', '自由活动', '放回默认位置', '复位浮窗', '设置…', '诊断', '对话轮次', '重启后台和角色',
    '退出 Agentic Complex']) click(find(menu, label));
  click(find(sub(menu, '最近播报'), '● codex 会话没能启动'));
  click(find(sub(menu, '最近播报'), '全部标为已读'));
  click(find(sub(menu, '切换角色'), '示例乙'));
  click(find(sub(menu, '切换角色'), '角色卡…'));
  click(find(sub(menu, '外观'), '外勤'));
  assert.deepEqual(h.calls, ['openMain "/home"', 'openMain "/chat"', 'toggleFreeRoam', 'settingsChanged ["stay_mode"]', 'resetPosition',
    'resetPanels', 'openMain "/settings"', 'openMain "/diag"', 'openMain "/diag?tab=turns"', 'restartChildren', 'quit',
    'openAnnouncement "a2"', 'markAllAnnouncementsRead', 'switchCharacter "birch"', 'openMain "/character"', 'switchAppearance "field"']);

  const bare = trayMenu(SAMPLE, ports(['setQuiet', 'toggleFreeRoam', 'resetPosition', 'resetPanels', 'switchCharacter', 'switchAppearance',
    'restartChildren', 'openAnnouncement', 'markAllAnnouncementsRead']).ports);
  for (const label of ['自由活动', '放回默认位置', '复位浮窗', '重启后台和角色']) {
    assert.equal(find(bare, label).enabled, false, label);
    assert.equal(find(bare, label).click, undefined, label);
  }
  assert.ok(sub(bare, '免打扰').every((i) => i.type === 'separator' || i.enabled === false));
  assert.ok(sub(bare, '最近播报').every((i) => i.type === 'separator' || i.enabled === false));
  assert.equal(find(sub(bare, '切换角色'), '示例甲').enabled, false);
  assert.equal(find(sub(bare, '切换角色'), '角色卡…').enabled, true);
  assert.equal(find(sub(bare, '外观'), '外勤').enabled, false);
  for (const label of ['打开主页', '对话', '设置…', '诊断', '对话轮次', '退出 Agentic Complex']) assert.equal(find(bare, label).enabled, true);
  await settle();
});

test('menus: 免打扰 sets quiet for its span, 结束免打扰 only while quiet; a failure is logged', async () => {
  const h = ports();
  const now = h.ports.now!();
  const quiet = sub(trayMenu(SAMPLE, h.ports), '免打扰');
  assert.equal(find(trayMenu(SAMPLE, h.ports), '免打扰').checked, false);
  assert.equal(find(quiet, '结束免打扰').enabled, false);
  for (const label of ['30 分钟', '1 小时', '到明早 7:00']) click(find(quiet, label));
  const on = sub(trayMenu({ ...SAMPLE, quiet: true }, h.ports), '免打扰');
  assert.equal(find(trayMenu({ ...SAMPLE, quiet: true }, h.ports), '免打扰').checked, true);
  click(find(on, '结束免打扰'));
  await settle();
  assert.deepEqual(h.calls, [`setQuiet ${now / 1000 + 1800}`, `setQuiet ${now / 1000 + 3600}`,
    `setQuiet ${quietUntil('untilMorning', now)}`, 'setQuiet null']);
  const failing = ports();
  failing.ports.setQuiet = async () => { throw new Error('agentd 不在'); };
  click(find(sub(trayMenu(SAMPLE, failing.ports), '免打扰'), '1 小时'));
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
  click(find(trayMenu(SAMPLE, h.ports), '自由活动'));
  changes.changed(['no_such_key']);
  cancel();
  changes.changed(['stay_mode']);
  assert.deepEqual(h.calls, ['toggleFreeRoam']);
  assert.deepEqual(events, ['change {"ids":["beh.stay"]}']);
});

test('menus: the app menu has ⌘, ⌘0–⌘4, ⌘W, ⌘M, ⌘Q and the edit items', () => {
  const h = ports();
  const menu = appMenu(h.ports, Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins);
  assert.deepEqual(menu.map((m) => m.label), ['Agentic Complex', '文件', '编辑', '前往', '窗口']);
  const rows = (m: MenuItem) => (m.submenu as MenuItem[]).map((i) => (i.type === 'separator' ? '-' : `${i.label} ${i.accelerator}${i.role ? ` ${i.role}` : ''}`));
  assert.deepEqual(menu.map(rows), [
    ['设置… Command+,', '-', '退出 Agentic Complex Command+Q'],
    ['关闭窗口 Command+W'],
    ['撤销 Command+Z undo', '重做 Shift+Command+Z redo', '-', '剪切 Command+X cut', '复制 Command+C copy', '粘贴 Command+V paste',
      '全选 Command+A selectAll'],
    ['主页 Command+0', '每日简报 Command+1', '对话 Command+2', '记忆 Command+3', '角色 Command+4'],
    ['最小化 Command+M minimize'],
  ]);
  for (const m of [menu[0]!, menu[3]!]) for (const i of m.submenu as MenuItem[]) if (i.click) click(i);
  assert.deepEqual(h.calls, ['openMain "/settings"', 'quit', 'openMain "/home"', 'openMain "/overview"', 'openMain "/chat"', 'openMain "/memory"',
    'openMain "/character"']);
});

test('menus: ⌘W closes the focused window, never a desktop overlay', () => {
  const close = (appMenu(ports().ports, Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins)[1]!.submenu as MenuItem[])[0]!;
  const closed: string[] = [];
  const win = (name: string) => ({ close: () => closed.push(name), setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, setIgnoreMouseEvents() {},
    setHiddenInMissionControl() {} }) as unknown as BrowserWindow;
  const main = win('main'), console = win('console');
  makeOverlay(console, 'console', null);
  const press = close.click as (item: unknown, focused: BrowserWindow | undefined, event: unknown) => void;
  press(close, console, {});
  press(close, undefined, {});
  press(close, main, {});
  assert.deepEqual(closed, ['main']);
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
  assert.deepEqual(widths, { normal: 36, error: 56, hidden: 36, recording: 56, switching: 56, restarting: 56, observationPaused: 56,
    meetingMode: 56, quiet: 56, clickThroughAll: 56, pendingApproval: 54 });
  const alpha = (b: ReturnType<typeof iconBitmap>, x: number, y: number) => b.pixels[(Math.round(y * 2) * b.width + Math.round(x * 2)) * 4 + 3]!;
  const normal = iconBitmap('normal');
  assert.equal(normal.height, 36);
  assert.ok(normal.pixels.every((v, i) => i % 4 === 3 || v === 0));
  // The mark: the chevron's apex and legs, its hollow counter, the diamond, the orbit with a gap above it, no leg below it.
  assert.equal(alpha(normal, 9, 3.5), 255, 'the apex');
  assert.equal(alpha(normal, 6.2, 10), 255, 'the left leg');
  assert.equal(alpha(normal, 11.8, 10), 255, 'the right leg');
  assert.equal(alpha(normal, 9, 8.5), 0, 'the counter');
  assert.equal(alpha(normal, 9, 11.7), 255, 'the diamond');
  assert.equal(alpha(normal, 9, 13), 0, 'the gap above the orbit');
  assert.equal(alpha(normal, 9, 14), 255, 'the orbit');
  assert.equal(alpha(normal, 3, 15.5), 0, 'the leg ends at the orbit');
  const error = iconBitmap('error');
  assert.deepEqual([alpha(error, 24, 6), alpha(error, 24, 11.6)], [255, 255], 'the bar and the dot after the mark');
  // Hidden: the chevron's outline alone, dashed along its outer right edge.
  const hidden = iconBitmap('hidden');
  const edge = Array.from({ length: 24 }, (_, i) => alpha(hidden, 9 + i * 0.5 * 0.508, 1.5 + i * 0.5));
  assert.ok(edge.some((a) => a < 200) && edge.some((a) => a === 255));
  assert.equal(alpha(hidden, 9, 11.7), 0, 'no diamond');
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
  // The orbit's pixel (18, 28), moved down by (56 - 36) / 2.
  assert.deepEqual(at(quiet, 18, 28), [0, 0, 0, 255]);
  assert.deepEqual(at(dark, 18, 38), [255, 255, 255, 255]);
  assert.deepEqual(at(light, 18, 38), [0, 0, 0, 255]);
  assert.deepEqual(at(dark, 18, 5), [0, 0, 0, 0], 'the padding is clear');
  const normal = squareIcon(iconBitmap('normal'), true);
  assert.deepEqual([normal.width, normal.height], [36, 36]);
  assert.deepEqual(normal.pixels, iconBitmap('normal').pixels.map((v, i, p) => (i % 4 === 3 ? v : p[i - (i % 4) + 3]!)));
});
