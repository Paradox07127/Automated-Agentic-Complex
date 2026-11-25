// agentd's `/feed` `looks` events carried out (src/main/commands/looks.ts) against a fake AvatarLooks and link that
// record what they were asked: the menu's own calls in order, then one receipt to `POST /avatar/looks/receipts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedLooks } from '../src/common/commands.ts';
import type { ModValues } from '../src/common/looks.ts';
import { looksCommands } from '../src/main/commands/looks.ts';
import { ActionFailure } from '../src/main/renderer/link.ts';

async function until(seconds: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return done();
}

function setup(f: { character?: string | null; fail?: string } = {}) {
  const calls: string[] = [], posted: [string, unknown][] = [], log: string[] = [];
  const link = { currentCharacter: f.character === undefined ? 'pelica' : f.character, currentAppearance: 'default' as string | null };
  const stored: Record<string, ModValues> = { mod_a: { coat: 0, color: 2 } };
  const looks = {
    setAppearance: async (id: string) => {
      calls.push(`setAppearance ${id}`);
      if (f.fail === 'appearance') throw new ActionFailure('failed', '角色没有连上，或者正在换外观');
      link.currentAppearance = id;
    },
    setLayers: async (change: { hide: string[]; show: string[] }) => { calls.push(`setLayers ${JSON.stringify(change)}`); },
    saveModSettings: async (character: string, appearance: string, values: ModValues) => {
      calls.push(`saveModSettings ${character} ${appearance} ${JSON.stringify(values)}`);
      stored[appearance] = values;
      return { req: 1, character, appearance, values, adjusted: [] };
    },
    modSettings: () => stored,
  };
  const feed = looksCommands({ looks, link, log: (line) => log.push(line),
    post: async (path, body) => { posted.push([path, body]); return { status: 200 }; } });
  const send = (data: unknown) => feed({ event: 'looks', id: '1', data: JSON.stringify(data) });
  return { calls, posted, log, feed, send };
}

const RID = '0123456789abcdef';

test('a feed `looks` event reads as FeedLooks; anything malformed is not one', () => {
  assert.deepEqual(feedLooks({ event: 'looks', data: JSON.stringify({ seq: 4, request_id: RID, character: 'pelica', appearance: 'mod_a',
    layers: { hide: ['cape'], show: [] }, mod_settings: { appearance: 'mod_a', values: { coat: 1 } } }) }),
  { seq: 4, requestId: RID, character: 'pelica', appearance: 'mod_a', layers: { hide: ['cape'], show: [] },
    modSettings: { appearance: 'mod_a', values: { coat: 1 } } });
  assert.deepEqual(feedLooks({ event: 'looks', data: JSON.stringify({ seq: 4, request_id: RID, character: 'pelica', appearance: 'mod_a' }) }),
    { seq: 4, requestId: RID, character: 'pelica', appearance: 'mod_a' });
  const C = { character: 'pelica' };
  for (const data of [{ seq: 4, request_id: RID, appearance: 'a' }, { seq: 4, request_id: RID, character: '', appearance: 'a' },
    { seq: 4, request_id: RID, character: 3, appearance: 'a' }, { ...C, seq: 4, request_id: RID }, { ...C, seq: '4', request_id: RID, appearance: 'a' },
    { ...C, seq: 4, request_id: 'r', appearance: 'a' },
    { ...C, seq: 4, request_id: RID, appearance: '' }, { ...C, seq: 4, request_id: RID, appearance: 'a', extra: 1 },
    { ...C, seq: 4, request_id: RID, layers: { hide: [], show: [] } }, { ...C, seq: 4, request_id: RID, layers: { hide: ['a'] } },
    { ...C, seq: 4, request_id: RID, layers: { hide: [''], show: [] } }, { ...C, seq: 4, request_id: RID, mod_settings: { appearance: 'a', values: {} } },
    { ...C, seq: 4, request_id: RID, mod_settings: { appearance: 'a', values: { coat: 1.5 } } },
    { ...C, seq: 4, request_id: RID, mod_settings: { values: { coat: 1 } } }]) {
    assert.equal(feedLooks({ event: 'looks', data: JSON.stringify(data) }), null, JSON.stringify(data));
  }
  assert.equal(feedLooks({ event: 'looks', data: 'not json' }), null);
  assert.equal(feedLooks({ event: 'command', data: JSON.stringify({ ...C, seq: 4, request_id: RID, appearance: 'a' }) }), null);
});

test('a looks event calls the menu\'s AvatarLooks methods in order and posts the receipt', async () => {
  const s = setup();
  s.send({ seq: 4, request_id: RID, character: 'pelica', appearance: 'mod_a', layers: { hide: ['cape'], show: [] }, mod_settings: { appearance: 'mod_a', values: { coat: 1 } } });
  assert.ok(await until(2, () => s.posted.length === 1));
  assert.deepEqual(s.calls, ['setAppearance mod_a', 'setLayers {"hide":["cape"],"show":[]}', 'saveModSettings pelica mod_a {"coat":1,"color":2}']);
  assert.deepEqual(s.posted, [['/avatar/looks/receipts', { request_id: RID, ok: true, appearance: 'mod_a', values: { coat: 1, color: 2 } }]]);
});

test('the first failure stops the change and the receipt carries its reason', async () => {
  const s = setup({ fail: 'appearance' });
  s.send({ seq: 5, request_id: RID, character: 'pelica', appearance: 'mod_a', layers: { hide: ['cape'], show: [] } });
  assert.ok(await until(2, () => s.posted.length === 1));
  assert.deepEqual(s.calls, ['setAppearance mod_a']);
  assert.deepEqual(s.posted, [['/avatar/looks/receipts',
    { request_id: RID, ok: false, reason: '角色没有连上，或者正在换外观', appearance: 'default', values: {} }]]);
});

test('without a character nothing is called and the receipt says no_character', async () => {
  const s = setup({ character: null });
  s.send({ seq: 6, request_id: RID, character: 'pelica', appearance: 'mod_a' });
  assert.ok(await until(2, () => s.posted.length === 1));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.posted, [['/avatar/looks/receipts', { request_id: RID, ok: false, reason: 'no_character', appearance: 'default', values: {} }]]);
});

test('an event checked against another character than the one shown calls nothing and says character_changed', async () => {
  const s = setup({ character: 'chen' });
  s.send({ seq: 6, request_id: RID, character: 'pelica', appearance: 'mod_a', mod_settings: { appearance: 'mod_a', values: { coat: 1 } } });
  assert.ok(await until(2, () => s.posted.length === 1));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.posted, [['/avatar/looks/receipts',
    { request_id: RID, ok: false, reason: 'character_changed', appearance: 'default', values: {} }]]);
});

test('a malformed or other event calls nothing and posts nothing', async () => {
  const s = setup();
  s.send({ seq: 7, request_id: RID, character: 'pelica', appearance: 'mod_a', layers: ['cape'] });
  s.send({ seq: 8, request_id: RID, character: 'pelica' });
  s.send({ seq: 8, request_id: RID, appearance: 'mod_a' });
  s.feed({ event: 'command', id: '2', data: JSON.stringify({ seq: 9, action: 'open', target: 'Safari' }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.posted, []);
});
