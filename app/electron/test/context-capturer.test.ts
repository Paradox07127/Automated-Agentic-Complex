// The screen context loop (src/main/context/): its request handling, automatic reads, failure
// reports and selection reads, on a fake platform helper, a fake agentd and a fake clock. Nothing here reads the real
// system's windows, screen or clipboard.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AttentionSample, type AttentionWindow, type BlacklistRules, parseBlacklist } from '../src/common/attention.ts';
import type { ShellPlatform } from '../src/common/config.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { type AgentdReply, type ContextPolicy, DEFAULT_CONTEXT_POLICY } from '../src/common/screen-context.ts';
import { NO_ANSWER, type UserAnswer } from '../src/main/attention/sampler.ts';
import { type ContextPorts, startContext } from '../src/main/context/capturer.ts';

// Deny mode with no rules: every window but our own is read.
const NO_RULES = parseBlacklist({ mode: 'deny' });

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);

const win = (over: Partial<AttentionWindow> = {}): AttentionWindow => ({
  app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null, ...over,
});

function sample(over: Partial<AttentionSample> = {}): AttentionSample {
  return {
    ts: 0, front: win(), frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null,
    secureInput: false, fullscreen: false, cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null,
    frontAudioOut: null, frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null, ...over,
  };
}

/** CONTRACT §7.12 `window`s as `windows.list` with `include_titles` gives them. */
const TEXTEDIT = { window_id: 640, pid: 702, bounds: { x: 0, y: 25, width: 800, height: 600 }, layer: 0, alpha: 1, title: 'notes.txt',
  app_name: 'TextEdit', app_id: 'com.apple.TextEdit' };
const NOTES = { window_id: 77, pid: 800, bounds: { x: 40, y: 60, width: 900, height: 700 }, layer: 0, alpha: 1, title: 'Groceries',
  app_name: 'Notes', app_id: 'com.apple.Notes' };
const list = (...windows: Record<string, unknown>[]) => ok({ windows });
/** CONTRACT §7.12 `front` as `attention.sample` gives it. */
const TEXTEDIT_FRONT = { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit', window: TEXTEDIT };

/** CONTRACT §7.4 `ax.window_text`. */
const axText = (text: string, over: Record<string, unknown> = {}) => ok({
  snapshot_id: 'snap', matched: true, text,
  nodes: [{ id: 0, parent: -1, role: 'AXStaticText', native_role: 'AXStaticText', value: text, bounds: { x: 1, y: 2, width: 300, height: 20 } }],
  coverage: { status: 'complete', scope: 'visible_window', reasons: [], captured_nodes: 1, captured_chars: [...text].length, next_cursor: null },
  ...over,
});

const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

const TEXT_ON: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY, allowText: true };
const ALL_ON: ContextPolicy = { allowText: true, allowImages: true, level: 'window', redact: true };
const WINDOW_TEXT: ContextPolicy = { ...TEXT_ON, level: 'window' };

