// The screen context capturer wired as index.ts wires it (src/main/context/shell.ts): a fake platform helper, a fake agentd
// client, fake feed events and a fake clock. Nothing here reads the real system's windows, screen or clipboard.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AttentionSample } from '../src/common/attention.ts';
import { DEFAULT_PLUGINS, shellPlan } from '../src/common/plugins.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import { NO_ANSWER, type UserAnswer } from '../src/main/attention/sampler.ts';
import { shellAttention } from '../src/main/attention/shell.ts';
import { agentdLook, anyOwnCapture, shellContext } from '../src/main/context/shell.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
const err = (code: string): HelperAnswer => ({ ok: false, error: { code } });
type Answer = HelperAnswer | ((params: Record<string, unknown>) => HelperAnswer | Promise<HelperAnswer>);

const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };

/** TextEdit's window 640 in front. */
function sample(): AttentionSample {
  return {
    ts: 0, front: { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 702, windowId: 640, title: 'notes.txt', urlHost: null },
    frontIncognito: false, mouse: null, idleSeconds: 0, locked: false, asleep: false, focusRole: null, secureInput: false, fullscreen: false,
    cameraActive: null, micActive: null, userSpeaking: null, focusWindow: null, input: null, micApps: null, frontAudioOut: null,
    frontVideo: null, frontGpu: null, screenCaptured: null, edge: null, frontBounds: null,
  };
}

const TEXTEDIT = { window_id: 640, pid: 702, bounds: { x: 0, y: 25, width: 800, height: 600 }, layer: 0, alpha: 1, title: 'notes.txt',
  app_name: 'TextEdit', app_id: 'com.apple.TextEdit' };

