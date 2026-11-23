// The desktop panels' assembly (src/main/desktop/assembly.ts) with a stand-in `electron` module, fake windows and a fake
// agentd: the 快速输入 hot key is not registered with `--no-attention` (as hotkeys/shell.ts); `pushState` sends
// `desktop.onState` at once, with the hover buttons' `dock`; `desktop.action`'s openSessions, openStack and talk; the bubble's
// notice; C3 rule 39's present of the bubble for an approval; the hover buttons opening after a rest on her; a mouse down
// outside closes the wheel and the console; her lines' `noteLine` and the `typing` the frame rate reads.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { BrowserWindow, Rectangle } from 'electron';
import type { Handler } from '../src/common/bridge.ts';
import { PageSession } from '../src/common/page.ts';
import type { EventSource, StreamEvent } from '../src/common/page.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';
import type { Request } from '../src/common/stack-source.ts';
import { TurnMarks } from '../src/common/turn-marks.ts';

/** The tokens of the presents sent. */
const presented: string[] = [];
/** globalShortcut: records each call; nothing reaches the system. */
const shortcuts: string[] = [];
(globalThis as Record<string, unknown>).__desktopAssemblyElectron = {
  globalShortcut: { register: (accel: string) => { shortcuts.push(`register ${accel}`); return true; },
    unregister: (accel: string) => { shortcuts.push(`unregister ${accel}`); } },
  Notification: class { show() {} },
};
const STUB = 'const e = globalThis.__desktopAssemblyElectron; export const globalShortcut = e.globalShortcut; export const Notification = e.Notification;';
registerHooks({
  resolve: (specifier, context, next) => (specifier === 'electron'
    ? { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true } : next(specifier, context)),
});
const { DesktopAssembly } = await import('../src/main/desktop/assembly.ts');
type DesktopOptions = import('../src/main/desktop/assembly.ts').DesktopOptions;
/** The panels' routes in the order the assembly makes their windows. */
const ROUTES = ['/bubble', '/dock', '/cmd', '/console', '/chip'];
/** The URLs the fake windows loaded. */
const loaded: string[] = [];

/** `shown` gets `show <route>` at each showInactive and `hide <route>` at each hide, `moved` each setBounds. */
function fakeWindow(id: number, shown: (route: string) => void, moved: (route: string, b: Rectangle) => void) {
  const contents = Object.assign(new EventEmitter(), { id, send() {}, isDestroyed: () => false });
  let bounds = { x: 0, y: 0, width: 100, height: 100 };
  return Object.assign(new EventEmitter(), {
    webContents: contents, setFocusable() {}, loadURL: async (url: string) => { loaded.push(url); }, getBounds: () => bounds, isDestroyed: () => false,
    isFocused: () => false, showInactive() { shown(`show ${ROUTES[id - 1]!}`); }, hide() { shown(`hide ${ROUTES[id - 1]!}`); }, setIgnoreMouseEvents() {}, setOpacity() {}, focus() {},
    destroy() {},
    setBounds(b: typeof bounds) { bounds = b; moved(ROUTES[id - 1]!, b); },
  });
}

