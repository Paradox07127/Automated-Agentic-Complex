// The timeline recorder (src/main/timeline/recorder.ts): its switch, the window and action records, the tree reads and the
// batches, on a fake platform helper, a fake agentd and a fake clock. Nothing here watches the real system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent } from '../src/common/activity.ts';
import { type AttentionSample, type BlacklistRules, parseBlacklist } from '../src/common/attention.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import type { TimelinePolicy, TimelineRecord } from '../src/common/timeline.ts';
import { startActivity } from '../src/main/activity/recorder.ts';
import { TimelineRecorder, type TimelinePorts } from '../src/main/timeline/recorder.ts';

const NO_RULES = parseBlacklist({ mode: 'deny' });
const ON: TimelinePolicy = { allowActions: true, allowWindowText: true, allowTypedText: true, redact: false };

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);

const FULL = 'window "notes.txt"\n  button "Save"';
const tree = (mode: string, id: string, text = mode === 'no_change' ? '' : `${mode} ${id}`) =>
  ok({ matched: true, tree_id: id, mode, text, lines: 1, truncated: false, secure: false });
/** The helper's answers: a full tree without `previous`, else a diff whose id counts up. */
function trees() {
  let n = 0;
  return (p: Record<string, unknown>) => (p.previous === undefined ? tree('full', `t${++n}`, FULL) : tree('diff', `t${++n}`));
}

/** CONTRACT §7.12 `ax_element` of TextEdit's Save button. */
const button = { role: 'AXButton', native_role: 'AXButton', subrole: null, label: 'Save', value_length: null, window_title: 'notes.txt' };
const SAVE = { role: 'AXButton', subrole: null, title: 'Save', description: null, identifier: null, value: null };

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null },
    frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false,
    fullscreen: false, cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null,
    frontAudioOut: null, frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null, ...over,
  };
}
const NOTES = { app: 'Notes', bundleId: 'com.apple.Notes', pid: 800, windowId: 900, title: 'Groceries', urlHost: null };

function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function setup(o: { helper?: Record<string, Answer>; post?: () => Promise<number>; policy?: TimelinePolicy; blacklist?: BlacklistRules } = {}) {
  let clock = 1_763_539_200_000;
  const timers: { ms: number; fn: () => void; due: number; live: boolean }[] = [];
  let policy = o.policy ?? ON;
  const requests: [string, Record<string, unknown>][] = [];
  const posts: TimelineRecord[][] = [];
  const logs: string[] = [];
  const helper: Record<string, Answer> = { 'input.actions': (p) => ok({ watching: p.enabled }), 'ax.window_tree': trees(), ...o.helper };
  const ports: TimelinePorts = {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    post: async (body) => { posts.push(body.records); return o.post ? o.post() : 200; },
    blacklist: () => o.blacklist ?? NO_RULES,
    policy: () => policy,
    ownPids: () => [4000],
    now: () => clock,
    every: (ms, fn) => {
      const t = { ms, fn, due: clock + ms, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    log: (line) => logs.push(line),
  };
  const recorder = new TimelineRecorder(ports);
  /** What the sampler sees, sent each second from start as a sample taken then. */
  let current: AttentionSample | null = null;
  const started = clock;
  const show = (s: AttentionSample) => {
    current = s;
    recorder.update({ ...s, ts: clock / 1000 });
  };
  return {
    recorder, helper, requests, posts, logs,
    get intervals() { return timers.filter((t) => t.live).map((t) => t.ms); },
    set policy(p: TimelinePolicy) { policy = p; },
    async start(s: AttentionSample | null = sample()) { recorder.start(); await settle(); if (s) show(s); await settle(); },
    /** A sample of `s` now, and each second after. */
    show,
    /** 100 ms steps for `ms`. */
    async run(ms: number) {
      for (let i = 0; i < ms / 100; i += 1) {
        clock += 100;
        for (const t of [...timers]) {
          if (!t.live || t.due > clock) continue;
          t.due += t.ms;
          t.fn();
        }
        if (current && (clock - started) % 1000 === 0) recorder.update({ ...current, ts: clock / 1000 });
        await settle();
      }
    },
    act(kind: string, more: Record<string, unknown> = {}) {
      recorder.event('input.action', { kind, pid: 702, target: button, ...more });
    },
    ops: (op: string) => requests.filter(([name]) => name === op).map(([, p]) => p),
    records: () => posts.flat(),
  };
}

test('allowActions off: no input.actions, no tree read, nothing posted', async () => {
  const t = setup({ policy: { ...ON, allowActions: false } });
  await t.start();
  t.act('click');
  t.recorder.mirror({ ts: 1, kind: 'value', app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, window: 'notes.txt', urlHost: null,
    doc: null, role: 'AXTextArea', subrole: null, label: 'Body', value: 'milk', valueLen: 4, shrink: 0, edits: 1 });
  await t.run(6000);
  assert.deepEqual(t.requests, []);
  assert.deepEqual(t.posts, []);
});

test('start asks for the actions and ticks each 0.5 s; stop and a policy change turn them off and on', async () => {
  const t = setup();
  await t.start(null);
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }]);
  assert.deepEqual(t.intervals, [500]);
  t.policy = { ...ON, allowActions: false };
  await t.run(500);
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }, { enabled: false }]);
  t.policy = ON;
  await t.run(500);
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }, { enabled: false }, { enabled: true }]);
  t.recorder.stop();
  await settle();
  assert.deepEqual(t.ops('input.actions').at(-1), { enabled: false });
  assert.deepEqual(t.intervals, []);
});

