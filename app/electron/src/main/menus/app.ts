// The app's main menu: an accessory app never shows it, but its key equivalents work
// while a window of the app is key. ⌘0–⌘3 and ⌘, open pages; the close, minimize and edit items act on the focused window.
import { type MenuItem, type MenuPorts, SEPARATOR } from './items.ts';

export function appMenu(ports: Pick<MenuPorts, 'openMain' | 'quit'>): MenuItem[] {
  const page = (id: string, label: string, accelerator: string, route: string): MenuItem =>
    ({ id, label, accelerator, click: () => ports.openMain(route) });
  return [
    { label: 'Agentic Complex', submenu: [page('settings', '设置…', 'Command+,', '/settings'), SEPARATOR,
      { id: 'quit', label: '退出 Agentic Complex', accelerator: 'Command+Q', click: () => ports.quit() }] },
    { label: '文件', submenu: [{ id: 'close', label: '关闭窗口', role: 'close', accelerator: 'Command+W' }] },
    { label: '编辑', submenu: [
      { id: 'undo', label: '撤销', role: 'undo', accelerator: 'Command+Z' },
      { id: 'redo', label: '重做', role: 'redo', accelerator: 'Shift+Command+Z' }, SEPARATOR,
      { id: 'cut', label: '剪切', role: 'cut', accelerator: 'Command+X' },
      { id: 'copy', label: '复制', role: 'copy', accelerator: 'Command+C' },
      { id: 'paste', label: '粘贴', role: 'paste', accelerator: 'Command+V' },
      { id: 'selectAll', label: '全选', role: 'selectAll', accelerator: 'Command+A' }] },
    // Each page's route.ts `hotkey`.
    { label: '前往', submenu: [page('go.home', '主页', 'Command+0', '/home'), page('go.overview', '今天', 'Command+1', '/overview'),
      page('go.chat', '对话', 'Command+2', '/chat'), page('go.memory', '记忆', 'Command+3', '/memory')] },
    { label: '窗口', submenu: [{ id: 'minimize', label: '最小化', role: 'minimize', accelerator: 'Command+M' }] },
  ];
}
