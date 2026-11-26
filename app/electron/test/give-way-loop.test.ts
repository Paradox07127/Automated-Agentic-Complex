// The give-way loop (src/main/give-way/): the keep-clear feed's reads and the fullscreen
// hiding, on a fake platform helper and fake timers. Nothing here reads the real system's windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AttentionSample, helperY, type ReflexState } from '../src/common/attention.ts';
import type { KeepClearRect } from '../src/common/keepclear.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { type GiveWayPorts, startGiveWay } from '../src/main/give-way/loop.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);
const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const SCREENS = ok({ screens: [{ display_id: 1, frame: r(0, 0, 1440, 900), visible: r(0, 25, 1440, 875), scale: 2, primary: true }] });
const FIELD = { pid: 702, role: 'AXTextField', native_role: 'AXTextField', subrole: null, frame: r(100, 100, 300, 24), caret: null, editable: true };

function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res)); };

function setup(o: { helper?: Record<string, Answer> } = {}) {
  const timers = new Map<number, () => void>();
  const requests: [string, Record<string, unknown>][] = [];
  const keepClear: KeepClearRect[][] = [];
  const hides: [boolean, string][] = [];
  const logs: string[] = [];
  const state = { hidden: false, behavior: 'hide', reflex: null as ReflexState | null, covered: false };
  const helper: Record<string, Answer> = {
    'screens.list': SCREENS, 'workspace.watch': (p) => ok({ watching: p.enabled }), 'ax.focused': ok({ focus: FIELD }),
    'ax.dialog_buttons': ok({ buttons: [] }), 'ax.overlays': ok({ banners: [], ime: [] }), ...o.helper,
  };
  const ports: GiveWayPorts = {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    ownPids: () => [4000, 4001],
    reflex: () => state.reflex,
    keepClear: (rects) => keepClear.push(rects),
    covered: () => state.covered,
    fullscreenBehavior: () => state.behavior,
    hideOnScreenCapture: () => true,
    avatarHidden: () => state.hidden,
    setHidden: (hidden, reason) => { hides.push([hidden, reason]); state.hidden = hidden; },
    every: (ms, fn) => { timers.set(ms, fn); return () => { timers.delete(ms); }; },
    log: (line) => logs.push(line),
  };
  const giveWay = startGiveWay(ports);
  const fire = async (ms: number) => { timers.get(ms)?.(); await settle(); };
  return {
    giveWay, ports, helper, requests, keepClear, hides, logs, state, timers,
    ops: () => requests.map(([op]) => op),
    feed: () => fire(500),
    async start() { giveWay.helper(true); await settle(); },
  };
}

test('nothing is read before the helper says hello; then the screens, the workspace watch and a 0.5 s feed', async () => {
  const t = setup();
  assert.equal(t.timers.size, 0);
  await t.start();
  assert.deepEqual(t.ops().slice(0, 2).sort(), ['screens.list', 'workspace.watch']);
  assert.deepEqual(t.requests.find(([op]) => op === 'workspace.watch')![1], { enabled: true });
  assert.equal(t.timers.has(500), true);
  assert.equal(t.ops().includes('windows.list'), false, 'the surface source checks for covering windows');
});

test('whether she is covered is the surface source\'s', () => {
  const t = setup();
  assert.equal(t.giveWay.covered, false);
  t.state.covered = true;
  assert.equal(t.giveWay.covered, true);
});

test('Windows: helper rects keep their y in C3 (physical pixels, y down)', async () => {
  const t = setup({ helper: { 'ax.dialog_buttons': ok({ buttons: [r(500, 400, 80, 24)] }) } });
  const w = startGiveWay({ ...t.ports, helperY: helperY });
  w.helper(true);
  await settle();
  await t.feed();
  assert.deepEqual(t.keepClear.at(-1)!.map((k) => k.frame), [{ x: 100, y: 100, w: 300, h: 24 }, { x: 500, y: 400, w: 80, h: 24 }]);
  w.stop();
});

