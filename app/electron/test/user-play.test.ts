// The user's play from the character page comes first: the link tells agentd to give her body up before `play_action`,
// asks again while the renderer answers `busy` (her sit, walk or hold is ending), and gives the body back once the play
// is over or did not start. A user `motion_state` reaches agentd, whose stand-down ends with it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type C3Message, decodeLine } from '../src/common/c3.ts';
import { agentdForwarding } from '../src/main/agentd/forward.ts';
import { HostLink } from '../src/main/renderer/link.ts';
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
const strip = ({ v: _v, type: _type, ...body }: Record<string, unknown>) => body;

/** A link forwarding to a fake agentd that records each POST; the fake avatar answers each `play_action` with `answer`. */
async function linked(answer: (m: C3Message, n: number) => Record<string, unknown>[],
  run: (link: HostLink, a: FakeAvatar, posted: [string, unknown][]) => Promise<void>) {
  const posted: [string, unknown][] = [], log: string[] = [];
  const forwarding = agentdForwarding({ epoch: 1, log: (l) => log.push(l), post: async (path, body) => {
    posted.push([path, body]);
    return { status: path === '/behavior/receipts' ? 200 : 204, body: null };
  } });
  const dir = mkdtempSync(join(tmpdir(), 'c3-up-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => log.push(l), timeScale: 0.01,
    onBehaviorReceipt: forwarding.onBehaviorReceipt, onMotionState: forwarding.onMotionState, onUserPlay: forwarding.onUserPlay });
  await link.start();
  const a = new FakeAvatar(link.path);
  let plays = 0;
  a.socket.on('data', () => {
    for (const m of a.got.filter((x) => x.type === 'play_action').slice(plays)) {
      plays += 1;
      for (const reply of answer(m, plays)) a.send({ type: 'action_played', play_id: m.play_id, id: m.id, reason: null, ...reply });
    }
  });
  try {
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: ['actions', 'action_loop', 'behavior_receipt'] });
    assert.ok(await until(2, () => link.hello?.pid === 99));
    await run(link, a, posted);
  } finally {
    a.socket.destroy();
    link.stop();
    forwarding.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
const userPlays = (posted: [string, unknown][]) => posted.filter(([p]) => p === '/behavior/user_play').map(([, b]) => b);

test('a play the renderer answers busy while her sit gives way plays once her body is free, and gives it back at its end', { skip: UNIX_LINK }, async () => {
  await linked((_m, n) => (n < 3 ? [{ phase: 'rejected', reason: 'busy' }] : [{ phase: 'started' }]), async (link, a, posted) => {
    await link.playAction('aster', 'wave', 1, false);
    assert.equal(a.got.filter((m) => m.type === 'play_action').length, 3);
    assert.deepEqual(userPlays(posted), [{ playing: true }], 'agentd gives her body up before the first play_action');
    const last = a.last('play_action')!;
    a.send({ type: 'action_played', play_id: last.play_id, id: 'wave', phase: 'completed', reason: null });
    assert.ok(await until(2, () => userPlays(posted).length === 2));
    assert.deepEqual(userPlays(posted), [{ playing: true }, { playing: false }]);
  });
});

test('a stopped play gives her body back', { skip: UNIX_LINK }, async () => {
  await linked(() => [{ phase: 'started' }], async (link, a, posted) => {
    await link.playAction('aster', 'wave', 1, true);
    link.stopAction();
    assert.ok(await until(2, () => a.last('stop_action') !== undefined));
    a.send({ type: 'action_played', play_id: a.last('stop_action')!.play_id, id: 'wave', phase: 'interrupted', reason: 'stopped' });
    assert.ok(await until(2, () => userPlays(posted).length === 2));
    assert.deepEqual(userPlays(posted), [{ playing: true }, { playing: false }]);
  });
});

test('a play still busy when the wait is over is refused busy and gives her body back; a hard refusal is not asked again', { skip: UNIX_LINK }, async () => {
  await linked((m) => [{ phase: 'rejected', reason: m.id === 'wave' ? 'busy' : 'not_ready' }], async (link, a, posted) => {
    await assert.rejects(link.playAction('aster', 'wave', 1, false), { code: 'busy' });
    assert.ok(a.got.filter((m) => m.type === 'play_action').length > 1);
    assert.deepEqual(userPlays(posted), [{ playing: true }, { playing: false }]);
    const before = a.got.length;
    await assert.rejects(link.playAction('aster', 'dance', 1, false), { code: 'not_ready' });
    assert.equal(a.got.slice(before).filter((m) => m.type === 'play_action').length, 1);
    assert.ok(await until(2, () => userPlays(posted).length === 4));
    assert.deepEqual(userPlays(posted).slice(2), [{ playing: true }, { playing: false }]);
  });
});

test("the renderer's user motion_state reaches agentd", { skip: UNIX_LINK }, async () => {
  const user = readFileSync(join(PENDING, 'avatar-to-companion-motion-state-user.ndjson'), 'utf8').split('\n')
    .filter((l) => l.trim() !== '').map((l) => decodeLine(l)!).filter((m) => m.type === 'motion_state' && m.origin === 'user');
  await linked(() => [], async (_link, a, posted) => {
    for (const m of user) a.send(m);
    assert.ok(await until(2, () => posted.length >= user.length));
    assert.deepEqual(posted, user.map((m) => ['/behavior/motion_state', strip(m)]));
  });
});
