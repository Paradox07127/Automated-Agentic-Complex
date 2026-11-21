// The desktop commands' global hot keys (src/main/hotkeys/shell.ts, GlobalHotkeys in src/common/desktop-hotkey.ts) wired as
// index.ts wires them; the 屏幕识读 receipt and the computer control state on the stack. A fake globalShortcut, a fake platform
// helper and a fake agentd: no real hot key is registered and nothing reads the real system's windows or clipboard.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AttentionSample } from '../src/common/attention.ts';
import { computerUseState } from '../src/common/computer-control.ts';
import type { CmdMode } from '../src/common/desktop-layout.ts';
import { GlobalHotkeys, HOTKEY_IDS, type SelectionCommand } from '../src/common/desktop-hotkey.ts';
import { DEFAULT_PLUGINS } from '../src/common/plugins.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { StackSource } from '../src/common/stack-source.ts';
import { lookReceipt, shellContext } from '../src/main/context/shell.ts';
import { shellControl } from '../src/main/control/shell.ts';
import { shellHotkeys, unregisteredHotkeys } from '../src/main/hotkeys/shell.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

/** globalShortcut: refuses the accelerators in `refuse`, keeps each registered press. */
class Shortcut {
  calls: string[] = [];
  pressed = new Map<string, () => void>();
  refuse = new Set<string>();
  register = (accel: string, fn: () => void) => {
    this.calls.push(`register ${accel}`);
    if (this.refuse.has(accel)) return false;
    this.pressed.set(accel, fn);
    return true;
  };
  unregister = (accel: string) => {
    this.calls.push(`unregister ${accel}`);
    this.pressed.delete(accel);
  };
  press(accel: string) {
    const fn = this.pressed.get(accel);
    assert.ok(fn, `${accel} is not registered`);
    fn();
  }
}

/** TextEdit's window 640 in front. */
function sample(): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null },
    frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false,
    cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null, micApps: null, frontAudioOut: null,
    frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null,
  };
}