function setup(o: { helper?: Record<string, Answer>; policy?: ContextPolicy; blacklist?: BlacklistRules;
  post?: (path: string, body: Record<string, unknown>) => AgentdReply; platform?: ShellPlatform } = {}) {
  let clock = 1_763_539_200_000;
  let tickFn: (() => void) | null = null;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const state = { policy: o.policy ?? TEXT_ON, user: NO_ANSWER as UserAnswer };
  const requests: [string, Record<string, unknown>][] = [];
  const posts: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  const helper: Record<string, Answer> = {
    'windows.list': list(TEXTEDIT, NOTES),
    'attention.sample': ok({ ts: 0, locked: false, secure_input: false, front: TEXTEDIT_FRONT }),
    'permissions.status': ok({ accessibility: 'granted', screenRecording: 'granted', microphone: 'denied', automation: 'notDetermined',
      inputMonitoring: 'denied' }),
    'ax.window_text': axText('hello'),
    'ax.focused': ok({ focus: { pid: 702, role: 'AXTextArea', native_role: 'AXTextArea', subrole: null,
      frame: { x: 0, y: 0, width: 10, height: 10 }, caret: null, editable: true, element_key: 'k1' } }),
    'ax.watch': (p) => ok({ watching: p.pid !== null, pid: p.pid, watch_id: p.watch_id }),
    'capture.window': ok({ image: { format: 'jpeg', width: 800, height: 600, data: 'SlBFRw==' }, scale: 2 }),
    'ocr.recognize': ok({ text: 'seen', languages: ['zh-Hans', 'en-US'],
      lines: [{ text: 'seen', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, confidence: 1 }] }),
    ...o.helper,
  };
  const ports: ContextPorts = {
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = helper[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    post: async (path, body) => {
      posts.push([path, body]);
      if (o.post) return o.post(path, body);
      if (path === '/context/text') return { status: 202, body: { accepted: true } };
      if (path === '/context/image') return { status: 'error' in body ? 200 : 202, body: {} };
      if (path === '/look') return { status: 202, body: { request_id: 'look-1' } };
      return { status: 200, body: {} };
    },
    blacklist: () => o.blacklist ?? NO_RULES,
    policy: () => state.policy,
    user: () => state.user,
    ownPids: () => [4000, 4001],
    newId: () => 'ocr-snap',
    now: () => clock,
    every: (_ms, fn) => {
      tickFn = fn;
      return () => { tickFn = null; };
    },
    after: (ms, fn) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
    log: (line) => logs.push(line),
  };
  const c = startContext(ports, o.platform ?? 'mac');
  return {
    c, requests, posts, logs, helper, state,
    ops: () => requests.map(([op]) => op),
    tick: async () => { tickFn?.(); await settle(); },
    ticking: () => tickFn !== null,
    /** One attention beat, then whatever it unblocked. */
    beat: async (s: AttentionSample = sample()) => { c.update(s); await settle(); },
    advance: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => x.live && x.at <= clock)) {
        t.live = false;
        t.fn();
      }
      await settle();
    },
    request: async (mode: string, windowId = 640, reason = 'judge', id = 'r1') => {
      c.feed({ event: 'request', data: JSON.stringify({ seq: 1, request_id: id, window_id: windowId, mode, reason }) });
      await settle();
    },
  };
}

/** A started capturer with one beat in. */
async function running(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  s.c.start();
  await s.beat();
  return s;
}

const textPosts = (posts: [string, Record<string, unknown>][]) => posts.filter(([p]) => p === '/context/text').map(([, b]) => b);
const imagePosts = (posts: [string, Record<string, unknown>][]) => posts.filter(([p]) => p === '/context/image').map(([, b]) => b);

// ---- text requests

test('text request for the front window: AX text, checked again at the next beats, posted with the request id', async () => {
  const s = await running();
  await s.request('text');
  assert.deepEqual(s.requests.find(([op]) => op === 'ax.window_text')?.[1], { pid: 702, level: 'focused' });
  assert.equal(textPosts(s.posts).length, 0, 'waits for the beat after the read');
  await s.beat();
  await s.beat();
  const [body] = textPosts(s.posts);
  assert.equal(body?.request_id, 'r1');
  assert.equal(body?.source, 'ax');
  assert.equal(body?.text, 'hello');
  assert.equal(body?.window_id, 640);
  assert.ok(s.logs.includes('CAPTURE request id=r1 mode=text result=accepted'));
});

test('text request: a blacklisted window is not read', async () => {
  const s = await running({ blacklist: parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }) });
  await s.request('text');
  assert.ok(!s.ops().includes('ax.window_text'));
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=blacklisted'));
  assert.equal(s.posts.length, 0);
});

test('text request: secure input blocks the read', async () => {
  const s = await running({ helper: { 'attention.sample': ok({ ts: 0, locked: false, secure_input: true, front: null }) } });
  await s.request('text');
  assert.ok(!s.ops().includes('ax.window_text'));
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=secure_input'));
});

