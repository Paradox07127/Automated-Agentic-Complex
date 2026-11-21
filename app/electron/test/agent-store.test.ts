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
