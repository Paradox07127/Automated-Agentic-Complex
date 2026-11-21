// The menus' state, ports and menu bar icon as index.ts wires them (src/main/menus/shell.ts) on fake ports: the menu
// state, the status icon, the menu actions' features, appearance and layer switches, pending approvals and recording.
// No menu pops up and no tray icon is set: the icon is the bitmap handed to `setIcon`.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Actions } from '../src/common/c3.ts';
import type { Playlist } from '../src/common/character.ts';
import type { ObservationState } from '../src/common/desktop-action.ts';
import type { PlaylistState } from '../src/common/playlist.ts';
import { PLUGIN_IDS, type Plugins, shellPlan } from '../src/common/plugins.ts';
import { RecentAnnouncements } from '../src/common/recent-announcements.ts';
import type { MenuBarIconState } from '../src/common/menus.ts';
import { avatarMenu } from '../src/main/menus/avatar.ts';
import { iconBitmap } from '../src/main/menus/icon.ts';
import type { MenuItem } from '../src/main/menus/items.ts';
import { shellMenus, type ShellMenusOptions } from '../src/main/menus/shell.ts';
import { trayMenu } from '../src/main/menus/tray.ts';

function find(menu: MenuItem[], label: string): MenuItem {
  const found = menu.find((i) => i.label === label);
  assert.ok(found, `no item ${label}`);
  return found;
}
const sub = (menu: MenuItem[], label: string) => find(menu, label).submenu as MenuItem[];
const click = (i: MenuItem) => (i.click as () => void)();
/** Lets a port's promise settle. */
const settle = () => new Promise((r) => setImmediate(r));

/** Shell menus on fake ports; `calls` records what the ports were asked, `icons` each icon set. */
function setup(over: Partial<ShellMenusOptions> = {}) {
  const calls: string[] = [];
  const icons: ReturnType<typeof iconBitmap>[] = [];
  /** `GET /state` reads. */
  const loads = { n: 0 };
  const link = {
    hidden: false, clickThroughAll: false, currentCharacter: 'aster' as string | null, currentAppearance: 'standard' as string | null,
    capabilities: ['capture'],
    appearances: [{ id: 'standard', name: '标准制服' }, { id: 'field', name: '外勤' }],
    layers: [{ id: 'coat', name: '外套' }, { id: 'hat', name: '帽子', appearances: ['field'] }, { id: 'bag', name: '挎包', appearances: ['standard'] }],
    hiddenLayers: ['bag'], appearanceSwitching: false, layersSwitching: false,
    capture: async (background: string) => {
      calls.push(`capture ${background}`);
      return { file: 'shot.png', width: 10, height: 10 };
    },
    /** What `actions` answers; null rejects. */
    actionRows: [] as { id: string; name: string }[] | null,
    actions: async (character: string): Promise<Actions> => {
      calls.push(`actions ${character}`);
      if (link.actionRows === null) throw new Error('角色没有回应');
      return { v: 1, type: 'actions', character, switches: {}, actions: link.actionRows.map((a) => ({ ...a, section: 'mmd', duration: null,
        trigger: '', required_reason: null, missing: null })) };
    },
  };
  const state: ObservationState = { pausedUntil: null, meeting: false, off: false, quietUntil: null };
  const observation = {
    state, quietUntil: () => state.quietUntil,
    load: async () => { loads.n += 1; },
    setQuiet: async (until: number | null) => {
      calls.push(`setQuiet ${until}`);
      state.quietUntil = until;
    },
  };
  const switcher = { busy: false, select: (id: string) => { calls.push(`select ${id}`); } };
  const pushToTalk = { held: false };
  const looks = {
    setAppearance: async (id: string) => { calls.push(`setAppearance ${id}`); },
    setLayers: async (hidden: string[]) => { calls.push(`setLayers ${hidden.join(',')}`); },
  };
  const desktop = { openQuickInput: () => calls.push('openQuickInput'), notice: (t: string) => calls.push(`notice ${t}`),
    resetOffsets: () => calls.push('resetOffsets') };
  const dir = mkdtempSync(join(tmpdir(), 'menu-shell-'));
  const options: ShellMenusOptions = {
    settings: () => ({}), plan: () => shellPlan(Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as Plugins),
    characters: () => [{ id: 'aster', name: '示例甲' }, { id: 'birch', name: '示例乙' }], launched: 'aster',
    services: () => ['角色 · 运行中', '后台 · 运行中'],
    processes: () => ({ agentdConnected: true, childFailed: false, restarting: false }),
    link, looks, switcher, observation, camera: null, pushToTalk, context: null, interaction: null,
    desktop: () => desktop, placer: () => null,
    capture: { dir: join(dir, 'captures'), saved: (file) => calls.push(`saved ${file}`) },
    setHidden: (hidden) => calls.push(`setHidden ${hidden}`), restartChildren: () => calls.push('restartChildren'),
    openMain: (route) => calls.push(`openMain ${route}`), quit: () => calls.push('quit'),
    settingsChanged: (keys) => calls.push(`settingsChanged ${keys.join(',')}`), log: (line) => calls.push(`log ${line}`),
    setIcon: (icon) => icons.push(icon),
    ...over,
  };
  const menus = shellMenus(options);
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { menus, calls, icons, loads, link, state, switcher, pushToTalk, dir, done };
}