test('image request: a browser window never seen in front is blocked as browser_unknown', async () => {
  const chrome = { ...NOTES, app_name: 'Google Chrome', app_id: 'com.google.Chrome' };
  const s = await running({ policy: ALL_ON, helper: { 'windows.list': list(TEXTEDIT, chrome) } });
  await s.request('image', 77);
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=browser_unknown'));
  assert.ok(!s.ops().includes('capture.window'));
});

test('text request: our own window is never read', async () => {
  const own = { ...NOTES, pid: 4000, app_name: 'Agentic Complex', app_id: 'local.agenticcomplex.electron' };
  const s = await running({ policy: ALL_ON, helper: { 'windows.list': list(TEXTEDIT, own) } });
  await s.request('ocr', 77);
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=blacklisted'));
  assert.ok(!s.ops().includes('ocr.recognize'));
});

test('text request: not the front window and no OCR consent is refused, never broadened', async () => {
  const s = await running();
  await s.request('text', 77);
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=ax_unavailable'));
  assert.ok(!s.ops().includes('ax.window_text'));
  assert.ok(!s.ops().includes('ocr.recognize'));
});

test('text request: without the Accessibility permission, OCR answers when consent allows it', async () => {
  const s = await running({ policy: ALL_ON, helper: { 'permissions.status': ok({ accessibility: 'denied' }) } });
  await s.request('text');
  assert.deepEqual(s.requests.find(([op]) => op === 'ocr.recognize')?.[1], { window_id: 640 });
  const [body] = textPosts(s.posts);
  assert.equal(body?.source, 'ocr');
  assert.equal(body?.request_id, 'r1');
  assert.deepEqual(body?.coverage, { status: 'partial', scope: 'window_image_ocr_normalized_bottom_left',
    reasons: ['ocr_can_miss_visual_content'], captured_nodes: 1, captured_chars: 4 });
});

test('text request: an AX read that fails or times out is logged, nothing is sent', async () => {
  const s = await running({ helper: { 'ax.window_text': err('helper_timeout') } });
  await s.request('text');
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=ax_empty'));
  await s.beat();
  assert.equal(s.posts.length, 0);
});

test('text request: the front window changed during the read drops the text', async () => {
  const s = await running();
  await s.request('text');
  await s.beat(sample({ front: win({ windowId: 641, title: 'other.txt' }) }));
  assert.ok(s.logs.includes('CAPTURE text_dropped id=r1 window=640 reason=window_changed'));
  await s.beat();
  assert.equal(textPosts(s.posts).length, 0);
});

test('text request: the window became blacklisted before the send drops the text', async () => {
  const s = await running({ blacklist: parseBlacklist({ mode: 'deny', title_patterns: ['^Private'] }) });
  await s.request('text');
  await s.beat();
  await s.beat(sample({ front: win({ title: 'Private notes' }) }));
  assert.ok(s.logs.includes('CAPTURE text_dropped id=r1 window=640 reason=window_changed'));
  assert.equal(textPosts(s.posts).length, 0);
});

test('text request: no beat after the read (locked or stopped) drops the text', async () => {
  const s = await running();
  await s.request('text');
  await s.advance(3000);
  await s.beat();
  assert.equal(textPosts(s.posts).length, 0);
});

test('text request: a locked or asleep beat after the read drops the text', async () => {
  for (const over of [{ locked: true }, { asleep: true }]) {
    const s = await running();
    await s.request('text');
    await s.beat(sample(over));
    await s.beat();
    await s.beat();
    assert.equal(textPosts(s.posts).length, 0);
  }
});

test('text request: stop while the read waits for its beat drops the text', async () => {
  const s = await running();
  await s.request('text');
  await s.beat();
  s.c.stop();
  await s.beat();
  await s.beat();
  assert.equal(textPosts(s.posts).length, 0);
});

