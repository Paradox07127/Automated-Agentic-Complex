// C1 §3 over this shell: every receipt
// of the C1 fixtures goes from a fake renderer through the link to agentd's `POST /behavior/receipts` unchanged, and a
// closing `cancelled` / `connection_lost` one is made by the shell when the link drops.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { agentdForwarding } from '../src/main/agentd/forward.ts';
import { HostLink } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const FIXTURES = resolve(import.meta.dirname, '../../../protocol/C1-agent-events/fixtures');
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
// performance.now: Date is mocked while the link drops.
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}

test('every receipt in the C1 fixtures reaches agentd unchanged; the link drop makes the closing connection_lost one', { skip: UNIX_LINK }, async () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  assert.equal(files.length, 16);
  let total = 0;
  for (const name of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { messages: Record<string, unknown>[] };
    const receipts = fixture.messages.filter((m) => m.event === 'receipt').map(({ event: _event, ...r }) => r);
    total += receipts.length;
    const last = receipts.at(-1);
    const lost = last?.phase === 'cancelled' && last.reason === 'connection_lost' ? last : null;
    const sent = lost ? receipts.slice(0, -1) : receipts;
    const posted: unknown[] = [];
    const forwarding = agentdForwarding({ epoch: 1, log: () => {}, post: async (path, body) => {
      if (path === '/behavior/receipts') posted.push(body);
      return { status: 200, body: null };
    } });
    const dir = mkdtempSync(join(tmpdir(), 'c1-r-')), log: string[] = [];
    const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => log.push(l), onBehaviorReceipt: forwarding.onBehaviorReceipt });
    await link.start();
    try {
      const a = new FakeAvatar(link.path);
      a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['behavior_receipt'] });
      assert.ok(await until(2, () => link.hello?.pid === 99), name);
      for (const receipt of sent) a.send({ ...receipt, type: 'behavior_receipt' });
      assert.ok(await until(2, () => posted.length === sent.length), `${name} ${log.join(' | ')}`);
      if (lost) {
        mock.timers.enable({ apis: ['Date'], now: lost.at_ms as number });
        try {
          a.socket.destroy();
          assert.ok(await until(2, () => posted.length === receipts.length), `${name} ${log.join(' | ')}`);
        } finally {
          mock.timers.reset();
        }
      }
      await sleep(0.1);
      assert.deepEqual(posted, receipts, name);
      a.socket.destroy();
    } finally {
      link.stop();
      forwarding.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(total, 73);
});
