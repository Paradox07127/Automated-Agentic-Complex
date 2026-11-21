// The activity loop (src/main/activity/): its attach, notification handling, batches and
// failure paths, on a fake platform helper, a fake agentd and a fake clock. Nothing here watches the real system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityPolicy } from '../src/common/activity.ts';
import { type AttentionSample, type BlacklistRules, parseBlacklist } from '../src/common/attention.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { type ActivityPorts, startActivity } from '../src/main/activity/recorder.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);

const TEXTEDIT = { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit' };
const VSCODE = { pid: 900, name: 'Code', app_id: 'com.microsoft.VSCode' };
const NOTIFICATIONS = ['focus', 'window', 'title', 'value', 'selection'];
/** The params ActivityRecorder.attach watches with (CONTRACT §7.4 `ax.watch`). */
const watchOf = (pid: number, typed = false, manual = false) => ({ pid, notifications: NOTIFICATIONS, read_selected_text: typed,
  read_value: typed, ...(manual && { manual_accessibility: true }), watch_id: 'activity' });
const UNWATCH = { pid: null, notifications: [], watch_id: 'activity' };
const NOTES = { pid: 800, name: 'Notes', app_id: 'com.apple.Notes' };
const frontOf = (front: Record<string, unknown> | null) => ok({ ts: 0, locked: false, front: front && { ...front, window: null } });

/** CONTRACT §7.12 `ax_element` of TextEdit's text area. */
const element = (over: Record<string, unknown> = {}) => ({
  role: 'AXTextArea', native_role: 'AXTextArea', subrole: null, label: 'Body', value_length: 10, window_title: 'notes.txt',
  doc: '/Users/u/notes.txt', ...over,
});

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null },
    frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false,
    fullscreen: false, cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null, micApps: null,
    frontAudioOut: null, frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null, ...over,
  };
}

function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function setup(o: { helper?: Record<string, Answer>; post?: () => Promise<number>; policy?: ActivityPolicy; blacklist?: BlacklistRules } = {}) {
  let clock = 1_763_539_200_000;
  let fire: (() => void) | null = null;
  let interval = 0;
  let policy = o.policy ?? { allowTypedText: false, senseCounts: true, redact: true };
  const requests: [string, Record<string, unknown>][] = [];
  const posts: Record<string, unknown>[][] = [];
  const logs: string[] = [];
  const helper: Record<string, Answer> = {
    'attention.sample': frontOf(TEXTEDIT), 'workspace.watch': (p) => ok({ watching: p.enabled }),
    'ax.watch': (p) => ok({ watching: p.pid !== null, pid: p.pid }),
    ...o.helper,
  };
  const ports: ActivityPorts = {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    post: async (body) => { posts.push(body.events as Record<string, unknown>[]); return o.post ? o.post() : 200; },
    blacklist: () => o.blacklist ?? NO_RULES,
    policy: () => policy,
    ownPids: () => [4000],
    now: () => clock,
    every: (ms, fn) => { interval = ms; fire = fn; return () => { fire = null; }; },
    log: (line) => logs.push(line),
  };
  const recorder = startActivity(ports);
  return {
    recorder, helper, requests, posts, logs,
    get interval() { return interval; },
    get running() { return fire !== null; },
    set policy(p: ActivityPolicy) { policy = p; },
    async start() { recorder.update(sample()); recorder.start(); await settle(); },
    /** Half-second ticks for `seconds`. */
    async run(seconds: number) { for (let i = 0; i < seconds * 2; i += 1) { clock += 500; fire?.(); await settle(); } },
    notify(notification: string, el: unknown = element(), pid = 702, more: Record<string, unknown> = {}) {
      recorder.event('ax.notification', { pid, notification, element: el, ...more });
    },
    watches: () => requests.filter(([op]) => op === 'ax.watch').map(([, p]) => p),
    kinds: () => posts.flat().map((e) => e.kind),
  };
}

test('start watches the workspace and the front app with the six notifications; ticks each 0.5 s', async () => {
  const t = setup();
  await t.start();
  assert.equal(t.interval, 500);
  assert.deepEqual(t.requests.slice(0, 3), [['workspace.watch', { enabled: true }], ['attention.sample', {}],
    ['ax.watch', watchOf(702)]]);
});

test('the queue is posted 5 s after the last post, as one {events} body', async () => {
  const t = setup();
  await t.start();
  await t.run(4.5);
  assert.equal(t.posts.length, 0);
  await t.run(0.5);
  assert.deepEqual(t.posts.map((b) => b.map((e) => [e.kind, e.app, e.bundle_id, e.pid])), [[['app', 'TextEdit', 'com.apple.TextEdit', 702]]]);
  await t.run(10);
  assert.equal(t.posts.length, 1);
});