test('a new front window is one window record with the full tree, every key sent', async () => {
  const t = setup();
  await t.start();
  assert.deepEqual(t.ops('ax.window_tree'), [{ pid: 702 }]);
  t.show(sample());
  await t.run(5000);
  assert.deepEqual(t.records(), [{ ts: 1_763_539_200, kind: 'window', app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702,
    window_id: 640, window_title: 'notes.txt', url_host: null, target: null, keys: null, text: null, tree: { mode: 'full', text: FULL } }]);
  assert.deepEqual(t.ops('ax.window_tree'), [{ pid: 702 }], 'the same window is not read again');
  t.show(sample({ front: NOTES }));
  await settle();
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 800 });
});

test('a click reads the diff 300 ms later and carries it', async () => {
  const t = setup();
  await t.start();
  await t.run(5000);
  t.act('click');
  await t.run(200);
  assert.equal(t.ops('ax.window_tree').length, 1);
  await t.run(100);
  assert.deepEqual(t.ops('ax.window_tree'), [{ pid: 702 }, { pid: 702, previous: 't1' }]);
  await t.run(5000);
  const click = t.records()[1]!;
  assert.deepEqual([click.kind, click.target, click.keys, click.tree], ['click', SAVE, null, { mode: 'diff', text: 'diff t2' }]);
  t.act('submit');
  await t.run(300);
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 702, previous: 't2' });
});

test('two clicks within 300 ms are one read, carried by the later click', async () => {
  const t = setup();
  await t.start();
  await t.run(5000);
  t.act('click');
  await t.run(100);
  t.act('context_menu');
  await t.run(5000);
  assert.equal(t.ops('ax.window_tree').length, 2);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree]), [['window', { mode: 'full', text: FULL }], ['click', null],
    ['context_menu', { mode: 'diff', text: 'diff t2' }]]);
});

test('a click whose read finds no change is read once more 700 ms later and carries what changed by then', async () => {
  const answers = [tree('full', 't1', FULL), tree('no_change', 't2'), tree('diff', 't3')];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(5000);
  t.act('click');
  await t.run(900);
  assert.equal(t.ops('ax.window_tree').length, 2);
  await t.run(100);
  assert.deepEqual(t.ops('ax.window_tree').map((p) => p.previous), [undefined, 't1', 't1']);
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree]), [['window', { mode: 'full', text: FULL }], ['click', { mode: 'diff', text: 'diff t3' }]]);
});

test('no_change twice leaves the click without a tree; a full answer is carried as full', async () => {
  const answers = [tree('full', 't1', FULL), tree('no_change', 't1'), tree('no_change', 't1'), tree('full', 't9', 'window again')];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(5000);
  t.act('click');
  await t.run(1100);
  t.act('click');
  await t.run(5000);
  assert.deepEqual(t.ops('ax.window_tree').map((p) => p.previous), [undefined, 't1', 't1', 't1']);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree]), [['window', { mode: 'full', text: FULL }], ['click', null],
    ['click', { mode: 'full', text: 'window again' }]]);
});

