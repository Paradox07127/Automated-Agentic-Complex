import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseHealth } from '../src/common/agentd.ts';
import { decodeRuntime, decodeState, feedStreamEdge, type SSEEvent, SSEParser } from '../src/common/c6.ts';
import { agentdSwitchPorts } from '../src/common/switch.ts';
import { AgentdClient, FeedClient, REQUEST_IDLE_TIMEOUT } from '../src/main/agentd/client.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../protocol/C6-agentd-api/fixtures/${name}`, import.meta.url), 'utf8'));

test('the C6 fixtures decode: health, state with a character, idle state without one', () => {
  assert.deepEqual(parseHealth(fixture('health.json')), { kind: 'ready', degraded: ['observations'] });
  assert.deepEqual(decodeState(fixture('state.json')), { character: 'voice_a', switchingTo: 'si' });
  assert.deepEqual(decodeState(fixture('state-idle.json')), { character: null, switchingTo: null });
  assert.deepEqual(decodeState({ character: null, switching: null }), { character: null, switchingTo: null });
  assert.throws(() => decodeState({ character: 3 }));
});

test('the C9 ui-runtime.json example decodes to its address and token', () => {
  const example = JSON.parse(readFileSync(new URL('../../../protocol/C9-agentd-process/examples/ui-runtime.json', import.meta.url), 'utf8'));
  assert.deepEqual(decodeRuntime(example), { baseUrl: 'http://127.0.0.1:48800', uiToken: 'EXAMPLE-ui-token-not-a-secret' });
  assert.throws(() => decodeRuntime({ base_url: 'http://x' }));
});

test('the event-stream parser: multi-line data, comments, CR, the id carried over, empty events dropped', () => {
  const p = new SSEParser();
  const feed = (lines: string[]) => lines.map((l) => p.feed(l)).filter((e) => e !== undefined);
  assert.deepEqual(feed([': keepalive', 'event: line', 'id: 7', 'data: {"a":', 'data:1}', '']), [{ event: 'line', id: '7', data: '{"a":\n1}' }]);
  assert.deepEqual(feed(['data: x', '']), [{ event: 'message', id: '7', data: 'x' }]);
  assert.deepEqual(feed(['event: ping', '', 'id: a\0b', 'data', '']), [{ event: 'message', id: '7', data: '' }]);
  assert.equal(feedStreamEdge({ event: 'stream', data: '{"stream_epoch":"e1","latest_seq":12}' }, false), 'e1-12');
  assert.equal(feedStreamEdge({ event: 'stream', data: '{"stream_epoch":"e1","latest_seq":12}' }, true), undefined);
  assert.equal(feedStreamEdge({ event: 'reset', data: '{"stream_epoch":"e2","latest_seq":0}' }, true), 'e2-0');
  assert.equal(feedStreamEdge({ event: 'line', data: '{}' }, false), undefined);
});

interface Fake {
  url: string;
  close(): Promise<void>;
}

async function fakeAgentd(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fake> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function withRuntime(fn: (dir: string, write: (base: string, token: string) => void) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'c6-'));
  const write = (base: string, token: string) => {
    writeFileSync(join(dir, 'tmp.json'), JSON.stringify({ schema: 1, base_url: base, ui_token: token }));
    renameSync(join(dir, 'tmp.json'), join(dir, 'ui-runtime.json'));
  };
  return fn(dir, write).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('requests carry the ui_token; a 401 reads ui-runtime.json again and retries once', async () => {
  let token = 'old';
  const seen: string[] = [];
  const fake = await fakeAgentd((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end('{"error":"unauthorized"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"character": null, "focus": {}}');
  });
  await withRuntime(async (dir, write) => {
    write(fake.url, 'old');
    const client = new AgentdClient(join(dir, 'ui-runtime.json'));
    assert.deepEqual(await client.state(), { character: null, switchingTo: null });
    // agentd has a new token but has not written it yet: one retry, then the 401 is the answer.
    token = 'new';
    assert.equal((await client.request('POST', '/speech/cancel', {})).status, 401);
    // The file changed: the next request reads it before sending.
    write(fake.url, 'new');
    assert.equal((await client.request('POST', '/speech/cancel', {})).status, 200);
    assert.deepEqual(seen, ['GET /state Bearer old', 'POST /speech/cancel Bearer old', 'POST /speech/cancel Bearer old',
      'POST /speech/cancel Bearer new']);
  }).finally(() => fake.close());
});

