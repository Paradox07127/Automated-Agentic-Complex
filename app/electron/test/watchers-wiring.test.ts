// The surface source, the give-way loop and the activity and timeline recorders wired as index.ts wires them
// (src/main/attention/watchers.ts), on a fake platform helper, a fake renderer link, a fake agentd and fake timers. Nothing
// here reads the real system's windows.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AttentionSample } from '../src/common/attention.ts';
import type { Box } from '../src/common/c3.ts';
import { DEFAULT_PLUGINS, shellPlan, type Subsystem } from '../src/common/plugins.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { NO_ANSWER, type UserAnswer } from '../src/main/attention/sampler.ts';
import { helperYFor, type RecorderOptions, shellRecorders, shellWatchers, surfaceLinkOptions, type WatcherOptions }
  from '../src/main/attention/watchers.ts';
import { placementSpace } from '../src/main/platform/screens.ts';
import type { LinkEvent } from '../src/main/renderer/link.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const r = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res)); };

/** TextEdit in front with a 300×24 field focused, one 1440×900 display. */
const HELPER: Record<string, HelperAnswer> = {
  'workspace.watch': ok({ watching: true }),
  'screens.list': ok({ screens: [{ display_id: 1, frame: r(0, 0, 1440, 900), visible: r(0, 25, 1440, 875), scale: 2, primary: true }] }),
  'windows.list': ok({ windows: [{ window_id: 640, pid: 702, layer: 0, alpha: 1, bounds: r(200, 120, 900, 600) }] }),
  'ax.focused': ok({ focus: { pid: 702, role: 'AXTextField', native_role: 'AXTextField', subrole: null, frame: r(100, 100, 300, 24), caret: null, editable: true } }),
  'ax.dialog_buttons': ok({ buttons: [] }),
  'ax.overlays': ok({ banners: [], ime: [] }),
  'attention.sample': ok({ front: { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit' } }),
  'ax.watch': ok({ watching: true }),
};

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: null, urlHost: null }, frontIncognito: false,
    mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false, cameraActive: false,
    micActive: false, userSpeaking: null, focusWindow: null, input: null, frontAudioOut: null, frontVideo: null, frontGpu: null,
    screenCaptured: false, edge: null, frontBounds: null, ...over,
  };
}

