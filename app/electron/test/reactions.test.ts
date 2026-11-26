// A fake renderer's `reaction` lines and drag begins reach agentd's `POST /interaction/record`
// as one record each; a `reaction` this link did not list, or one that breaks the rule, is dropped and logged.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { decodeLine } from '../src/common/c3.ts';
import { agentdForwarding } from '../src/main/agentd/forward.ts';
import { HostLink, type LinkOptions } from '../src/main/renderer/link.ts';
import { FakeAvatar } from './fake-avatar.ts';

const PENDING = resolve(import.meta.dirname, '../../../protocol/C3-host-ipc/examples/pending');
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;
const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.01);
  }
  return ok();
}
const lines = (file: string) => readFileSync(join(PENDING, file), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => decodeLine(l)!);

/** A link whose `wired` callbacks forward to a fake agentd that records each POST; her hello lists no capability. */
async function linked(wired: ('onReaction' | 'onDragBegin')[],
  run: (a: FakeAvatar, posted: [string, unknown][], log: string[]) => Promise<void>) {
  const posted: [string, unknown][] = [], log: string[] = [];
  const forwarding = agentdForwarding({ epoch: 1, log: (l) => log.push(l), post: async (path, body) => {
    posted.push([path, body]);
    return { status: 204, body: null };
  } });
  const dir = mkdtempSync(join(tmpdir(), 'c3-re-'));
  const options: Partial<LinkOptions> = { ...(wired.includes('onReaction') && { onReaction: forwarding.onReaction }),
    ...(wired.includes('onDragBegin') && { onDragBegin: forwarding.onDragBegin }) };
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => log.push(l), ...options });
  await link.start();
  const a = new FakeAvatar(link.path);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: [] });
    assert.ok(await until(2, () => link.hello?.pid === 99 && a.got.length > 0));
    await run(a, posted, log);
  } finally {
    a.socket.destroy();
    link.stop();
    forwarding.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('with onReaction the hello lists reactions; each valid reaction is one record, the invalid ones are dropped and logged', { skip: UNIX_LINK }, async () => {
  const valid = lines('avatar-to-companion-reactions.ndjson').filter((m) => m.type === 'reaction');
  const bad = ['a2c-reaction-bad-trigger.ndjson', 'a2c-reaction-extra-key.ndjson', 'a2c-reaction-without-trigger.ndjson']
    .flatMap((f) => lines(`invalid/${f}`));
  await linked(['onReaction'], async (a, posted, log) => {
    assert.ok((a.got[0]!.capabilities as string[]).includes('reactions'));
    for (const m of [...bad, ...valid]) a.send(m);
    assert.ok(await until(2, () => posted.length >= valid.length), log.join(' | '));
    await sleep(0.1);
    assert.deepEqual(posted, valid.map((m) => ['/interaction/record', { kind: m.trigger }]));
    assert.deepEqual(posted.map(([, body]) => (body as { kind: string }).kind), ['pat', 'pat', 'pinch', 'greet']);
    // The second why=trigger is within the minute of the first on this connection.
    assert.deepEqual(log.filter((l) => l.startsWith('rejected type=reaction')),
      ['rejected type=reaction why=trigger', 'rejected type=reaction why=keys']);
    assert.deepEqual(log.filter((l) => l.includes('forward')), []);
  });
});

test('a reaction is dropped and logged when this link does not list reactions; a drag begin is one drag record', { skip: UNIX_LINK }, async () => {
  const [reaction] = lines('avatar-to-companion-reactions.ndjson').filter((m) => m.type === 'reaction');
  await linked(['onDragBegin'], async (a, posted, log) => {
    assert.ok(!(a.got[0]!.capabilities as string[]).includes('reactions'));
    a.send(reaction!);
    assert.ok(await until(2, () => log.includes('rejected type=reaction why=capability')), log.join(' | '));
    a.send({ type: 'drag', phase: 'begin' });
    a.send({ type: 'drag', phase: 'end', x: 10, y: 20 });
    assert.ok(await until(2, () => posted.length >= 1), log.join(' | '));
    await sleep(0.1);
    assert.deepEqual(posted, [['/interaction/record', { kind: 'drag' }]]);
  });
});

test('a record agentd does not take is logged once', async () => {
  const log: string[] = [];
  const fw = agentdForwarding({ epoch: 1, log: (l) => log.push(l), post: async () => ({ status: 400, body: null }) });
  try {
    fw.onReaction('greet');
    assert.ok(await until(1, () => log.length === 1));
    assert.deepEqual(log, ['record forward kind=greet status=400']);
  } finally {
    fw.stop();
  }
});