test('text request: consent revoked during the read drops the text and asks agentd to forget window text', async () => {
  const s = await running();
  s.helper['ax.window_text'] = async () => {
    s.state.policy = DEFAULT_CONTEXT_POLICY;
    return axText('hello');
  };
  await s.request('text');
  s.c.update(sample());
  await settle();
  await s.beat();
  await s.beat();
  assert.equal(textPosts(s.posts).length, 0);
  await s.request('text', 640, 'judge', 'r2');
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r2 reason=local_policy'));
  assert.deepEqual(s.posts.find(([p]) => p === '/context/privacy/sync')?.[1], { revoke: ['window_text'] });
});

test('requests: only between start and stop', async () => {
  const s = setup();
  await s.request('text');
  assert.equal(s.requests.length, 0);
  s.c.start();
  s.c.stop();
  await s.request('text');
  assert.ok(!s.ops().includes('windows.list'));
});

test('requests: one read at a time', async () => {
  let release!: (a: HelperAnswer) => void;
  const s = await running({ helper: { 'ax.window_text': () => new Promise<HelperAnswer>((r) => { release = r; }) } });
  await s.request('text');
  await s.request('text', 640, 'judge', 'r2');
  assert.ok(s.logs.includes('CAPTURE request_dropped id=r2 reason=read_busy'));
  release(axText('x'));
  await settle();
});

test('requests: an unknown mode is dropped', async () => {
  const s = await running({ policy: ALL_ON });
  await s.request('video');
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=local_policy'));
  assert.equal(s.posts.length, 0);
});

test('helper not running: a text request is dropped, an image request reports window_gone', async () => {
  const gone = () => err('helper_exited');
  const s = await running({ policy: ALL_ON, helper: { 'windows.list': gone, 'attention.sample': gone, 'permissions.status': gone } });
  await s.request('text');
  assert.ok(s.logs.includes('CAPTURE request_dropped id=r1 reason=no_window'));
  await s.request('image', 640, 'judge', 'r2');
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r2', window_id: 640, url_host: null, error: 'window_gone' }]);
});

// ---- image requests

test('image request: the window as JPEG, our own capture marked while it runs, posted with the url host', async () => {
  let duringCapture: boolean | null = null;
  const s = await running({ policy: ALL_ON });
  s.helper['capture.window'] = () => {
    duringCapture = s.c.ownCaptureRecent();
    return ok({ image: { format: 'jpeg', width: 800, height: 600, data: 'SlBFRw==' }, scale: 2 });
  };
  await s.request('image');
  assert.deepEqual(s.requests.find(([op]) => op === 'capture.window')?.[1], { window_id: 640, format: 'jpeg', max_long_side: 1280 });
  assert.equal(duringCapture, true);
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, jpeg_base64: 'SlBFRw==' }]);
  assert.equal(s.c.ownCaptureRecent(), true, 'for 3 s after');
  await s.advance(3000);
  assert.equal(s.c.ownCaptureRecent(), false);
});

test('image request: screenshots off reports permission_denied without capturing', async () => {
  const s = await running({ policy: TEXT_ON });
  await s.request('image');
  assert.ok(!s.ops().includes('capture.window'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, error: 'permission_denied' }]);
});

test('image request: a blocked window reports permission_denied without capturing or its url host', async () => {
  const s = await running({ policy: ALL_ON, blacklist: parseBlacklist({ mode: 'deny', domains: ['bank.com'] }) });
  await s.beat(sample({ front: win({ urlHost: 'bank.com' }) }));
  await s.request('image');
  assert.ok(!s.ops().includes('capture.window'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, error: 'permission_denied' }]);
});

test('image request: a window not on screen reports window_gone', async () => {
  const s = await running({ policy: ALL_ON });
  await s.request('image', 999);
  assert.ok(s.logs.includes('CAPTURE request_dropped id=r1 reason=no_window'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 999, url_host: null, error: 'window_gone' }]);
});