test('a click in an app the sampler has not seen in front yet is recorded with the next sample that shows it', async () => {
  const t = setup();
  await t.start();
  t.recorder.event('input.action', { kind: 'click', pid: 800, target: { ...button, window_title: 'Groceries' } });
  await t.run(600);
  t.show(sample({ front: NOTES }));
  await t.run(5000);
  const [, window, click] = t.records();
  assert.deepEqual(t.records().map((r) => [r.kind, r.app, r.window_id]), [['window', 'TextEdit', 640], ['window', 'Notes', 900],
    ['click', 'Notes', 900]]);
  assert.equal(Math.round((window!.ts - click!.ts) * 1000), 600, 'the click keeps its own time');
  t.recorder.event('input.action', { kind: 'click', pid: 702, target: button });
  await t.run(1600);
  t.show(sample());
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => r.kind), ['window', 'window', 'click', 'window'], 'past 1.5 s the click is dropped');
});

test('a shortcut reads no tree and carries its keys', async () => {
  const t = setup();
  await t.start();
  await t.run(1000);
  t.act('shortcut', { keys: 'command+s', target: null });
  await t.run(5000);
  assert.equal(t.ops('ax.window_tree').length, 1);
  assert.deepEqual(t.records().map((r) => [r.kind, r.keys, r.target, r.tree]), [['window', null, null, { mode: 'full', text: FULL }],
    ['shortcut', 'command+s', null, null]]);
});

test('one read at a time: an action during a read is read after it', async () => {
  const pending = later<HelperAnswer>();
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), pending.promise, tree('full', 't3')];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(5000);
  t.act('click');
  await t.run(300);
  t.act('submit');
  await t.run(1000);
  assert.equal(t.ops('ax.window_tree').length, 2);
  pending.resolve(tree('diff', 't2'));
  await settle();
  await t.run(1000);
  assert.deepEqual(t.ops('ax.window_tree').map((p) => p.previous), [undefined, 't1', undefined], 't2 is not posted yet');
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree?.text]), [['window', FULL], ['click', 'diff t2'], ['submit', 'full t3']]);
});

test('a tree answer that comes after the window changed is dropped; its click goes without one', async () => {
  const pending = later<HelperAnswer>();
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), pending.promise, tree('full', 'n1', 'notes tree')];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(1000);
  t.act('click');
  await t.run(300);
  t.show(sample({ front: NOTES }));
  await settle();
  assert.equal(t.ops('ax.window_tree').length, 2, 'the new window waits for the read in flight');
  pending.resolve(tree('diff', 't2'));
  await settle();
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 800 });
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.app, r.tree?.text ?? null]), [['window', 'TextEdit', FULL], ['click', 'TextEdit', null],
    ['window', 'Notes', 'notes tree']]);
});

test('allowWindowText off: the window and the click are recorded and no tree is read', async () => {
  const t = setup({ policy: { ...ON, allowWindowText: false } });
  await t.start();
  t.act('click');
  t.show(sample({ front: NOTES }));
  await t.run(5000);
  assert.deepEqual(t.ops('ax.window_tree'), []);
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }]);
  assert.deepEqual(t.records().map((r) => [r.kind, r.app, r.tree]), [['window', 'TextEdit', null], ['click', 'TextEdit', null],
    ['window', 'Notes', null]]);
});

test('a tree read that returns after a switch to a blocked tab in the same window is not posted under the allowed tab', async () => {
  const SAFARI = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 702, windowId: 640, title: 'Docs', urlHost: 'docs.example' };
  const pending = later<HelperAnswer>();
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), pending.promise];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! },
    blacklist: parseBlacklist({ mode: 'deny', domains: ['bank.example'] }) });
  await t.start(sample({ front: SAFARI }));
  await t.run(1000);
  t.act('click', { target: { ...button, window_title: 'Docs' } });
  await t.run(300);
  assert.equal(t.ops('ax.window_tree').length, 2);
  t.show(sample({ front: { ...SAFARI, title: 'Account', urlHost: 'bank.example' } }));
  pending.resolve(tree('diff', 't2', 'MARKER balance'));
  await t.run(5000);
  assert.deepEqual(t.records().filter((r) => r.tree?.text.includes('MARKER')).map((r) => r.url_host), []);
  assert.deepEqual(t.records().map((r) => [r.kind, r.url_host, r.tree?.mode ?? null]), [['window', 'docs.example', 'full'],
    ['click', 'docs.example', null]]);
});

