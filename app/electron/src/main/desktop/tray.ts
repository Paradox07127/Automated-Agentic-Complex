// The tray icon's clicks, the macOS menu bar icon's and the Windows notification area icon's alike:
// a left click opens or closes the console at the icon; a right click or an option click closes it and pops the menu up.
import type { Rectangle } from 'electron';
import type { ShellPlatform } from '../../common/config.ts';
import type { Rect } from '../../common/placement.ts';

export interface TrayPorts {
  /** null without the desktop panels: a left click then pops the menu up. */
  desktop: { readonly consoleOpen: boolean; openConsole(statusItem: Rect | null): void; closeConsole(): void } | null;
  /** The icon's bounds (DIP) in the placement space. */
  toPlacement(bounds: Rectangle): Rect;
  popUpMenu(): void;
  log(line: string): void;
}

/** Electron's tray click as `trayClick` takes it: Windows has no option click, so a left click there always goes to the console. */
export function trayClickOf(platform: ShellPlatform, right: boolean, keys: { altKey?: boolean }, bounds: Rectangle):
  { right: boolean; option: boolean; bounds: Rectangle } {
  return { right, option: platform === 'mac' && keys.altKey === true, bounds };
}

export function trayClick(click: { right: boolean; option: boolean; bounds: Rectangle }, ports: TrayPorts): void {
  const desktop = ports.desktop;
  if (click.right || click.option) {
    ports.log(`STATUS_MENU source=${click.right ? 'right_click' : 'option_click'}`);
    desktop?.closeConsole();
    ports.popUpMenu();
  } else if (!desktop) {
    ports.popUpMenu();
  } else if (desktop.consoleOpen) {
    desktop.closeConsole();
  } else {
    desktop.openConsole(ports.toPlacement(click.bounds));
  }
}