/** agentd's state dir with a deny-mode blacklist.json of no rules: every window but ours is read. */
const OPEN_STATE = mkdtempSync(join(tmpdir(), 'watchers-open-'));
writeFileSync(join(OPEN_STATE, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
after(() => rmSync(OPEN_STATE, { recursive: true, force: true }));

/** ObservationControl.state as the tests set it. */
interface Observed { meeting: boolean; pausedUntil: number | null }

/** shellPlan with screen awareness on: the recorders and the focus turn run. */
const AWARE = shellPlan({ ...DEFAULT_PLUGINS, screen_awareness: true });

function setup(o: { argv?: string[]; saved?: Record<string, unknown> | null; platform?: 'mac' | 'windows'; frontFullscreen?: boolean;
  observation?: Observed | null; helper?: Record<string, HelperAnswer>; focus?: boolean; plan?: ReadonlySet<Subsystem>;
  user?: Partial<UserAnswer> } = {}) {
  let clock = 0;
  /** The sampler's last `/user/coarse` answer. */
  let user: UserAnswer = { ...NO_ANSWER, ...o.user };
  const answers = { ...HELPER, ...o.helper };
  let cursor = { x: 0, y: 0 };
  let lastCursorHit = false;
  const focusHides: boolean[] = [];
  const timers = new Set<{ ms: number; fn: () => void; at: number }>();
  const requests: [string, Record<string, unknown>][] = [];
  const posts: [string, string, unknown][] = [];
  const sent: { type: string; body: unknown }[] = [];
  const hides: [boolean, string][] = [];
  const listeners = new Set<(e: LinkEvent) => void>();
  let capabilities: string[] = [];
  let hidden = false;
  const options: WatcherOptions & RecorderOptions = {
    argv: o.argv ?? [], platform: o.platform ?? 'mac',
    helper: { request: async (op, params = {}) => { requests.push([op, params]); return answers[op] ?? { ok: false, error: { code: 'unsupported' } }; } },
    link: {
      hello: { pid: 4100 }, get capabilities() { return capabilities; }, get hidden() { return hidden; }, get lastCursorHit() { return lastCursorHit; },
      on: (l) => { listeners.add(l); return () => listeners.delete(l); },
      sendSurfaces: (seq, windows) => { sent.push({ type: 'surfaces', body: { seq, windows } }); return true; },
      sendSurface: (s) => { sent.push({ type: 'surface', body: s }); return true; },
      sendCovered: (w) => { sent.push({ type: 'covered', body: w }); return true; },
      sendPassThrough: (rects: Box[]) => { sent.push({ type: 'pass_through', body: rects }); return true; },
      setHitExclusions: () => true,
      cursorMoved: () => {},
      sendAttentionSide: (source, kind, side) => { sent.push({ type: 'attention_side', body: { source, kind, side } }); return true; },
    },
    agentd: { request: async (method, path, json) => { posts.push([method, path, json]); return { status: 202 }; } },
    agentdStateDir: OPEN_STATE,
    saved: () => (o.saved === undefined ? {} : o.saved),
    plan: () => o.plan ?? AWARE,
    cursor: () => cursor,
    ownPids: () => [77],
    attention: () => ({ reflex: null, systemPaused: false, frontFullscreen: o.frontFullscreen ?? false, user }),
    keyIdle: () => 60,
    avatarHidden: () => hidden,
    setHidden: (h, reason) => { hides.push([h, reason]); hidden = h; },
    log: () => {}, linkLog: () => {},
    // index.ts: the link's set_visible and the runtime's visibility.
    ...(o.focus && { setFocusHidden: (h: boolean) => { focusHides.push(h); hidden = h; } }),
    // Null leaves the option out.
    ...(o.observation !== null && { observation: () => o.observation ?? { meeting: false, pausedUntil: null } }),
    mainHeight: () => 900,
    wall: () => 1_000_000,
    clock: {
      now: () => clock,
      every: (ms, fn) => { const t = { ms, fn, at: clock }; timers.add(t); return () => { timers.delete(t); }; },
    },
  };
  const watchers = shellWatchers(options), recorders = shellRecorders(options);
  /** Runs each timer as many times as `ms` lets it. */
  const step = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter((t) => t.at + t.ms <= end).sort((a, b) => a.at + a.ms - (b.at + b.ms))[0];
      if (!due) break;
      clock = due.at + due.ms;
      due.at = clock;
      due.fn();
      await settle();
    }
    clock = end;
    await settle();
  };
  const hello = (caps = ['surfaces', 'opacity', 'layering', 'pass_through', 'keep_clear']) => {
    capabilities = caps;
    for (const l of listeners) l({ kind: 'hello', hello: { v: 1, type: 'hello', role: 'avatar', pid: 4100, protocol: 1, capabilities: caps } as never });
  };
  const message = (m: Record<string, unknown>) => { for (const l of listeners) l({ kind: 'message', message: { v: 1, ...m } as never }); };
  const lost = () => { for (const l of listeners) l({ kind: 'lost' } as never); };
  return { watchers, recorders, requests, posts, sent, hides, step, hello, message, lost, timers, ops: () => requests.map(([op]) => op), answers, focusHides,
    point: (p: { x: number; y: number }) => { cursor = p; }, cursorHit: (hit: boolean) => { lastCursorHit = hit; },
    setHidden: (h: boolean) => { hidden = h; }, answer: (over: Partial<UserAnswer>) => { user = { ...NO_ANSWER, ...over }; } };
}

