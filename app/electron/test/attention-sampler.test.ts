// The attention loop (src/main/attention/): its beats, presence edges and failure paths, on a
// fake platform helper, a fake agentd and a fake clock. Nothing here samples the real system.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AttentionSample, type BlacklistRules, EMPTY_BLACKLIST, parseBlacklist } from '../src/common/attention.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { BlacklistFile } from '../src/main/attention/blacklist.ts';
import { type AttentionPorts, startAttention } from '../src/main/attention/sampler.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);

/** CONTRACT §7.3 `attention.sample`: TextEdit in front on a 1440×900 display. */
function sampleResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: 1763539200, idle_s: 1, locked: false, secure_input: false,
    front: {
      pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit',
      window: { window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 }, title: 'notes.txt', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' },
    },
    mouse_window: null, focus_role: null, focus_native_role: null, focus_window_role: null, focus_window_native_role: null,
    focus_window_subrole: null, camera_active: false, mic_active: false, audio_clients: [], input_counters: null, input_idles: null,
    video_pids: [], front_gpu_busy: null, capture_indicator: false,
    ...over,
  };
}

const SCREENS = ok({ screens: [{ display_id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 }, visible: { x: 0, y: 25, width: 1440, height: 875 }, scale: 2, primary: true }] });

/** A promise settled from outside, for an answer that comes later. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function setup(o: { helper?: Record<string, Answer>; post?: () => Promise<number>; sensing?: { input: boolean; audioApps: boolean; redact: boolean };
  blacklist?: BlacklistRules } = {}) {
  let clock = 1_763_539_200_000;
  let fire: (() => void) | null = null;
  let interval = 0;
  const requests: [string, Record<string, unknown>][] = [];
  const posts: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const samples: AttentionSample[] = [];
  const pauses: boolean[] = [];
  const helper: Record<string, Answer> = {
    'attention.sample': ok(sampleResult()), 'screens.list': SCREENS, 'presence.watch': (p) => ok({ watching: p.enabled }),
    ...o.helper,
  };
  const ports: AttentionPorts = {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    post: async (body) => { posts.push(body); return o.post ? o.post() : 200; },
    blacklist: () => o.blacklist ?? NO_RULES,
    sensing: () => o.sensing ?? { input: true, audioApps: true, redact: true },
    ownPids: () => [4000],
    now: () => clock,
    every: (ms, fn) => { interval = ms; fire = fn; return () => { fire = null; }; },
    log: (line) => logs.push(line),
    onSample: (s) => samples.push(s),
    onSystemPaused: (p) => pauses.push(p),
  };
  const sampler = startAttention(ports);
  return {
    sampler, helper, requests, posts, logs, samples, pauses,
    get interval() { return interval; },
    get running() { return fire !== null; },
    async second() { clock += 1000; fire?.(); await settle(); },
    advance(ms: number) { clock += ms; },
    ops: () => requests.map(([op]) => op),
    async edge(edge: string) { sampler.event('presence.edge', { edge }); await settle(); },
  };
}

test('no beat before agentd runs; a sample and a POST each second while it runs; none after it stops (AgentdReadyPlan, AttentionBeats)', async () => {
  const t = setup();
  t.sampler.helper(true);
  await t.second();
  assert.equal(t.posts.length, 0);
  t.sampler.agentd(true);
  assert.equal(t.interval, 1000);
  await t.second();
  await t.second();
  assert.equal(t.posts.length, 2);
  assert.equal((t.posts[0]!.front as Record<string, unknown>).title, 'notes.txt');
  t.sampler.agentd(false);
  assert.equal(t.running, false);
});

test('the posted front title is the focused window\'s AX title when the helper gives one, else the window title', async () => {
  const front = (sampleResult().front as Record<string, unknown>);
  const ax = setup({ helper: { 'attention.sample': ok(sampleResult({ front: { ...front, focused_window_title: 'notes.txt — Edited' } })) } });
  ax.sampler.agentd(true);
  await ax.second();
  assert.equal((ax.posts[0]!.front as Record<string, unknown>).title, 'notes.txt — Edited');
  const windows = setup();
  windows.sampler.agentd(true);
  await windows.second();
  assert.equal((windows.posts[0]!.front as Record<string, unknown>).title, 'notes.txt', 'no focused_window_title (Windows)');
});

test('the sample asks for titles and audio always, input counts only while sense_input_counts is on', async () => {
  const on = setup();
  on.sampler.agentd(true);
  await on.second();
  assert.deepEqual(on.requests.find(([op]) => op === 'attention.sample')![1], { include_titles: true, include_input: true, include_audio: true });
  const off = setup({ sensing: { input: false, audioApps: false, redact: true },
    helper: { 'attention.sample': ok(sampleResult({ audio_clients: [{ pid: 9, app_id: 'us.zoom.xos', name: 'zoom', running_input: true, running_output: null }] })) } });
  off.sampler.agentd(true);
  await off.second();
  assert.deepEqual(off.requests.find(([op]) => op === 'attention.sample')![1], { include_titles: true, include_input: false, include_audio: true });
  assert.equal('mic_apps' in off.posts[0]!, false);
  assert.equal('input' in off.posts[0]!, false);
});

test('input counts come from the helper counters, and restart from zero when the helper restarts', async () => {
  let keys = 1000;
  const t = setup({ helper: { 'attention.sample': () => ok(sampleResult({
    input_counters: { keys, left_clicks: 0, right_clicks: 0, scrolls: 0, moves: 0 }, input_idles: { key: 0, pointer: 0, scroll: 0, click: 0 } })) } });
  t.sampler.helper(true);
  t.sampler.agentd(true);
  await t.second();
  keys = 1004;
  await t.second();
  assert.equal((t.posts[1]!.input as Record<string, unknown>).keys_10s, 4);
  t.sampler.helper(false);
  t.sampler.helper(true);
  keys = 3;
  await t.second();
  assert.equal((t.posts[2]!.input as Record<string, unknown>).keys_10s, 0);
});

test('a beat still in flight skips the next second', async () => {
  const post = later<number>();
  const t = setup({ post: () => post.promise });
  t.sampler.agentd(true);
  await t.second();
  await t.second();
  assert.equal(t.ops().filter((op) => op === 'attention.sample').length, 1);
  post.resolve(200);
  await settle();
  await t.second();
  assert.equal(t.ops().filter((op) => op === 'attention.sample').length, 2);
});

test('agentd not answering does not stop the beats (AgentdClient.postAttention returns 0)', async () => {
  const t = setup({ post: async () => 0 });
  t.sampler.agentd(true);
  await t.second();
  await t.second();
  assert.equal(t.posts.length, 2);
});

test('without the helper nothing is posted, the failure is logged once, and the beats go on', async () => {
  let up = false;
  const t = setup({ helper: { 'attention.sample': () => (up ? ok(sampleResult()) : err('helper_exited')) } });
  t.sampler.agentd(true);
  await t.second();
  await t.second();
  assert.equal(t.posts.length, 0);
  assert.deepEqual(t.logs.filter((l) => l.startsWith('ATTENTION sample')), ['ATTENTION sample failed code=helper_exited']);
  up = true;
  await t.second();
  assert.equal(t.posts.length, 1);
});

test('presence.watch is turned on once; a restarted helper gets it from the supervisor, a failed one is asked again (CONTRACT §6.4)', async () => {
  const t = setup();
  t.sampler.helper(true);
  await settle();
  t.sampler.helper(false);
  t.sampler.helper(true);
  await settle();
  assert.deepEqual(t.requests.filter(([op]) => op === 'presence.watch'), [['presence.watch', { enabled: true }]]);
  const failed = setup({ helper: { 'presence.watch': err('helper_exited') } });
  failed.sampler.helper(true);
  await settle();
  failed.sampler.helper(false);
  failed.sampler.helper(true);
  await settle();
  assert.equal(failed.requests.filter(([op]) => op === 'presence.watch').length, 2);
});

test('lock: a beat with edge lock at once, paused polls that post nothing, then unlock seen by the poll resumes', async () => {
  let locked = false;
  const t = setup({ helper: { 'attention.sample': () => ok(sampleResult({ locked })) } });
  t.sampler.agentd(true);
  await t.second();
  locked = true;
  await t.edge('lock');
  assert.deepEqual(t.pauses, [true]);
  assert.equal(t.sampler.systemPaused, true);
  assert.equal(t.posts.length, 2);
  assert.equal(t.posts[1]!.edge, 'lock');
  assert.equal(t.posts[1]!.locked, true);
  await t.second();
  assert.equal(t.posts.length, 2);
  assert.deepEqual(t.requests.at(-1), ['attention.sample', {}]);
  t.advance(5000);
  locked = false;
  await t.second();
  assert.deepEqual(t.pauses, [true, false]);
  assert.equal(t.posts.at(-1)!.edge, 'unlock');
  assert.equal(t.posts.at(-1)!.locked, false);
});

test('a lock seen by both the event and the beat\'s own read goes out once (PresenceEdges.debounce)', async () => {
  let locked = false;
  const t = setup({ helper: { 'attention.sample': () => ok(sampleResult({ locked })) } });
  t.sampler.agentd(true);
  await t.second();
  locked = true;
  await t.edge('lock');
  assert.deepEqual(t.posts.map((p) => p.edge), [undefined, 'lock']);
});

test('display sleep and wake are sent as sleep and wake with asleep set', async () => {
  const t = setup();
  t.sampler.agentd(true);
  await t.second();
  await t.edge('display_sleep');
  assert.equal(t.posts.at(-1)!.edge, 'sleep');
  assert.equal(t.posts.at(-1)!.asleep, true);
  assert.deepEqual(t.pauses, [true]);
  await t.edge('sleep');
  assert.equal(t.posts.length, 2);
  t.advance(3000);
  await t.edge('wake');
  assert.equal(t.posts.length, 2);
  await t.edge('display_wake');
  assert.deepEqual(t.pauses, [true, false]);
  assert.equal(t.posts.at(-1)!.edge, 'wake');
  assert.equal(t.posts.at(-1)!.asleep, false);
});

test('edges while agentd is down send nothing, but the pause still applies', async () => {
  const t = setup();
  await t.edge('lock');
  assert.deepEqual(t.pauses, [true]);
  assert.equal(t.posts.length, 0);
  await t.edge('unlock');
  assert.deepEqual(t.pauses, [true, false]);
});

test('an edge during a beat in flight goes out right after it', async () => {
  const first = later<number>();
  let n = 0;
  const t = setup({ post: () => (n++ === 0 ? first.promise : Promise.resolve(200)) });
  t.sampler.agentd(true);
  await t.second();
  await t.edge('display_sleep');
  assert.equal(t.posts.length, 1);
  first.resolve(200);
  await settle();
  assert.equal(t.posts.length, 2);
  assert.equal(t.posts[1]!.edge, 'sleep');
});

test('stopping drops the edges not yet sent', async () => {
  const first = later<number>();
  let n = 0;
  const t = setup({ post: () => (n++ === 0 ? first.promise : Promise.resolve(200)) });
  t.sampler.agentd(true);
  await t.second();
  await t.edge('display_sleep');
  t.sampler.agentd(false);
  first.resolve(200);
  await settle();
  assert.equal(t.posts.length, 1);
});

test('Safari and Chrome are asked for their tab; another app is not', async () => {
  const chrome = sampleResult({ front: { pid: 9, name: 'Google Chrome', app_id: 'com.google.Chrome', window: { window_id: 3, pid: 9, bounds: { x: 0, y: 25, width: 800, height: 600 }, title: 'Secret tab' } } });
  const t = setup({ helper: { 'attention.sample': ok(chrome), 'browser.front_tab': ok({ url_host: null, incognito: true }) } });
  t.sampler.agentd(true);
  await t.second();
  assert.deepEqual(t.requests.find(([op]) => op === 'browser.front_tab'), ['browser.front_tab', { app_id: 'com.google.Chrome' }]);
  assert.equal((t.posts[0]!.front as Record<string, unknown>).title, null);
  assert.equal(t.samples[0]!.frontIncognito, true);
  const other = setup();
  other.sampler.agentd(true);
  await other.second();
  assert.equal(other.ops().includes('browser.front_tab'), false);
});

test('fullscreen, the last sample and the system pause are readable; onSample sees each beat', async () => {
  const full = sampleResult({ front: { pid: 7, name: 'Keynote', app_id: 'com.apple.iWork.Keynote', window: { window_id: 3, pid: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 } } } });
  const t = setup({ helper: { 'attention.sample': ok(full) } });
  assert.equal(t.sampler.frontFullscreen, false);
  t.sampler.agentd(true);
  await t.second();
  assert.equal(t.sampler.frontFullscreen, true);
  assert.equal(t.posts[0]!.fullscreen, true);
  assert.equal(t.samples.length, 1);
  assert.equal(t.sampler.lastSample, t.samples[0]);
  assert.equal(t.sampler.systemPaused, false);
});

test('a front app playing video reads its AX video rect for the reflex, in AppKit points', async () => {
  const t = setup({ helper: { 'attention.sample': ok(sampleResult({ video_pids: [702] })), 'ax.video_rect': ok({ rect: { x: 10, y: 20, width: 300, height: 200 } }) } });
  t.sampler.agentd(true);
  await t.second();
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.video_rect'), ['ax.video_rect', { pid: 702 }]);
  assert.deepEqual(t.sampler.reflex, { kind: 'video', rect: { x: 10, y: 680, width: 300, height: 200 } });
  assert.equal(t.posts[0]!.front_video, true);
});

test('the gate and focus window lines are logged when they change', async () => {
  let camera = false;
  const t = setup({ helper: { 'attention.sample': () => ok(sampleResult({ camera_active: camera })) } });
  t.sampler.agentd(true);
  await t.second();
  await t.second();
  camera = true;
  await t.second();
  assert.deepEqual(t.logs, [
    'ATTENTION gate fullscreen=false camera=false mic=false speaking=nil', 'ATTENTION focus_window nil',
    'ATTENTION gate fullscreen=false camera=true mic=false speaking=nil',
  ]);
});

test('BlacklistFile: none is the empty allow list; reread when the mtime changes; a half-written file keeps the last rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attention-blacklist-'));
  try {
    const path = join(dir, 'blacklist.json');
    const file = new BlacklistFile(path);
    assert.deepEqual(file.rules(), EMPTY_BLACKLIST);
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'deny', incognito: true, bundle_ids: ['a'] }));
    utimesSync(path, 1000, 1000);
    assert.equal(file.rules().incognito, true);
    writeFileSync(path, '{"incognito": fal');
    utimesSync(path, 2000, 2000);
    assert.equal(file.rules().incognito, true);
    writeFileSync(path, JSON.stringify({ mode: 'deny', incognito: false }));
    utimesSync(path, 3000, 3000);
    assert.equal(file.rules().incognito, false);
    rmSync(path);
    assert.deepEqual(file.rules(), EMPTY_BLACKLIST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
