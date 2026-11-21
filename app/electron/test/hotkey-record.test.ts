// 录热键 and the refused hot keys on the settings page (src/main/hotkeys/record.ts, `settings.recordHotkey`, `settings.read`'s
// statuses). A fake main window
// fed fake key events, a fake platform helper and a fake clock: no key reaches the system and no hot key is registered.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import { handle } from '../src/common/bridge.ts';
import { type KeyInput, recordedHotkey } from '../src/common/desktop-hotkey.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import type { HelperReply } from '../src/main/helper/client.ts';
import { HotkeyRecorder } from '../src/main/hotkeys/record.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { settingsOps } from '../src/main/ops/settings.ts';

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

/** A key event as Electron's `before-input-event` gives it; `mods` holds c, a, s and m for control, alt, shift and meta. */
const key = (code: string, mods = '', type = 'keyDown'): KeyInput => ({ type, code, control: mods.includes('c'), alt: mods.includes('a'),
  shift: mods.includes('s'), meta: mods.includes('m') });

/** The main window's contents: `press` emits one key event and says whether the recorder kept it from the page. */
function window() {
  const contents = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; } });
  const press = (input: KeyInput) => {
    let prevented = false;
    contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, input);
    return prevented;
  };
  return { contents, press };
}

function setup(o: { modifiers?: HelperReply; noWindow?: boolean } = {}) {
  const w = window();
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const asked: string[] = [];
  const recorder = new HotkeyRecorder({
    contents: () => (o.noWindow ? null : w.contents as unknown as WebContents),
    helper: { request: async (op) => {
      asked.push(op);
      return o.modifiers ?? { ok: true, result: { alt: false, shift: false, control: false, meta: false } };
    } },
    clock: { after: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    } },
  });
  return { ...w, timers, asked, recorder };
}

test('HotkeyName.name: modifiers in order and the physical key; a letter, digit or Space needs ⌃, ⌥ or ⌘, a function key does not', () => {
  assert.equal(recordedHotkey(key('KeyH', 'ca')), 'control+option+h');
  assert.equal(recordedHotkey(key('Space', 'msac')), 'control+option+shift+command+space');
  assert.equal(recordedHotkey(key('Digit7', 'm')), 'command+7');
  assert.equal(recordedHotkey(key('F5')), 'f5');
  assert.equal(recordedHotkey(key('F12', 's')), 'shift+f12');
  assert.equal(recordedHotkey(key('KeyA', 's')), null);
  assert.equal(recordedHotkey(key('Space')), null);
  assert.equal(recordedHotkey(key('F13', 'c')), null);
  assert.equal(recordedHotkey(key('Minus', 'c')), null);
  assert.equal(recordedHotkey(key('Numpad1', 'c')), null);
});

test('WebHotkeyCapture.feed: the first hot key ends the recording and is kept from the page; other keys are kept from it too, modifiers and key ups are not', { timeout: 10_000 }, async () => {
  const s = setup();
  const recorded = s.recorder.record(false);
  assert.equal(s.press(key('ControlLeft', 'c')), false);
  assert.equal(s.press(key('KeyA', 's')), true);
  assert.equal(s.press(key('KeyA', 's', 'keyUp')), false);
  assert.equal(s.press(key('KeyK', 'ca')), true);
  assert.equal(await recorded, 'control+option+k');
  // Ended: the listeners and the timer are gone.
  assert.equal(s.press(key('KeyJ', 'ca')), false);
  assert.equal(s.contents.listenerCount('before-input-event'), 0);
  assert.equal(s.timers[0]!.ms, 15_000);
  assert.equal(s.timers[0]!.cancelled, true);
});

test('WebHotkeyCapture.record: null on Esc, after 15 s, when another recording starts, when the page goes, and with no main window', { timeout: 10_000 }, async () => {
  const esc = setup();
  const byEsc = esc.recorder.record(false);
  assert.equal(esc.press(key('Escape')), true);
  assert.equal(await byEsc, null);

  const late = setup();
  const byTimeout = late.recorder.record(false);
  late.timers[0]!.fn();
  assert.equal(await byTimeout, null);
  assert.equal(late.contents.listenerCount('before-input-event'), 0);

  const twice = setup();
  const first = twice.recorder.record(false);
  const second = twice.recorder.record(false);
  assert.equal(await first, null);
  twice.press(key('KeyQ', 'm'));
  assert.equal(await second, 'command+q');
  assert.equal(twice.contents.listenerCount('before-input-event'), 0);

  const away = setup();
  const navigated = away.recorder.record(false);
  away.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  away.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  away.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(await navigated, null);
  const gone = away.recorder.record(false);
  away.contents.emit('render-process-gone');
  assert.equal(await gone, null);
  const closed = away.recorder.record(false);
  away.contents.destroyed = true;
  away.contents.emit('destroyed');
  assert.equal(await closed, null);

  const cancelled = setup();
  const byCancel = cancelled.recorder.record(false);
  cancelled.recorder.cancel();
  assert.equal(await byCancel, null);

  assert.equal(await setup({ noWindow: true }).recorder.record(false), null);
});