test('image request: capture errors and a helper timeout are reported as agentd failures', async () => {
  for (const [code, failure] of [['permission_denied', 'permission_denied'], ['window_gone', 'window_gone'],
    ['too_large', 'capture_failed'], ['helper_timeout', 'capture_failed']]) {
    const s = await running({ policy: ALL_ON, helper: { 'capture.window': err(code!) } });
    await s.request('image');
    assert.ok(s.logs.includes(`CAPTURE request_failed id=r1 mode=image error=${code}`));
    assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, error: failure }]);
    assert.equal(s.c.ownCaptureRecent(), true);
  }
});

test('image request: a background browser window reads as unknown, whatever it showed while in front', async () => {
  const chrome = { window_id: 90, pid: 900, bounds: { x: 0, y: 25, width: 800, height: 600 }, layer: 0, alpha: 1, title: 'Docs',
    app_name: 'Google Chrome', app_id: 'com.google.Chrome' };
  const s = await running({ policy: ALL_ON, helper: { 'windows.list': list(TEXTEDIT, chrome) } });
  await s.beat(sample({ front: win({ app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 900, windowId: 90, title: 'Docs',
    urlHost: 'allowed.com' }) }));
  await s.tick();
  await s.beat();
  await s.beat();
  await s.request('image', 90);
  assert.ok(!s.ops().includes('capture.window'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 90, url_host: null, error: 'permission_denied' }]);
});

test('image request: the window changed after the capture is reported, the image is not sent', async () => {
  let calls = 0;
  const s = await running({ policy: ALL_ON, helper: { 'windows.list': () => (calls++ === 0 ? list(TEXTEDIT) : list({ ...TEXTEDIT, pid: 703 })) } });
  await s.request('image');
  assert.ok(s.logs.includes('CAPTURE image_dropped id=r1 reason=window_gone'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, error: 'window_gone' }]);
});

// ---- OCR requests

test('ocr request: the helper recognizes the window and the text is posted redacted, source ocr', async () => {
  const s = await running({ policy: ALL_ON, helper: { 'ocr.recognize': ok({ text: 'mail a@b.com', languages: ['en-US'],
    lines: [{ text: 'mail a@b.com', bounds: { x: 0, y: 0, width: 1, height: 0.5 } }] }) } });
  await s.request('ocr');
  const [body] = textPosts(s.posts);
  assert.equal(body?.text, 'mail [邮箱已遮蔽]');
  assert.equal(body?.snapshot_id, 'ocr-snap');
  assert.deepEqual(body?.nodes, [{ id: 0, parent: -1, role: 'OCRText', value: 'mail [邮箱已遮蔽]', bounds: [0, 0.5, 1, 0.5] }]);
  assert.ok(!JSON.stringify(textPosts(s.posts)).includes('a@b.com'));
});

test('ocr request: not allowed below the window level; a helper failure is only logged', async () => {
  const s = await running({ policy: { ...ALL_ON, level: 'focused' } });
  await s.request('ocr');
  assert.ok(s.logs.includes('CAPTURE request_blocked id=r1 reason=local_policy'));
  const t = await running({ policy: ALL_ON, helper: { 'ocr.recognize': err('ocr_unavailable') } });
  await t.request('ocr');
  assert.ok(t.logs.includes('CAPTURE request_failed id=r1 mode=ocr error=ocr_unavailable'));
  assert.equal(t.posts.length, 0);
});

// ---- look_window text requests

test('look_window: the named window’s AX text by its bounds, front or not', async () => {
  const s = await running({ policy: WINDOW_TEXT });
  await s.request('text', 77, 'look_window');
  assert.deepEqual(s.requests.find(([op]) => op === 'ax.window_text')?.[1],
    { pid: 800, level: 'window', window_bounds: { x: 40, y: 60, width: 900, height: 700 } });
  const [body] = textPosts(s.posts);
  assert.equal(body?.request_id, 'r1');
  assert.equal(body?.window_id, 77);
  assert.equal(body?.app, 'Notes');
});

