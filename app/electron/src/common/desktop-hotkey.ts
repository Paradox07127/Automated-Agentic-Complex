// The 快速输入 hot key: config.json's `hotkey_quick_input` as a global
// shortcut that opens 快速输入; a name that is no hot key, or one another program holds, logs and posts a notification.
// The desktop commands' hot keys only log. A recorded key press as config.json names it.
import type { SelectionDecision } from './screen-context.ts';
import { canonicalHotkey } from './settings.ts';

/** config.json's default `hotkey_quick_input`. */
export const DEFAULT_QUICK_INPUT_HOTKEY = 'control+option+space';

const PARTS: Record<string, string> = { control: 'Control', option: 'Alt', shift: 'Shift', command: 'Command', space: 'Space' };

/** The Electron accelerator for a config.json name; null for right option, which a global shortcut cannot hold, and for a
 *  name `canonicalHotkey` refuses. */
export function accelerator(name: string): string | null {
  const canonical = canonicalHotkey(name);
  if (canonical === null || canonical === 'right_option') return null;
  return canonical.split('+').map((p) => PARTS[p] ?? p.toUpperCase()).join('+');
}

export interface HotkeyPorts {
  /** globalShortcut.register: false when the system refused it. */
  register(accelerator: string, pressed: () => void): boolean;
  unregister(accelerator: string): void;
  log(line: string): void;
  notify(title: string, body: string): void;
}

const TITLE = '快速输入的快捷键没设上';

export class QuickInputHotkey {
  /** The name the system refused (another program holds it); null once a name registers or is cleared. */
  failed: string | null = null;
  private held: string | null = null;
  private readonly ports: HotkeyPorts;
  private readonly show: () => void;

  constructor(ports: HotkeyPorts, show: () => void) {
    this.ports = ports;
    this.show = show;
  }

  /** Registers `name`; empty registers nothing. */
  register(name: string): void {
    this.failed = null;
    if (name === '') return;
    const accel = accelerator(name);
    if (accel === null) {
      this.ports.log(`QUICKINPUT bad_hotkey ${name}`);
      this.ports.notify(TITLE, `${name} 不是有效的快捷键，请前往设置修改`);
      return;
    }
    if (!this.ports.register(accel, this.show)) {
      this.failed = name;
      this.ports.log(`QUICKINPUT hotkey_failed ${name}`);
      this.ports.notify(TITLE, `${name} 可能被别的程序占用了，请前往设置更换`);
      return;
    }
    this.held = accel;
  }

  /** Registers `name` in place of the current hot key. */
  update(name: string): void {
    this.stop();
    this.register(name);
  }

  stop(): void {
    if (this.held !== null) this.ports.unregister(this.held);
    this.held = null;
  }
}

/** The desktop commands' hot key ids, which their log lines carry. */
export const HOTKEY_IDS = { look: 3, toggleAvatar: 4, clickThrough: 5, radialMenu: 6, selection: 7 } as const;

export class GlobalHotkeys {
  /** The names that did not register (no hot key, or another program holds it), by id. */
  readonly failed = new Map<number, string>();
  private readonly actions = new Map<number, () => void>();
  private readonly held = new Map<number, string>();
  private readonly ports: Pick<HotkeyPorts, 'register' | 'unregister' | 'log'>;

  constructor(ports: Pick<HotkeyPorts, 'register' | 'unregister' | 'log'>) {
    this.ports = ports;
  }

  /** Registers `name` as hot key `id`; empty registers nothing. */
  register(name: string, id: number, action: () => void): void {
    // Kept even when nothing registers, so `update` can register a new name for it.
    this.actions.set(id, action);
    this.failed.delete(id);
    if (name === '') return;
    const accel = accelerator(name);
    if (accel === null) {
      this.failed.set(id, name);
      this.ports.log(`HOTKEY bad_hotkey ${name}`);
      return;
    }
    if (!this.ports.register(accel, () => this.actions.get(id)?.())) {
      this.failed.set(id, name);
      this.ports.log(`HOTKEY hotkey_failed id=${id} key=${name}`);
      return;
    }
    this.held.set(id, accel);
    if (id === HOTKEY_IDS.radialMenu) this.ports.log(`HOTKEY registered id=${id} key=${name}`);
  }

  /** Registers `name` in place of hot key `id`'s current combination, with the action it was registered with. */
  update(name: string, id: number): void {
    const accel = this.held.get(id);
    if (accel !== undefined) this.ports.unregister(accel);
    this.held.delete(id);
    const action = this.actions.get(id);
    if (action === undefined) {
      this.ports.log(`HOTKEY update_unknown ${id}`);
      return;
    }
    this.register(name, id, action);
    if (this.held.has(id)) this.ports.log(`HOTKEY updated ${id} ${name}`);
  }

  stop(): void {
    for (const accel of this.held.values()) this.ports.unregister(accel);
    this.held.clear();
  }
}

/** Electron's `before-input-event` key input, as far as recording a hot key reads it. */
export interface KeyInput { type: string; code: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }

/** The hot key names' key table by physical key (`KeyboardEvent.code`). */
const CODE_KEYS = new Map<string, string>([['Space', 'space'],
  ...[...'abcdefghijklmnopqrstuvwxyz'].map((c): [string, string] => [`Key${c.toUpperCase()}`, c]),
  ...[...'0123456789'].map((d): [string, string] => [`Digit${d}`, d]),
  ...Array.from({ length: 12 }, (_, i): [string, string] => [`F${i + 1}`, `f${i + 1}`])]);

/** `control+option+shift+command+<key>`; null for a key outside the table, and for a
 *  letter, digit or Space without control, option or command. */
export function recordedHotkey(input: KeyInput): string | null {
  const key = CODE_KEYS.get(input.code);
  if (key === undefined) return null;
  const fn = key.length > 1 && key.startsWith('f');
  if (!fn && !input.control && !input.alt && !input.meta) return null;
  const held = ([[input.control, 'control'], [input.alt, 'option'], [input.shift, 'shift'], [input.meta, 'command']] as const)
    .filter(([down]) => down).map(([, name]) => name);
  return [...held, key].join('+');
}

/** DesktopCommand's `selection` and `selectionRefused`, sent just before the 快速输入 open. */
export type SelectionCommand =
  | { kind: 'selection'; source: 'selection' | 'clipboard'; text: string; app: string | null; truncated: boolean }
  | { kind: 'selectionRefused'; message: string };

/** What 快速输入 opens with after a `hotkey_selection` read; nothing for an empty read. */
export function selectionCommand(decision: SelectionDecision, app: string | null): SelectionCommand | undefined {
  switch (decision.kind) {
    case 'read': return { kind: 'selection', source: decision.read.source, text: decision.read.text, app, truncated: decision.read.truncated };
    case 'refused': return { kind: 'selectionRefused', message: decision.message };
    case 'empty': return undefined;
  }
}
