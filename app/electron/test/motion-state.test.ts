// C3 rule 54 over this shell: a fake renderer's `motion_state` lines reach agentd's `POST /behavior/motion_state`
// unchanged, in one order with the receipts, within rule 25's per-second limit they share.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { decodeLine } from '../src/common/c3.ts';
import { agentdForwarding } from '../src/main/agentd/forward.ts';
import type { ErrorInput } from '../src/common/error-record.ts';
import { HostLink, LINK_LIMITS, type LinkOptions } from '../src/main/renderer/link.ts';
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
const strip = ({ v: _v, type: _type, ...body }: Record<string, unknown>) => body;

/** A link forwarding to a fake agentd that records each POST; `capabilities` are her hello's. */
async function linked(capabilities: string[], run: (a: FakeAvatar, posted: [string, unknown][], log: string[]) => Promise<void>,
  extra: Partial<LinkOptions> = {}) {
  const posted: [string, unknown][] = [], log: string[] = [];
  const forwarding = agentdForwarding({ epoch: 1, log: (l) => log.push(l), post: async (path, body) => {
    posted.push([path, body]);
    return { status: path === '/behavior/motion_state' ? 204 : 200, body: null };
  } });
  const dir = mkdtempSync(join(tmpdir(), 'c3-ms-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => log.push(l),
    onBehaviorReceipt: forwarding.onBehaviorReceipt, onMotionState: forwarding.onMotionState, ...extra });
  await link.start();
  const a = new FakeAvatar(link.path);
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities });
    assert.ok(await until(2, () => link.hello?.pid === 99));
    await run(a, posted, log);
  } finally {
    a.socket.destroy();
    link.stop();
    forwarding.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('valid motion_state lines reach POST /behavior/motion_state unchanged and in order with receipts; invalid ones do not', { skip: UNIX_LINK }, async () => {
  const valid = lines('avatar-to-companion-motion-state.ndjson').filter((m) => m.type === 'motion_state');
  const bad = ['a2c-motion-state-agent-without-behavior.ndjson', 'a2c-motion-state-bad-phase.ndjson'].flatMap((f) => lines(`invalid/${f}`));
  const receipt = { type: 'behavior_receipt', behavior_id: 'b-1763700000-1', phase: 'running', reason: null, at_ms: 1, turn_generation: 0 };
  await linked(['behavior_receipt'], async (a, posted, log) => {
    a.send(receipt);
    for (const m of [...bad, ...valid, { ...valid[0]!, clip: '' }]) a.send(m);
    const expected: [string, unknown][] = [['/behavior/receipts', strip(receipt)], ...valid.map((m): [string, unknown] => ['/behavior/motion_state', strip(m)])];
    assert.ok(await until(2, () => posted.length >= expected.length), log.join(' | '));
    await sleep(0.1);
    assert.deepEqual(posted, expected);
    assert.deepEqual(log.filter((l) => l.startsWith('rejected type=motion_state')),
      ['rejected type=motion_state why=behavior_id', 'rejected type=motion_state why=phase', 'rejected type=motion_state why=clip']);
    assert.deepEqual(log.filter((l) => l.includes('forward')), []);
  });
});

test('a motion_state the contract rejects again and again is one log line per connection a minute, and each an error record', { skip: UNIX_LINK }, async () => {
  const [state] = lines('avatar-to-companion-motion-state.ndjson').filter((m) => m.type === 'motion_state');
  const records: ErrorInput[] = [];
  await linked(['behavior_receipt'], async (a, posted, log) => {
    for (let i = 0; i < 30; i += 1) a.send({ ...state!, resting: 1 });
    a.send({ ...state!, phase: 'nope' });
    assert.ok(await until(2, () => records.length === 31), log.join(' | '));
    assert.deepEqual(log.filter((l) => l.startsWith('rejected type=motion_state')),
      ['rejected type=motion_state why=resting', 'rejected type=motion_state why=phase']);
    assert.deepEqual(records[0], { component: 'renderer-link', code: 'host_message_rejected', message: 'type=motion_state why=resting' });
    assert.deepEqual(posted, []);
  }, { recordError: (r) => records.push(r) });
});

test('motion_state is not forwarded when her hello does not list behavior_receipt', { skip: UNIX_LINK }, async () => {
  const [state] = lines('avatar-to-companion-motion-state.ndjson').filter((m) => m.type === 'motion_state');
  await linked([], async (a, posted, log) => {
    a.send(state!);
    assert.ok(await until(2, () => log.includes('rejected type=motion_state why=capability')), log.join(' | '));
    assert.deepEqual(posted, []);
  });
});

test('over the per-second limit shared with receipts the extra motion_state is dropped and logged; a terminal receipt still goes', { skip: UNIX_LINK }, async () => {
  const [state] = lines('avatar-to-companion-motion-state.ndjson').filter((m) => m.type === 'motion_state');
  const receipt = { type: 'behavior_receipt', behavior_id: 'b-1', phase: 'running', reason: null, at_ms: 1, turn_generation: 0 };
  await linked(['behavior_receipt'], async (a, posted, log) => {
    a.send(receipt);
    for (let i = 1; i < LINK_LIMITS.receiptRate; i += 1) a.send(state!);
    a.send({ ...state!, phase: 'ended' });
    a.send({ ...receipt, phase: 'completed' });
    assert.ok(await until(2, () => posted.length >= LINK_LIMITS.receiptRate + 1), log.join(' | '));
    await sleep(0.1);
    assert.equal(posted.length, LINK_LIMITS.receiptRate + 1);
    assert.equal(posted.filter(([p]) => p === '/behavior/motion_state').length, LINK_LIMITS.receiptRate - 1);
    assert.deepEqual(posted.at(-1), ['/behavior/receipts', strip({ ...receipt, phase: 'completed' })]);
    assert.deepEqual(log.filter((l) => l.startsWith('rejected type=motion_state')), ['rejected type=motion_state why=rate']);
  });
});

test('forwarding keeps a receipt and a motion_state in one queue and logs a failed motion_state post once', async () => {
  const posts: string[] = [], log: string[] = [];
  let release: (() => void) | null = null;
  const fw = agentdForwarding({ epoch: 1, log: (l) => log.push(l), post: async (path, body) => {
    posts.push(`${path} ${(body as { behavior_id: string }).behavior_id}`);
    if (path === '/behavior/receipts') await new Promise<void>((r) => { release = r; });
    return { status: path === '/behavior/motion_state' ? 500 : 200, body: null };
  } });
  try {
    fw.onBehaviorReceipt({ behavior_id: 'b1', phase: 'running' });
    fw.onMotionState({ behavior_id: 'b1', origin: 'agent', phase: 'started' });
    await sleep(0.02);
    assert.deepEqual(posts, ['/behavior/receipts b1']);
    release!();
    assert.ok(await until(1, () => log.length === 1));
    assert.deepEqual(posts, ['/behavior/receipts b1', '/behavior/motion_state b1']);
    assert.deepEqual(log, ['motion_state forward behavior_id=b1 phase=started status=500']);
  } finally {
    fw.stop();
  }
});