function setup(o: { argv?: string[]; settings?: Record<string, unknown>; helper?: Record<string, Answer>;
  agentd?: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-'));
  writeFileSync(join(dir, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
  let clock = 1_763_539_200_000;
  let tickFn: (() => void) | null = null;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const state = { settings: o.settings ?? { share_window_text: true, share_screenshots: true },
    attention: null as { user: UserAnswer } | null };
  const requests: [string, Record<string, unknown>][] = [];
  const posts: [string, Record<string, unknown>][] = [];
  const logs: string[] = [];
  const answers: Record<string, Answer> = {
    'windows.list': ok({ windows: [TEXTEDIT] }),
    'attention.sample': ok({ ts: 0, locked: false, secure_input: false, front: null }),
    'permissions.status': ok({ accessibility: 'granted' }),
    'ax.focused': ok({ focus: { pid: 702, role: 'AXTextArea', element_key: 'k1' } }),
    'ax.watch': (p) => ok({ watching: p.pid !== null, pid: p.pid, watch_id: p.watch_id }),
    'ax.window_text': ok({ snapshot_id: 'snap', matched: true, text: 'hello',
      nodes: [{ id: 0, parent: -1, role: 'AXStaticText', native_role: 'AXStaticText', value: 'hello', bounds: { x: 1, y: 2, width: 300, height: 20 } }],
      coverage: { status: 'complete', scope: 'visible_window', reasons: [], captured_nodes: 1, captured_chars: 5, next_cursor: null } }),
    'capture.window': ok({ image: { format: 'jpeg', width: 800, height: 600, data: 'SlBFRw==' }, scale: 2 }),
    ...o.helper,
  };
  const context = shellContext({
    argv: o.argv ?? ['electron', '.'],
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        const a = answers[op];
        if (a === undefined) return err('unsupported');
        return typeof a === 'function' ? a(params) : a;
      },
    },
    agentd: {
      request: async (method, path, json) => {
        assert.equal(method, 'POST');
        const body = json as Record<string, unknown>;
        posts.push([path, body]);
        const r = o.agentd?.(path, body) ?? (path === '/context/image' ? { status: 'error' in body ? 200 : 202, body: {} }
          : path === '/context/text' ? { status: 202, body: { accepted: true } } : { status: 200, body: {} });
        return { status: r.status, body: Buffer.from(JSON.stringify(r.body)) };
      },
    },
    agentdStateDir: dir, settings: () => state.settings, ownPids: () => [4000], log: (line) => logs.push(line),
    attention: () => state.attention,
    clock: {
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
    },
  });
  return {
    context, dir, state, requests, posts, logs,
    ops: () => requests.map(([op]) => op),
    ticking: () => tickFn !== null,
    tick: async () => { tickFn?.(); await settle(); },
    beat: async () => { context?.sampled(sample()); await settle(); },
    advance: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((x) => x.live && x.at <= clock)) {
        t.live = false;
        t.fn();
      }
      await settle();
    },
    request: async (mode: string, id = 'r1') => {
      context?.feed({ event: 'request', data: JSON.stringify({ seq: 1, request_id: id, window_id: 640, mode, reason: 'judge' }) });
      await settle();
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const imagePosts = (posts: [string, Record<string, unknown>][]) => posts.filter(([p]) => p === '/context/image').map(([, b]) => b);

test('--no-attention starts no capturer', () => {
  const s = setup({ argv: ['electron', '.', '--config', 'c.json', '--no-push-to-talk', '--no-attention'] });
  assert.equal(s.context, null);
  s.done();
  const t = setup({ argv: ['electron', '.', '--config', 'c.json', '--no-push-to-talk'] });
  assert.notEqual(t.context, null);
  t.done();
});

test('ports: a feed request is answered through agentd\'s POST, under config.json\'s policy and the blacklist file', async () => {
  const s = setup();
  try {
    s.context!.agentd(true);
    await s.beat();
    await s.request('image', 'r1');
    assert.deepEqual(imagePosts(s.posts), [{ request_id: 'r1', window_id: 640, url_host: null, jpeg_base64: 'SlBFRw==' }]);
    writeFileSync(join(s.dir, 'blacklist.json'), JSON.stringify({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }));
    await s.request('image', 'r2');
    assert.deepEqual(imagePosts(s.posts).at(-1), { request_id: 'r2', window_id: 640, url_host: null, error: 'permission_denied' });
    writeFileSync(join(s.dir, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
    s.state.settings = { share_window_text: true };
    await s.request('image', 'r3');
    assert.deepEqual(imagePosts(s.posts).at(-1), { request_id: 'r3', window_id: 640, url_host: null, error: 'permission_denied' });
    assert.ok(s.logs.includes('CAPTURE request_blocked id=r3 reason=local_policy'), s.logs.join('\n'));
    assert.equal(s.ops().filter((op) => op === 'capture.window').length, 1);
  } finally {
    s.context!.stop();
    s.done();
  }
});

test('agentd running starts it, stopped stops it: feed requests are answered only in between (AgentdReadyPlan .context(on:))', async () => {
  const s = setup();
  try {
    await s.request('image', 'before');
    assert.equal(s.ticking(), false);
    s.context!.agentd(true);
    assert.equal(s.ticking(), true);
    await s.request('image', 'running');
    s.context!.agentd(false);
    assert.equal(s.ticking(), false);
    await s.request('image', 'after');
    assert.deepEqual(imagePosts(s.posts).map((b) => b.request_id), ['running']);
    // A feed event that is not a request is not one.
    s.context!.agentd(true);
    s.context!.feed({ event: 'line', data: JSON.stringify({ seq: 1, request_id: 'x', window_id: 640, mode: 'image', reason: 'judge' }) });
    await settle();
    assert.equal(imagePosts(s.posts).length, 1);
  } finally {
    s.context!.stop();
    s.done();
  }
});

test('each attention sample, the helper\'s hello and its ax.notification events reach it; stop drops the watch', async () => {
  const s = setup({ settings: { share_window_text: true } });
  const watches = () => s.requests.filter(([op]) => op === 'ax.watch').map(([, p]) => p.pid);
  const reads = () => s.ops().filter((op) => op === 'ax.window_text').length;
  try {
    s.context!.agentd(true);
    await s.tick();
    assert.deepEqual(watches(), [], 'no sample, no front window');
    await s.beat();
    await s.tick();
    assert.deepEqual(watches(), [702]);
    // A new helper has no watches: the next tick asks again.
    s.context!.helper(true);
    await s.tick();
    assert.deepEqual(watches(), [702, 702]);
    await s.beat();
    await s.beat();
    await s.advance(5000);
    await s.tick();
    await s.beat();
    await s.beat();
    assert.equal(reads(), 2);
    s.context!.event('ax.notification', { watch_id: 'context', pid: 702, notification: 'value' });
    await s.advance(5000);
    await s.tick();
    assert.equal(reads(), 3, 'the notification asks for a read before the 10 s backoff');
    s.context!.stop();
    await settle();
    assert.deepEqual(watches().at(-1), null);
  } finally {
    s.context!.stop();
    s.done();
  }
});

test('the automatic reads follow the attention sampler\'s answer; without a sampler the user is present', async () => {
  const s = setup({ settings: { share_window_text: true } });
  const reads = () => s.ops().filter((op) => op === 'ax.window_text').length;
  try {
    s.state.attention = { user: { ...NO_ANSWER, presence: 'locked', stage: 'offstage', absence: { id: '1795280400000-1', since: 0 } } };
    s.context!.agentd(true);
    await s.beat();
    await s.tick();
    assert.equal(reads(), 1, 'the first read of the window');
    await s.beat();
    await s.advance(60_000);
    await s.tick();
    assert.equal(reads(), 1, 'locked');
    s.state.attention = null;
    await s.advance(1000);
    await s.tick();
    assert.equal(reads(), 2, 'no sampler: present, and the absence it saw is over');
  } finally {
    s.context!.stop();
    s.done();
  }
});

test('look: agentd\'s POST /look answer, as ContextCapturer.lookNow and the main window\'s look read it', async () => {
  const answers: Record<string, { status: number; body: unknown }> = {
    requested: { status: 202, body: { request_id: 'look-1' } },
    blocked: { status: 409, body: { error: 'blocked', reason: 'paused' } },
    rejected: { status: 503, body: { error: 'busy' } },
  };
  for (const [kind, answer] of Object.entries(answers)) {
    const s = setup({ agentd: (path) => (path === '/look' ? answer : { status: 200, body: {} }) });
    const result = await s.context!.look();
    assert.equal(result.kind, kind);
    assert.deepEqual(s.posts.at(-1), ['/look', {}]);
    s.done();
  }
  const s = setup({ agentd: () => answers.requested! });
  assert.deepEqual(await s.context!.look(), { kind: 'requested', requestId: 'look-1' });
  assert.ok(s.logs.includes('LOOK result=requested(look-1)'), s.logs.join('\n'));
  s.done();
  const unreachable = { request: async () => { throw new Error('ECONNREFUSED'); } };
  const lines: string[] = [];
  assert.deepEqual(await agentdLook(unreachable, (l) => lines.push(l))(), { kind: 'failed' });
  const main = agentdLook({ request: async () => ({ status: 202, body: Buffer.from('{"request_id":"look-2"}') }) }, (l) => lines.push(l));
  assert.deepEqual(await main(), { kind: 'requested', requestId: 'look-2' });
  assert.deepEqual(lines, ['web-main look: failed', 'web-main look: requested(look-2)']);
});

test('the attention sampler does not count a screenshot of the context capturer as the user recording the screen', async () => {
  let release = () => {};
  const shot = new Promise<HelperAnswer>((resolve) => {
    release = () => resolve(ok({ image: { format: 'jpeg', width: 800, height: 600, data: 'SlBFRw==' }, scale: 2 }));
  });
  const s = setup({ helper: { 'capture.window': () => shot } });
  const beat = async (recent: () => boolean) => {
    const posts: Record<string, unknown>[] = [];
    const helper = { request: async (op: string) => {
      if (op === 'attention.sample') {
        return { ok: true as const, result: { ts: Date.now() / 1000, idle_s: 1, locked: false, secure_input: false, front: null, mouse_window: null,
          camera_active: false, mic_active: false, capture_indicator: true } };
      }
      return op === 'presence.watch' ? { ok: true as const, result: { watching: true } } : { ok: false as const, error: { code: 'unsupported' } };
    } };
    const sampler = shellAttention({ argv: ['electron', '.'], helper, agentdStateDir: '/nonexistent', settings: () => ({}),
      plan: () => shellPlan({ ...DEFAULT_PLUGINS, screen_awareness: true }),
      agentd: { request: async (_method, path, json) => {
        if (path === '/context/attention') posts.push(json as Record<string, unknown>);
        return { status: 200, body: Buffer.from('{}') };
      } },
      ownPids: () => [], userSpeaking: () => null, log: () => {}, onSystemPaused: () => {}, ownCaptureRecent: recent });
    sampler!.helper(true);
    sampler!.agentd(true);
    try {
      const deadline = Date.now() + 5000;
      while (posts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    } finally {
      sampler!.agentd(false);
    }
    return posts[0]!.screen_captured;
  };
  try {
    s.context!.agentd(true);
    await s.beat();
    await s.request('image', 'r1');
    assert.equal(s.ops().at(-1), 'capture.window');
    // The ambient sampler has captured nothing; the context capturer's screenshot is in flight.
    const recent = anyOwnCapture(() => ({ ownCaptureRecent: false }), () => s.context);
    assert.equal(recent(), true);
    assert.equal(await beat(recent), undefined);
    assert.equal(await beat(anyOwnCapture(() => ({ ownCaptureRecent: true }), () => null)), undefined, 'the ambient sampler\'s still counts');
    assert.equal(await beat(anyOwnCapture(() => null, () => null)), true);
  } finally {
    release();
    s.context!.stop();
    s.done();
  }
});

test('readRegion: 框选给她看\'s read goes to the capturer with the blacklist file, before agentd runs', async () => {
  const s = setup({ settings: {}, helper: { 'windows.at_point': ok({ window: TEXTEDIT }) } });
  try {
    assert.deepEqual(await s.context!.readRegion({ x: 10, y: 30, width: 100, height: 40 }, [1]),
      { kind: 'read', text: 'hello', truncated: false, app: 'TextEdit' });
    writeFileSync(join(s.dir, 'blacklist.json'), JSON.stringify({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }));
    // On Windows a rewrite within one clock tick keeps the mtime the rules are cached by.
    utimesSync(join(s.dir, 'blacklist.json'), new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(await s.context!.readRegion({ x: 10, y: 30, width: 100, height: 40 }, [1]), { kind: 'refused', text: '这个窗口设了不读' });
  } finally {
    s.done();
  }
});