test('an action whose own window is not the sampled one is not recorded and reads no tree', async () => {
  const SAFARI = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 702, windowId: 640, title: 'Docs', urlHost: 'docs.example' };
  const t = setup({ blacklist: parseBlacklist({ mode: 'deny', domains: ['bank.example'] }) });
  await t.start(sample({ front: SAFARI }));
  await t.run(5000);
  t.act('click', { target: { ...button, label: 'Transfer', window_title: 'Account' } });
  await t.run(5000);
  assert.equal(t.ops('ax.window_tree').length, 1);
  assert.deepEqual(t.records().filter((r) => r.tree !== null).map((r) => r.kind), ['window']);
  assert.deepEqual(t.records().filter((r) => r.target?.title === 'Transfer'), []);
});

test('a tree is kept only when a sample after the read still shows its window without secure input', async () => {
  const pending = [later<HelperAnswer>(), later<HelperAnswer>()];
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), pending[0]!.promise, pending[1]!.promise];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(1000);
  t.act('click');
  await t.run(300);
  assert.equal(t.ops('ax.window_tree').length, 2);
  t.show(sample({ secureInput: true }));
  pending[0]!.resolve(tree('diff', 't2', 'MARKER typed'));
  await t.run(5000);
  t.show(sample());
  t.act('click');
  await t.run(300);
  assert.equal(t.ops('ax.window_tree').length, 3);
  t.show(sample({ secureInput: true }));
  t.show(sample());
  pending[1]!.resolve(tree('diff', 't3', 'MARKER again'));
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree?.text ?? null]), [['window', FULL], ['click', null], ['click', null]],
    'secure input after the click, during the read or after it keeps the tree out');
});

test('a tree is kept only once a sample taken after the read came', async () => {
  const pending = later<HelperAnswer>();
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), pending.promise, tree('full', 'n1')];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(1000);
  t.act('click');
  await t.run(300);
  pending.resolve(tree('diff', 't2', 'MARKER'));
  await settle();
  t.recorder.update(sample({ ts: 0 }));
  await t.run(100);
  t.show(sample({ front: NOTES }));
  await t.run(5000);
  assert.deepEqual(t.records().filter((r) => r.app === 'TextEdit').map((r) => [r.kind, r.tree?.text ?? null]),
    [['window', FULL], ['click', null]]);
});

test('the tree is read from the sampled window by its bounds, not whichever window of the app has focus', async () => {
  const bounds = { x: 0, y: 25, width: 800, height: 600 };
  const t = setup();
  await t.start(sample({ frontBounds: bounds }));
  assert.deepEqual(t.ops('ax.window_tree'), [{ pid: 702, window_bounds: bounds }]);
});

test('a tab switch in one window is a new window: the first allowed tab after a blocked one is recorded', async () => {
  const SAFARI = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 702, windowId: 640, title: 'Account', urlHost: 'bank.example' };
  const t = setup({ blacklist: parseBlacklist({ mode: 'deny', domains: ['bank.example'] }) });
  await t.start(sample({ front: SAFARI }));
  t.show(sample({ front: { ...SAFARI, title: 'Docs', urlHost: 'docs.example' } }));
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.url_host, r.tree?.mode ?? null]), [['window', 'docs.example', 'full']]);
  assert.deepEqual(t.ops('ax.window_tree'), [{ pid: 702 }]);
});