const icon = (s: MenuBarIconState, badge = 0) => iconBitmap(s, badge);

test('menuState: 外观 lists her appearances with the current one checked; a pick goes through the look switch', async () => {
  const h = setup();
  const s = h.menus.state();
  assert.deepEqual(s.appearances, [{ id: 'standard', name: '标准制服' }, { id: 'field', name: '外勤' }]);
  assert.equal(s.currentAppearance, 'standard');
  assert.equal(s.appearanceSwitchingTo, null);
  const looks = sub(sub(avatarMenu(s, h.menus.ports()), '角色'), '外观');
  assert.deepEqual(looks.map((i) => [i.label, i.checked, i.enabled]), [['标准制服', true, true], ['外勤', false, true]]);
  assert.ok(find(trayMenu(s, h.menus.ports()), '外观'));
  click(find(looks, '外勤'));
  await settle();
  assert.deepEqual(h.calls, ['setAppearance field']);
  // The target of a running switch is not known, so the group greys without a mark.
  h.link.appearanceSwitching = true;
  assert.equal(h.menus.state().appearanceSwitchingTo, '');
  assert.equal(find(sub(avatarMenu(h.menus.state(), h.menus.ports()), '角色'), '外观').enabled, false);
  h.done();
});

test('menuState: 服装分层 lists the layers of the current appearance, checked when shown; a click flips one', async () => {
  const h = setup();
  const s = h.menus.state();
  // A layer with an appearance list shows only under those.
  assert.deepEqual(s.layers, [{ id: 'coat', name: '外套', visible: true }, { id: 'bag', name: '挎包', visible: false }]);
  assert.equal(s.layersSwitching, false);
  const layers = sub(sub(avatarMenu(s, h.menus.ports()), '角色'), '服装分层');
  assert.deepEqual(layers.map((i) => [i.label, i.checked]), [['外套', true], ['挎包', false]]);
  click(find(layers, '外套'));
  click(find(layers, '挎包'));
  await settle();
  assert.deepEqual(h.calls, ['setLayers bag,coat', 'setLayers ']);
  h.link.layersSwitching = true;
  assert.equal(h.menus.state().layersSwitching, true);
  h.done();
});

test('a look switch that fails is logged', async () => {
  const h = setup({ looks: { setAppearance: async () => { throw new Error('角色没有连上，或者正在换外观'); },
    setLayers: async () => { throw new Error('这个角色没有这一层'); } } });
  const ports = h.menus.ports();
  ports.switchAppearance!('field');
  ports.toggleLayer!('coat');
  await settle();
  assert.deepEqual(h.calls, ['log appearance id=field failed: 角色没有连上，或者正在换外观', 'log layers hidden=bag,coat failed: 这个角色没有这一层']);
  h.done();
});

test('更多 › 保存截图: she writes into the capture directory, made first, and the user is told the file', async () => {
  const h = setup();
  const s = h.menus.state();
  assert.equal(s.canCapture, true);
  const item = find(sub(avatarMenu(s, h.menus.ports()), '更多'), '保存截图');
  assert.equal(item.enabled, true);
  click(item);
  await settle();
  assert.ok(existsSync(join(h.dir, 'captures')));
  assert.deepEqual(h.calls, ['capture transparent', 'saved shot.png']);
  h.done();
});

