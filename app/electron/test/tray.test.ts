// The menu bar icon's clicks on macOS (src/main/desktop/tray.ts): StatusItemClick.route's cases and
// what each click does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Rect } from '../src/common/placement.ts';
import { trayTitle } from '../src/common/tray-title.ts';
import { trayClick, type TrayPorts } from '../src/main/desktop/tray.ts';

/** A fake desktop whose console opens and closes, and a fake menu; records each call. */
function harness(open = false) {
  const calls: string[] = [], lines: string[] = [];
  const state = { open };
  const desktop = {
    get consoleOpen() { return state.open; },
    openConsole: (r: Rect | null) => { calls.push(`open ${JSON.stringify(r)}`); state.open = true; },
    closeConsole: () => { calls.push('close'); state.open = false; },
  };
  const ports = (withDesktop = true): TrayPorts => ({ desktop: withDesktop ? desktop : null,
    toPlacement: (b) => ({ x: b.x, y: 1080 - (b.y + b.height), w: b.width, h: b.height }),
    popUpMenu: () => calls.push('menu'), log: (l) => lines.push(l) });
  return { calls, lines, ports };
}
const BOUNDS = { x: 1500, y: 0, width: 24, height: 24 };

test('tray: a left click opens the console under the icon, the next one closes it', () => {
  const h = harness();
  trayClick({ right: false, option: false, bounds: BOUNDS }, h.ports());
  assert.deepEqual(h.calls, ['open {"x":1500,"y":1056,"w":24,"h":24}']);
  trayClick({ right: false, option: false, bounds: BOUNDS }, h.ports());
  assert.deepEqual(h.calls.slice(1), ['close']);
  assert.deepEqual(h.lines, []);
});

test('tray: a right click or an option click closes the console and pops the menu up', () => {
  const h = harness(true);
  trayClick({ right: true, option: false, bounds: BOUNDS }, h.ports());
  assert.deepEqual(h.calls, ['close', 'menu']);
  trayClick({ right: false, option: true, bounds: BOUNDS }, h.ports());
  assert.deepEqual(h.calls.slice(2), ['close', 'menu']);
  assert.deepEqual(h.lines, ['STATUS_MENU source=right_click', 'STATUS_MENU source=option_click']);
});

test('tray: without the desktop panels a left click pops the menu up', () => {
  const h = harness();
  trayClick({ right: false, option: false, bounds: BOUNDS }, h.ports(false));
  assert.deepEqual(h.calls, ['menu']);
});

test('tray: a test instance (config.json loaded on another support dir) shows 测试 beside the icon', () => {
  const installed = '/Users/u/Library/Application Support/Agentic Complex';
  assert.equal(trayTitle(installed, installed), '');
  assert.equal(trayTitle('/tmp/other/support', installed), '测试');
  assert.equal(trayTitle(null, installed), '', 'config.json did not load');
});