test('notifications become focus, window and merged value events', async () => {
  const t = setup();
  await t.start();
  t.notify('focus');
  t.notify('title', element({ window_title: 'notes.txt — Edited' }));
  t.notify('value', element({ value_length: 11 }));
  t.notify('value', element({ value_length: 9 }));
  await t.run(5);
  const events = t.posts.flat();
  assert.deepEqual(events.map((e) => [e.kind, e.window]), [['app', null], ['focus', 'notes.txt'], ['window', 'notes.txt — Edited'], ['value', 'notes.txt — Edited']]);
  assert.deepEqual([events[3]!.value_len, events[3]!.shrink, events[3]!.edits, events[3]!.value], [9, 2, 2, null]);
});

test('a value or selection change counts only for the element last focused', async () => {
  const t = setup({ policy: { allowTypedText: true, senseCounts: true, redact: false } });
  await t.start();
  t.notify('value');
  t.notify('focus');
  t.notify('value', element({ label: 'Search' }));
  t.notify('selection', element({ label: 'Search', selected_text: 'x' }));
  t.notify('focus', null);
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus']);
});

test('the selected text is read only with share_typed_text on; a change of the switch watches again', async () => {
  const t = setup();
  await t.start();
  t.notify('focus');
  t.notify('selection', element({ selected_text: 'secret' }));
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus']);
  t.policy = { allowTypedText: true, senseCounts: true, redact: false };
  await t.run(0.5);
  assert.deepEqual(t.watches().at(-1), watchOf(702, true));
  t.notify('selection', element({ selected_text: 'hello' }));
  await t.run(5);
  const sel = t.posts.flat().find((e) => e.kind === 'selection')!;
  assert.deepEqual([sel.value, sel.value_len], ['hello', 5]);
});

test('each event passes the filter against the latest sample', async () => {
  const t = setup({ blacklist: parseBlacklist({ mode: 'deny', title_patterns: ['Payroll'] }) });
  await t.start();
  const secure = { role: 'AXTextField', native_role: 'AXTextField', subrole: 'AXSecureTextField', label: null };
  t.notify('focus', element({ ...secure, value_length: null }));
  t.notify('value', element({ ...secure, value_length: 4 }));
  t.notify('title', element({ ...secure, window_title: 'Payroll 2026' }));
  await t.run(5);
  const events = t.posts.flat();
  assert.deepEqual(events.map((e) => [e.kind, e.window, e.value_len, e.edits]), [['app', null, null, null], ['focus', 'notes.txt', null, null],
    ['value', 'notes.txt', null, null]]);
});

test('nothing is recorded while the sample is locked or asleep, nothing posted before a sample', async () => {
  const t = setup();
  t.recorder.start();
  await settle();
  t.notify('focus');
  await t.run(6);
  assert.equal(t.posts.length, 0);
  t.recorder.update(sample({ locked: true }));
  t.notify('focus', element({ label: 'Locked' }));
  await t.run(6);
  assert.equal(t.posts.length, 0);
  t.recorder.update(sample({ asleep: true }));
  await t.run(6);
  assert.equal(t.posts.length, 0);
  t.recorder.update(sample());
  await t.run(0.5);
  assert.deepEqual(t.posts.flat().map((e) => [e.kind, e.label]), [['app', null], ['focus', 'Body']]);
});

test('a paused attach records no app event', async () => {
  const t = setup();
  t.recorder.update(sample({ locked: true }));
  t.recorder.start();
  await settle();
  t.recorder.update(sample());
  await t.run(5);
  assert.equal(t.posts.length, 0);
});

test('a front app change watches the new app; other apps notifications are ignored', async () => {
  const t = setup();
  await t.start();
  t.helper['attention.sample'] = frontOf(NOTES);
  t.recorder.event('workspace.changed', { reason: 'space', front_pid: 800 });
  await settle();
  assert.equal(t.watches().length, 1);
  t.recorder.event('workspace.changed', { reason: 'front_app', front_pid: 800 });
  await settle();
  assert.equal(t.watches().at(-1)!.pid, 800);
  t.notify('focus', element(), 702);
  t.notify('focus', element({ label: 'Note' }), 800);
  await t.run(5);
  assert.deepEqual(t.posts.flat().map((e) => [e.kind, e.app, e.label]), [['app', 'TextEdit', null], ['app', 'Notes', null], ['focus', 'Notes', 'Note']]);
});

test('our own process, a blacklisted app or no front app is not watched', async () => {
  for (const [front, rules] of [[{ ...TEXTEDIT, pid: 4000 }, NO_RULES], [TEXTEDIT, parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] })],
    [null, NO_RULES]] as const) {
    const t = setup({ helper: { 'attention.sample': frontOf(front) }, blacklist: rules });
    await t.start();
    await t.run(5);
    assert.deepEqual(t.watches(), []);
    assert.equal(t.posts.length, 0);
  }
  const t = setup();
  await t.start();
  t.recorder.event('workspace.changed', { reason: 'front_app', front_pid: null });
  await settle();
  assert.deepEqual(t.watches().at(-1), UNWATCH);
  t.notify('focus');
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app']);
});

