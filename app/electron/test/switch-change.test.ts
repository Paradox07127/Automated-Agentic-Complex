// CharacterSwitch.onChange: every set of current, failure, busy, shown, pending and agentd
// tells the switch's view, which index.ts sends to app.runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CharacterView } from '../src/common/runtime.ts';
import { CharacterSwitch, type SwitchPorts } from '../src/common/switch.ts';

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function setup(over: Partial<SwitchPorts> = {}) {
  const ports: SwitchPorts = {
    agentdRunning: () => true,
    prepare: async (id) => ({ kind: 'prepared', switchId: id }),
    commit: async () => ({ kind: 'committed' }),
    abort: async () => ({ kind: 'aborted' }),
    setAgentdCharacter: async () => ({ kind: 'changed', changed: true }),
    readAgentd: async () => null,
    setCharacter: () => true, restartAvatar: () => {}, persist: () => {}, renderable: () => true, known: () => true, log: () => {},
    ...over,
  };
  const sw = new CharacterSwitch(ports);
  const views: CharacterView[] = [];
  sw.onChange = (v) => views.push(v);
  return { sw, views, last: () => views.at(-1) };
}

const view = (o: Partial<CharacterView>): CharacterView => ({
  current: null, shown: null, agentd: null, pending: null, switching: false, failure: null, ...o,
});

test('onChange: a hello sets shown and current, agentd\'s report sets agentd, a late reply sets shown and the restore puts it back', async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'a' });
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a' }));
  t.sw.agentdReported('a');
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a', agentd: 'a' }));
  assert.equal(t.sw.agentd, 'a');
  t.sw.avatar({ kind: 'lateChanged', id: 'b' });
  assert.ok(t.views.some((v) => v.shown === 'b' && !v.switching), 'the late reply tells shown before the restore starts');
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'b', agentd: 'a', switching: true }), 'restoring a');
  t.sw.avatar({ kind: 'changed', id: 'a' });
  await settle();
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a', agentd: 'a' }));
});

test('onChange: a choice is pending until it starts, a choice made while busy stays pending; commit sets agentd and current', async () => {
  const t = setup();
  t.sw.avatar({ kind: 'current', id: 'a' });
  t.sw.agentdReported('a');
  t.sw.select('b');
  assert.ok(t.views.some((v) => v.pending === 'b' && !v.switching), 'b is pending before it starts');
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a', agentd: 'a', switching: true }));
  await settle();
  t.sw.select('c');
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a', agentd: 'a', pending: 'c', switching: true }));
  assert.equal(t.sw.pending, 'c');
  t.sw.avatar({ kind: 'changed', id: 'b' });
  await settle();
  assert.ok(t.views.some((v) => v.current === 'b' && v.agentd === 'b' && v.shown === 'b'), 'b committed');
  t.sw.avatar({ kind: 'changed', id: 'c' });
  await settle();
  assert.deepEqual(t.last(), view({ current: 'c', shown: 'c', agentd: 'c' }));
  assert.equal(t.sw.pending, null);
});

test('onChange: prepare, avatar and commit failures show as failure; a refused commit puts shown back on the old character', async () => {
  const prepare = setup({ prepare: async () => ({ kind: 'rejected', status: 409, reason: 'busy' }) });
  prepare.sw.avatar({ kind: 'current', id: 'a' });
  await prepare.sw.switchOutcome('b');
  assert.ok(prepare.views.some((v) => v.failure !== null && v.switching), 'the failure is told while the switch still runs');
  assert.deepEqual(prepare.last(), view({ current: 'a', shown: 'a', failure: { target: 'b', stage: 'prepare', reason: 'busy' } }));

  const avatar = setup();
  avatar.sw.avatar({ kind: 'current', id: 'a' });
  const refused = avatar.sw.switchOutcome('b');
  await settle();
  avatar.sw.avatar({ kind: 'failed', id: 'b', reason: 'no_such_character' });
  await refused;
  assert.deepEqual(avatar.last(), view({ current: 'a', shown: 'a', failure: { target: 'b', stage: 'avatar', reason: 'no_such_character' } }));

  const commit = setup({ commit: async () => ({ kind: 'rejected', status: 409, reason: 'stale' }) });
  commit.sw.avatar({ kind: 'current', id: 'a' });
  const stale = commit.sw.switchOutcome('b');
  await settle();
  commit.sw.avatar({ kind: 'changed', id: 'b' });
  await settle();
  assert.equal(commit.last()?.shown, 'b');
  commit.sw.avatar({ kind: 'changed', id: 'a' });
  await stale;
  assert.deepEqual(commit.last(), view({ current: 'a', shown: 'a', failure: { target: 'b', stage: 'commit', reason: 'stale' } }));
});

test('onChange: agentd set back onto current, refused, leaves agentd unknown; a text-only character agentd names is current', async () => {
  const t = setup({ setAgentdCharacter: async () => ({ kind: 'rejected', status: 500, reason: 'down' }) });
  t.sw.avatar({ kind: 'current', id: 'a' });
  t.sw.agentdReported('z');
  assert.ok(t.views.some((v) => v.agentd === 'z'));
  await settle();
  assert.deepEqual(t.last(), view({ current: 'a', shown: 'a' }));

  const text = setup({ renderable: (id) => id !== 'aide' });
  text.sw.agentdReported('aide');
  assert.deepEqual(text.last(), view({ current: 'aide', agentd: 'aide' }));
  assert.deepEqual(text.sw.view, text.last());
});