function setup(o: { argv?: string[]; capturer?: boolean; settings?: Record<string, unknown>; desktop?: boolean; selected?: string | null; secure?: boolean;
  look?: { status: number; body: unknown }; link?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hotkeys-'));
  writeFileSync(join(dir, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
  const shortcut = new Shortcut();
  const requests: string[] = [];
  const logs: string[] = [];
  const opened: (SelectionCommand | undefined)[] = [];
  const hidden: [boolean, string][] = [];
  const state = { hidden: false, desktop: o.desktop ?? true, clickThroughAll: false, cmdMode: null as CmdMode | null };
  const ring: string[] = [];
  const stack = new StackSource({ request: async () => ({ status: 404, body: '' }), notify: () => ({ modes: {} }), avatarHidden: () => false,
    frontFullscreen: () => false, playSound: () => {} });
  const context = shellContext({
    argv: o.argv ?? ['electron', '.'],
    helper: {
      request: async (op) => {
        requests.push(op);
        if (op === 'attention.sample') return ok({ secure_input: o.secure ?? false });
        if (op === 'ax.selected_text') return ok({ text: o.selected === undefined ? 'selected words' : o.selected });
        if (op === 'clipboard.read') return ok({ items: [] });
        return { ok: false, error: { code: 'unsupported' } };
      },
    },
    agentd: {
      request: async (_method, path) => {
        requests.push(`POST ${path}`);
        const r = o.look ?? { status: 202, body: { request_id: 'look-1' } };
        return { status: r.status, body: Buffer.from(JSON.stringify(r.body)) };
      },
    },
    agentdStateDir: dir, settings: () => ({}), ownPids: () => [4000], log: (line) => logs.push(line),
    onLook: lookReceipt(() => (state.desktop ? stack : null)),
    clock: { now: () => 1_000, every: () => () => {}, after: () => () => {} },
  });
  context?.sampled(sample());
  const hotkeys = shellHotkeys({
    argv: o.argv ?? ['electron', '.'], shortcut, settings: () => o.settings ?? {}, context: o.capturer === false ? null : context,
    avatarHidden: () => state.hidden,
    setHidden: (h, reason) => {
      hidden.push([h, reason]);
      state.hidden = h;
    },
    quickInput: () => (state.desktop ? (first) => opened.push(first) : null),
    clickThroughAll: o.link === false ? null : { on: () => state.clickThroughAll, set: (on) => { state.clickThroughAll = on; } },
    commandRing: () => (state.desktop ? {
      get cmdMode() { return state.cmdMode; },
      open: (mode) => { ring.push(`open ${mode}`); state.cmdMode = mode; },
      close: () => { ring.push('close'); state.cmdMode = null; },
    } : null),
    log: (line) => logs.push(line),
  });
  return { dir, shortcut, requests, logs, opened, hidden, state, ring, stack, context, hotkeys,
    done: () => { hotkeys?.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('register: an empty name registers nothing, a bad one logs bad_hotkey, a refused one hotkey_failed; both are kept as failed', () => {
  const shortcut = new Shortcut(), logs: string[] = [];
  const keys = new GlobalHotkeys({ register: shortcut.register, unregister: shortcut.unregister, log: (l) => logs.push(l) });
  let presses = 0;
  keys.register('', HOTKEY_IDS.look, () => { presses += 1; });
  assert.deepEqual(shortcut.calls, []);
  keys.register('right_option', HOTKEY_IDS.look, () => { presses += 1; });
  assert.deepEqual(shortcut.calls, []);
  assert.deepEqual(logs, ['HOTKEY bad_hotkey right_option']);
  assert.equal(keys.failed.get(HOTKEY_IDS.look), 'right_option');
  shortcut.refuse.add('Control+Alt+H');
  keys.register('control+option+h', HOTKEY_IDS.toggleAvatar, () => { presses += 1; });
  assert.equal(logs.at(-1), 'HOTKEY hotkey_failed id=4 key=control+option+h');
  assert.equal(keys.failed.get(HOTKEY_IDS.toggleAvatar), 'control+option+h');
  // update re-registers with the action it was registered with, and a name that takes clears the failure.
  keys.update('control+option+l', HOTKEY_IDS.look);
  assert.equal(logs.at(-1), 'HOTKEY updated 3 control+option+l');
  assert.equal(keys.failed.has(HOTKEY_IDS.look), false);
  shortcut.press('Control+Alt+L');
  assert.equal(presses, 1);
  keys.update('control+option+k', HOTKEY_IDS.look);
  assert.deepEqual(shortcut.calls.slice(-2), ['unregister Control+Alt+L', 'register Control+Alt+K']);
  keys.update('control+option+j', HOTKEY_IDS.selection);
  assert.equal(logs.at(-1), 'HOTKEY update_unknown 7');
  keys.stop();
  assert.equal(shortcut.calls.at(-1), 'unregister Control+Alt+K');
  assert.equal(shortcut.pressed.size, 0);
});

test('setUpGlobalHotkeys: hotkey_look, hotkey_toggle_avatar, hotkey_click_through, hotkey_radial_menu and hotkey_selection with their defaults', () => {
  const s = setup();
  try {
    assert.deepEqual(s.shortcut.calls, ['register Control+Alt+L', 'register Control+Alt+H', 'register Control+Alt+P', 'register Control+Alt+R',
      'register Control+Alt+S']);
    // GlobalHotkeys logs the ring's registration only.
    assert.deepEqual(s.logs.filter((l) => l.startsWith('HOTKEY')), ['HOTKEY registered id=6 key=control+option+r']);
  } finally { s.done(); }
  const t = setup({ settings: { hotkey_look: 'command+shift+l', hotkey_toggle_avatar: '', hotkey_click_through: '', hotkey_radial_menu: '',
    hotkey_selection: 'f6' } });
  try {
    assert.deepEqual(t.shortcut.calls, ['register Shift+Command+L', 'register F6']);
    t.hotkeys!.stop();
    assert.deepEqual(t.shortcut.calls.slice(2), ['unregister Shift+Command+L', 'unregister F6']);
  } finally { t.done(); }
});

test('hotkey_click_through turns click-through all on and off as the hot key; without the avatar link it logs', () => {
  const s = setup();
  try {
    s.shortcut.press('Control+Alt+P');
    assert.equal(s.state.clickThroughAll, true);
    s.shortcut.press('Control+Alt+P');
    assert.equal(s.state.clickThroughAll, false);
    assert.deepEqual(s.logs.filter((l) => l.startsWith('CLICK_THROUGH')), ['CLICK_THROUGH on source=hotkey', 'CLICK_THROUGH off source=hotkey']);
  } finally { s.done(); }
  const bare = setup({ link: false });
  try {
    bare.shortcut.press('Control+Alt+P');
    assert.ok(bare.logs.includes('CLICK_THROUGH source=hotkey: no avatar link (config failed)'));
  } finally { bare.done(); }
});

test('hotkey_radial_menu opens the command ring, and closes it while the ring is open', () => {
  const s = setup();
  try {
    s.shortcut.press('Control+Alt+R');
    s.shortcut.press('Control+Alt+R');
    s.state.cmdMode = 'input';
    s.shortcut.press('Control+Alt+R');
    assert.deepEqual(s.ring, ['open ring', 'close', 'open ring']);
    assert.deepEqual(s.logs.filter((l) => l.startsWith('COMMAND_RING')), ['COMMAND_RING source=hotkey action=open',
      'COMMAND_RING source=hotkey action=close', 'COMMAND_RING source=hotkey action=open']);
  } finally { s.done(); }
  const bare = setup({ desktop: false });
  try {
    bare.shortcut.press('Control+Alt+R');
    assert.deepEqual(bare.ring, []);
    assert.deepEqual(bare.logs.filter((l) => l.startsWith('COMMAND_RING')), []);
  } finally { bare.done(); }
});

test('unregisteredHotkeys: the names the system refused or that are no hot key, by config.json key, with 快速输入\'s and 按住说话\'s', () => {
  const s = setup({ settings: { hotkey_look: 'right_option' } });
  try {
    assert.deepEqual(unregisteredHotkeys(s.hotkeys, null, null), { hotkey_look: 'right_option' });
    s.shortcut.refuse.add('Control+Alt+K');
    s.hotkeys!.saved('hotkey_radial_menu', 'control+option+k');
    assert.deepEqual(unregisteredHotkeys(s.hotkeys, 'control+option+space', 'right_command'), { hotkey_look: 'right_option',
      hotkey_radial_menu: 'control+option+k', hotkey_quick_input: 'control+option+space', voice_hotkey: 'right_command' });
    s.hotkeys!.saved('hotkey_radial_menu', 'control+option+j');
    s.hotkeys!.saved('hotkey_look', '');
    assert.deepEqual(unregisteredHotkeys(s.hotkeys, null, null), {});
    assert.deepEqual(unregisteredHotkeys(null, null, 'right_option'), { voice_hotkey: 'right_option' });
  } finally { s.done(); }
});

test('hotkey_look asks agentd to look through the capturer; a requested look puts 已识读 with the front window\'s title on the stack', async () => {
  const s = setup();
  try {
    s.shortcut.press('Control+Alt+L');
    await settle();
    assert.deepEqual(s.requests, ['POST /look']);
    assert.ok(s.logs.includes('LOOK result=requested(look-1)'));
    const cards = s.stack.snapshot().cards;
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.variant, 'look');
    assert.equal(cards[0]!.title, '已识读：notes.txt');
  } finally { s.done(); }
});

test('the receipt: a look agentd did not take shows none, an unknown window is 前台窗口, and none without the desktop panels', async () => {
  const blocked = setup({ look: { status: 409, body: { error: 'blocked', reason: 'blacklisted' } } });
  try {
    await blocked.context!.look();
    assert.deepEqual(blocked.stack.snapshot().cards, []);
  } finally { blocked.done(); }
  const s = setup();
  try {
    s.context!.sampled({ ...sample(), front: null });
    await s.context!.look();
    assert.equal(s.stack.snapshot().cards[0]!.title, '已识读：前台窗口');
    s.state.desktop = false;
    s.stack.collapse(s.stack.snapshot().cards[0]!.id as string);
    await s.context!.look();
    assert.deepEqual(s.stack.snapshot().cards, []);
  } finally { s.done(); }
});

test('hotkey_toggle_avatar hides her when shown and shows her when hidden, as the user', () => {
  const s = setup();
  try {
    s.shortcut.press('Control+Alt+H');
    s.shortcut.press('Control+Alt+H');
    assert.deepEqual(s.hidden, [[true, 'user'], [false, 'user']]);
  } finally { s.done(); }
});

test('hotkey_selection opens 快速输入 with the read, the refusal or nothing; without the desktop panels nothing is read', async () => {
  const s = setup();
  try {
    s.shortcut.press('Control+Alt+S');
    await settle();
    assert.deepEqual(s.opened, [{ kind: 'selection', source: 'selection', text: 'selected words', app: 'TextEdit', truncated: false }]);
    assert.ok(s.logs.includes('SELECTION read source=selection chars=14 truncated=false'));
  } finally { s.done(); }
  const secure = setup({ secure: true });
  try {
    secure.shortcut.press('Control+Alt+S');
    await settle();
    assert.equal(secure.opened.length, 1);
    assert.equal(secure.opened[0]!.kind, 'selectionRefused');
    assert.ok(!secure.requests.includes('ax.selected_text'));
  } finally { secure.done(); }
  const empty = setup({ selected: null });
  try {
    empty.shortcut.press('Control+Alt+S');
    await settle();
    assert.deepEqual(empty.opened, [undefined]);
  } finally { empty.done(); }
  const bare = setup({ desktop: false });
  try {
    bare.shortcut.press('Control+Alt+S');
    await settle();
    assert.deepEqual(bare.opened, []);
    assert.deepEqual(bare.requests, []);
    assert.ok(bare.logs.includes('SELECTION no_web_desktop'));
  } finally { bare.done(); }
});

test('hotkeySaved: the five desktop command hot keys take their new names; the other keys are not theirs', () => {
  const s = setup();
  try {
    s.shortcut.calls = [];
    s.hotkeys!.saved('hotkey_look', 'control+option+k');
    s.hotkeys!.saved('hotkey_toggle_avatar', '');
    s.hotkeys!.saved('hotkey_selection', 'control+option+d');
    s.hotkeys!.saved('hotkey_click_through', 'control+option+t');
    s.hotkeys!.saved('hotkey_radial_menu', 'control+option+w');
    s.hotkeys!.saved('hotkey_quick_input', 'control+option+q');
    s.hotkeys!.saved('voice_hotkey', 'right_command');
    assert.deepEqual(s.shortcut.calls, ['unregister Control+Alt+L', 'register Control+Alt+K', 'unregister Control+Alt+H',
      'unregister Control+Alt+S', 'register Control+Alt+D', 'unregister Control+Alt+P', 'register Control+Alt+T', 'unregister Control+Alt+R',
      'register Control+Alt+W']);
    assert.deepEqual(s.logs.slice(-2), ['HOTKEY registered id=6 key=control+option+w', 'HOTKEY updated 6 control+option+w']);
    s.shortcut.press('Control+Alt+T');
    assert.equal(s.state.clickThroughAll, true);
    s.shortcut.press('Control+Alt+K');
    assert.ok(!s.shortcut.pressed.has('Control+Alt+H'));
  } finally { s.done(); }
});

test('--no-attention (test and host runs) registers no hot key; without a capturer neither hotkey_look nor hotkey_selection registers', () => {
  const s = setup({ argv: ['electron', '.', '--no-attention'] });
  try {
    assert.equal(s.hotkeys, null);
    assert.deepEqual(s.shortcut.calls, []);
  } finally { s.done(); }
  const t = setup({ capturer: false });
  try {
    const shown = ['register Control+Alt+H', 'register Control+Alt+P', 'register Control+Alt+R'];
    assert.deepEqual(t.shortcut.calls, shown);
    t.hotkeys!.saved('hotkey_look', 'control+option+k');
    t.hotkeys!.saved('hotkey_selection', 'control+option+d');
    assert.deepEqual(t.shortcut.calls, shown);
  } finally { t.done(); }
});

test('computer control: each published state reaches the stack card and computerUseActive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-'));
  writeFileSync(join(dir, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ plugins: { computer_use: true } }));
  const stack = new StackSource({ request: async () => ({ status: 404, body: '' }), notify: () => ({ modes: {} }), avatarHidden: () => false,
    frontFullscreen: () => false, playSound: () => {} });
  const phases: [string, boolean][] = [];
  const respond: Record<string, unknown>[] = [];
  const control = shellControl({
    argv: ['electron', '.'],
    helper: {
      request: async (op, params = {}) => {
        if (op === 'control.listen') return ok({ endpoint: params.endpoint });
        if (op === 'input.watch') return ok({ watching: params.enabled === true });
        if (op === 'permissions.status') return ok({ accessibility: 'granted', screenRecording: 'granted' });
        if (op === 'control.respond') {
          respond.push(params);
          return ok({ sent: true });
        }
        if (op === 'apps.running') return ok({ apps: [{ pid: 800, name: 'Notes', app_id: 'com.example.notes', launched_at: 2000 }] });
        if (op === 'windows.list') return ok({ windows: [{ window_id: 77, pid: 800, bounds: { x: 0, y: 0, width: 9, height: 9 }, layer: 0, title: 'a' }] });
        return { ok: false, error: { code: 'unsupported' } };
      },
    },
    supportDir: dir, configPath, agentdStateDir: dir, saved: () => ({ plugins: { ...DEFAULT_PLUGINS, computer_use: true } }), ownPids: () => [process.pid],
    log: () => {},
    onState: (s) => {
      stack.setComputerUse(s);
      phases.push([s.phase, computerUseState(s).active]);
    },
  });
  try {
    const observe = (conn: number) => control!.event('control.request', { conn,
      request: { id: `r${conn}`, method: 'desktop_observe', session_id: 's1', params: { pid: 800, window_id: 77 } } });
    control!.helper(true);
    await settle();
    observe(1);
    await settle();
    assert.deepEqual(phases.at(-1), ['waitingPermission', false]);
    assert.deepEqual(stack.snapshot().cards, []);
    await control!.grant('observation', control!.state.challenge);
    await settle();
    // The fake helper has no control.observe: observing, then failed.
    const seen: { phase: string; cards: unknown[] }[] = [];
    const before = phases.length;
    const was = stack.setComputerUse.bind(stack);
    stack.setComputerUse = (s) => {
      was(s);
      seen.push({ phase: s?.phase ?? 'none', cards: stack.snapshot().cards.map((c) => c.id) });
    };
    observe(2);
    await settle();
    assert.deepEqual(phases.slice(before), [['observing', true], ['failed', false]]);
    assert.deepEqual(seen, [{ phase: 'observing', cards: ['computer-use'] }, { phase: 'failed', cards: [] }]);
    assert.equal(stack.snapshot().history[0]!.title, '电脑操作');
    assert.equal(computerUseState(control!.state).active, false);
  } finally {
    await control?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