test('把剪贴板交给她 runs the port the shell gives; greyed without one', () => {
  const handed: string[] = [];
  const h = setup({ handClipboard: () => handed.push('handClipboard') });
  click(find(sub(avatarMenu(h.menus.state(), h.menus.ports()), '给她看'), '把剪贴板交给她'));
  assert.deepEqual(handed, ['handClipboard']);
  h.done();
  const none = setup();
  assert.equal(find(sub(avatarMenu(none.menus.state(), none.menus.ports()), '给她看'), '把剪贴板交给她').enabled, false);
  none.done();
});

test('框选给她看… runs the port the shell gives; greyed without one', () => {
  const asked: string[] = [];
  const h = setup({ selectRegion: () => asked.push('selectRegion') });
  click(find(sub(avatarMenu(h.menus.state(), h.menus.ports()), '给她看'), '框选给她看…'));
  assert.deepEqual(asked, ['selectRegion']);
  h.done();
  const none = setup();
  assert.equal(find(sub(avatarMenu(none.menus.state(), none.menus.ports()), '给她看'), '框选给她看…').enabled, false);
  none.done();
});

test('更多 › 调整镜头… begins camera mode; greyed without a camera', () => {
  const began: string[] = [];
  const camera = { poses: { state: () => null }, poseActions: { setPose() {}, togglePoseLock() {} }, camera: { begin: () => { began.push('begin'); return true; } } };
  const h = setup({ camera: camera as unknown as ShellMenusOptions['camera'] });
  const ports = h.menus.ports();
  ports.beginCamera!();
  assert.deepEqual(began, ['begin']);
  h.done();
  const none = setup();
  assert.equal(none.menus.ports().beginCamera, undefined);
  none.done();
});

test('更多 › 复位浮窗 puts the desktop panels back; greyed before the panels are made', () => {
  const h = setup();
  click(find(sub(avatarMenu(h.menus.state(), h.menus.ports()), '更多'), '复位浮窗'));
  assert.deepEqual(h.calls, ['resetOffsets']);
  h.done();
  const none = setup({ desktop: () => null });
  assert.equal(find(sub(avatarMenu(none.menus.state(), none.menus.ports()), '更多'), '复位浮窗').enabled, false);
  none.done();
});

test('icon: the pending count from StackSource.onCount shows as the badge, redrawn only when it changes', () => {
  const h = setup();
  h.menus.pendingApprovalsChanged(2);
  h.menus.pendingApprovalsChanged(2);
  h.menus.pendingApprovalsChanged(0);
  assert.deepEqual(h.icons, [icon('pendingApproval', 2), icon('normal')]);
  h.done();
});

test('icon: redrawn when recording starts and when it ends', () => {
  const h = setup();
  h.pushToTalk.held = true;
  h.menus.refreshIcon();
  h.pushToTalk.held = false;
  h.menus.refreshIcon();
  assert.deepEqual(h.icons, [icon('recording'), icon('normal')]);
  h.done();
});

test('icon: redrawn when quiet starts and ends from the menu, after agentd answers', async () => {
  const h = setup();
  const ports = h.menus.ports();
  await ports.setQuiet!(1_900_000_000);
  assert.deepEqual(h.icons, [icon('quiet')]);
  await ports.setQuiet!(null);
  assert.deepEqual(h.icons, [icon('quiet'), icon('normal')]);
  h.done();
});

test('icon: a menu opened while agentd runs reads /state again and redraws (refreshObservationState)', async () => {
  const h = setup();
  h.menus.state();
  await settle();
  assert.equal(h.loads.n, 1);
  assert.deepEqual(h.icons, [icon('normal')]);
  h.done();
  const off = setup({ processes: () => ({ agentdConnected: false, childFailed: false, restarting: true }) });
  off.menus.state();
  await settle();
  assert.deepEqual([off.loads.n, off.icons.length], [0, 0]);
  off.done();
});

test('icon: redrawn when a character switch starts and when it ends', () => {
  const h = setup();
  h.switcher.busy = true;
  h.menus.refreshIcon();
  h.switcher.busy = false;
  h.menus.refreshIcon();
  assert.deepEqual(h.icons, [icon('switching'), icon('normal')]);
  h.done();
});

