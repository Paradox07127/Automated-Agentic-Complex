// The commands every menu item calls and the items the tray menu and the character menu share. An action whose port is not given is greyed.
import type { MenuItemConstructorOptions } from 'electron';
import { idsOfKeys } from '../../common/settings.ts';
import { ABSENT_FEATURES, MENU_ROUTES, type MenuState, type QuietSpan, quietUntil } from '../../common/menus.ts';
import { PushSource } from '../../common/push.ts';

export type MenuItem = MenuItemConstructorOptions;

export interface MenuPorts {
  /** A main window hash route (`MENU_ROUTES`), the window brought up. */
  openMain(route: string): void;
  quit(): void;
  /** companion.log. */
  log(line: string): void;
  /** 最近播报: marks one read and selects its session when it has one. */
  openAnnouncement?(id: string): void;
  markAllAnnouncementsRead?(): void;
  /** `PUT /observation/quiet`: `until` in epoch seconds, null to end it. */
  setQuiet?(until: number | null): Promise<void>;
  /** Flips config.json's `stay_mode` and PUTs the switches. */
  toggleFreeRoam?(): void;
  /** `settings.onChange`: config.json keys a menu changed. */
  settingsChanged?(keys: string[]): void;
  resetPosition?(): void;
  switchCharacter?(id: string): void;
  switchAppearance?(id: string): void;
  restartChildren?(): void;
  /** 复位浮窗: the desktop panels back to their default offsets. */
  resetPanels?(): void;
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

/** 免打扰: checked while quiet, with its spans and 结束免打扰. */
export function quietItem(s: MenuState, ports: MenuPorts): MenuItem {
  return submenu('quiet', '免打扰', [
    item('quiet.halfHour', '30 分钟', setQuiet(ports, 'halfHour')), item('quiet.hour', '1 小时', setQuiet(ports, 'hour')),
    item('quiet.untilMorning', '到明早 7:00', setQuiet(ports, 'untilMorning')), SEPARATOR,
    item('quiet.end', '结束免打扰', setQuiet(ports, null), { enabled: s.quiet }),
  ], { checked: s.quiet });
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

/** The character list and 角色卡…, under 切换角色. */
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
