// CharacterSwitch and agentd: a refused POST /character is tried again while agentd runs,
// and prepare's same_character means agentd's half of the switch is already done.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharacterSwitch, type SetResult, type SwitchPorts } from '../src/common/switch.ts';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function setup(over: Partial<SwitchPorts> = {}) {
  const ports: SwitchPorts = {
    agentdRunning: () => true,
    prepare: async (id) => ({ kind: 'prepared', switchId: id }),
    commit: async () => ({ kind: 'committed' }),
    abort: async () => ({ kind: 'aborted' }),
    setAgentdCharacter: async () => ({ kind: 'changed', changed: true }),
    readAgentd: async () => null,
    setCharacter: () => true, restartAvatar: () => {}, persist: () => {}, renderable: () => true, log: () => {},
    ...over,
  };
  return new CharacterSwitch(ports);
}

const refused: SetResult = { kind: 'rejected', status: 409, reason: 'switching' };

test('a refused POST /character is posted again after the backoff with no other event, onto the current character', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts: string[] = [];
  let refusals = 1;
  const sw = setup({ setAgentdCharacter: async (id) => { posts.push(id); return refusals-- > 0 ? refused : { kind: 'changed', changed: true }; } });
  sw.avatar({ kind: 'current', id: 'a' });
  sw.agentdReported('z');
  await settle();
  assert.deepEqual(posts, ['a']);
  assert.equal(sw.agentd, null);
  t.mock.timers.tick(sw.agentdRetry * 1000);
  await settle();
  assert.deepEqual(posts, ['a', 'a']);
  assert.equal(sw.agentd, 'a');
  t.mock.timers.tick(sw.agentdRetryMax * 1000);
  await settle();
  assert.deepEqual(posts, ['a', 'a'], 'nothing more once agentd took it');
});

test('the retry backs off up to its cap, stops while agentd is down and ends when agentd reports a character', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let running = true;
  let posts = 0;
  const sw = setup({ agentdRunning: () => running, setAgentdCharacter: async () => { posts++; return refused; } });
  sw.agentdRetry = 1;
  sw.agentdRetryMax = 4;
  sw.avatar({ kind: 'current', id: 'a' });
  sw.agentdReported('z');
  await settle();
  const after = async (ms: number) => { t.mock.timers.tick(ms); await settle(); return posts; };
  assert.equal(posts, 1);
  assert.equal(await after(999), 1);
  assert.equal(await after(1), 2);
  assert.equal(await after(1999), 2);
  assert.equal(await after(1), 3);
  assert.equal(await after(4000), 4);
  assert.equal(await after(4000), 5, 'capped at agentdRetryMax');
  running = false;
  assert.equal(await after(60_000), 5, 'no POST while agentd is down');
  running = true;
  sw.agentdReported('a');
  assert.equal(await after(60_000), 5, 'agentd reported the current character');
});

test('a switch committed while a retry waits ends the retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts: string[] = [];
  const sw = setup({ setAgentdCharacter: async (id) => { posts.push(id); return refused; } });
  sw.avatar({ kind: 'current', id: 'a' });
  sw.agentdReported('z');
  await settle();
  const outcome = sw.switchOutcome('b');
  await settle();
  sw.avatar({ kind: 'changed', id: 'b' });
  assert.deepEqual(await outcome, { kind: 'switched' });
  assert.equal(sw.agentd, 'b');
  t.mock.timers.tick(sw.agentdRetryMax * 1000);
  await settle();
  assert.deepEqual(posts, ['a']);
});

test('prepare\'s same_character: agentd already speaks the target, the avatar switches and nothing is committed', async () => {
  const commits: string[] = [];
  const sw = setup({
    prepare: async () => ({ kind: 'rejected', status: 409, reason: 'same_character' }),
    commit: async (id) => { commits.push(id); return { kind: 'committed' }; },
  });
  sw.avatar({ kind: 'current', id: 'a' });
  const outcome = sw.switchOutcome('b');
  await settle();
  sw.avatar({ kind: 'changed', id: 'b' });
  assert.deepEqual(await outcome, { kind: 'switched' });
  assert.equal(sw.current, 'b');
  assert.equal(sw.agentd, 'b');
  assert.equal(sw.failure, null);
  assert.deepEqual(commits, []);
});

test('prepare\'s same_character, then the avatar refuses: agentd is set back onto the old character', async () => {
  const posts: string[] = [];
  const sw = setup({
    prepare: async () => ({ kind: 'rejected', status: 409, reason: 'same_character' }),
    setAgentdCharacter: async (id) => { posts.push(id); return { kind: 'changed', changed: true }; },
  });
  sw.avatar({ kind: 'current', id: 'a' });
  const outcome = sw.switchOutcome('b');
  await settle();
  sw.avatar({ kind: 'failed', id: 'b', reason: 'no_such_character' });
  assert.deepEqual(await outcome, { kind: 'failed', stage: 'avatar', reason: 'no_such_character' });
  await settle();
  assert.deepEqual(posts, ['a']);
  assert.equal(sw.agentd, 'a');
});