test('the helper up: the surfaces send their first snapshot, give-way its first screen targets, and the recorder watches the front app', async () => {
  const t = setup();
  const w = t.watchers!, rec = t.recorders!;
  w.helper(true);
  rec.helper(true);
  t.hello();
  rec.agentd(true);
  await t.step(600);
  assert.deepEqual(t.sent.filter((m) => m.type === 'surfaces').map((m) => (m.body as { seq: number }).seq), [0]);
  const mac = placementSpace({ getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: { height: 900 } }) as never }, 'mac');
  assert.deepEqual(w.keepClear((x) => mac.rectFromC3(x)), [{ kind: 'text_input', frame: { x: 100, y: 776, w: 300, h: 24 } }]);
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.watch')?.[1],
    { pid: 702, notifications: ['focus', 'window', 'title', 'value', 'selection'], read_selected_text: false, read_value: false, watch_id: 'activity' });
  w.stop();
  rec.stop();
  assert.equal(t.timers.size, 0, 'nothing runs after stop');
});

test('without screen awareness the surfaces and give-way still start, and the recorders do not while agentd runs', async () => {
  const t = setup({ plan: shellPlan(DEFAULT_PLUGINS) });
  t.watchers!.helper(true);
  t.recorders!.helper(true);
  t.hello();
  t.recorders!.agentd(true);
  await t.step(600);
  assert.deepEqual(t.sent.filter((m) => m.type === 'surfaces').map((m) => (m.body as { seq: number }).seq), [0]);
  assert.ok(t.ops().includes('ax.focused'), 'give-way reads the focused field');
  assert.ok(!t.ops().includes('ax.watch'));
  assert.deepEqual(t.posts, []);
  t.watchers!.stop();
  t.recorders!.stop();
});

test('--no-attention starts none of them, and the link lists no surfaces or pass_through', () => {
  const t = setup({ argv: ['--no-attention'] });
  assert.equal(t.watchers, null);
  assert.equal(t.recorders, null);
  assert.equal(t.timers.size, 0);
  const track = () => {};
  assert.deepEqual(surfaceLinkOptions(['--no-attention'], track), {});
  assert.deepEqual(surfaceLinkOptions([], track), { onSurfaceTrack: track, offers: ['pass_through'] });
});

test('screen awareness off leaves the recorders off while agentd runs; agentd stopping stops them', async () => {
  const t = setup({ plan: shellPlan(DEFAULT_PLUGINS) });
  t.recorders!.helper(true);
  t.recorders!.agentd(true);
  await t.step(1000);
  assert.ok(!t.ops().includes('ax.watch'));
  assert.ok(!t.ops().includes('attention.sample'));
  t.recorders!.stop();
  const on = setup();
  on.recorders!.helper(true);
  on.recorders!.agentd(true);
  await on.step(100);
  on.recorders!.agentd(false);
  await on.step(100);
  assert.deepEqual(on.requests.filter(([op]) => op === 'ax.watch').at(-1)?.[1], { pid: null, notifications: [], watch_id: 'activity' },
    'agentd stopping stops the recorder');
});

test('each attention sample may hide her for fullscreen; the front fullscreen is the sampler\'s', () => {
  const t = setup({ frontFullscreen: true });
  const w = t.watchers!;
  assert.equal(w.frontFullscreen, true);
  w.sampled(sample({ fullscreen: true }));
  assert.deepEqual(t.hides, [[true, 'fullscreen']]);
  assert.equal(w.fullscreenHidden, true);
  w.userSetHidden();
  assert.equal(w.fullscreenHidden, false);
  assert.equal(setup().watchers!.frontFullscreen, false);
  // Windows: efw keeps her out of captures itself (C3 Windows appendix), so a capture hides nothing here.
  const win = setup({ platform: 'windows', saved: { hide_on_screen_capture: true } });
  win.watchers!.sampled(sample({ screenCaptured: true }));
  assert.deepEqual(win.hides, []);
  const mac = setup({ saved: { fullscreen_behavior: 'corner' } });
  mac.watchers!.sampled(sample({ screenCaptured: true }));
  assert.deepEqual(mac.hides, [[true, 'fullscreen']]);
});