/** An assembly on fake windows with `extra` arguments until `done`, with config.json in a temporary support dir. */
function setup(extra: string[], o: { present?: boolean; request?: Request; marks?: TurnMarks; mouse?: () => { x: number; y: number };
  mouseDowns?: (listener: () => void) => () => void; feed?: EventSource; noteLine?: () => void; makeWindow?: (kind: string) => void;
  toDip?: (f: Rect) => Rectangle; screens?: () => ScreenInfo[]; hovered?: boolean; talk?: (phase: 'start' | 'stop') => void;
  recent?: DesktopOptions['recent'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-assembly-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ hotkey_quick_input: 'control+option+k' }));
  const argv = process.argv;
  process.argv = [...argv, '--config', join(dir, 'config.json'), ...extra];
  shortcuts.length = 0;
  const calls: string[] = [];
  /** Each panel's last bounds, in the fake DIP space. */
  const bounds = new Map<string, Rectangle>();
  let state = 0, id = 0;
  const pages = new Map<string, { page: PageSession; ops: ReadonlyMap<string, Handler<PageSession>> }>();
  const desktop = new DesktopAssembly({
    makeWindow: (kind) => {
      o.makeWindow?.(kind);
      return fakeWindow(++id, (line) => calls.push(line), (route, b) => bounds.set(route, b)) as unknown as BrowserWindow;
    },
    url: (route) => `app://x/stack.html#${route}`,
    toDip: o.toDip ?? ((f) => ({ x: f.x, y: 1000 - f.y - f.h, width: f.w, height: f.h })),
    screens: o.screens ?? (() => [{ id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 }, visibleFrame: { x: 0, y: 0, w: 1512, h: 957 } }]),
    cursorDip: () => ({ x: 0, y: 0 }), mouse: o.mouse ?? (() => ({ x: 0, y: 0 })),
    ...(o.mouseDowns && { mouseDowns: o.mouseDowns }),
    ...(o.noteLine && { noteLine: o.noteLine }),
    ...(o.recent && { recent: o.recent }),
    register: (contents, page, ops) => {
      pages.set(ROUTES[contents.id - 1]!, { page, ops });
    },
    unregister: () => {},
    baseOps: new Map(),
    request: o.request ?? (async () => ({ status: 503, body: '{}' })),
    ...(o.marks && { marks: o.marks }),
    feed: o.feed ?? null,
    notify: () => ({ modes: { done: 'card', waiting: 'card', error: 'card', brief: 'card', reminder: 'card' }, systemNotifications: false }),
    sample: () => ({ now: performance.now() / 1000, body: { x: 600, y: 100, w: 200, h: 400 }, bodyAt: performance.now() / 1000, visual: null,
      placement: null, dragging: false }),
    avatarHidden: () => false, frontFullscreen: () => false, figure: () => 'si/default',
    hover: () => ({ present: o.hovered === true, hovered: o.hovered === true, hints: true }),
    state: () => ({ n: ++state }),
    actions: { look() {}, setHidden() {}, setQuiet: async () => {}, switchCharacter() {}, placeOnScreen() {}, resetPosition() {}, restartAll() {},
      quit() {}, ...(o.talk && { talk: o.talk }) },
    ...(o.present === false ? {} : { present: (token: string, side: string, phase: string) => {
      presented.push(token);
      calls.push(`present ${token} ${side} ${phase}`);
      return true;
    } }),
    playSound() {}, confirm: async () => true,
    openMain: (route) => calls.push(`openMain ${route}`),
    log: () => {},
  });
  /** What `route`'s page got on `op` (subscribed now), as the parsed `data` of each push. */
  const watch = (route: string, op: string) => {
    const got: unknown[] = [];
    const entry = pages.get(route)!;
    const page = new PageSession((_sub, _stream, _kind, payload) => { if (payload) got.push(JSON.parse(payload.data)); });
    entry.ops.get(op)!([7], page);
    return got;
  };
  const call = (route: string, op: string, args: unknown[]) => pages.get(route)!.ops.get(op)!(args, new PageSession(() => {}));
  const done = () => {
    if (!open.delete(done)) return;
    desktop.stop();
    process.argv = argv;
    rmSync(dir, { recursive: true, force: true });
  };
  open.add(done);
  return { desktop, calls, bounds, watch, call, done, dir };
}

/** The assemblies a failed test left running: their timers would keep the test process alive. */
const open = new Set<() => void>();
afterEach(() => {
  for (const done of [...open]) done();
});

test('--no-attention registers no 快速输入 hot key, at start or when it is saved; without it both register', () => {
  const quiet = setup(['--no-attention']);
  quiet.desktop.start();
  quiet.desktop.hotkeySaved('hotkey_quick_input', 'control+option+j');
  assert.deepEqual(shortcuts, []);
  quiet.done();
  const live = setup([]);
  live.desktop.start();
  live.desktop.hotkeySaved('hotkey_quick_input', 'control+option+j');
  assert.deepEqual(shortcuts, ['register Control+Alt+K', 'unregister Control+Alt+K', 'register Control+Alt+J']);
  live.done();
  assert.deepEqual(shortcuts.slice(3), ['unregister Control+Alt+J']);
});

