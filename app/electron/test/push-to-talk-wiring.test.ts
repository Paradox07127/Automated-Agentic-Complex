// 按住说话 wired as index.ts wires it, end to end: a fake platform helper in Node under HelperSupervisor sends ptt.down,
// a partial and ptt.up; the transcript reaches a local fake agentd's POST /say, and the page's `voice.onPushToTalk`
// gets protocol.ts `PushToTalkState` values. No microphone, hot key or permission prompt is touched.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { PushSource } from '../src/common/push.ts';
import { PushToTalk, pushToTalkState } from '../src/common/push-to-talk.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { AgentdClient } from '../src/main/agentd/client.ts';
import { HelperSupervisor } from '../src/main/helper/supervisor.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(20);
  }
  return ok();
}

/** A helper with every grant whose user holds the key 0.4 s once it is registered and says 明天 下午三点 meanwhile. */
const FAKE = String.raw`
const fs = require('node:fs');
const [received] = process.argv.slice(2);
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, ...m }) + '\n');
let seq = 0;
const event = (name, data) => send({ event: name, seq: ++seq, data });
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
        ops: ['hello', 'cancel', 'shutdown', 'ptt.register', 'ptt.unregister', 'permissions.status', 'mic.start', 'mic.stop'],
        events: ['ptt.down', 'ptt.up', 'mic.level', 'speech.partial'] } });
    } else if (op === 'ptt.register') {
      send({ id, ok: true, result: { registered: true } });
      setTimeout(() => event('ptt.down', {}), 50);
    } else if (op === 'permissions.status') {
      send({ id, ok: true, result: { accessibility: 'granted', screenRecording: 'granted', microphone: 'granted', automation: 'granted',
        inputMonitoring: 'granted' } });
    } else if (op === 'mic.start') {
      send({ id, ok: true, result: { session: params.session, locale: params.locale, sample_rate: 48000 } });
      event('mic.level', { session: params.session, rms: 0.05 });
      event('speech.partial', { session: params.session, text: '明天 下午' });
      setTimeout(() => event('ptt.up', {}), 400);
    } else if (op === 'mic.stop') {
      send({ id, ok: true, result: { session: params.session, text: '明天 下午三点', duration_ms: 400 } });
    } else if (op === 'ptt.unregister') {
      send({ id, ok: true, result: { unregistered: true } });
    } else if (op === 'shutdown') {
      send({ id, ok: true, result: {} });
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** protocol.ts `PushToTalkState`: its phases and its keys, read from the web's type. */
function pushToTalkShape(): { phases: string[]; keys: string[] } {
  const source = readFileSync(join(import.meta.dirname, '../../../web/src/bridge/protocol.ts'), 'utf8');
  const body = /export interface PushToTalkState \{([^}]*)\}/.exec(source)![1]!;
  return { phases: [.../phase: ([^;]*);/.exec(body)![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!),
    keys: [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!) };
}

test('ptt.down → barge-in, mic.start, the partial on voice.onPushToTalk, ptt.up → mic.stop → POST /say with the text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptt-'));
  const said: unknown[] = [], cancels: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer token');
      if (req.url === '/turn/cancel') cancels.push(JSON.parse(body));
      if (req.url === '/say') said.push(JSON.parse(body));
      const answer = req.url === '/turn/cancel' ? { generation: 3 } : { line_id: 'l1', trace_id: 't1', generation: 3 };
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mkdirSync(join(dir, 'agentd'));
  const runtime = join(dir, 'agentd', 'ui-runtime.json');
  writeFileSync(runtime, JSON.stringify({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ui_token: 'token' }));
  const script = join(dir, 'fake.cjs'), received = join(dir, 'received');
  writeFileSync(script, FAKE);
  const client = new AgentdClient(runtime), stops: (number | undefined)[] = [], logs: string[] = [];
  const events = new PushSource('state', { replay: false });
  let ptt: PushToTalk | null = null;
  const helper = new HelperSupervisor({ executable: process.execPath, prefix: [script, received], supportDir: join(dir, 's'),
    clientVersion: 'test', onStatus: (s) => ptt?.helper(s.kind === 'running'), onEvent: (e) => ptt?.event(e.event, e.data) });
  ptt = new PushToTalk('control+option+space', {
    helper, agentd: async (method, path, json) => {
      const r = await client.request(method, path, json);
      return { status: r.status, body: r.body.toString('utf8') };
    },
    stopSpeech: (g) => stops.push(g), onHint: (h) => events.send(pushToTalkState(h)), locale: () => 'zh-CN',
    now: Date.now, after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    log: (line) => logs.push(line),
  });
  const pushed: { phase: string; partial?: string; error?: string }[] = [];
  const page = new PageSession((_id, stream, kind, payload) => {
    if (stream === 'voice.onPushToTalk' && kind === 'event') pushed.push(JSON.parse(payload!.data) as typeof pushed[number]);
  });
  const ctx = { surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: client,
    store: null, diag: silentSource, supervisor: null, library: null, confirm: async () => false,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
    pushToTalk: events } satisfies OpsContext;
  try {
    const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op: 'voice.onPushToTalk', args: [1] }, registry(ctx), page);
    assert.deepEqual(reply, { ok: true, value: null });
    ptt.agentd(true);
    helper.start();
    assert.ok(await until(10, () => said.length === 1), `${logs.join('\n')}\n${JSON.stringify(pushed)}`);
    const ops = readFileSync(received, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { op: string }).op);
    assert.deepEqual(ops, ['hello', 'ptt.register', 'permissions.status', 'permissions.status', 'mic.start', 'mic.stop']);
    assert.deepEqual(cancels, [{ reason: 'barge_in' }]);
    assert.deepEqual(stops, [undefined, 3]);
    const sent = said[0] as { text: string; source: string; voice_timing: Record<string, number> };
    assert.equal(sent.text, '明天下午三点');
    assert.equal(sent.source, 'voice');
    const { pressed_ms: pressed, released_ms: released, final_ms: final } = sent.voice_timing;
    assert.ok(pressed! <= released! && released! <= final! && released! - pressed! >= 300, JSON.stringify(sent.voice_timing));
    assert.ok(await until(5, () => pushed.at(-1)?.phase === 'sent'));
    assert.deepEqual(pushed.at(-1), { phase: 'sent', partial: '明天下午三点' });
    assert.ok(pushed.some((s) => s.phase === 'listening' && s.partial === '明天 下午'), JSON.stringify(pushed));
    const shape = pushToTalkShape();
    for (const s of pushed) {
      assert.ok(shape.phases.includes(s.phase), s.phase);
      for (const [k, v] of Object.entries(s)) assert.ok(shape.keys.includes(k) && typeof v === 'string', `${k} in ${JSON.stringify(s)}`);
    }
    assert.ok(await until(5, () => pushed.at(-1)?.phase === 'idle'), 'the hint goes after 1.5 s');
  } finally {
    page.end();
    await helper.stop();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
