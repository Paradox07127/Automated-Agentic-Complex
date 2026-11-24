// The menus' state, ports and menu bar icon as index.ts wires them (src/main/menus/shell.ts) on fake ports: the menu
// state, the status icon, the menu actions' features, appearance switches, pending approvals and recording.
// No menu pops up and no tray icon is set: the icon is the bitmap handed to `setIcon`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservationState } from '../src/common/desktop-action.ts';
import { RecentAnnouncements } from '../src/common/recent-announcements.ts';
import type { MenuBarIconState } from '../src/common/menus.ts';
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
    appearances: [{ id: 'standard', name: '标准制服' }, { id: 'field', name: '外勤' }], appearanceSwitching: false,
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
  const looks = { setAppearance: async (id: string) => { calls.push(`setAppearance ${id}`); } };
  const desktop = { resetOffsets: () => calls.push('resetOffsets') };
  const options: ShellMenusOptions = {
    settings: () => ({}),
    characters: () => [{ id: 'aster', name: '示例甲' }, { id: 'birch', name: '示例乙' }], launched: 'aster',
    processes: () => ({ agentdConnected: true, childFailed: false, restarting: false }),
    link, looks, switcher, observation, pushToTalk, interaction: null,
    desktop: () => desktop, placer: () => null,
    restartChildren: () => calls.push('restartChildren'),
    openMain: (route) => calls.push(`openMain ${route}`), quit: () => calls.push('quit'),
    log: (line) => calls.push(`log ${line}`),
    setIcon: (icon) => icons.push(icon),
    ...over,
  };
  const menus = shellMenus(options);
  return { menus, calls, icons, loads, link, state, switcher, pushToTalk };
}

const icon = (s: MenuBarIconState, badge = 0) => iconBitmap(s, badge);

test('menuState: 外观 lists her appearances with the current one checked; a pick goes through the look switch', async () => {
  const h = setup();
  const s = h.menus.state();
  assert.deepEqual(s.appearances, [{ id: 'standard', name: '标准制服' }, { id: 'field', name: '外勤' }]);
  assert.equal(s.currentAppearance, 'standard');
  assert.equal(s.appearanceSwitchingTo, null);
  const looks = sub(trayMenu(s, h.menus.ports()), '外观');
  assert.deepEqual(looks.map((i) => [i.label, i.checked, i.enabled]), [['标准制服', true, true], ['外勤', false, true]]);
  click(find(looks, '外勤'));
  await settle();
  assert.deepEqual(h.calls, ['setAppearance field']);
  // The target of a running switch is not known, so the group greys without a mark.
  h.link.appearanceSwitching = true;
  assert.equal(h.menus.state().appearanceSwitchingTo, '');
  assert.equal(find(trayMenu(h.menus.state(), h.menus.ports()), '外观').enabled, false);
});

test('a look switch that fails is logged', async () => {
  const h = setup({ looks: { setAppearance: async () => { throw new Error('角色没有连上，或者正在换外观'); } } });
  h.menus.ports().switchAppearance!('field');
  await settle();
  assert.deepEqual(h.calls, ['log appearance id=field failed: 角色没有连上，或者正在换外观']);
});

test('icon: the pending count from StackSource.onCount shows as the badge, redrawn only when it changes', () => {
  const h = setup();
  h.menus.pendingApprovalsChanged(2);
  h.menus.pendingApprovalsChanged(2);
  h.menus.pendingApprovalsChanged(0);
  assert.deepEqual(h.icons, [icon('pendingApproval', 2), icon('normal')]);
});

test('icon: redrawn when recording starts and when it ends', () => {
  const h = setup();
  h.pushToTalk.held = true;
  h.menus.refreshIcon();
  h.pushToTalk.held = false;
  h.menus.refreshIcon();
  assert.deepEqual(h.icons, [icon('recording'), icon('normal')]);
});

test('icon: redrawn when quiet starts and ends from the menu, after agentd answers', async () => {
  const h = setup();
  const ports = h.menus.ports();
  await ports.setQuiet!(1_900_000_000);
  assert.deepEqual(h.icons, [icon('quiet')]);
  await ports.setQuiet!(null);
  assert.deepEqual(h.icons, [icon('quiet'), icon('normal')]);
});

test('icon: a menu opened while agentd runs reads /state again and redraws (refreshObservationState)', async () => {
  const h = setup();
  h.menus.state();
  await settle();
  assert.equal(h.loads.n, 1);
  assert.deepEqual(h.icons, [icon('normal')]);
  const off = setup({ processes: () => ({ agentdConnected: false, childFailed: false, restarting: true }) });
  off.menus.state();
  await settle();
  assert.deepEqual([off.loads.n, off.icons.length], [0, 0]);
});

test('icon: redrawn when a character switch starts and when it ends', () => {
  const h = setup();
  h.switcher.busy = true;
  h.menus.refreshIcon();
  h.switcher.busy = false;
  h.menus.refreshIcon();
  assert.deepEqual(h.icons, [icon('switching'), icon('normal')]);
});

test('menuState keeps what index.ts filled: roster, 自由活动, and the config error without a roster', () => {
  const h = setup({ settings: () => ({ stay_mode: 'stay' }) });
  const s = h.menus.state();
  assert.deepEqual([s.currentCharacter, s.characterSwitching, s.freeRoam, s.configError], ['aster', false, false, null]);
  const failed = setup({ characters: () => null, link: null });
  const f = failed.menus.state();
  assert.equal(f.configError, '请查看设置');
  assert.equal(trayMenu(f, failed.menus.ports())[0]!.label, '配置错误：请查看设置', 'said once');
  assert.deepEqual([f.characters, f.currentCharacter, f.appearances], [[], 'aster', []]);
});

test('复位浮窗 resets the desktop panels\' offsets; without the panels it is grey', () => {
  const h = setup();
  click(find(trayMenu(h.menus.state(), h.menus.ports()), '复位浮窗'));
  assert.deepEqual(h.calls, ['resetOffsets']);
  const bare = setup({ desktop: () => null });
  assert.equal(find(trayMenu(bare.menus.state(), bare.menus.ports()), '复位浮窗').enabled, false);
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
  assert.deepEqual(rows.map((i) => [i.label, i.sublabel]), [['● 第 2 条', '14:36'], ['● 第 1 条', '14:35'],
    [undefined, undefined], ['全部标为已读', undefined]]);
  click(find(rows, '● 第 1 条'));
  click(find(rows, '● 第 2 条'));
  // SessionPanel.show(select:): the sessions route with `sel`; one without a session leads nowhere.
  assert.deepEqual(h.calls, ['openMain /overview?sel=own:a%26b&focus=task-own:a%26b']);
  assert.deepEqual(h.menus.state().recent.map((a) => a.unread), [false, false]);
  recent.receive(announce(3), Date.now());
  click(find(sub(trayMenu(h.menus.state(), h.menus.ports()), '最近播报'), '全部标为已读'));
  assert.deepEqual(h.menus.state().recent.map((a) => a.unread), [false, false, false]);
  assert.equal(find(sub(trayMenu(h.menus.state(), h.menus.ports()), '最近播报'), '全部标为已读').enabled, false);
  const none = setup();
  assert.deepEqual(none.menus.state().recent, []);
  assert.equal(none.menus.ports().openAnnouncement, undefined);
});