test('pushState sends desktop.onState now; notice and openStack reach desktop.onCommand; openSessions opens the sessions page', async () => {
  const h = setup(['--no-attention']);
  h.desktop.start();
  const states = h.watch('/dock', 'desktop.onState');
  const commands = h.watch('/bubble', 'desktop.onCommand');
  h.desktop.pushState();
  assert.deepEqual(states, [{ n: 1, dock: { open: false, side: 'right', compact: false } }]);
  h.desktop.notice('她在忙，等这一轮做完');
  // 去处理 with no card says so in the bubble; with one the stack expands.
  assert.equal(await h.call('/cmd', 'desktop.action', ['openStack']), null);
  h.desktop.agentd(true);
  assert.equal(h.desktop.testCard('approval'), true);
  assert.equal(await h.call('/cmd', 'desktop.action', ['openStack']), null);
  assert.deepEqual(commands, [{ kind: 'notice', text: '她在忙，等这一轮做完' }, { kind: 'notice', text: '现在没有要处理的' },
    { kind: 'expandStack' }]);
  assert.equal(await h.call('/cmd', 'desktop.action', ['openSessions']), null);
  assert.ok(h.calls.includes('openMain /overview?focus=running'));
  h.done();
});

test('desktop.onRecent sends 最近播报 at start and on each change; the console opens one and marks all read through the shell', async () => {
  const rows = [{ id: 'announce-2', text: '周报已交付', time: '14:01', unread: true }];
  const calls: string[] = [];
  const h = setup(['--no-attention'], { recent: { rows: () => rows, open: (id) => calls.push(`open ${id}`), markAllRead: () => calls.push('markAllRead') } });
  h.desktop.start();
  const got = h.watch('/console', 'desktop.onRecent');
  assert.deepEqual(got, [rows]);
  rows[0]!.unread = false;
  h.desktop.recentChanged();
  assert.deepEqual(got, [[{ ...rows[0], unread: true }], rows]);
  assert.equal(await h.call('/console', 'desktop.openAnnouncement', ['announce-2']), null);
  assert.equal(await h.call('/console', 'desktop.markAllRead', []), null);
  assert.deepEqual(calls, ['open announce-2', 'markAllRead']);
  await assert.rejects(async () => h.call('/console', 'desktop.openAnnouncement', [3]), /invalid_args/);
  h.done();
  const bare = setup(['--no-attention']);
  bare.desktop.start();
  assert.deepEqual(bare.watch('/console', 'desktop.onRecent'), [[]]);
  assert.throws(() => bare.call('/console', 'desktop.markAllRead', []), TypeError, 'no handler without 最近播报');
  bare.done();
});

test('stateSource replays the last desktop.onState to a page outside the panels (the first-run guide)', () => {
  const h = setup(['--no-attention']);
  h.desktop.start();
  h.desktop.pushState();
  const got: unknown[] = [];
  h.desktop.stateSource.subscribe(null, (e) => got.push(JSON.parse(e.data)), () => {});
  assert.deepEqual(got, [{ n: 1, dock: { open: false, side: 'right', compact: false } }]);
  h.done();
});

test('each panel\'s window is made for its own overlay level', () => {
  const kinds: string[] = [];
  const h = setup(['--no-attention'], { makeWindow: (kind) => kinds.push(kind) });
  h.desktop.start();
  assert.deepEqual(kinds, ['bubble', 'dock', 'cmd', 'console', 'chip']);
  h.done();
});

test('resetOffsets (复位浮窗 in the menus) clears every panel\'s user offset, as desktop.action resetBoxes does', () => {
  const h = setup(['--no-attention']);
  const file = join(h.dir, 'desktop-offsets.json');
  const saved = { side: 'left', gap: 12, along: 0.5 };
  writeFileSync(file, JSON.stringify({ 'desktopPanelOffset.v3.dock': saved, 'desktopPanelOffset.v3.bubble': saved, other: 1 }));
  h.desktop.resetOffsets();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { other: 1 });
  h.done();
});