test('our own process, another app\'s pid and a blacklisted window are not recorded or read', async () => {
  const own = setup();
  await own.start(sample({ front: { ...NOTES, pid: 4000 } }));
  own.recorder.event('input.action', { kind: 'click', pid: 4000, target: button });
  await own.run(5000);
  assert.deepEqual([own.ops('ax.window_tree'), own.posts], [[], []]);
  const other = setup();
  await other.start();
  other.recorder.event('input.action', { kind: 'click', pid: 800, target: button });
  await other.run(5000);
  assert.deepEqual(other.records().map((r) => r.kind), ['window']);
  const listed = setup({ blacklist: parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }) });
  await listed.start();
  listed.act('click');
  await listed.run(5000);
  assert.deepEqual([listed.ops('ax.window_tree'), listed.posts], [[], []]);
});

test('secure input: the window and the click are recorded without a tree, and no tree is read', async () => {
  const t = setup();
  await t.start(sample({ secureInput: true }));
  t.act('click', { target: { ...button, value: 'x' } });
  await t.run(5000);
  assert.deepEqual(t.ops('ax.window_tree'), []);
  assert.deepEqual(t.records().map((r) => [r.kind, r.tree, r.target?.value ?? null]), [['window', null, null],
    ['click', null, null]]);
});

test('a failed post goes back to the front and is sent again; a refused one is dropped and logged once', async () => {
  const replies = [later<number>(), later<number>(), later<number>()];
  let n = 0;
  const t = setup({ post: () => replies[n++]!.promise });
  await t.start();
  await t.run(5000);
  assert.equal(t.posts.length, 1);
  t.act('shortcut', { keys: 'command+c' });
  replies[0]!.resolve(503);
  await settle();
  await t.run(5000);
  assert.deepEqual(t.posts[1]!.map((r) => r.kind), ['window', 'shortcut']);
  replies[1]!.resolve(0);
  await settle();
  await t.run(5000);
  assert.deepEqual(t.posts[2]!.map((r) => r.kind), ['window', 'shortcut']);
  replies[2]!.resolve(200);
  await settle();
  await t.run(10000);
  assert.equal(t.posts.length, 3);
  const refused = setup({ post: async () => 422 });
  await refused.start();
  await refused.run(5000);
  refused.act('shortcut', { keys: 'command+c' });
  await refused.run(5000);
  assert.deepEqual(refused.posts.map((b) => b.map((r) => r.kind)), [['window'], ['shortcut']]);
  assert.deepEqual(refused.logs, ['TIMELINE post refused status=422']);
});

test('the helper diffs against a tree only once agentd took it; a refused full tree is asked for again', async () => {
  const statuses = [422, 200];
  const t = setup({ post: async () => statuses.shift() ?? 200 });
  await t.start();
  await t.run(5000);
  assert.deepEqual(t.posts.map((b) => b.map((r) => r.tree?.mode ?? null)), [['full']]);
  t.act('click');
  await t.run(300);
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 702 }, 'no diff against the refused t1');
  await t.run(5000);
  t.act('click');
  await t.run(300);
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 702, previous: 't2' });
});

test('a truncated tree is no diff base, even once agentd took it', async () => {
  const t = setup({ helper: { 'ax.window_tree': (p) => ok({ ...(trees()(p) as { result: Record<string, unknown> }).result, truncated: true }) } });
  await t.start();
  await t.run(5000);
  assert.deepEqual(t.posts.map((b) => b.map((r) => r.tree?.mode ?? null)), [['full']]);
  t.act('click');
  await t.run(300);
  assert.deepEqual(t.ops('ax.window_tree').at(-1), { pid: 702 });
});

test('a failed input.actions is asked again at the next tick', async () => {
  const replies = [err('ax_denied')];
  const t = setup({ helper: { 'input.actions': (p) => replies.shift() ?? ok({ watching: p.enabled }) } });
  await t.start();
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }]);
  await t.run(500);
  assert.deepEqual(t.ops('input.actions'), [{ enabled: true }, { enabled: true }]);
  await t.run(1000);
  assert.equal(t.ops('input.actions').length, 2);
  assert.deepEqual(t.logs, ['TIMELINE input.actions failed code=ax_denied']);
});