test('menuState keeps what index.ts filled: rows, roster, hot keys, and the config error without a roster', () => {
  const h = setup({ settings: () => ({ hotkey_look: 'control+option+k', stay_mode: 'stay' }) });
  const s = h.menus.state();
  assert.deepEqual(s.services, [{ name: '角色', detail: '运行中' }, { name: '后台', detail: '运行中' }]);
  assert.deepEqual([s.currentCharacter, s.characterSwitching, s.freeRoam, s.lookHotkey, s.quickInputHotkey, s.configError],
    ['aster', false, false, 'control+option+k', 'control+option+space', null]);
  h.done();
  const failed = setup({ characters: () => null, link: null });
  const f = failed.menus.state();
  assert.equal(f.configError, '配置错误，请查看设置');
  assert.deepEqual([f.characters, f.currentCharacter, f.appearances, f.layers], [[], 'aster', [], []]);
  failed.done();
});

/** The main window's PlaylistHost as ops/avatar.ts `avatarPlaylist` hands it over; `lists` are the saved lists. */
function fakePlaylist(calls: string[], lists: Record<string, Playlist>) {
  return {
    state: { kind: 'idle' } as PlaylistState,
    saved: (character: string): Playlist => lists[character] ?? { items: [], loop: 'off', speed: 1 },
    save: (character: string, list: Playlist) => {
      calls.push(`save ${character} ${JSON.stringify(list)}`);
      lists[character] = list;
    },
    start: (index: number) => { calls.push(`start ${index}`); },
    stop: () => { calls.push('stop'); },
    playSlot: (id: string) => { calls.push(`playSlot ${id}`); },
  };
}

test('角色 › MMD: her mmd_ actions as the previous open read them, the saved list\'s first in its order', async () => {
  const calls: string[] = [];
  const playlist = fakePlaylist(calls, { aster: { items: ['mmd_c', 'mmd_a'], loop: 'one', speed: 1 } });
  const h = setup({ playlist: () => playlist });
  h.link.actionRows = [{ id: 'mmd_a', name: '舞一' }, { id: 'wave', name: '挥手' }, { id: 'mmd_b', name: '舞二' }, { id: 'mmd_c', name: '舞三' }];
  // This open shows the list the previous one fetched.
  assert.deepEqual(h.menus.state().motionSlots, []);
  await settle();
  const s = h.menus.state();
  assert.deepEqual(s.motionSlots, [{ id: 'mmd_c', name: '舞三' }, { id: 'mmd_a', name: '舞一' }, { id: 'mmd_b', name: '舞二' }]);
  assert.deepEqual([s.playingSlot, s.playlistLoop, s.playlistPlaying], [null, 'one', false]);
  const mmd = sub(sub(avatarMenu(s, h.menus.ports()), '角色'), 'MMD');
  assert.deepEqual(mmd.filter((i) => i.type !== 'separator').map((i) => i.label), ['舞三', '舞一', '舞二', '连播', '循环', '停止']);
  assert.deepEqual(h.calls.filter((c) => c.startsWith('actions')), ['actions aster', 'actions aster']);
  // A read that fails leaves no list.
  h.link.actionRows = null;
  await settle();
  h.menus.state();
  await settle();
  assert.deepEqual(h.menus.state().motionSlots, []);
  h.done();
});

test('角色 › MMD: a slot, 连播, 停止 and 循环 drive the playlist; the checked slot is the one played, else the list\'s item', async () => {
  const calls: string[] = [];
  const playlist = fakePlaylist(calls, { aster: { items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 2 }, birch: { items: ['mmd_z'], loop: 'all', speed: 1 } });
  const h = setup({ playlist: () => playlist });
  h.link.actionRows = [{ id: 'mmd_a', name: '舞一' }, { id: 'mmd_b', name: '舞二' }];
  h.menus.state();
  await settle();
  const ports = h.menus.ports();
  ports.playSlot!('mmd_b');
  playlist.state = { kind: 'playing', index: 0, playId: 'p1' };
  let s = h.menus.state();
  assert.deepEqual([s.playingSlot, s.playlistPlaying], ['mmd_b', true]);
  assert.equal(find(sub(sub(avatarMenu(s, ports), '角色'), 'MMD'), '停止').enabled, true);
  ports.playPlaylist!();
  playlist.state = { kind: 'playing', index: 0, playId: 'p2' };
  s = h.menus.state();
  assert.equal(s.playingSlot, 'mmd_a');
  ports.stopPlaylist!();
  playlist.state = { kind: 'idle' };
  assert.deepEqual([h.menus.state().playingSlot, h.menus.state().playlistPlaying], [null, false]);
  click(find(sub(sub(sub(avatarMenu(h.menus.state(), ports), '角色'), 'MMD'), '循环'), '全部'));
  ports.setPlaylistLoop!('sometimes');
  assert.deepEqual(calls, ['playSlot mmd_b', 'start 0', 'stop', 'save aster {"items":["mmd_a","mmd_b"],"loop":"all","speed":2}']);
  assert.equal(h.menus.state().playlistLoop, 'all');
  h.done();
});