test('a refused ax.watch is logged and records nothing', async () => {
  const t = setup({ helper: { 'ax.watch': err('permission_denied') } });
  await t.start();
  t.notify('focus');
  await t.run(5);
  assert.equal(t.posts.length, 0);
  assert.deepEqual(t.logs, ['ACTIVITY ax.watch failed pid=702 code=permission_denied']);
});

test('50 queued events are posted at the next tick, 50 at a time', async () => {
  const t = setup();
  await t.start();
  for (let i = 0; i < 60; i += 1) t.notify('focus', element({ label: `f${i}` }));
  await t.run(0.5);
  assert.deepEqual(t.posts.map((b) => b.length), [50]);
  await t.run(0.5);
  assert.equal(t.posts.length, 1);
  await t.run(4.5);
  assert.deepEqual(t.posts.map((b) => b.length), [50, 11]);
});

test('one post at a time; a failed batch goes back to the front and is sent again', async () => {
  const replies = [later<number>(), later<number>(), later<number>()];
  let n = 0;
  const t = setup({ post: () => replies[n++]!.promise });
  await t.start();
  await t.run(5);
  assert.equal(t.posts.length, 1);
  t.notify('focus');
  await t.run(10);
  assert.equal(t.posts.length, 1);
  replies[0]!.resolve(503);
  await settle();
  await t.run(5);
  assert.deepEqual(t.posts[1]!.map((e) => e.kind), ['app', 'focus']);
  replies[1]!.resolve(0);
  await settle();
  await t.run(5);
  assert.deepEqual(t.posts[2]!.map((e) => e.kind), ['app', 'focus']);
  replies[2]!.resolve(200);
  await settle();
  await t.run(10);
  assert.equal(t.posts.length, 3);
});

test('stop ends the watch and the ticks; the queue waits for the next start', async () => {
  const t = setup();
  await t.start();
  t.notify('focus');
  t.recorder.stop();
  await settle();
  assert.equal(t.running, false);
  assert.deepEqual(t.watches().at(-1), UNWATCH);
  t.notify('value');
  t.recorder.event('workspace.changed', { reason: 'front_app', front_pid: 800 });
  await settle();
  assert.equal(t.watches().length, 2);
  t.recorder.start();
  await settle();
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus']);
});

test('a restarted helper gets the watches from the supervisor; the recorder asks again only for what never answered (CONTRACT §6.4)', async () => {
  const t = setup();
  await t.start();
  t.recorder.helper(false);
  t.recorder.helper(true);
  await settle();
  assert.deepEqual(t.requests.map(([op]) => op), ['workspace.watch', 'attention.sample', 'ax.watch']);
  t.notify('focus', element({ label: 'After' }));
  await t.run(5);
  assert.deepEqual(t.posts.flat().map((e) => [e.kind, e.label]), [['app', null], ['focus', 'After']]);
  let exited = true;
  const failed = setup({ helper: { 'ax.watch': (p) => (exited ? err('helper_exited') : ok({ watching: true, pid: p.pid })) } });
  await failed.start();
  exited = false;
  failed.recorder.helper(false);
  failed.recorder.helper(true);
  await settle();
  assert.deepEqual(failed.requests.map(([op]) => op), ['workspace.watch', 'attention.sample', 'ax.watch', 'attention.sample', 'ax.watch']);
});

// ---- The fields CONTRACT §7.4 added for the recorder; Windows gives none of them (the tests above)

/** ok-ax.ndjson's TextEdit element, with its `element_key`. */
const keyed = (key: string, over: Record<string, unknown> = {}) => element({ element_key: key, ...over });

test('element_key tells two elements apart that read the same', async () => {
  const t = setup();
  await t.start();
  t.notify('focus', keyed('a81f3c'));
  t.notify('focus', keyed('5d02e1'));
  t.notify('focus', keyed('5d02e1'));
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus', 'focus']);
  const windows = setup();
  await windows.start();
  windows.notify('focus');
  windows.notify('focus');
  await windows.run(5);
  assert.deepEqual(windows.kinds(), ['app', 'focus'], 'without element_key the same reading is the same element');
});

test('a value or selection change whose source_key is not the element last focused is dropped', async () => {
  const t = setup({ policy: { allowTypedText: true, senseCounts: true, redact: false } });
  await t.start();
  t.notify('focus', keyed('a81f3c'));
  t.notify('value', keyed('a81f3c', { value_length: 29 }), 702, { source_key: '5d02e1' });
  t.notify('selection', keyed('a81f3c', { selected_text: 'milk' }), 702, { source_key: '5d02e1' });
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus']);
  t.notify('value', keyed('a81f3c', { value_length: 29 }), 702, { source_key: 'a81f3c' });
  t.notify('selection', keyed('a81f3c', { selected_text: 'milk' }), 702, { source_key: 'a81f3c' });
  await t.run(5);
  assert.deepEqual(t.kinds(), ['app', 'focus', 'selection', 'value'], 'a selection settles in 0.8 s, a value in 1.5 s');
});

