// The 快速输入 hot key (src/common/desktop-hotkey.ts), registered and updated: the
// config.json name as an Electron accelerator, an empty name registers nothing, a bad or refused one logs and notifies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accelerator, QuickInputHotkey } from '../src/common/desktop-hotkey.ts';

function setup(refuse = new Set<string>()) {
  const calls: unknown[][] = [];
  const presses: string[] = [];
  const hotkey = new QuickInputHotkey({
    register: (accel, fn) => {
      calls.push(['register', accel]);
      if (refuse.has(accel)) return false;
      presses.push(accel);
      fn();
      return true;
    },
    unregister: (accel) => calls.push(['unregister', accel]),
    log: (line) => calls.push(['log', line]),
    notify: (title, body) => calls.push(['notify', title, body]),
  }, () => calls.push(['show']));
  return { calls, presses, hotkey };
}

test('config.json names become Electron accelerators; right option and unknown keys have none', () => {
  assert.equal(accelerator('control+option+space'), 'Control+Alt+Space');
  assert.equal(accelerator('Ctrl+Alt+Q'), 'Control+Alt+Q');
  assert.equal(accelerator('command+shift+k'), 'Shift+Command+K');
  assert.equal(accelerator('f5'), 'F5');
  assert.equal(accelerator('control+7'), 'Control+7');
  assert.equal(accelerator('right_option'), null);
  assert.equal(accelerator('control+tab'), null);
  assert.equal(accelerator('hyper+k'), null);
});

test('a name registers its accelerator and a press opens 快速输入; an empty name registers nothing', () => {
  let { calls, hotkey } = setup();
  hotkey.register('control+option+space');
  assert.deepEqual(calls, [['register', 'Control+Alt+Space'], ['show']]);
  assert.equal(hotkey.failed, null);
  ({ calls, hotkey } = setup());
  hotkey.register('');
  assert.deepEqual(calls, []);
});

test('a bad name and one another program holds log and notify; the refused one is remembered', () => {
  let { calls, hotkey } = setup();
  hotkey.register('right_option');
  assert.deepEqual(calls, [['log', 'QUICKINPUT bad_hotkey right_option'],
    ['notify', '快速输入的快捷键没设上', 'right_option 不是有效的快捷键，请前往设置修改']]);
  assert.equal(hotkey.failed, null);
  ({ calls, hotkey } = setup(new Set(['Control+Alt+Space'])));
  hotkey.register('control+option+space');
  assert.deepEqual(calls, [['register', 'Control+Alt+Space'], ['log', 'QUICKINPUT hotkey_failed control+option+space'],
    ['notify', '快速输入的快捷键没设上', 'control+option+space 可能被别的程序占用了，请前往设置更换']]);
  assert.equal(hotkey.failed, 'control+option+space');
});

test('update unregisters the held key first, and stop leaves none registered', () => {
  const { calls, hotkey } = setup();
  hotkey.register('control+option+space');
  hotkey.update('control+option+f9');
  hotkey.stop();
  hotkey.stop();
  assert.deepEqual(calls, [['register', 'Control+Alt+Space'], ['show'], ['unregister', 'Control+Alt+Space'],
    ['register', 'Control+Alt+F9'], ['show'], ['unregister', 'Control+Alt+F9']]);
});
