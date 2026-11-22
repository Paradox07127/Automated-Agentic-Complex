// The app's main menu: an accessory app never shows it, but its key equivalents work
// while a window of the app is key. ⌘0–⌘4 and ⌘, open pages; the close, minimize and edit items act on the focused window.
import type { Input } from 'electron';
import type { ShellPlatform } from '../../common/config.ts';
import type { Plugins } from '../../common/plugins.ts';
import { PLUGINS } from '../../common/plugins.generated.ts';
import { type MenuItem, type MenuPorts, SEPARATOR } from './items.ts';

/** 设置 and 前往's pages by each page's route.ts `hotkey` (角色's ⌘4 is the menu's own): id, label, the key after Command+,
 *  route. */
const PAGES = [['settings', '设置…', ',', '/settings'], ['go.home', '主页', '0', '/home'], ['go.overview', '工业简报', '1', '/overview'],
  ['go.chat', '对话', '2', '/chat'], ['go.memory', '记忆', '3', '/memory'], ['go.character', '角色', '4', '/character']] as const;

/** PAGES without the pages of the plug-ins that are off in `plugins`. */
function pages(plugins: Plugins) {
  const off = new Set<string>(PLUGINS.filter((p) => !plugins[p.id]).flatMap((p) => p.web.pages));
  return PAGES.filter(([id]) => !off.has(id.slice('go.'.length)));
}

/** `plugins` are the ones agentd runs with: 前往 leaves out the pages of those that are off. */
export function appMenu(ports: Pick<MenuPorts, 'openMain' | 'quit'>, plugins: Plugins): MenuItem[] {
  const [settings, ...go] = pages(plugins).map(([id, label, key, route]): MenuItem =>
    ({ id, label, accelerator: `Command+${key}`, click: () => ports.openMain(route) }));
  return [
    { label: 'Agentic Complex', submenu: [settings!, SEPARATOR,
      { id: 'quit', label: '退出 Agentic Complex', accelerator: 'Command+Q', click: () => ports.quit() }] },
    { label: '文件', submenu: [{ id: 'close', label: '关闭窗口', role: 'close', accelerator: 'Command+W' }] },
    { label: '编辑', submenu: [
      { id: 'undo', label: '撤销', role: 'undo', accelerator: 'Command+Z' },
      { id: 'redo', label: '重做', role: 'redo', accelerator: 'Shift+Command+Z' }, SEPARATOR,
      { id: 'cut', label: '剪切', role: 'cut', accelerator: 'Command+X' },
      { id: 'copy', label: '复制', role: 'copy', accelerator: 'Command+C' },
      { id: 'paste', label: '粘贴', role: 'paste', accelerator: 'Command+V' },
      { id: 'selectAll', label: '全选', role: 'selectAll', accelerator: 'Command+A' }] },
    { label: '前往', submenu: go },
    { label: '窗口', submenu: [{ id: 'minimize', label: '最小化', role: 'minimize', accelerator: 'Command+M' }] },
  ];
}

/**
 * Windows shows no menu bar, so the main window's `before-input-event` asks this: the route of the `appMenu` page whose
 * Command+ key `input` presses with Ctrl alone (Ctrl+0–4, Ctrl+,), gated by `plugins` alike; null for any other key and on
 * the Mac, whose menu has them.
 */
export function pageShortcut(platform: ShellPlatform, input: Pick<Input, 'type' | 'key' | 'control' | 'alt' | 'shift' | 'meta'>,
  plugins: Plugins): string | null {
  if (platform === 'mac' || input.type !== 'keyDown' || !input.control || input.alt || input.shift || input.meta) return null;
  return pages(plugins).find(([, , key]) => key === input.key)?.[3] ?? null;
}