test('share_typed_text on: the watch reads the value, and a value event carries the last change\'s text', async () => {
  const t = setup({ policy: { allowTypedText: true, senseCounts: true, redact: false } });
  await t.start();
  assert.deepEqual(t.watches(), [watchOf(702, true)]);
  t.notify('focus', keyed('a81f3c'));
  t.notify('value', keyed('a81f3c', { value_length: 28, value: 'Shopping list\nmilk\neggs\nbrea' }), 702, { source_key: 'a81f3c' });
  t.notify('value', keyed('a81f3c', { value_length: 29, value: 'Shopping list\nmilk\neggs\nbread' }), 702, { source_key: 'a81f3c' });
  await t.run(5);
  const value = t.posts.flat().find((e) => e.kind === 'value')!;
  assert.deepEqual([value.value, value.value_len, value.edits], ['Shopping list\nmilk\neggs\nbread', 29, 2]);
  const off = setup();
  await off.start();
  off.notify('focus', keyed('a81f3c'));
  off.notify('value', keyed('a81f3c', { value: 'leaked' }), 702, { source_key: 'a81f3c' });
  await off.run(5);
  assert.equal(off.posts.flat().find((e) => e.kind === 'value')!.value, null, 'the switch is off');
  const windows = setup({ policy: { allowTypedText: true, senseCounts: true, redact: false } });
  await windows.start();
  windows.notify('focus');
  windows.notify('value', element({ value_length: 11 }));
  await windows.run(5);
  assert.equal(windows.posts.flat().find((e) => e.kind === 'value')!.value, null, 'no value from the helper (Windows)');
});

test('the watch\'s element and window are the first read: a window and a focus event after the app', async () => {
  const t = setup({ helper: { 'ax.watch': (p) => ok({ watching: true, pid: p.pid, watch_id: 'activity', element: keyed('a81f3c'),
    window: { title: 'notes.txt', doc: '/Users/me/notes.txt' } }) } });
  await t.start();
  await t.run(5);
  assert.deepEqual(t.posts.flat().map((e) => [e.kind, e.window, e.doc, e.label]), [['app', null, null, null],
    ['window', 'notes.txt', '/Users/me/notes.txt', null], ['focus', 'notes.txt', '/Users/u/notes.txt', 'Body']]);
  t.notify('value', keyed('a81f3c', { value_length: 12 }), 702, { source_key: 'a81f3c' });
  await t.run(5);
  assert.deepEqual(t.kinds().slice(3), ['value'], 'the first read is the element last focused');
  const none = setup({ helper: { 'ax.watch': (p) => ok({ watching: true, pid: p.pid, element: null, window: null }) } });
  await none.start();
  await none.run(5);
  assert.deepEqual(none.posts.flat().map((e) => [e.kind, e.window]), [['app', null], ['window', null]]);
});

test('window and title notifications take the window the helper read, even without a focused element', async () => {
  const t = setup();
  await t.start();
  t.notify('focus', keyed('a81f3c'));
  t.notify('title', null, 702, { window: { title: 'notes.txt — Edited', doc: '/Users/me/notes.txt' } });
  t.notify('value', keyed('a81f3c', { value_length: 30 }), 702, { source_key: 'a81f3c' });
  await t.run(5);
  assert.deepEqual(t.posts.flat().map((e) => [e.kind, e.window, e.doc]), [['app', null, null], ['focus', 'notes.txt', '/Users/u/notes.txt'],
    ['window', 'notes.txt — Edited', '/Users/me/notes.txt'], ['value', 'notes.txt — Edited', '/Users/me/notes.txt']]);
});

test('apps that build their AX tree only when asked are watched with manual_accessibility', async () => {
  const t = setup({ helper: { 'attention.sample': frontOf(VSCODE) } });
  await t.start();
  assert.deepEqual(t.watches(), [watchOf(900, false, true)]);
});

test('notifications of another watch_id are not the recorder\'s; without one they are (CONTRACT §7.4 watch_id)', async () => {
  const t = setup();
  await t.start();
  t.notify('focus', element({ label: 'Theirs' }), 702, { watch_id: 'context' });
  t.notify('focus', element({ label: 'Ours' }), 702, { watch_id: 'activity' });
  t.notify('focus', element({ label: 'Default' }));
  await t.run(5);
  assert.deepEqual(t.posts.flat().map((e) => e.label), [null, 'Ours', 'Default']);
});
