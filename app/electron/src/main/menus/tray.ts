// The menu bar icon's menu, built afresh each time it opens.
import type { ShellPlatform } from '../../common/config.ts';
import { ABSENT_FEATURES, MENU_ROUTES, type MenuState, menuAccelerator } from '../../common/menus.ts';
import { appearanceItem, characterEntries, clickThroughItem, freeRoamItem, hiddenItem, item, label, type MenuItem,
  type MenuPorts, page, quietItem, SEPARATOR, submenu } from './items.ts';

export function trayMenu(s: MenuState, ports: MenuPorts): MenuItem[] {
  const quit = () => ports.quit();
  const sessions = s.plan.has('sessions') ? [item('sessions', '会话面板', page(ports, MENU_ROUTES.sessions))] : [];
  if (s.configError !== null) {
    return [
      label('configError', `配置错误：${s.configError}`), SEPARATOR,
      item('home', '打开主窗口', page(ports, MENU_ROUTES.home), { accelerator: 'Command+0' }),
      item('conversation', '对话', page(ports, MENU_ROUTES.conversation), { accelerator: 'Command+J' }),
      ...sessions,
      SEPARATOR,
      item('restartChildren', '重启子进程', ports.restartChildren, { enabled: false }),
      item('quit', '退出', quit, { accelerator: 'Command+Q' }),
    ];
  }
  const unread = s.recent.filter((a) => a.unread).length, open = ports.openAnnouncement;
  const recent: MenuItem[] = [
    ...s.recent.map((a): MenuItem => ({ ...item(`announcement.${a.id}`, a.text, open && (() => open(a.id)), { checked: a.unread }),
      sublabel: a.time })),
    SEPARATOR, item('markAllRead', '全部标为已读', ports.markAllAnnouncementsRead, { enabled: unread > 0 }),
  ];
  const e: MenuItem[] = [
    ...s.services.map((r, i) => label(`service.${i}`, `${r.name} · ${r.detail}`)), SEPARATOR,
    item('home', '打开主窗口', page(ports, MENU_ROUTES.home), { accelerator: 'Command+0' }),
    item('conversation', '对话', page(ports, MENU_ROUTES.conversation), { accelerator: 'Command+J' }),
    ...(s.plan.has('approvals') ? [item('pending', '待处理', page(ports, MENU_ROUTES.pending))] : []),
    ...sessions,
    ...(s.plan.has('reading') ? [item('look', '屏幕识读', ports.look, { accelerator: menuAccelerator(s.lookHotkey) })] : []),
    item('quickInput', '快速输入…', ports.quickInput, { accelerator: menuAccelerator(s.quickInputHotkey) }),
    submenu('recent', '最近播报', recent), SEPARATOR,
    item('memory', '记忆…', page(ports, MENU_ROUTES.memory)),
    item('trace', '日志与 Trace', page(ports, MENU_ROUTES.trace)),
    item('monitor', '状态监控', page(ports, MENU_ROUTES.monitor)), SEPARATOR,
    quietItem(s, ports),
  ];
  const clickThrough = clickThroughItem(s, ports), freeRoam = freeRoamItem(s, ports);
  if (clickThrough) e.push(clickThrough);
  if (freeRoam) e.push(freeRoam);
  e.push(SEPARATOR, hiddenItem(s, ports), item('resetPosition', '放回默认位置', ports.resetPosition),
    submenu('characters', '切换角色', characterEntries(s, ports), { enabled: !s.characterSwitching }));
  const looks = appearanceItem(s, ports);
  if (looks) e.push(looks);
  e.push(SEPARATOR);
  if (s.showsDiagnostics && !ABSENT_FEATURES.has('diagnostics')) {
    const notWired = (name: string) => () => ports.log(`menu action not wired: ${name}`);
    e.push(submenu('diagnostics', '诊断', [item('permissionProbe', '权限探针', notWired('permissionProbe')),
      item('performanceDebug', '表现调试', notWired('performanceDebug'))]));
  }
  e.push(item('settings', '设置…', page(ports, MENU_ROUTES.settings), { accelerator: 'Command+,' }),
    item('restartChildren', '重启子进程', ports.restartChildren),
    item('quit', '退出', quit, { accelerator: 'Command+Q' }));
  return e;
}

/**
 * The tray icon's own menu, which Windows opens on a right click: `trayMenu` with the helper's row `helper` under the
 * children's and without the Mac's Command+ shortcuts; null on the Mac, where `trayClick` pops `trayMenu` up instead.
 * `state` is read only off the Mac: a read asks agentd and the renderer.
 */
export function trayContextMenu(platform: ShellPlatform, state: () => MenuState, ports: MenuPorts, helper: string): MenuItem[] | null {
  if (platform === 'mac') return null;
  const s = state(), menu = trayMenu(s, ports).map((i) => {
    const { accelerator, ...rest } = i;
    return accelerator?.startsWith('Command+') ? rest : i;
  });
  if (s.configError === null) menu.splice(s.services.length, 0, label('service.helper', helper));
  return menu;
}