test('each feed read asks the focus, its app\'s dialog buttons and the overlays, and hands the targets on in the placement space', async () => {
  const t = setup({ helper: {
    'ax.dialog_buttons': ok({ buttons: [r(500, 400, 80, 24)] }), 'ax.overlays': ok({ banners: [r(1000, 40, 360, 80)], ime: [] }),
  } });
  await t.start();
  t.state.reflex = { kind: 'game', rect: r(0, 0, 1440, 900) };
  await t.feed();
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.focused')![1], {});
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.dialog_buttons')![1], { pid: 702 });
  assert.deepEqual(t.keepClear, [[
    { kind: 'text_input', frame: { x: 100, y: 776, w: 300, h: 24 } }, { kind: 'dialog', frame: { x: 500, y: 476, w: 80, h: 24 } },
    { kind: 'banner', frame: { x: 1000, y: 780, w: 360, h: 80 } }, { kind: 'game', frame: { x: 0, y: 0, w: 1440, h: 900 } },
  ]]);
});

test('the targets go out only when they change', async () => {
  let frame = r(100, 100, 300, 24);
  const t = setup({ helper: { 'ax.focused': () => ok({ focus: { ...FIELD, frame } }) } });
  await t.start();
  await t.feed();
  await t.feed();
  assert.equal(t.keepClear.length, 1);
  frame = r(100, 200, 300, 24);
  await t.feed();
  assert.equal(t.keepClear.length, 2);
  assert.deepEqual(t.keepClear[1]![0]!.frame, { x: 100, y: 676, w: 300, h: 24 });
});

test('her own focus gives no target and no dialog read', async () => {
  const t = setup({ helper: { 'ax.focused': ok({ focus: { ...FIELD, pid: 4000 } }), 'ax.overlays': ok({ banners: [r(1000, 40, 360, 80)], ime: [] }) } });
  await t.start();
  await t.feed();
  assert.equal(t.ops().includes('ax.dialog_buttons'), false);
  assert.deepEqual(t.keepClear.map((x) => x.map((k) => k.kind)), [['banner']]);
});

test('no focused control: the dialog buttons are read from ax.focused\'s app_pid, never her own', async () => {
  const t = setup({ helper: { 'ax.focused': ok({ focus: null, app_pid: 702 }), 'ax.dialog_buttons': ok({ buttons: [r(500, 400, 80, 24)] }) } });
  await t.start();
  await t.feed();
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.dialog_buttons')?.[1], { pid: 702 });
  assert.deepEqual(t.keepClear, [[{ kind: 'dialog', frame: { x: 500, y: 476, w: 80, h: 24 } }]]);
  for (const appPid of [4001, null]) {
    const own = setup({ helper: { 'ax.focused': ok({ focus: null, app_pid: appPid }), 'ax.dialog_buttons': ok({ buttons: [r(500, 400, 80, 24)] }) } });
    await own.start();
    await own.feed();
    assert.equal(own.ops().includes('ax.dialog_buttons'), false, String(appPid));
  }
});

test('without app_pid (Windows) no focused control means no dialog read', async () => {
  const t = setup({ helper: { 'ax.focused': ok({ focus: null }), 'ax.dialog_buttons': ok({ buttons: [r(500, 400, 80, 24)] }) } });
  await t.start();
  await t.feed();
  assert.equal(t.ops().includes('ax.dialog_buttons'), false);
  assert.deepEqual(t.keepClear, []);
});

test('workspace.watch is asked for once; a restarted helper gets it from the supervisor, a failed one is asked again', async () => {
  const t = setup();
  await t.start();
  t.giveWay.helper(false);
  await t.start();
  assert.equal(t.ops().filter((op) => op === 'workspace.watch').length, 1);
  assert.equal(t.timers.has(500), true, 'the feed runs again');
  const failed = setup({ helper: { 'workspace.watch': err('helper_exited') } });
  await failed.start();
  failed.giveWay.helper(false);
  await failed.start();
  assert.equal(failed.ops().filter((op) => op === 'workspace.watch').length, 2);
});

