// config.json's `plugins`: what agentd is told, what this shell starts and which menu items show (src/common/plugins.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentdArguments } from '../src/common/agentd.ts';
import { ConfigError, parseConfig } from '../src/common/config.ts';
import { MENU_STATE_DEFAULTS } from '../src/common/menus.ts';
import { DEFAULT_PLUGINS, PLUGIN_IDS, type Plugins, shellPlan } from '../src/common/plugins.ts';
import { current, parseChanges, planSave, schema, settingValues, withSettings } from '../src/common/settings.ts';
import { avatarMenu } from '../src/main/menus/avatar.ts';
import type { MenuItem, MenuPorts } from '../src/main/menus/items.ts';
import { trayMenu } from '../src/main/menus/tray.ts';

const config = (o: Record<string, unknown> = {}) => parseConfig(JSON.stringify({
  agentd_dir: '/a/agentd', python: '/a/python', agentd_port: 48810, gpu_hold_files: [], characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app' }],
  support_dir: '/s', agentd_state_dir: '/st', ...o,
}), { supportDir: '/support', agentdStateDir: '/state', catalog: () => null });

const ctx = { launcherScript: '/r/agentd_launcher.py', parentPid: 42, character: 'aster' };

/** Each `--plugin-on`/`--plugin-off` of the command line, as `[flag, id]`. */
const pluginFlags = (args: string[]) => args.flatMap((a, i) => (a === '--plugin-on' || a === '--plugin-off' ? [[a, args[i + 1]!]] : []));

test('agentd gets one --plugin-on or --plugin-off for every plug-in: by default only light_ai is on, and no --observation-off', () => {
  const args = agentdArguments(config(), ctx);
  assert.deepEqual(pluginFlags(args), PLUGIN_IDS.map((id) => [id === 'light_ai' ? '--plugin-on' : '--plugin-off', id]));
  assert.equal(PLUGIN_IDS.length, 10);
  assert.ok(!args.includes('--observation-off'));
  assert.ok(!args.includes('--computer-control-socket'));
  const on = agentdArguments(config({ plugins: { screen_awareness: true, light_ai: false, computer_use: true } }), ctx);
  const flags = Object.fromEntries(pluginFlags(on).map(([flag, id]) => [id, flag]));
  assert.deepEqual([flags.screen_awareness, flags.light_ai, flags.computer_use, flags.coding_sessions],
    ['--plugin-on', '--plugin-off', '--plugin-on', '--plugin-off']);
  assert.deepEqual(on.slice(on.indexOf('--computer-control-socket'), on.indexOf('--computer-control-socket') + 4),
    ['--computer-control-socket', '/s/run/computer-control.sock', '--computer-control-token-file', '/s/run/computer-control.token']);
});

test('config.json without `plugins` reads the registry defaults; an id it names takes its value', () => {
  assert.deepEqual(config().plugins, DEFAULT_PLUGINS);
  assert.deepEqual(config({ plugins: { daily_brief: true } }).plugins, { ...DEFAULT_PLUGINS, daily_brief: true });
});

test('an unknown plug-in id, a value that is not a boolean or a `plugins` that is not an object is a config error', () => {
  assert.throws(() => config({ plugins: { screen_awarenes: true } }), (e: unknown) => e instanceof ConfigError && e.message === '未知插件 screen_awarenes');
  assert.throws(() => config({ plugins: { light_ai: 'yes' } }), (e: unknown) => e instanceof ConfigError && e.message === '字段 plugins.light_ai 类型错误');
  assert.throws(() => config({ plugins: ['light_ai'] }), (e: unknown) => e instanceof ConfigError && e.message === '字段 plugins 类型错误');
});