test('the helper\'s coordinates: macOS flips into AppKit points; Windows keeps its pixels, which the placement space negates', async () => {
  assert.equal(helperYFor('mac')(100, 24, 900), 776);
  assert.equal(helperYFor('windows')(100, 24, 900), 100);
  const t = setup({ platform: 'windows' });
  t.watchers!.helper(true);
  await t.step(500);
  const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) as never };
  const space = placementSpace(screen, 'windows');
  assert.deepEqual(t.watchers!.keepClear((x) => space.rectFromC3(x)), [{ kind: 'text_input', frame: { x: 100, y: -124, w: 300, h: 24 } }]);
  t.watchers!.stop();
});

// ---- C3 rule 39 `attention_side` with source focus

/** Her body's capsule in global points: the bounds (620, 120, 160, 360), centre (700, 300). */
const BODY = { type: 'hit_capsules', space: 'global', capsules: [{ a: [700, 200], b: [700, 400], r: 80 }] };
/** In helper coordinates; on the 900 pt main display its AppKit centre is (150, 600), 626 pt from hers. */
const FAR_LEFT = r(0, 100, 300, 400);
const sides = (t: ReturnType<typeof setup>) => t.sent.filter((m) => m.type === 'attention_side').map((m) => m.body);

test('a focused window far from her for 3 s turns her toward it once; the user starting to type turns her too', () => {
  const t = setup();
  t.hello();
  t.message(BODY);
  const w = t.watchers!;
  w.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  w.sampled(sample({ ts: 2.9, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), []);
  w.sampled(sample({ ts: 3, frontBounds: FAR_LEFT }));
  w.sampled(sample({ ts: 10, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [{ source: 'focus', kind: 'window', side: 'left' }]);
  t.answer({ typing: true });
  w.sampled(sample({ ts: 11, frontBounds: FAR_LEFT }));
  w.sampled(sample({ ts: 12, frontBounds: FAR_LEFT }));
  t.answer({ typing: false });
  w.sampled(sample({ ts: 13, frontBounds: FAR_LEFT }));
  t.answer({ typing: true });
  w.sampled(sample({ ts: 14, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t).slice(1), [{ source: 'focus', kind: 'typing', side: 'left' }], 'at most once per typingInterval');
  assert.equal('feed' in w, false, 'agentd\'s behavior events turn her no more');
});

test('without her body or without ObservationControl she does not turn; a new avatar starts without a body', () => {
  const noBody = setup({ user: { typing: true } });
  noBody.hello();
  const noObservation = setup({ observation: null, user: { typing: true } });
  noObservation.hello();
  noObservation.message(BODY);
  for (const t of [noBody, noObservation]) {
    for (const ts of [0, 3, 6]) t.watchers!.sampled(sample({ ts, frontBounds: FAR_LEFT }));
    assert.deepEqual(sides(t), []);
  }
  const again = setup();
  again.hello();
  again.message(BODY);
  again.watchers!.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  again.hello();
  again.watchers!.sampled(sample({ ts: 3, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(again), []);
});

test('a manual or detected meeting, offstage, pause, screen awareness off, lock, sleep, secure input and an incognito front stop the turn and clear the dwell', () => {
  const gates: [string, Parameters<typeof setup>[0], Partial<AttentionSample>][] = [
    ['manual meeting', { observation: { meeting: true, pausedUntil: null } }, {}],
    ['detected meeting', { user: { stage: 'quiet', doing: 'meeting' } }, {}],
    ['offstage', { user: { stage: 'offstage' } }, {}],
    ['paused', { observation: { meeting: false, pausedUntil: 2_000_000 } }, {}],
    ['screen awareness off', { plan: shellPlan(DEFAULT_PLUGINS) }, {}],
    ['locked', {}, { locked: true }],
    ['asleep', {}, { asleep: true }],
    ['secure input', {}, { secureInput: true }],
    ['incognito', {}, { frontIncognito: true }],
  ];
  for (const [name, options, over] of gates) {
    const t = setup({ ...options, user: { ...options!.user, typing: true } });
    t.hello();
    t.message(BODY);
    const w = t.watchers!;
    w.sampled(sample({ ts: 0, frontBounds: FAR_LEFT, ...over }));
    w.sampled(sample({ ts: 3, frontBounds: FAR_LEFT, ...over }));
    assert.deepEqual(sides(t), [], name);
  }
  // Quiet for the user's own typing is no meeting.
  const typing = setup({ user: { stage: 'quiet', typing: true } });
  typing.hello();
  typing.message(BODY);
  typing.watchers!.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(typing), [{ source: 'focus', kind: 'typing', side: 'left' }]);
  // A gated sample forgets the window: after one, the dwell starts again.
  for (const [name, , over] of gates.slice(5)) {
    const t = setup();
    t.hello();
    t.message(BODY);
    const w = t.watchers!;
    w.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
    w.sampled(sample({ ts: 1, frontBounds: FAR_LEFT, ...over }));
    w.sampled(sample({ ts: 3, frontBounds: FAR_LEFT }));
    w.sampled(sample({ ts: 5.9, frontBounds: FAR_LEFT }));
    assert.deepEqual(sides(t), [], name);
    w.sampled(sample({ ts: 6, frontBounds: FAR_LEFT }));
    assert.deepEqual(sides(t), [{ source: 'focus', kind: 'window', side: 'left' }], name);
  }
});

test('meeting, pause and the answer are read at each sample: once they end the dwell starts', () => {
  const observation: Observed = { meeting: true, pausedUntil: null };
  const t = setup({ observation, user: { stage: 'quiet' } });
  t.hello();
  t.message(BODY);
  const w = t.watchers!;
  w.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  w.sampled(sample({ ts: 3, frontBounds: FAR_LEFT }));
  t.answer({ stage: 'quiet', typing: true });
  w.sampled(sample({ ts: 3.5, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [], 'meeting');
  observation.meeting = false;
  observation.pausedUntil = 999_000;
  t.answer({});
  w.sampled(sample({ ts: 4, frontBounds: FAR_LEFT }));
  w.sampled(sample({ ts: 7, frontBounds: FAR_LEFT }));
  t.answer({ typing: true });
  w.sampled(sample({ ts: 8, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [{ source: 'focus', kind: 'window', side: 'left' }, { source: 'focus', kind: 'typing', side: 'left' }]);
});

test('the front window\'s bounds go into her capsules\' space: AppKit points on macOS, the helper\'s own pixels on Windows', () => {
  // Helper centre (800, 300): 316 pt from her once flipped on the 900 pt display, 100 px unflipped.
  const window = r(750, 200, 100, 200);
  for (const [platform, want] of [['mac', [{ source: 'focus', kind: 'window', side: 'right' }]], ['windows', []]] as const) {
    const t = setup({ platform });
    t.hello();
    t.message(BODY);
    t.watchers!.sampled(sample({ ts: 0, frontBounds: window }));
    t.watchers!.sampled(sample({ ts: 3, frontBounds: window }));
    assert.deepEqual(sides(t), want, platform);
  }
});

test('only the answer\'s typing coming on turns her, and none in a meeting; capsules in window space sit at her window frame', () => {
  const observation: Observed = { meeting: false, pausedUntil: null };
  const t = setup({ observation });
  t.hello();
  t.message(BODY);
  const w = t.watchers!;
  w.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [], 'not typing');
  observation.meeting = true;
  t.answer({ stage: 'quiet', typing: true });
  w.sampled(sample({ ts: 0.5, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [], 'meeting');
  observation.meeting = false;
  t.answer({});
  w.sampled(sample({ ts: 1, frontBounds: FAR_LEFT }));
  t.answer({ typing: true });
  w.sampled(sample({ ts: 1.5, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(t), [{ source: 'focus', kind: 'typing', side: 'left' }]);
  // Window-space centre (100, 300) in a frame at (600, 0): global (700, 300), right of the window's 150.
  const local = setup({ user: { typing: true } });
  local.hello();
  local.message({ type: 'hit_capsules', space: 'window', capsules: [{ a: [100, 200], b: [100, 400], r: 80 }] });
  local.watchers!.sampled(sample({ ts: 0, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(local), [], 'no window frame yet');
  local.message({ type: 'window_frame', frame: { x: 600, y: 0, w: 300, h: 600 }, viewport: 'window' });
  local.answer({});
  local.watchers!.sampled(sample({ ts: 1, frontBounds: FAR_LEFT }));
  local.answer({ typing: true });
  local.watchers!.sampled(sample({ ts: 2, frontBounds: FAR_LEFT }));
  assert.deepEqual(sides(local), [{ source: 'focus', kind: 'typing', side: 'left' }]);
});

/** Her body under TextEdit's window (AppKit 200,180 900×600) in a window viewport. */
const COVERED = [{ type: 'window_frame', frame: { x: 600, y: 100, w: 300, h: 600 }, viewport: 'window' }, BODY];
const press = (t: ReturnType<typeof setup>) => t.watchers!.event('input.activity', { kind: 'mouse_down' });

test('the helper up asks for input.watch, whose mouse downs reach onMouseDown with the pointer', async () => {
  const t = setup();
  const w = t.watchers!;
  w.helper(true);
  await t.step(20);
  assert.deepEqual(t.requests.filter(([op]) => op === 'input.watch'), [['input.watch', { enabled: true }]]);
  const seen: unknown[] = [];
  const off = w.onMouseDown((at) => seen.push(at));
  t.point({ x: 300, y: 400 });
  press(t);
  w.event('input.activity', { kind: 'key' });
  off();
  press(t);
  assert.deepEqual(seen, [{ x: 300, y: 400 }]);
  w.stop();
});

test('focus visibility: covered 1.2 s in the window viewport hides her; uncovered 0.8 s and hidden 3 s shows her', async () => {
  const t = setup({ focus: true });
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  w.sampled(sample());
  for (const m of COVERED) t.message(m);
  await t.step(1400);
  assert.deepEqual(t.focusHides, [], 'the cover itself takes 0.3 s');
  await t.step(400);
  assert.deepEqual(t.focusHides, [true]);
  // Hidden, she sends no capsules; the cover is still judged on her last body.
  t.message({ type: 'hit_capsules', space: 'global', capsules: [] });
  t.answers['windows.list'] = ok({ windows: [{ window_id: 640, pid: 702, layer: 0, alpha: 1, bounds: r(1000, 120, 400, 300) }] });
  await t.step(2500);
  assert.deepEqual(t.focusHides, [true], 'not before 3 s hidden');
  await t.step(600);
  assert.deepEqual(t.focusHides, [true, false]);
  w.stop();
});

test('focus visibility: a connection lost while it hides her shows her again (HostLink.closeConnection)', async () => {
  const t = setup({ focus: true });
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  w.sampled(sample());
  for (const m of COVERED) t.message(m);
  await t.step(1800);
  assert.deepEqual(t.focusHides, [true]);
  t.lost();
  assert.deepEqual(t.focusHides, [true, false]);
  w.stop();
});

test('focus visibility: not in the fullscreen viewport, and a press or a show by the user holds it off 3 s', async () => {
  const full = setup({ focus: true });
  full.watchers!.helper(true);
  full.hello();
  full.watchers!.sampled(sample());
  full.message({ ...COVERED[0], viewport: 'fullscreen' });
  full.message(BODY);
  await full.step(3000);
  assert.deepEqual(full.focusHides, []);
  full.watchers!.stop();

  const t = setup({ focus: true });
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  w.sampled(sample());
  for (const m of COVERED) t.message(m);
  await t.step(1000);
  press(t);
  await t.step(2900);
  assert.deepEqual(t.focusHides, [], 'a press holds it off 3 s');
  await t.step(1500);
  assert.deepEqual(t.focusHides, [true]);
  // 显示 from the menu: the user's show wins and the covered run starts again.
  t.setHidden(false);
  w.userSetHidden();
  await t.step(2900);
  assert.deepEqual(t.focusHides, [true]);
  await t.step(1500);
  assert.deepEqual(t.focusHides, [true, true]);
  w.stop();
});

const release = (t: ReturnType<typeof setup>) => t.watchers!.event('input.activity', { kind: 'mouse_up' });

test('buttonsDown (HostLink.buttonsDown): from a press to its release once the helper sends releases, else a press until the next tick', async () => {
  const t = setup();
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  await t.step(20);
  press(t);
  assert.equal(w.buttonsDown, true);
  await t.step(20);
  assert.equal(w.buttonsDown, false, 'no `mouse_up` from this helper yet: the press lasts until the tick');
  release(t);
  press(t);
  await t.step(1000);
  assert.equal(w.buttonsDown, true);
  release(t);
  assert.equal(w.buttonsDown, false);
  press(t);
  await t.step(20);
  w.helper(false);
  assert.equal(w.buttonsDown, false, 'the helper went');
  w.stop();
});

test('focus visibility: a button held down keeps her shown; 3 s after its release the cover hides her', async () => {
  const t = setup({ focus: true });
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  w.sampled(sample());
  for (const m of COVERED) t.message(m);
  press(t);
  release(t);
  await t.step(1000);
  press(t);
  await t.step(6000);
  assert.deepEqual(t.focusHides, [], 'held 6 s');
  release(t);
  await t.step(2900);
  assert.deepEqual(t.focusHides, []);
  await t.step(1500);
  assert.deepEqual(t.focusHides, [true]);
  w.stop();
});

test('keep_clear sources: 3 presses near her in one 50 pt cell are `near_clicks`; presses after a hit are not', async () => {
  const t = setup();
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  for (const m of COVERED) t.message(m);
  await t.step(20);
  const near = () => w.keepClear((x) => x).filter((k) => k.kind === 'near_clicks');
  t.point({ x: 510, y: 210 });
  press(t);
  press(t);
  assert.deepEqual(near(), []);
  t.cursorHit(true);
  press(t);
  assert.deepEqual(near(), [], 'the last cursor hit her');
  t.cursorHit(false);
  t.point({ x: 400, y: 210 });
  press(t);
  assert.deepEqual(near(), [], 'more than 120 pt off her');
  t.point({ x: 520, y: 240 });
  press(t);
  assert.deepEqual(near(), [{ kind: 'near_clicks', frame: { x: 500, y: 200, w: 50, h: 50 } }]);
  // CursorKinematics.click looks at the capsule hit at the press, not the last cursor's.
  assert.equal(w.nearClicks10s(), 4, 'near_clicks_10s counts presses off her within 120 pt');
  await t.step(10_000);
  assert.equal(w.nearClicks10s(), 0);
  w.stop();
});

test('keep_clear sources: the pass-through control under the pointer is a `control` at a press, kept 10 s', async () => {
  const t = setup({ helper: { 'ax.hit_chain': ok({ chain: [{ role: 'AXButton', subrole: null, frame: r(650, 560, 40, 20) }] }) } });
  const w = t.watchers!;
  w.helper(true);
  t.hello();
  t.message({ ...COVERED[0], viewport: 'fullscreen' });
  t.message(BODY);
  t.point({ x: 660, y: 330 });
  await t.step(200);
  const controls = () => w.keepClear((x) => x).filter((k) => k.kind === 'control');
  assert.deepEqual(controls(), []);
  press(t);
  await t.step(20);
  assert.deepEqual(controls(), [{ kind: 'control', frame: { x: 650, y: 320, w: 40, h: 20 } }]);
  t.point({ x: 0, y: 0 });
  await t.step(10_100);
  assert.deepEqual(controls(), []);
  w.stop();
});
