// The commands every menu item calls and the items the tray menu and the character menu share. An action whose port is not given is greyed.
import type { MenuItemConstructorOptions } from 'electron';
import { idsOfKeys } from '../../common/settings.ts';
import { ABSENT_FEATURES, MENU_ROUTES, type MenuState, menuAccelerator, type QuietSpan, quietUntil } from '../../common/menus.ts';
import { PushSource } from '../../common/push.ts';

export type MenuItem = MenuItemConstructorOptions;

export interface MenuPorts {
  /** A main window hash route (`MENU_ROUTES`), the window brought up. */
  openMain(route: string): void;
  quit(): void;
  /** companion.log. */
  log(line: string): void;
  look?(): void;
  quickInput?(): void;
  /** 最近播报: marks one read and selects its session when it has one. */
  openAnnouncement?(id: string): void;
  markAllAnnouncementsRead?(): void;
  /** `PUT /observation/quiet`: `until` in epoch seconds, null to end it. */
  setQuiet?(until: number | null): Promise<void>;
  toggleClickThroughAll?(): void;
  /** Flips config.json's `stay_mode` and PUTs the switches. */
  toggleFreeRoam?(): void;
  /** `settings.onChange`: config.json keys a menu changed. */
  settingsChanged?(keys: string[]): void;
  /** 隐藏 for 30 minutes, or 显示. */
  toggleHidden?(): void;
  resetPosition?(): void;
  switchCharacter?(id: string): void;
  switchAppearance?(id: string): void;
  /** Flips one outfit layer's visibility. */
  toggleLayer?(id: string): void;
  /** A slot's row id, null for 自动; a held lock carries over to the slot, 自动 releases it. */
  setPose?(id: string | null): void;
  /** 锁定当前姿态: the current pose with the lock flipped. */
  togglePoseLock?(): void;
  restartChildren?(): void;
  /** 镜头与动作…: the tune panel. */
  openTune?(): void;
  /** 调整镜头…: camera mode over her. */
  beginCamera?(): void;
  /** 保存截图: the avatar writes a PNG and names it; `saved` tells the user. */
  capture?: { take(): Promise<string>; saved(file: string): void };
  giveGift?(): void;
  /** 复位浮窗: the desktop panels back to their default offsets. */
  resetPanels?(): void;
  /** 把剪贴板交给她: the clipboard read once and handed over like a drop on her. */
  handClipboard?(): void;
  /** 框选给她看…: a dragged region's text read once and handed to 快速输入. */
  selectRegion?(): void;
  playSlot?(id: string): void;
  playPlaylist?(): void;
  stopPlaylist?(): void;
  /** Saves the list's loop: `off`, `one` or `all`. */
  setPlaylistLoop?(loop: string): void;
  /** Epoch milliseconds; tests drive it. */
  now?(): number;
}

export const SEPARATOR: MenuItem = { type: 'separator' };

/** An item that runs `run`; without it (no port) the item is greyed. `checked` makes it a check item. */
export function item(id: string, label: string, run: (() => void) | undefined,
  o: { accelerator?: string; checked?: boolean; enabled?: boolean } = {}): MenuItem {
  const out: MenuItem = { id, label, enabled: (o.enabled ?? true) && run !== undefined };
  if (o.checked !== undefined) {
    out.type = 'checkbox';
    out.checked = o.checked;
  }
  if (o.accelerator !== undefined) out.accelerator = o.accelerator;
  if (run) out.click = () => run();
  return out;
}

export function submenu(id: string, label: string, entries: MenuItem[], o: { checked?: boolean; enabled?: boolean } = {}): MenuItem {
  const out: MenuItem = { id, label, enabled: o.enabled ?? true, submenu: entries };
  if (o.checked !== undefined) out.checked = o.checked;
  return out;
}

/** A row that only shows text. */
export function label(id: string, text: string): MenuItem {
  return { id, label: text, enabled: false };
}

export const page = (ports: MenuPorts, route: string) => () => ports.openMain(route);

function setQuiet(ports: MenuPorts, span: QuietSpan | null): (() => void) | undefined {
  const set = ports.setQuiet;
  if (!set) return undefined;
  return () => {
    const until = span === null ? null : quietUntil(span, ports.now?.() ?? Date.now());
    set(until).catch((e: unknown) => ports.log(`quiet span=${span ?? 'end'} failed: ${e instanceof Error ? e.message : String(e)}`));
  };
}

/** 安静: checked while quiet, with its spans and 结束安静. */
export function quietItem(s: MenuState, ports: MenuPorts): MenuItem {
  return submenu('quiet', '安静', [
    item('quiet.halfHour', '30 分钟', setQuiet(ports, 'halfHour')), item('quiet.hour', '1 小时', setQuiet(ports, 'hour')),
    item('quiet.untilMorning', '到明早 7:00', setQuiet(ports, 'untilMorning')),
    item('quiet.end', '结束安静', setQuiet(ports, null), { enabled: s.quiet }),
  ], { checked: s.quiet });
}

export function clickThroughItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (ABSENT_FEATURES.has('clickThroughAll')) return null;
  return item('clickThroughAll', '临时全部点穿', ports.toggleClickThroughAll,
    { accelerator: menuAccelerator(s.clickThroughHotkey), checked: s.clickThroughAll });
}

/** 自由活动; the settings page hears of the `stay_mode` it changed. */
export function freeRoamItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (ABSENT_FEATURES.has('freeRoam')) return null;
  const toggle = ports.toggleFreeRoam;
  return item('freeRoam', '自由活动', toggle && (() => {
    toggle();
    ports.settingsChanged?.(['stay_mode']);
  }), { checked: s.freeRoam });
}

export function hiddenItem(s: MenuState, ports: MenuPorts): MenuItem {
  return item('hidden', s.avatarHidden ? '显示角色' : '隐藏角色 30 分钟', ports.toggleHidden);
}

/** The character list and 角色卡…, shared by 切换角色 and the right-click 角色. */
export function characterEntries(s: MenuState, ports: MenuPorts): MenuItem[] {
  const pick = ports.switchCharacter;
  return [
    ...s.characters.map((c) => item(`character.${c.id}`, c.name, pick && (() => pick(c.id)),
      { checked: c.id === s.currentCharacter, enabled: !s.characterSwitching })),
    SEPARATOR, item('characterCard', '角色卡…', page(ports, MENU_ROUTES.character)),
  ];
}

/** null with fewer than two appearances. */
export function appearanceItem(s: MenuState, ports: MenuPorts): MenuItem | null {
  if (s.appearances.length < 2) return null;
  const enabled = !s.characterSwitching && s.appearanceSwitchingTo === null, pick = ports.switchAppearance;
  return submenu('appearances', '外观', s.appearances.map((a) => item(`appearance.${a.id}`,
    a.id === s.appearanceSwitchingTo ? `${a.name} · 切换中…` : a.name, pick && (() => pick(a.id)),
    { checked: a.id === s.currentAppearance, enabled })), { enabled });
}

/** The settings change source: event `change` with the settings page's ids of the keys that have one. */
export class SettingsChanges extends PushSource {
  constructor() {
    super('change', { replay: false });
  }

  changed(keys: string[]): void {
    const ids = idsOfKeys(keys);
    if (ids.length > 0) this.send({ ids });
  }
}