test('the chip panel loads #/chip, shows with its circle\'s region beside her head and gets her anchor and desktop.onState', () => {
  const h = setup(['--no-attention']);
  loaded.length = 0;
  h.desktop.start();
  assert.equal(loaded.at(-1), 'app://x/stack.html#/chip');
  const anchors = h.watch('/chip', 'window.onAnchor');
  const states = h.watch('/chip', 'desktop.onState');
  h.call('/chip', 'window.setContentSize', [{ width: 528, height: 36 }]);
  h.call('/chip', 'window.setInteractiveRegions', [[{ x: 246, y: 0, width: 36, height: 36 }]]);
  assert.ok(h.calls.includes('show /chip'));
  // Her head top (700, 500): the circle's top there, its left 8 out from her face's right edge at 760.
  assert.deepEqual(h.bounds.get('/chip'), { x: 522, y: 500, width: 528, height: 36 });
  assert.deepEqual(anchors.map((a) => { const { panel, side, docked } = a as Record<string, unknown>; return { panel, side, docked }; }),
    [{ panel: 'chip', side: 'right', docked: null }]);
  h.desktop.pushState();
  assert.deepEqual(states.at(-1), { n: 1, dock: { open: false, side: 'right', compact: false } });
  h.done();
});

test('on a 200 % display the page\'s reported size is the window\'s size in DIPs', () => {
  // A placement space of physical pixels, as on Windows; a DIP is two of them.
  const h = setup(['--no-attention'], {
    toDip: (f) => ({ x: f.x / 2, y: (1964 - f.y - f.h) / 2, width: f.w / 2, height: f.h / 2 }),
    screens: () => [{ id: 1, frame: { x: 0, y: 0, w: 3024, h: 1964 }, visibleFrame: { x: 0, y: 0, w: 3024, h: 1914 } }],
  });
  h.desktop.start();
  h.call('/chip', 'window.setContentSize', [{ width: 400, height: 36 }]);
  h.call('/chip', 'window.setInteractiveRegions', [[{ x: 182, y: 0, width: 36, height: 36 }]]);
  assert.ok(h.calls.includes('show /chip'));
  const b = h.bounds.get('/chip')!;
  assert.deepEqual([b.width, b.height], [400, 36]);
  h.done();
});

/** The bubble page showing its confirm card, as BubbleRoot reports it. */
const confirmCard = (h: { call: (route: string, op: string, args: unknown[]) => unknown }) => {
  h.call('/bubble', 'window.setContentSize', [{ width: 380, height: 200 }]);
  h.call('/bubble', 'window.setInteractiveRegions', [[{ x: 16, y: 22, width: 348, height: 162 }]]);
};

test('rule 39: a hidden bubble that gets an approval presents first and shows at her stroke', async () => {
  const h = setup(['--no-attention']);
  h.desktop.start();
  h.desktop.agentd(true);
  assert.equal(h.desktop.testCard('approval'), true);
  confirmCard(h);
  const token = presented.at(-1)!;
  assert.deepEqual(h.calls, [`present ${token} right open`]);
  h.desktop.stroke('another');
  assert.deepEqual(h.calls, [`present ${token} right open`]);
  h.desktop.stroke(token);
  assert.deepEqual(h.calls, [`present ${token} right open`, 'show /bubble']);
  h.done();
  // Without the link's present the bubble shows as before.
  const bare = setup(['--no-attention'], { present: false });
  bare.desktop.start();
  bare.desktop.agentd(true);
  assert.equal(bare.desktop.testCard('approval'), true);
  confirmCard(bare);
  assert.deepEqual(bare.calls, ['show /bubble']);
  bare.done();
});

test('rule 39: a bubble left with no approval closes her snap at the push', async () => {
  const h = setup(['--no-attention']);
  h.desktop.start();
  h.desktop.agentd(true);
  assert.equal(h.desktop.testCard('approval'), true);
  confirmCard(h);
  const token = presented.at(-1)!;
  h.desktop.stroke(token);
  h.calls.length = 0;
  h.desktop.source.onPush!([]);
  assert.deepEqual(h.calls, [`present ${token} right close`]);
  h.done();
});

