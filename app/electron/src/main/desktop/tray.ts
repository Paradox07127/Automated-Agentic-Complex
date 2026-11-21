// The menu bar icon's clicks on macOS:
// a left click opens or closes the console under the icon; a right click or an option click closes it and pops the menu up.
import type { Rectangle } from 'electron';
import type { Rect } from '../../common/placement.ts';

export interface TrayPorts {
  /** null without the desktop panels: a left click then pops the menu up. */
  desktop: { readonly consoleOpen: boolean; openConsole(statusItem: Rect | null): void; closeConsole(): void } | null;
  /** The icon's bounds (DIP) in the placement space. */
  toPlacement(bounds: Rectangle): Rect;
  popUpMenu(): void;
  log(line: string): void;
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