test('look_window: at the focused level only the front window is read, and only its focused part', async () => {
  const s = await running();
  await s.request('text', 77, 'look_window');
  assert.ok(!s.ops().includes('ax.window_text'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 77, url_host: null, error: 'permission_denied' }]);
  const t = await running();
  await t.request('text', 640, 'look_window');
  assert.deepEqual(t.requests.find(([op]) => op === 'ax.window_text')?.[1],
    { pid: 702, level: 'focused', window_bounds: { x: 0, y: 25, width: 800, height: 600 } });
  assert.equal(textPosts(t.posts)[0]?.request_id, 'r1');
});

test('look_window: a window listed without its title is refused while a title rule exists', async () => {
  const s = await running({ policy: WINDOW_TEXT, blacklist: parseBlacklist({ mode: 'deny', title_patterns: ['^Private'] }),
    helper: { 'windows.list': list(TEXTEDIT, { ...NOTES, title: null }) } });
  await s.request('text', 77, 'look_window');
  assert.ok(!s.ops().includes('ax.window_text'));
  assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 77, url_host: null, error: 'permission_denied' }]);
});

test('look_window: every refusal is reported so agentd can ask for an image', async () => {
  const cases: [Parameters<typeof setup>[0], string][] = [
    [{ helper: { 'windows.list': list(TEXTEDIT) } }, 'window_gone'],
    [{ policy: DEFAULT_CONTEXT_POLICY }, 'permission_denied'],
    [{ blacklist: parseBlacklist({ mode: 'deny', app_names: ['notes'] }) }, 'permission_denied'],
    [{ helper: { 'permissions.status': ok({ accessibility: 'denied' }) } }, 'ax_unavailable'],
    [{ helper: { 'ax.window_text': axText('', { matched: false }) } }, 'ax_unavailable'],
    [{ helper: { 'ax.window_text': err('helper_timeout') } }, 'ax_unavailable'],
    [{ helper: { 'ax.window_text': axText('  \n') } }, 'ax_empty'],
  ];
  for (const [o, failure] of cases) {
    const s = await running({ policy: WINDOW_TEXT, ...o });
    await s.request('text', 77, 'look_window');
    assert.ok(s.logs.includes(`CAPTURE request_blocked id=r1 reason=${failure}`), failure);
    assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 77, url_host: null, error: failure }], failure);
    assert.equal(textPosts(s.posts).length, 0);
  }
});

// ---- automatic reads

test('automatic: the front app is watched under watch_id context and its text posted without a request id', async () => {
  const s = await running();
  await s.tick();
  assert.deepEqual(s.requests.find(([op]) => op === 'ax.watch')?.[1], { watch_id: 'context', pid: 702, notifications: ['value', 'title', 'focus'] });
  await s.beat();
  await s.beat();
  const [body] = textPosts(s.posts);
  assert.equal(body?.request_id, null);
  assert.equal(body?.source, 'ax');
  assert.ok(s.logs.includes('CAPTURE text window=640 source=ax chars=5 result=accepted'));
});

test('automatic: the same text is not posted again, re-reads back off', async () => {
  const s = await running();
  await s.tick();
  await s.beat();
  await s.beat();
  await s.advance(1000);
  await s.tick();
  assert.equal(s.ops().filter((op) => op === 'ax.window_text').length, 1, 'no read before 5 s');
  await s.advance(5000);
  await s.tick();
  await s.beat();
  await s.beat();
  assert.equal(s.ops().filter((op) => op === 'ax.window_text').length, 2);
  assert.equal(textPosts(s.posts).length, 1, 'unchanged text is not sent twice');
});