test('a request\'s own headers go with it, and with the retry after a 401', async () => {
  const seen: string[] = [];
  const fake = await fakeAgentd((req, res) => {
    seen.push(`${req.headers.authorization} ${req.headers['idempotency-key']} ${req.headers['content-type']}`);
    res.writeHead(req.headers.authorization === 'Bearer new' ? 202 : 401).end('{}');
  });
  await withRuntime(async (dir, write) => {
    write(fake.url, 'old');
    const client = new AgentdClient(join(dir, 'ui-runtime.json'));
    assert.equal((await client.request('POST', '/say', { text: 'x' }, { 'Idempotency-Key': 'k1' })).status, 401);
    assert.deepEqual(seen, ['Bearer old k1 application/json', 'Bearer old k1 application/json']);
  }).finally(() => fake.close());
});

test('a DELETE body goes with its Content-Length, which agentd reads the body by', async () => {
  const seen: string[] = [];
  const fake = await fakeAgentd((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.headers['content-length']} ${Buffer.concat(chunks).toString('utf8')}`);
      res.writeHead(200).end('{}');
    });
  });
  await withRuntime(async (dir, write) => {
    write(fake.url, 'tok');
    const client = new AgentdClient(join(dir, 'ui-runtime.json'));
    await client.request('DELETE', '/blacklist', { field: 'app', value: '删' });
    const sent = JSON.stringify({ field: 'app', value: '删' });
    assert.deepEqual(seen, [`DELETE ${Buffer.byteLength(sent)} ${sent}`]);
  }).finally(() => fake.close());
});

test('the feed reconnects after the stream ends and resumes from the last event id', async () => {
  const connections: (string | undefined)[] = [];
  const fake = await fakeAgentd((req, res) => {
    connections.push(req.headers['last-event-id'] as string | undefined);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (connections.length === 1) {
      res.end('event: stream\ndata: {"stream_epoch":"e1","latest_seq":4}\n\nevent: line\nid: e1-5\ndata: {"seq":5}\r\n\r\n');
    } else {
      res.write('event: line\nid: e1-6\ndata: {"seq":6}\n\n');
    }
  });
  await withRuntime(async (dir, write) => {
    write(fake.url, 't');
    const feed = new FeedClient(join(dir, 'ui-runtime.json'));
    const events: SSEEvent[] = [];
    await new Promise<void>((resolve) => {
      feed.start((e) => {
        events.push(e);
        if (e.id === 'e1-6') resolve();
      });
    });
    feed.stop();
    assert.deepEqual(connections, [undefined, 'e1-5']);
    assert.deepEqual(events.map((e) => [e.event, e.data]), [
      ['stream', '{"stream_epoch":"e1","latest_seq":4}'], ['line', '{"seq":5}'], ['line', '{"seq":6}'],
    ]);
  }).finally(() => fake.close());
});

test('the feed retries after a refused connection and an unreachable agentd', async () => {
  let calls = 0;
  const fake = await fakeAgentd((_req, res) => {
    calls += 1;
    if (calls === 1) return res.writeHead(503).end('{"error":"starting"}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('event: line\nid: 1\ndata: {}\n\n');
  });
  await withRuntime(async (dir, write) => {
    write(fake.url, 't');
    const feed = new FeedClient(join(dir, 'ui-runtime.json'));
    const first = await new Promise<SSEEvent>((resolve) => feed.start(resolve));
    feed.stop();
    assert.equal(calls, 2);
    assert.equal(first.id, '1');
  }).finally(() => fake.close());
});

test('a request agentd never answers fails after the idle timeout, so a switch commit or abort ends as failed', { timeout: 10_000 }, async () => {
  assert.equal(REQUEST_IDLE_TIMEOUT, 60);
  const seen: string[] = [];
  const fake = await fakeAgentd((req) => { seen.push(`${req.method} ${req.url}`); });
  await withRuntime(async (dir, write) => {
    write(fake.url, 't');
    const client = new AgentdClient(join(dir, 'ui-runtime.json'), 0.3);
    const started = Date.now();
    await assert.rejects(client.request('POST', '/speech/cancel', {}), /timed out/);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    const ports = agentdSwitchPorts((method, path, json) => client.request(method, path, json));
    assert.equal((await ports.commit('sw-1')).kind, 'failed');
    assert.equal((await ports.abort('sw-1')).kind, 'failed');
    assert.deepEqual(seen, ['POST /speech/cancel', 'POST /character/commit', 'POST /character/abort']);
  }).finally(() => fake.close());
});
