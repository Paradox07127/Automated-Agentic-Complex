// The menu bar icon's menu, built afresh each time it opens.
import type { ShellPlatform } from '../../common/config.ts';
import { MENU_ROUTES, type MenuState } from '../../common/menus.ts';
import { appearanceItem, characterEntries, freeRoamItem, item, label, type MenuItem, type MenuPorts, page, quietItem, SEPARATOR,
  submenu } from './items.ts';

export function trayMenu(s: MenuState, ports: MenuPorts): MenuItem[] {
  const quit = () => ports.quit();
  const home = item('home', '打开主页', page(ports, MENU_ROUTES.home), { accelerator: 'Command+0' });
  const diag = item('diag', '诊断', page(ports, MENU_ROUTES.diag));
  const quitItem = item('quit', '退出 Agentic Complex', quit, { accelerator: 'Command+Q' });
  if (s.configError !== null) {
    return [
      label('configError', `配置错误：${s.configError}`), SEPARATOR, home, SEPARATOR, diag,
      item('restartChildren', '重启后台和角色', ports.restartChildren, { enabled: false }), quitItem,
    ];
  }
  const unread = s.recent.filter((a) => a.unread).length, open = ports.openAnnouncement;
  // A check would read as selected: the unread ones lead with a dot.
  const recent: MenuItem[] = [
    ...s.recent.map((a): MenuItem => ({ ...item(`announcement.${a.id}`, a.unread ? `● ${a.text}` : a.text, open && (() => open(a.id))),
      sublabel: a.time })),
    SEPARATOR, item('markAllRead', '全部标为已读', ports.markAllAnnouncementsRead, { enabled: unread > 0 }),
  ];
  const e: MenuItem[] = [
    home, item('conversation', '对话', page(ports, MENU_ROUTES.conversation), { accelerator: 'Command+J' }), SEPARATOR,
    submenu('recent', '最近播报', recent), SEPARATOR,
    quietItem(s, ports),
  ];
  const freeRoam = freeRoamItem(s, ports);
  if (freeRoam) e.push(freeRoam);
  e.push(item('resetPosition', '放回默认位置', ports.resetPosition), item('resetPanels', '复位浮窗', ports.resetPanels), SEPARATOR,
    submenu('characters', '切换角色', characterEntries(s, ports), { enabled: !s.characterSwitching }));
  const looks = appearanceItem(s, ports);
  if (looks) e.push(looks);
  e.push(SEPARATOR, item('settings', '设置…', page(ports, MENU_ROUTES.settings), { accelerator: 'Command+,' }),
    diag, item('turns', '对话轮次', page(ports, MENU_ROUTES.turns)),
    item('restartChildren', '重启后台和角色', ports.restartChildren), quitItem);
  return e;
}

/** The menu `trayClick` pops up: `trayMenu`, off the Mac without its Command+ shortcuts. */
export function trayContextMenu(platform: ShellPlatform, s: MenuState, ports: MenuPorts): MenuItem[] {
  if (platform === 'mac') return trayMenu(s, ports);
  return trayMenu(s, ports).map((i) => {
    const { accelerator, ...rest } = i;
    return accelerator?.startsWith('Command+') ? rest : i;
  });
}