test('shellPlan: the surfaces and give-way always; screen awareness adds the recorders and the context capturer', () => {
  const plain = shellPlan(DEFAULT_PLUGINS);
  for (const s of ['surfaces', 'giveWay', 'pushToTalk'] as const) assert.ok(plain.has(s), s);
  for (const s of ['activity', 'timeline', 'context', 'control', 'attention', 'focusTurn', 'reading', 'hooks', 'sessions'] as const) {
    assert.ok(!plain.has(s), s);
  }
  const none = shellPlan(Object.fromEntries(PLUGIN_IDS.map((id) => [id, false])) as Plugins);
  assert.deepEqual([...none].sort(), ['giveWay', 'surfaces']);
  const aware = shellPlan({ ...DEFAULT_PLUGINS, screen_awareness: true });
  for (const s of ['activity', 'timeline', 'context', 'surfaces', 'giveWay'] as const) assert.ok(aware.has(s), s);
  assert.ok(!aware.has('reading') && !aware.has('control'));
  assert.ok(shellPlan({ ...DEFAULT_PLUGINS, computer_use: true }).has('control'));
  const reading = shellPlan({ ...DEFAULT_PLUGINS, screen_reading: true });
  assert.ok(reading.has('reading') && reading.has('context') && !reading.has('activity'));
});

test('settings: plugins.<id> rows restart the backend; they read from and write into config.json\'s `plugins` object', () => {
  const rows = schema().filter((r) => String(r.id).startsWith('plugins.'));
  assert.deepEqual(rows.map((r) => r.id), PLUGIN_IDS.map((id) => `plugins.${id}`));
  assert.ok(rows.every((r) => r.restart === 'backend' && r.kind === 'toggle' && r.group === 'plugins'));
  assert.equal(rows.find((r) => r.id === 'plugins.light_ai')!.default, true);
  assert.ok(!schema().some((r) => r.id === 'observe' || r.id === 'k_cu'));
  const saved = settingValues({ mute: true, plugins: { screen_awareness: true }, characters: [] });
  assert.deepEqual(saved, { mute: true, 'plugins.screen_awareness': true });
  assert.equal(current(saved, null).values['plugins.screen_awareness'], true);
  assert.equal(current(saved, null).values['plugins.coding_sessions'], false);
  const plan = planSave(saved, null, parseChanges({ 'plugins.coding_sessions': true }, () => {}));
  assert.deepEqual([plan.write, plan.restart], [{ 'plugins.coding_sessions': true }, 'backend']);
  assert.deepEqual(withSettings({ mute: true, plugins: { screen_awareness: true } }, plan.write),
    { mute: true, plugins: { screen_awareness: true, coding_sessions: true } });
});

/** Every port; none is called here. */
const PORTS: MenuPorts = {
  openMain: () => {}, quit: () => {}, log: () => {}, look: () => {}, quickInput: () => {}, handClipboard: () => {}, selectRegion: () => {},
};
const deepIds = (menu: MenuItem[]): string[] =>
  menu.flatMap((i) => (i.type === 'separator' ? [] : [String(i.id), ...deepIds((i.submenu as MenuItem[] | undefined) ?? [])]));

test('menus: with coding sessions off neither the tray nor her menu has the session items; with it on both do', () => {
  const off = { ...MENU_STATE_DEFAULTS, plan: shellPlan(DEFAULT_PLUGINS) };
  for (const menu of [trayMenu(off, PORTS), avatarMenu(off, PORTS), trayMenu({ ...off, configError: '配置错误' }, PORTS)]) {
    const ids = deepIds(menu);
    assert.ok(!ids.includes('sessions') && !ids.includes('pending'), ids.join(' '));
  }
  // Screen reading is off too.
  assert.ok(!deepIds(trayMenu(off, PORTS)).includes('look'));
  assert.ok(!deepIds(avatarMenu(off, PORTS)).some((id) => id === 'look' || id === 'selectRegion'));
  const on = { ...off, plan: shellPlan({ ...DEFAULT_PLUGINS, coding_sessions: true }) };
  assert.ok(deepIds(trayMenu(on, PORTS)).includes('sessions') && deepIds(trayMenu(on, PORTS)).includes('pending'));
  assert.ok(deepIds(avatarMenu(on, PORTS)).includes('pending'));
  assert.ok(deepIds(trayMenu({ ...on, configError: '配置错误' }, PORTS)).includes('sessions'));
});
