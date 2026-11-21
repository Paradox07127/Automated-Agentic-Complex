// The desktop commands' global hot keys as index.ts starts them:
// 屏幕识读, 显示 / 隐藏角色, 临时全部点穿, 快捷轮盘 and 读取选中文字.
// 快速输入's is the desktop panels' (desktop/assembly.ts), 按住说话's the helper's (common/push-to-talk.ts).
import { GlobalHotkeys, HOTKEY_IDS, type HotkeyPorts, type SelectionCommand, selectionCommand } from '../../common/desktop-hotkey.ts';
import type { CmdMode } from '../../common/desktop-layout.ts';
import type { ShellContext } from '../context/shell.ts';

export interface ShellHotkeysOptions {
  /** The shell's arguments: `--no-attention` (test and host runs) registers no hot key, so none is taken from the user. */
  argv: readonly string[];
  /** globalShortcut. */
  shortcut: Pick<HotkeyPorts, 'register' | 'unregister'>;
  /** config.json as saved now; `{}` when it cannot be read. */
  settings(): Record<string, unknown>;
  /** The screen context capturer; without one neither 屏幕识读 nor 读取选中文字 registers, as both read the user's windows. */
  context: Pick<ShellContext, 'look' | 'readSelection'> | null;
  avatarHidden(): boolean;
  setHidden(hidden: boolean, reason: string): void;
  /** The desktop panels' 快速输入 open, with what it opens with; null without the panels. */
  quickInput(): ((first?: SelectionCommand) => void) | null;
  /** HostLink.clickThroughAll; `set` also tells the runtime and the desktop state. null or absent without the avatar link. */
  clickThroughAll?: { on(): boolean; set(on: boolean): void } | null;
  /** The desktop panels' command layer; absent, or null, without the panels. */
  commandRing?(): { readonly cmdMode: CmdMode | null; open(mode: CmdMode): void; close(): void } | null;
  log(line: string): void;
}

export interface ShellHotkeys {
  /** Settings saved hot key `key` as `name`. */
  saved(key: string, name: string): void;
  /** The names that did not register (no hot key, or another program holds it), by config.json key. */
  failed(): Record<string, string>;
  stop(): void;
}

/** The hot keys a config.json without them gets. */
const DEFAULTS: Record<string, string> = { hotkey_look: 'control+option+l', hotkey_toggle_avatar: 'control+option+h',
  hotkey_click_through: 'control+option+p', hotkey_radial_menu: 'control+option+r', hotkey_selection: 'control+option+s' };

/** Registers the hot keys at once; null with `--no-attention`. */
export function shellHotkeys(o: ShellHotkeysOptions): ShellHotkeys | null {
  if (o.argv.includes('--no-attention')) return null;
  const keys = new GlobalHotkeys({ ...o.shortcut, log: o.log });
  const saved = o.settings();
  const ids = new Map<string, number>();
  const register = (key: string, id: number, action: () => void) => {
    const name = saved[key];
    keys.register(typeof name === 'string' ? name : DEFAULTS[key]!, id, action);
    ids.set(key, id);
  };
  const context = o.context;
  if (context) register('hotkey_look', HOTKEY_IDS.look, () => { void context.look(); });
  register('hotkey_toggle_avatar', HOTKEY_IDS.toggleAvatar, () => o.setHidden(!o.avatarHidden(), 'user'));
  register('hotkey_click_through', HOTKEY_IDS.clickThrough, () => {
    const link = o.clickThroughAll;
    if (!link) return o.log('CLICK_THROUGH source=hotkey: no avatar link (config failed)');
    const on = !link.on();
    link.set(on);
    o.log(`CLICK_THROUGH ${on ? 'on' : 'off'} source=hotkey`);
  });
  // Without the panels there is no wheel to toggle.
  register('hotkey_radial_menu', HOTKEY_IDS.radialMenu, () => {
    const ring = o.commandRing?.();
    if (!ring) return;
    if (ring.cmdMode === 'ring') {
      o.log('COMMAND_RING source=hotkey action=close');
      return ring.close();
    }
    o.log('COMMAND_RING source=hotkey action=open');
    ring.open('ring');
  });
  if (context) {
    register('hotkey_selection', HOTKEY_IDS.selection, () => {
      const open = o.quickInput();
      if (!open) return o.log('SELECTION no_web_desktop');
      void context.readSelection().then(({ decision, app }) => open(selectionCommand(decision, app)));
    });
  }
  return {
    saved: (key, name) => {
      const id = ids.get(key);
      if (id !== undefined) keys.update(name, id);
    },
    failed: () => Object.fromEntries([...ids].filter(([, id]) => keys.failed.has(id)).map(([key, id]) => [key, keys.failed.get(id)!])),
    stop: () => keys.stop(),
  };
}

/** The names that did not register by config.json key, with 快速输入's and
 *  按住说话's refused names. */
export function unregisteredHotkeys(hotkeys: ShellHotkeys | null, quickInput: string | null, voice: string | null): Record<string, string> {
  const failed = hotkeys?.failed() ?? {};
  if (quickInput !== null) failed.hotkey_quick_input = quickInput;
  if (voice !== null) failed.voice_hotkey = voice;
  return failed;
}