test('the hover buttons open after a rest on her, go out in desktop.onState, and close with the wheel or a pick', async () => {
  const h = setup(['--no-attention'], { hovered: true });
  h.desktop.start();
  const states = h.watch('/dock', 'desktop.onState') as { dock: { open: boolean } }[];
  const open = () => states.at(-1)?.dock.open === true;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(open(), false, 'not yet at 150 ms');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(open(), true);
  h.desktop.open('ring');
  assert.equal(open(), false, 'the wheel takes over');
  h.desktop.close();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(open(), true);
  assert.equal(await h.call('/dock', 'desktop.action', ['look']), null);
  assert.equal(open(), false, 'a pick closes them');
  h.done();
});

test('C3 rule 57: the hover buttons do not open while she walks, and do once she stops', async () => {
  const h = setup(['--no-attention'], { hovered: true });
  h.desktop.setMoving(true);
  h.desktop.start();
  const states = h.watch('/dock', 'desktop.onState') as { dock: { open: boolean } }[];
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(states.at(-1)?.dock.open, false, 'walking');
  h.desktop.setMoving(false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(states.at(-1)?.dock.open, true);
  h.done();
});

test('C3 rule 56: the wheel a held right press opened gets its moves and release in its page\'s CSS px; one a click opened gets none', () => {
  const h = setup(['--no-attention']);
  h.desktop.start();
  const commands = h.watch('/cmd', 'desktop.onCommand') as Record<string, unknown>[];
  h.call('/cmd', 'window.setContentSize', [{ width: 520, height: 520 }]);
  h.desktop.openWheel({ x: 700, y: 500 }, true);
  h.call('/cmd', 'window.setInteractiveRegions', [[{ x: 0, y: 0, width: 520, height: 520 }]]);
  const b = h.bounds.get('/cmd')!;
  // The fake toDip puts a placement point at y 1000 − y.
  h.desktop.ringPointer('move', { x: 720, y: 480 });
  assert.deepEqual(commands.at(-1), { kind: 'ringPointer', phase: 'move', x: 720 - b.x, y: 520 - b.y });
  h.desktop.ringPointer('up', { x: 730, y: 470 });
  const up = commands.at(-1)!;
  assert.deepEqual({ ...up, ms: 0 }, { kind: 'ringPointer', phase: 'up', x: 730 - b.x, y: 530 - b.y, ms: 0 });
  assert.ok(typeof up.ms === 'number' && up.ms >= 0, `${up.ms}`);
  const after = commands.length;
  h.desktop.ringPointer('move', { x: 740, y: 460 });
  assert.equal(commands.length, after, 'the press is over');
  h.desktop.openWheel({ x: 700, y: 500 });
  const clicked = commands.length;
  h.desktop.ringPointer('move', { x: 720, y: 480 });
  h.desktop.ringPointer('up', { x: 720, y: 480 });
  assert.equal(commands.length, clicked);
  h.done();
});

test('说话 on the hover buttons runs the push-to-talk port and keeps them while it records', async () => {
  const phases: string[] = [];
  const h = setup(['--no-attention'], { hovered: true, talk: (phase) => phases.push(phase) });
  h.desktop.start();
  const states = h.watch('/dock', 'desktop.onState') as { dock: { open: boolean } }[];
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(states.at(-1)?.dock.open, true);
  assert.equal(await h.call('/dock', 'desktop.action', ['talk', 'start']), null);
  assert.equal(states.at(-1)?.dock.open, true);
  assert.equal(await h.call('/dock', 'desktop.action', ['talk', 'stop']), null);
  assert.deepEqual(phases, ['start', 'stop']);
  h.done();
  // Without the port the page hears not_implemented.
  const bare = setup(['--no-attention']);
  bare.desktop.start();
  await assert.rejects(async () => bare.call('/dock', 'desktop.action', ['talk', 'start']), /not_implemented|desktop.action talk/);
  bare.done();
});

test('desktop.say goes out with an Idempotency-Key and marks the line agentd took', async () => {
  const sent: Record<string, string>[] = [], marks: string[] = [];
  const h = setup(['--no-attention'], {
    request: async (_method, _path, _json, headers) => {
      sent.push(headers ?? {});
      return { status: 202, body: JSON.stringify({ line_id: 'l1', trace_id: 't1', generation: 1 }) };
    },
    marks: new TurnMarks((kind) => { marks.push(kind); }),
  });
  h.desktop.start();
  assert.deepEqual(await h.call('/cmd', 'desktop.say', [{ text: '你好', attachWindow: false, noMemory: false }]), { ok: true });
  assert.match(sent[0]!['Idempotency-Key']!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(marks, ['ui.submitted', 'ui.ack']);
  h.done();
});

/** A setup whose mouse downs `press` at `at` (placement space), with `route`'s centre given as a point there. */
function pressing() {
  let listener: (() => void) | null = null, at = { x: -500, y: -500 };
  const h = setup(['--no-attention'], { mouse: () => at, mouseDowns: (l) => {
    listener = l;
    return () => { listener = null; };
  } });
  const press = (p: { x: number; y: number }) => {
    at = p;
    listener?.();
  };
  const centre = (route: string) => {
    const b = h.bounds.get(route)!;
    return { x: b.x + b.width / 2, y: 1000 - b.y - b.height / 2 };
  };
  return { ...h, press, centre, listening: () => listener !== null };
}

/** The command layer opened in `mode` and its page's regions in, so its panel shows and is placed. */
function openCmd(h: ReturnType<typeof pressing>, mode: 'ring' | 'input') {
  h.call('/cmd', 'window.setContentSize', [{ width: 300, height: 300 }]);
  h.desktop.open(mode);
  h.call('/cmd', 'window.setInteractiveRegions', [[{ x: 0, y: 0, width: 300, height: 300 }]]);
}

test('a mouse down outside the wheel closes it, one in its panel does not; input stays (DesktopCoordinator.mouseDown)', () => {
  const h = pressing();
  h.desktop.start();
  assert.equal(h.listening(), true);
  openCmd(h, 'ring');
  assert.ok(h.calls.includes('show /cmd'));
  h.press(h.centre('/cmd'));
  assert.equal(h.desktop.cmdMode, 'ring');
  h.press({ x: -500, y: -500 });
  assert.equal(h.desktop.cmdMode, null);
  openCmd(h, 'input');
  h.press({ x: -500, y: -500 });
  assert.equal(h.desktop.cmdMode, 'input');
  h.done();
  assert.equal(h.listening(), false);
});

test('a mouse down outside the console closes it; one in it, or on the menu bar button its click toggles, does not', () => {
  const h = pressing();
  h.desktop.start();
  const statusItem = { x: 900, y: 960, w: 30, h: 22 };
  // The console's first open waits for a content size its page did not have before.
  h.desktop.openConsole(statusItem);
  h.call('/console', 'window.setContentSize', [{ width: 360, height: 400 }]);
  h.call('/console', 'window.setInteractiveRegions', [[{ x: 0, y: 0, width: 360, height: 400 }]]);
  assert.ok(h.calls.includes('show /console'));
  h.press(h.centre('/console'));
  // On the button and above the console's panel, whose top is at y 972 here.
  h.press({ x: 910, y: 978 });
  assert.equal(h.desktop.consoleOpen, true);
  h.press({ x: -500, y: -500 });
  assert.equal(h.desktop.consoleOpen, false);
  h.done();
});

test('fps tier: each `line` of the feed is a noteLine; `typing` is the desktop\'s typing', () => {
  let feedListener: ((e: StreamEvent) => void) | null = null;
  const feed: EventSource = { subscribe: (_after, onEvent) => {
    feedListener = onEvent;
    return () => { feedListener = null; };
  } };
  let lines = 0;
  const h = setup(['--no-attention'], { feed, noteLine: () => { lines += 1; } });
  h.desktop.start();
  feedListener!({ event: 'line', id: null, data: '{"line_id":"l1","text_delta":"你"}' });
  feedListener!({ event: 'announce', id: null, data: '{}' });
  assert.equal(lines, 1);
  assert.equal(h.desktop.typing, false);
  h.desktop.open('ring');
  assert.equal(h.desktop.typing, true);
  h.desktop.close();
  h.desktop.openConsole(null);
  assert.equal(h.desktop.typing, true);
  h.desktop.closeConsole();
  h.desktop.openQuickInput();
  assert.equal(h.desktop.typing, true);
  h.desktop.closeQuickInput();
  assert.equal(h.desktop.typing, false);
  h.done();
  assert.equal(feedListener, null);
});