test('automatic: an AX notification of the context watch asks for a read', async () => {
  const s = await running();
  await s.tick();
  await s.beat();
  await s.beat();
  await s.advance(5000);
  await s.tick();
  await s.beat();
  await s.beat();
  const reads = () => s.ops().filter((op) => op === 'ax.window_text').length;
  assert.equal(reads(), 2);
  s.c.event('ax.notification', { watch_id: 'activity', pid: 702, notification: 'value' });
  await s.advance(5000);
  await s.tick();
  assert.equal(reads(), 2, 'another watch’s notification and a backoff of 10 s');
  s.c.event('ax.notification', { watch_id: 'context', pid: 702, notification: 'value' });
  await s.advance(2000);
  await s.tick();
  assert.equal(reads(), 3);
});

test('automatic: no reads while agentd\'s answer says the user is away; the absence ending reads at once', async () => {
  const s = await running();
  const reads = () => s.ops().filter((op) => op === 'ax.window_text').length;
  await s.tick();
  await s.beat();
  await s.beat();
  assert.equal(reads(), 1);
  s.state.user = { ...NO_ANSWER, presence: 'away', stage: 'offstage', absence: { id: '1795280400000-1', since: 0 } };
  await s.advance(60_000);
  await s.tick();
  assert.equal(reads(), 1, 'away');
  s.state.user = NO_ANSWER;
  await s.advance(1000);
  await s.tick();
  assert.equal(reads(), 2, 'back');
  // The sample's own idle seconds are no absence.
  await s.beat(sample({ idleSeconds: 600 }));
  await s.advance(5000);
  await s.tick();
  assert.equal(reads(), 3);
});

test('automatic: nothing without window text consent, locked, or for a blocked front window', async () => {
  for (const [o, s0] of [
    [{ policy: DEFAULT_CONTEXT_POLICY }, sample()],
    [{ policy: { ...TEXT_ON, level: 'status' as const } }, sample()],
    [{}, sample({ locked: true })],
    [{}, sample({ secureInput: true })],
    [{}, sample({ frontIncognito: null })],
    [{ blacklist: parseBlacklist({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }) }, sample()],
  ] as [Parameters<typeof setup>[0], AttentionSample][]) {
    const s = setup(o);
    s.c.start();
    await s.beat(s0);
    await s.tick();
    await s.beat(s0);
    await s.beat(s0);
    assert.ok(!s.ops().includes('ax.window_text'));
    assert.ok(!s.requests.some(([op, p]) => op === 'ax.watch' && p.pid !== null));
    assert.equal(s.posts.filter(([p]) => p === '/context/text').length, 0);
  }
});

test('automatic: without the Accessibility permission nothing is read', async () => {
  const s = await running({ helper: { 'ax.focused': err('permission_denied') } });
  await s.tick();
  assert.ok(!s.ops().includes('ax.window_text'));
});

test('automatic: stop ends the watch and the ticks', async () => {
  const s = await running();
  await s.tick();
  s.c.stop();
  await settle();
  assert.deepEqual(s.requests.at(-1), ['ax.watch', { watch_id: 'context', pid: null, notifications: [] }]);
  assert.equal(s.ticking(), false);
});

// ---- look and selection

test('look: POST /look with the front title', async () => {
  const s = await running();
  assert.deepEqual(await s.c.look(), { title: 'notes.txt', result: { kind: 'requested', requestId: 'look-1' } });
  assert.deepEqual(s.posts.at(-1), ['/look', {}]);
});

test('selection: the selected text of the front app, else the first clipboard item', async () => {
  const s = await running({ helper: { 'ax.selected_text': ok({ text: 'picked' }) } });
  assert.deepEqual(await s.c.readSelection(),
    { decision: { kind: 'read', read: { source: 'selection', text: 'picked', truncated: false } }, app: 'TextEdit' });
  assert.deepEqual(s.requests.find(([op]) => op === 'ax.selected_text')?.[1], { pid: 702 });
  assert.ok(!s.ops().includes('clipboard.read'));
  s.helper['ax.selected_text'] = ok({ text: null });
  s.helper['clipboard.read'] = ok({ items: [{ types: ['public.utf8-plain-text'], text: 'copied' }], concealed: false, truncated: false });
  assert.deepEqual((await s.c.readSelection()).decision, { kind: 'read', read: { source: 'clipboard', text: 'copied', truncated: false } });
  assert.deepEqual(s.requests.find(([op]) => op === 'clipboard.read')?.[1], { first_only: true });
  assert.ok(s.logs.includes('SELECTION read source=clipboard chars=6 truncated=false'));
});

