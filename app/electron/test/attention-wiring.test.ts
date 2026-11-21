// The attention sampler wired as index.ts wires it (src/main/attention/shell.ts): a fake platform helper in Node under
// HelperSupervisor answers `attention.sample`; once it has said hello and agentd runs, each beat reaches a local fake agentd's
// POST /context/attention. Nothing here samples the real system.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PLUGINS, shellPlan } from '../src/common/plugins.ts';
import { AgentdClient } from '../src/main/agentd/client.ts';
import { shellAttention } from '../src/main/attention/shell.ts';
import { HelperSupervisor } from '../src/main/helper/supervisor.ts';

/** TextEdit in front of one 1440×900 display. */
const FAKE = String.raw`
const fs = require('node:fs');
const [received] = process.argv.slice(2);
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, ...m }) + '\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let n = buffer.indexOf('\n'); n !== -1; n = buffer.indexOf('\n')) {
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    fs.appendFileSync(received, line + '\n');
    const { id, op, params } = JSON.parse(line);
    if (op === 'hello') {
      send({ id, ok: true, result: { protocol: 1, platform: 'macos', helper_version: 'fake', os_version: 'x', arch: 'arm64', pid: process.pid,
        ops: ['hello', 'cancel', 'shutdown', 'presence.watch', 'attention.sample', 'screens.list'], events: ['presence.edge'] } });
    } else if (op === 'presence.watch') {
      send({ id, ok: true, result: { watching: params.enabled } });
    } else if (op === 'attention.sample') {
      send({ id, ok: true, result: { ts: Date.now() / 1000, idle_s: 1, locked: false, secure_input: false,
        front: { pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit',
          window: { window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 }, title: 'notes.txt', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' } },
        mouse_window: null, focus_role: null, focus_native_role: null, focus_window_role: null, focus_window_native_role: null,
        focus_window_subrole: null, camera_active: false, mic_active: false, audio_clients: [], input_counters: null, input_idles: null,
        video_pids: [], front_gpu_busy: null, capture_indicator: false } });
    } else if (op === 'screens.list') {
      send({ id, ok: true, result: { screens: [{ display_id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 },
        visible: { x: 0, y: 25, width: 1440, height: 875 }, scale: 2, primary: true }] } });
    } else if (op === 'shutdown') {
      send({ id, ok: true, result: {} });
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !ok()) await new Promise((r) => setTimeout(r, 20));
  return ok();
}

const unused = { request: async () => { throw new Error('not reached'); } };
/** The plan with screen awareness on: the beats go to agentd. */
const AWARE = shellPlan({ ...DEFAULT_PLUGINS, screen_awareness: true });

test('--no-attention starts no sampler', () => {
  const options = { helper: { request: async () => ({ ok: false as const, error: { code: 'unused' } }) }, agentd: unused, agentdStateDir: '/nonexistent',
    settings: () => ({}), redact: true, plan: () => AWARE, ownPids: () => [], userSpeaking: () => null, log: () => {}, onSystemPaused: () => {} };
  assert.equal(shellAttention({ ...options, argv: ['electron', '.', '--config', 'c.json', '--no-push-to-talk', '--no-attention'] }), null);
  const sampler = shellAttention({ ...options, argv: ['electron', '.', '--config', 'c.json', '--no-push-to-talk'] });
  assert.notEqual(sampler, null);
  sampler!.agentd(false);
});

test('the helper says hello and agentd runs: beats POST /context/attention, with the saved sensing, the blacklist file and user_speaking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'att-'));
  const posts: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/context/attention') posts.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const state = join(dir, 'agentd');
  mkdirSync(state);
  writeFileSync(join(state, 'ui-runtime.json'), JSON.stringify({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ui_token: 'token' }));
  writeFileSync(join(state, 'blacklist.json'), JSON.stringify({ mode: 'deny' }));
  const script = join(dir, 'fake.cjs'), received = join(dir, 'received');
  writeFileSync(script, FAKE);
  const pauses: boolean[] = [];
  let sampler: ReturnType<typeof shellAttention> = null;
  const helper = new HelperSupervisor({ executable: process.execPath, prefix: [script, received], supportDir: join(dir, 's'),
    clientVersion: 'test', onStatus: (s) => sampler?.helper(s.kind === 'running'), onEvent: (e) => sampler?.event(e.event, e.data) });
  sampler = shellAttention({ argv: ['electron', '.'], helper, agentd: new AgentdClient(join(state, 'ui-runtime.json')), agentdStateDir: state,
    settings: () => ({ sense_input_counts: false }), redact: true, plan: () => AWARE, ownPids: () => [process.pid], userSpeaking: () => true, log: () => {},
    onSystemPaused: (p) => pauses.push(p) });
  const ops = () => readFileSync(received, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string; params: Record<string, unknown> });
  try {
    helper.start();
    assert.ok(await until(10, () => { try { return ops().some((m) => m.op === 'presence.watch'); } catch { return false; } }));
    sampler!.agentd(true);
    assert.ok(await until(5, () => posts.length >= 1));
    const front = posts[0]!.front as Record<string, unknown>;
    assert.equal(front.title, 'notes.txt');
    assert.equal(posts[0]!.user_speaking, true);
    assert.deepEqual(ops().find((m) => m.op === 'attention.sample')!.params, { include_titles: true, include_input: false, include_audio: true });
    writeFileSync(join(state, 'blacklist.json'), JSON.stringify({ mode: 'deny', bundle_ids: ['com.apple.TextEdit'] }));
    const before = posts.length;
    assert.ok(await until(5, () => posts.length > before));
    assert.ok(!JSON.stringify(posts.at(-1)).includes('notes.txt'), JSON.stringify(posts.at(-1)));
    assert.deepEqual(pauses, []);
  } finally {
    sampler!.agentd(false);
    await helper.stop();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('our own screen capture is not the user recording the screen: ownCaptureRecent reaches the sampler', async () => {
  const beat = async (ownCaptureRecent?: () => boolean) => {
    const posts: Record<string, unknown>[] = [];
    const helper = { request: async (op: string) => {
      if (op === 'attention.sample') {
        return { ok: true as const, result: { ts: Date.now() / 1000, idle_s: 1, locked: false, secure_input: false, front: null, mouse_window: null,
          camera_active: false, mic_active: false, capture_indicator: true } };
      }
      return op === 'presence.watch' ? { ok: true as const, result: { watching: true } } : { ok: false as const, error: { code: 'unsupported' } };
    } };
    const sampler = shellAttention({ argv: ['electron', '.'], helper, agentdStateDir: '/nonexistent', settings: () => ({}), redact: true, plan: () => AWARE,
      agentd: { request: async (_method, _path, json) => { posts.push(json as Record<string, unknown>); return { status: 200 }; } },
      ownPids: () => [], userSpeaking: () => null, log: () => {}, onSystemPaused: () => {}, ...(ownCaptureRecent && { ownCaptureRecent }) });
    sampler!.helper(true);
    sampler!.agentd(true);
    try {
      assert.ok(await until(5, () => posts.length >= 1));
    } finally {
      sampler!.agentd(false);
    }
    return posts[0]!.screen_captured;
  };
  assert.equal(await beat(), true);
  // Unknown is left out of the body.
  assert.equal(await beat(() => true), undefined);
});

test('without screen awareness the beats still sample for give-way and the surfaces, and none reaches agentd', async () => {
  const posts: unknown[] = [], samples: unknown[] = [];
  const helper = { request: async (op: string) => {
    if (op === 'attention.sample') {
      return { ok: true as const, result: { ts: Date.now() / 1000, idle_s: 1, locked: false, secure_input: false, front: null, mouse_window: null } };
    }
    return op === 'presence.watch' ? { ok: true as const, result: { watching: true } } : { ok: false as const, error: { code: 'unsupported' } };
  } };
  const sampler = shellAttention({ argv: ['electron', '.'], helper, agentdStateDir: '/nonexistent', settings: () => ({}), redact: true,
    plan: () => shellPlan(DEFAULT_PLUGINS), agentd: { request: async (_method, _path, json) => { posts.push(json); return { status: 200 }; } },
    ownPids: () => [], userSpeaking: () => null, log: () => {}, onSystemPaused: () => {}, onSample: (s) => samples.push(s) });
  sampler!.helper(true);
  sampler!.agentd(true);
  try {
    assert.ok(await until(5, () => samples.length >= 2));
  } finally {
    sampler!.agentd(false);
  }
  assert.deepEqual(posts, []);
});

test('the clicks near her reach the beat as `near_clicks_10s`; without the port it is left out', async () => {
  const beat = async (nearClicks?: () => number | null) => {
    const posts: Record<string, unknown>[] = [];
    const helper = { request: async (op: string) => {
      if (op === 'attention.sample') {
        return { ok: true as const, result: { ts: Date.now() / 1000, idle_s: 1, locked: false, secure_input: false, front: null, mouse_window: null,
          input_counters: { keys: 0, left_clicks: 3, right_clicks: 0, scrolls: 0, moves: 0 }, input_idles: { key: 9, pointer: 1, scroll: 9, click: 1 } } };
      }
      return op === 'presence.watch' ? { ok: true as const, result: { watching: true } } : { ok: false as const, error: { code: 'unsupported' } };
    } };
    const sampler = shellAttention({ argv: ['electron', '.'], helper, agentdStateDir: '/nonexistent', settings: () => ({}), redact: true, plan: () => AWARE,
      agentd: { request: async (_method, _path, json) => { posts.push(json as Record<string, unknown>); return { status: 200 }; } },
      ownPids: () => [], userSpeaking: () => null, log: () => {}, onSystemPaused: () => {}, ...(nearClicks && { nearClicks }) });
    sampler!.helper(true);
    sampler!.agentd(true);
    try {
      assert.ok(await until(5, () => posts.length >= 1));
    } finally {
      sampler!.agentd(false);
    }
    return (posts[0]!.input as Record<string, unknown>).near_clicks_10s;
  };
  assert.equal(await beat(() => 2), 2);
  assert.equal(await beat(), undefined);
});
