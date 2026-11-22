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

/**
 * Electron's tray click as `trayClick` takes it, and whether its menu shows 诊断: on macOS an option click, left or right;
 * Windows has no option click, so a left click always goes to the console and a Shift right click stands in for option.
 */
export function trayClickOf(platform: ShellPlatform, right: boolean, keys: { altKey?: boolean; shiftKey?: boolean }, bounds: Rectangle):
  { click: { right: boolean; option: boolean; bounds: Rectangle }; diagnostics: boolean } {
  if (platform === 'mac') return { click: { right, option: keys.altKey === true, bounds }, diagnostics: keys.altKey === true };
  return { click: { right, option: false, bounds }, diagnostics: right && keys.shiftKey === true };
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