test('selection: secure input, incognito and the blacklist refuse before reading the selection or the clipboard', async () => {
  const cases: [Parameters<typeof setup>[0], AttentionSample, string][] = [
    [{ helper: { 'attention.sample': ok({ secure_input: true }) } }, sample(), '安全输入中，没有读取'],
    [{}, sample({ frontIncognito: true }), '无痕窗口，没有读取'],
    [{ blacklist: parseBlacklist({ mode: 'deny', app_names: ['TextEdit'] }) }, sample(), '这个窗口在黑名单里，没有读取'],
    [{ helper: { 'attention.sample': ok({ secure_input: false, front: null }) } }, sample({ front: null }), '没找到前台窗口，没有读取'],
  ];
  for (const [o, s0, message] of cases) {
    const s = setup(o);
    await s.beat(s0);
    assert.deepEqual((await s.c.readSelection()).decision, { kind: 'refused', message });
    assert.ok(!s.ops().includes('ax.selected_text') && !s.ops().includes('clipboard.read'));
  }
});

const CHROME_FRONT = (windowId: number) => ({ pid: 900, name: 'Google Chrome', app_id: 'com.google.Chrome',
  window: { window_id: windowId, pid: 900, bounds: { x: 0, y: 25, width: 800, height: 600 }, title: null, app_name: 'Google Chrome',
    app_id: 'com.google.Chrome' } });
const chromeWindow = (windowId: number) => win({ app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 900, windowId, title: null,
  urlHost: 'example.com' });

test('selection: the window in front when the hotkey is pressed decides, not the last beat', async () => {
  const s = setup({ helper: { 'attention.sample': ok({ secure_input: false, front: CHROME_FRONT(91) }),
    'ax.selected_text': ok({ text: 'secret' }), 'clipboard.read': ok({ items: [{ types: ['public.utf8-plain-text'], text: 'copied' }] }) } });
  await s.beat(sample({ front: chromeWindow(90), frontIncognito: false }));
  const pending = s.c.readSelection();
  await settle();
  await s.beat(sample({ front: chromeWindow(91), frontIncognito: true }));
  assert.deepEqual((await pending).decision, { kind: 'refused', message: '无痕窗口，没有读取' });
  assert.ok(!s.ops().includes('ax.selected_text') && !s.ops().includes('clipboard.read'));
  const t = setup({ helper: { 'attention.sample': ok({ secure_input: false, front: CHROME_FRONT(91) }) } });
  await t.beat(sample({ front: chromeWindow(90), frontIncognito: false }));
  const unconfirmed = t.c.readSelection();
  await settle();
  await t.advance(2500);
  assert.equal((await unconfirmed).decision.kind, 'refused');
  assert.ok(!t.ops().includes('ax.selected_text') && !t.ops().includes('clipboard.read'));
});

test('selection: the front window is checked again before the clipboard is read', async () => {
  const s = setup({ helper: { 'clipboard.read': ok({ items: [{ types: ['public.utf8-plain-text'], text: 'copied' }] }) } });
  s.helper['ax.selected_text'] = () => {
    s.helper['attention.sample'] = ok({ secure_input: true, front: TEXTEDIT_FRONT });
    return ok({ text: null });
  };
  await s.beat();
  assert.deepEqual((await s.c.readSelection()).decision, { kind: 'refused', message: '安全输入中，没有读取' });
  assert.ok(!s.ops().includes('clipboard.read'));
});