test('a failed read counts as nothing there, and is logged once per error code', async () => {
  const t = setup({ helper: { 'ax.focused': err('ax_timeout'), 'ax.overlays': ok({ banners: [], ime: [r(300, 300, 200, 40)] }) } });
  await t.start();
  await t.feed();
  await t.feed();
  assert.deepEqual(t.keepClear.map((x) => x.map((k) => k.kind)), [['ime']]);
  assert.deepEqual(t.logs.filter((l) => l.includes('ax.focused')), ['GIVEWAY ax.focused failed code=ax_timeout']);
});

test('a read still in flight is not started again', async () => {
  const slow = later<HelperAnswer>();
  const t = setup({ helper: { 'ax.focused': () => slow.promise } });
  await t.start();
  await t.feed();
  await t.feed();
  assert.equal(t.ops().filter((op) => op === 'ax.focused').length, 1);
  slow.resolve(ok({ focus: null }));
  await settle();
  await t.feed();
  assert.equal(t.ops().filter((op) => op === 'ax.focused').length, 2);
});

test('the main display height comes from screens.list, read again when the displays change', async () => {
  let height = 900;
  const t = setup({ helper: { 'screens.list': () => ok({ screens: [{ display_id: 1, frame: r(0, 0, 1440, height), visible: r(0, 0, 1, 1), scale: 2, primary: true }] }) } });
  await t.start();
  await t.feed();
  height = 1000;
  t.giveWay.event('workspace.changed', { reason: 'screens', front_pid: 702 });
  await settle();
  await t.feed();
  assert.deepEqual(t.keepClear.map((x) => x[0]!.frame.y), [776, 876]);
});

test('the helper going away stops the reads and clears the targets', async () => {
  const t = setup();
  await t.start();
  await t.feed();
  t.giveWay.helper(false);
  assert.equal(t.timers.size, 0);
  assert.deepEqual(t.keepClear.at(-1), []);
});

// ---- Fullscreen

function sample(over: Partial<AttentionSample>): AttentionSample {
  return {
    ts: 0, front: { app: 'X', bundleId: 'x', pid: 702, windowId: 1, title: null, urlHost: null }, frontIncognito: false, mouse: null,
    idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false, cameraActive: false, micActive: false,
    userSpeaking: null, focusWindow: null, input: null, frontAudioOut: null, frontVideo: null, frontGpu: null,
    screenCaptured: false, edge: null, frontBounds: null, ...over,
  };
}

test('each attention sample may hide her for fullscreen and show her after it', async () => {
  const t = setup();
  t.giveWay.sampled(sample({ fullscreen: true }));
  assert.deepEqual(t.hides, [[true, 'fullscreen']]);
  assert.equal(t.giveWay.fullscreenHidden, true);
  t.giveWay.sampled(sample({ fullscreen: true }));
  t.giveWay.sampled(sample({ fullscreen: false }));
  assert.deepEqual(t.hides, [[true, 'fullscreen'], [false, 'fullscreen_exit']]);
  assert.deepEqual(t.logs, ['FULLSCREEN hide behavior=hide captured=false', 'FULLSCREEN show behavior=hide']);
});

test('a fullscreen game she watches is not hidden; a hide by the user is kept after fullscreen', async () => {
  const t = setup();
  t.state.reflex = { kind: 'game', rect: r(0, 0, 1440, 900) };
  t.giveWay.sampled(sample({ fullscreen: true }));
  assert.deepEqual(t.hides, []);
  const u = setup();
  u.giveWay.sampled(sample({ fullscreen: true }));
  u.giveWay.userSetHidden();
  u.giveWay.sampled(sample({ fullscreen: false }));
  assert.deepEqual(u.hides, [[true, 'fullscreen']]);
});