test('角色 › MMD: without a playlist there is no submenu; a loop that cannot be saved is logged', async () => {
  const h = setup();
  h.link.actionRows = [{ id: 'mmd_a', name: '舞一' }];
  h.menus.state();
  await settle();
  assert.deepEqual(h.menus.state().motionSlots, []);
  assert.equal(h.menus.ports().playSlot, undefined);
  h.done();
  const calls: string[] = [];
  const playlist = { ...fakePlaylist(calls, {}), save: () => { throw new Error('config.json is not an object'); } };
  const g = setup({ playlist: () => playlist });
  g.menus.ports().setPlaylistLoop!('one');
  assert.deepEqual(g.calls.filter((c) => c.startsWith('log')), ['log playlist loop=one failed: config.json is not an object']);
  g.done();
});

const announce = (seq: number, extra: Record<string, unknown> = {}) => ({ event: 'announce', id: String(seq),
  data: JSON.stringify({ seq, level: 'P2', kind: 'session_done', headline: `第 ${seq} 条`, speak: false, ...extra }) });

test('最近播报: the history\'s rows, newest first; one opened is read and selects its session; 全部标为已读', () => {
  const recent = new RecentAnnouncements();
  const h = setup({ recent });
  recent.receive(announce(1, { session_id: 'own:a&b' }), new Date(2026, 10, 20, 14, 35).getTime());
  recent.receive(announce(2), new Date(2026, 10, 20, 14, 36).getTime());
  const s = h.menus.state();
  assert.deepEqual(s.recent, [{ id: 'announce-2', text: '第 2 条', time: '14:36', unread: true },
    { id: 'announce-1', text: '第 1 条', time: '14:35', unread: true }]);
  const rows = sub(trayMenu(s, h.menus.ports()), '最近播报');
  assert.deepEqual(rows.map((i) => [i.label, i.checked, i.sublabel]), [['第 2 条', true, '14:36'], ['第 1 条', true, '14:35'],
    [undefined, undefined, undefined], ['全部标为已读', undefined, undefined]]);
  click(find(rows, '第 1 条'));
  click(find(rows, '第 2 条'));
  // SessionPanel.show(select:): the sessions route with `sel`; one without a session leads nowhere.
  assert.deepEqual(h.calls, ['openMain /overview?sel=own:a%26b&focus=task-own:a%26b']);
  assert.deepEqual(h.menus.state().recent.map((a) => a.unread), [false, false]);
  recent.receive(announce(3), Date.now());
  click(find(sub(trayMenu(h.menus.state(), h.menus.ports()), '最近播报'), '全部标为已读'));
  assert.deepEqual(h.menus.state().recent.map((a) => a.unread), [false, false, false]);
  assert.equal(find(sub(trayMenu(h.menus.state(), h.menus.ports()), '最近播报'), '全部标为已读').enabled, false);
  h.done();
  const none = setup();
  assert.deepEqual(none.menus.state().recent, []);
  assert.equal(none.menus.ports().openAnnouncement, undefined);
  none.done();
});

test('option held: the state says so (showMenu(diagnostics:)); 诊断 stays out while the feature is absent', () => {
  const h = setup();
  assert.equal(h.menus.state().showsDiagnostics, false);
  const s = h.menus.state({ diagnostics: true });
  assert.equal(s.showsDiagnostics, true);
  assert.equal(trayMenu(s, h.menus.ports()).some((i) => i.label === '诊断'), false);
  h.done();
});