test('a click read twice with no change goes without a tree while a newer click waits for its own second read', async () => {
  const third = later<HelperAnswer>();
  const answers: (HelperAnswer | Promise<HelperAnswer>)[] = [tree('full', 't1', FULL), tree('no_change', 't2'), tree('no_change', 't3'),
    third.promise];
  const t = setup({ helper: { 'ax.window_tree': () => answers.shift()! } });
  await t.start();
  await t.run(5000);
  t.act('click', { target: { ...button, label: 'First' } });
  await t.run(500);
  t.act('click', { target: { ...button, label: 'Second' } });
  await t.run(500);
  assert.equal(t.ops('ax.window_tree').length, 3);
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => [r.kind, r.target?.title ?? null, r.tree?.mode ?? null]), [['window', null, 'full'],
    ['click', 'First', null]]);
});

test('records queued while share_actions is on are dropped when it turns off', async () => {
  const t = setup();
  await t.start();
  t.act('shortcut', { keys: 'command+s', target: null });
  t.policy = { ...ON, allowActions: false };
  await t.run(500);
  t.policy = ON;
  await t.run(5000);
  assert.deepEqual(t.records().map((r) => r.kind), ['window'], 'only the window sampled again once share_actions is back');
});

test('50 records are posted at the next tick', async () => {
  const t = setup();
  await t.start();
  for (let i = 0; i < 60; i += 1) t.act('shortcut', { keys: `command+${i}` });
  await t.run(500);
  assert.deepEqual(t.posts.map((b) => b.length), [50]);
  await t.run(5000);
  assert.deepEqual(t.posts.map((b) => b.length), [50, 11]);
});

const activityEvent = (over: Partial<ActivityEvent>): ActivityEvent => ({ ts: 1_763_539_201, kind: 'value', app: 'TextEdit',
  bundleId: 'com.apple.TextEdit', pid: 702, window: 'notes.txt', urlHost: null, doc: '/Users/u/notes.txt', role: 'AXTextArea',
  subrole: null, label: 'Body', value: 'milk', valueLen: 4, shrink: 0, edits: 1, ...over });

test('mirror: a value event is a text_input, a selection a selection; other kinds are not the timeline\'s', async () => {
  const t = setup();
  await t.start();
  await t.run(1000);
  t.recorder.mirror(activityEvent({}));
  t.recorder.mirror(activityEvent({ kind: 'selection', value: 'mil' }));
  t.recorder.mirror(activityEvent({ kind: 'focus', value: null }));
  t.recorder.mirror(activityEvent({ kind: 'value', pid: 4000 }));
  await t.run(5000);
  const body = { role: 'AXTextArea', subrole: null, title: 'Body', description: null, identifier: null, value: null };
  assert.deepEqual(t.records().slice(1), [
    { ts: 1_763_539_201, kind: 'text_input', app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640,
      window_title: 'notes.txt', url_host: null, target: body, keys: null, text: 'milk', tree: null },
    { ts: 1_763_539_201, kind: 'selection', app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640,
      window_title: 'notes.txt', url_host: null, target: body, keys: null, text: 'mil', tree: null },
  ]);
  const typedOff = setup({ policy: { ...ON, allowTypedText: false } });
  await typedOff.start();
  typedOff.recorder.mirror(activityEvent({}));
  await typedOff.run(5000);
  assert.equal(typedOff.records()[1]!.text, null);
});

test('ActivityRecorder hands each event it queues to its timeline port', async () => {
  const mirrored: ActivityEvent[] = [];
  let clock = 1_763_539_200_000;
  let fire: (() => void) | null = null;
  const activity = startActivity({
    helper: { request: async (op, p = {}) => (op === 'attention.sample'
      ? ok({ ts: 0, locked: false, front: { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit', window: null } })
      : ok({ watching: true, pid: p.pid })) },
    post: async () => 200, blacklist: () => NO_RULES, policy: () => ({ allowTypedText: true, senseCounts: true, redact: false }),
    ownPids: () => [], now: () => clock, every: (_ms, fn) => { fire = fn; return () => { fire = null; }; }, log: () => {},
    timeline: (e) => mirrored.push(e),
  });
  activity.update(sample());
  activity.start();
  await settle();
  activity.event('ax.notification', { pid: 702, notification: 'focus', element: { ...button, role: 'AXTextArea', label: 'Body' } });
  clock += 500;
  fire!();
  await settle();
  assert.deepEqual(mirrored.map((e) => [e.kind, e.label]), [['app', null], ['focus', 'Body']]);
});
