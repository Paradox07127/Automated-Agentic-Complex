// AgentStore's reconnect loop (src/main/agentd/store.ts) against a missing ui-runtime.json and a fake agentd's /feed, and
// the stream it reads (AgentdClient.stream).
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentdClient } from '../src/main/agentd/client.ts';
import { AgentStore } from '../src/main/agentd/store.ts';

async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !ok()) await new Promise((r) => setTimeout(r, 20));
  return ok();
}

test('reconnect waits that run out leave no listener behind on the store\'s abort signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  let failures = 0;
  const store = new AgentStore(join(dir, 'ui-runtime.json'), (n) => {
    failures = n;
    return 1;
  });
  try {
    store.start();
    assert.ok(await until(10, () => failures >= 15), `${failures}`);
    // Node's AbortSignal does not warn past the listener limit, so the test counts them.
    const { signal } = (store as unknown as { abort: AbortController }).abort;
    assert.ok(getEventListeners(signal, 'abort').length <= 1, `${getEventListeners(signal, 'abort').length}`);
  } finally {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a feed stream that sends nothing for the idle timeout ends, before and after its headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-')), runtime = join(dir, 'ui-runtime.json');
  const server = createServer((req, res) => { if (req.headers['last-event-id'] === 'headers') res.writeHead(200).flushHeaders(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(runtime, JSON.stringify({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ui_token: 'token' }));
  const abort = new AbortController();
  try {
    for (const resume of [undefined, 'headers']) {
      const ended = new AgentdClient(runtime, 0.2).stream('/feed', resume, abort.signal, () => {}).then(() => 'ended', () => 'ended');
      const late = new Promise((r) => setTimeout(() => r('still open'), 3000).unref());
      assert.equal(await Promise.race([ended, late]), 'ended', String(resume));
    }
  } finally {
    abort.abort();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start while the store waits to reconnect connects at once instead of after the wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-')), runtime = join(dir, 'ui-runtime.json');
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(': open\n\n'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  let waits = 0;
  const store = new AgentStore(runtime, () => {
    waits += 1;
    return 60_000;
  });
  try {
    store.start();
    assert.ok(await until(5, () => waits === 1));
    const { port } = server.address() as { port: number };
    writeFileSync(runtime, JSON.stringify({ base_url: `http://127.0.0.1:${port}`, ui_token: 'token' }));
    store.start();
    assert.ok(await until(5, () => store.connection === 'connected'), store.connection);
  } finally {
    store.stop();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a subscriber that throws on a gap stops neither the later subscribers nor the reloads, and the stream stays open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-')), runtime = join(dir, 'ui-runtime.json');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('id: e1-1\nevent: gap\ndata: {}\n\nid: e1-2\nevent: line\ndata: {}\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(runtime, JSON.stringify({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ui_token: 'token' }));
  const lines: string[] = [], seen: string[] = [];
  let reloads = 0;
  const store = new AgentStore(runtime, () => 60_000, (line) => lines.push(line));
  store.subscribe(() => { throw new Error('contents destroyed'); });
  store.subscribe((e) => seen.push(e.event));
  store.onReload(() => { reloads += 1; });
  try {
    store.start();
    assert.ok(await until(5, () => seen.length === 2), JSON.stringify(seen));
    assert.deepEqual(seen, ['gap', 'line']);
    assert.equal(reloads, 1);
    assert.equal(store.connection, 'connected');
    assert.deepEqual(lines, ['feed subscriber threw on gap: contents destroyed', 'feed subscriber threw on line: contents destroyed']);
  } finally {
    store.stop();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an onEvent that throws ends the stream with that error instead of throwing in the socket listener', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-')), runtime = join(dir, 'ui-runtime.json');
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('event: gap\ndata: {}\n\n'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(runtime, JSON.stringify({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ui_token: 'token' }));
  const abort = new AbortController();
  try {
    await assert.rejects(new AgentdClient(runtime).stream('/feed', undefined, abort.signal, () => { throw new Error('handler'); }), /handler/);
  } finally {
    abort.abort();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a base_url other than http on 127.0.0.1 or [::1] with a port is refused before any request is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-')), runtime = join(dir, 'ui-runtime.json');
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    for (const base of ['http://203.0.113.5:9', `http://localhost:${port}`, `https://127.0.0.1:${port}`, `http://u:p@127.0.0.1:${port}`,
      `http://127.0.0.1:${port}/elsewhere`, `http://127.0.0.1:${port}/?x=1`, 'http://127.0.0.1', `http://127.0.0.1:${port}@203.0.113.5`]) {
      writeFileSync(runtime, JSON.stringify({ base_url: base, ui_token: 'token' }));
      const client = new AgentdClient(runtime, 0.5);
      await assert.rejects(client.request('GET', '/state'), /base_url is not http on 127\.0\.0\.1/, base);
      await assert.rejects(async () => client.stream('/feed', undefined, new AbortController().signal, () => {}), /base_url/, base);
    }
    assert.equal(requests, 0);
    for (const base of [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`]) {
      writeFileSync(runtime, JSON.stringify({ base_url: base, ui_token: 'token' }));
      assert.equal((await new AgentdClient(runtime).request('GET', '/state')).status, 200, base);
    }
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