test('HotkeyName.rightOption: right Option pressed and released alone, with no modifier held on release (input.modifiers), only where allowed', { timeout: 10_000 }, async () => {
  const s = setup();
  const recorded = s.recorder.record(true);
  assert.equal(s.press(key('AltRight', 'a')), false);
  assert.equal(s.press(key('AltRight', '', 'keyUp')), false);
  assert.equal(await recorded, 'right_option');
  assert.deepEqual(s.asked, ['input.modifiers']);

  // Another key between press and release is no right Option alone.
  const between = setup();
  const combo = between.recorder.record(true);
  between.press(key('AltRight', 'a'));
  between.press(key('ShiftLeft', 'as'));
  between.press(key('AltRight', 's', 'keyUp'));
  await settle();
  assert.deepEqual(between.asked, []);
  between.press(key('KeyR', 'as'));
  assert.equal(await combo, 'option+shift+r');

  // Pressed with another modifier held.
  const held = setup();
  const withControl = held.recorder.record(true);
  held.press(key('AltRight', 'ca'));
  held.press(key('AltRight', 'c', 'keyUp'));
  await settle();
  assert.deepEqual(held.asked, []);
  held.recorder.cancel();
  assert.equal(await withControl, null);

  // The helper still reads a modifier down, or does not answer.
  for (const modifiers of [{ ok: true, result: { alt: true, shift: false, control: false, meta: false } },
    { ok: false, error: { code: 'helper_exited', message: 'gone' } }] as HelperReply[]) {
    const h = setup({ modifiers });
    const still = h.recorder.record(true);
    h.press(key('AltRight', 'a'));
    h.press(key('AltRight', '', 'keyUp'));
    await settle();
    assert.deepEqual(h.asked, ['input.modifiers']);
    h.press(key('KeyL', 'ca'));
    assert.equal(await still, 'control+option+l');
  }

  // Not for the other rows.
  const other = setup();
  const notAllowed = other.recorder.record(false);
  other.press(key('AltRight', 'a'));
  other.press(key('AltRight', '', 'keyUp'));
  await settle();
  assert.deepEqual(other.asked, []);
  other.press(key('KeyS', 'ca'));
  assert.equal(await notAllowed, 'control+option+s');
});

/** settingsOps over a config.json in a temporary directory; `refused` stands for the hot keys the system did not take. */
function settings(o: { refused?: Record<string, string>; record?: OpsContext['recordHotkey'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'settings-'));
  const path = join(dir, 'config.json');
  const saved: [string, string][] = [];
  const recordings: boolean[] = [];
  const ctx = {
    surface: 'main', config: { path, supportDir: dir, devResources: null }, agentd: null, loginItem: { enabled: () => null, set: () => {} },
    saved: { fps: () => {}, hotkey: (k: string, n: string) => saved.push([k, n]) }, settingsChanges: silentSource, log: () => {},
    unregisteredHotkeys: () => o.refused ?? {},
    recordHotkey: o.record === undefined ? async (rightOption: boolean) => { recordings.push(rightOption); return 'control+option+k'; } : o.record,
  } as unknown as OpsContext;
  const ops = new Map(Object.entries(settingsOps(ctx)));
  const page = new PageSession(() => {});
  const call = (op: string, ...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
  return { dir, path, saved, recordings, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('settings.recordHotkey: the key caps of the recorded hot key, or null; right Option only for 按住说话; a row that is no hot key is unknown_setting', { timeout: 10_000 }, async () => {
  const s = settings();
  try {
    assert.deepEqual(await s.call('settings.recordHotkey', 'hk_pass'), { ok: true, value: '⌃⌥K' });
    assert.deepEqual(await s.call('settings.recordHotkey', 'hk_ptt'), { ok: true, value: '⌃⌥K' });
    assert.deepEqual(s.recordings, [false, true]);
    assert.deepEqual(await s.call('settings.recordHotkey', 'mute'), { ok: false, error: { code: 'unknown_setting', detail: 'mute' } });
  } finally { s.done(); }
  const none = settings({ record: async () => null });
  try {
    assert.deepEqual(await none.call('settings.recordHotkey', 'hk_quick'), { ok: true, value: null });
  } finally { none.done(); }
  const absent = settings({ record: null });
  try {
    assert.deepEqual(await absent.call('settings.recordHotkey', 'hk_quick'),
      { ok: false, error: { code: 'not_implemented', detail: 'settings.recordHotkey' } });
  } finally { absent.done(); }
});

test('WebSettings.current: a stored hot key the system refused reads as none with a status, and saving it again registers it again', async () => {
  const s = settings({ refused: { hotkey_click_through: 'control+option+p', hotkey_quick_input: 'control+option+space' } });
  try {
    writeFileSync(s.path, JSON.stringify({ hotkey_click_through: 'control+option+p' }));
    const read = await s.call('settings.read');
    assert.ok(read.ok);
    const value = read.value as { saved: Record<string, unknown>; statuses: Record<string, string> };
    assert.equal(value.saved.hk_pass, '');
    assert.equal(value.statuses.hk_pass, '「⌃⌥P」没设上，可能被别的程序占用，请换一个');
    // Only a name config.json stores is checked: the default stands without a status.
    assert.equal(value.saved.hk_quick, '⌃⌥Space');
    assert.equal(value.statuses.hk_quick, undefined);
    assert.equal(value.saved.hk_wheel, '⌃⌥R');
    assert.equal(value.statuses.hk_wheel, undefined);
    // The refused name is no one's: another row may take it.
    assert.deepEqual(await s.call('settings.validateHotkey', 'hk_wheel', '⌃⌥P'), { ok: true, value: { ok: true } });
    const saved = await s.call('settings.save', { hk_pass: '⌃⌥P' });
    assert.deepEqual(saved, { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.deepEqual(s.saved, [['hotkey_click_through', 'control+option+p']]);
    assert.equal(JSON.parse(readFileSync(s.path, 'utf8')).hotkey_click_through, 'control+option+p');
  } finally { s.done(); }
});
