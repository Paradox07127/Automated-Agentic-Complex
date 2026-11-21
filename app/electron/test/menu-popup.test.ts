// Where the character menu pops up (src/main/menus/popup.ts): the shell pops
// it at the click: Menu.popup's window and x, y. Fake windows and displays; no menu pops up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Rectangle } from 'electron';
import type { Point } from '../src/common/placement.ts';
import { characterMenuPopup, type PopupWindow } from '../src/main/menus/popup.ts';

// A Mac: the main display 1440x900, a second one 1920x1080 to its right; C3 y up from the main display's bottom.
const MAIN: Rectangle = { x: 0, y: 0, width: 1440, height: 900 };
const SIDE: Rectangle = { x: 1440, y: -180, width: 1920, height: 1080 };
const ports = (windows: PopupWindow<string>[]) => ({
  toDip: (p: Point) => ({ x: p.x, y: 900 - p.y }),
  display: (p: Point) => (p.x >= SIDE.x ? SIDE : MAIN),
  windows: () => windows,
});

test('the menu pops up at the click over a window on the click\'s display, a shown one before a hidden one', () => {
  const windows: PopupWindow<string>[] = [
    { window: 'main', visible: true, content: { x: 100, y: 100, width: 800, height: 600 } },
    { window: 'hidden-side', visible: false, content: { x: 2000, y: 0, width: 100, height: 100 } },
    { window: 'bubble-side', visible: true, content: { x: 3000, y: 500, width: 300, height: 200 } },
  ];
  // C3 (2500, 400) is DIP (2500, 500) on the side display; x, y are off the window's content, which Menu.popup takes.
  assert.deepEqual(characterMenuPopup({ x: 2500, y: 400 }, ports(windows)), { window: 'bubble-side', x: -500, y: 0 });
  assert.deepEqual(characterMenuPopup({ x: 2500, y: 400 }, ports(windows.slice(0, 2))), { window: 'hidden-side', x: 500, y: 500 });
  // On the main display, in DIP points rounded.
  assert.deepEqual(characterMenuPopup({ x: 300.4, y: 699.6 }, ports(windows)), { window: 'main', x: 200, y: 100 });
});

test('a window off the click\'s display still places it at the click; without any window there is no popup', () => {
  const main = { window: 'main', visible: false, content: { x: 100, y: 100, width: 800, height: 600 } };
  assert.deepEqual(characterMenuPopup({ x: 2500, y: 400 }, ports([main])), { window: 'main', x: 2400, y: 400 });
  assert.equal(characterMenuPopup({ x: 2500, y: 400 }, ports([])), null);
});
