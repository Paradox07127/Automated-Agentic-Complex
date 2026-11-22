// The fake chat routes against agentd's conversation contract (personal/conversations.py, control_panel.py).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playOnce, replyScript } from '../../src/bridge/fake/feed';
import type { StreamEvent } from '../../src/bridge/protocol';
import type { WireConversation, WireTurn } from '../../src/domain/wire';
import { chatRoutes } from '../../src/mock/chat';
import { C1, C2 } from '../../src/mock/fixtures/ids';
import { HANDOVER, OTHER, S1 } from '../../src/mock/fixtures/chatDemo';
import type { MockRoute } from '../../src/mock/types';

afterEach(() => vi.useRealTimers());

function setup(said?: (line: { line_id: string; conversation_id: string; character_id: string }) => (() => boolean) | undefined) {
  const routes: MockRoute[] = chatRoutes({ present: () => 'si', ...(said ? { said } : {}) });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const [path = '', qs = ''] = url.split('?');
    for (const r of routes) {
      if (r.method !== method) continue;
      const names = r.path.split('/');
      const parts = path.split('/');
      if (names.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (!names.every((n, i) => (n.startsWith(':') ? ((params[n.slice(1)] = parts[i]!), true) : n === parts[i]))) continue;
      return r.handler({ method, path, params, query: new URLSearchParams(qs), body });
    }
    throw new Error(`no route ${method} ${url}`);
  };
  const list = async (character: string, extra = '') => ((await call('GET', `/conversations?character=${character}${extra}`)).body as { conversations: WireConversation[]; busy: boolean }).conversations;
  const turns = async (id: string) => ((await call('GET', `/conversations/${id}/turns`)).body as { turns: WireTurn[] }).turns;
  return { call, list, turns };
}

const err = (r: { body: unknown }) => (r.body as { error: string }).error;

describe('chat mock › messages', () => {
  it('keeps an accepted message as a turn and moves the list row', async () => {
    const { call, list, turns } = setup();
    const before = (await list('si')).find((c) => c.id === C1)!;
    const sent = await call('POST', `/conversations/${C1}/messages`, { text: '好的，谢谢' });
    expect(sent.status).toBe(202);
    const last = (await turns(C1)).at(-1)!;
    expect(last.user_text).toBe('好的，谢谢');
    expect(last.reply).not.toBe('');
    const after = (await list('si')).find((c) => c.id === C1)!;
    expect(after.turn_count).toBe(before.turn_count + 1);
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    expect(after.preview).toBe(last.reply);
  });

  it('answers a quote of an unknown turn with 400 invalid_quote_turn and takes a known one', async () => {
    const { call, turns } = setup();
    const known = (await turns(C1))[0]!.turn_id!;
    for (const quote of [{ turn_id: 'nope', part: 'reply' }, { turn_id: known, part: 'other' }, { turn_id: known }]) {
      const r = await call('POST', `/conversations/${C1}/messages`, { text: '为什么？', quote_turn: quote });
      expect([r.status, err(r)]).toEqual([400, 'invalid_quote_turn']);
    }
    expect((await call('POST', `/conversations/${C1}/messages`, { text: '为什么？', quote_turn: { turn_id: known, part: 'reply' } })).status).toBe(202);
  });

  it('stops the scripted reply on cancel of its run, and refuses another run or conversation', async () => {
    const stop = vi.fn(() => true);
    const { call, turns } = setup(() => stop);
    expect((await call('POST', `/conversations/${C1}/cancel`, { run_id: 'x', generation: 1 })).status).toBe(409);
    const sent = (await call('POST', `/conversations/${C1}/messages`, { text: '帮我看看' })).body as { run_id: string; generation: number };
    expect((await call('POST', `/conversations/${'0'.repeat(32)}/cancel`, { run_id: sent.run_id, generation: sent.generation })).status).toBe(404);
    const wrong = await call('POST', `/conversations/${C1}/cancel`, { run_id: 'other', generation: sent.generation });
    expect([wrong.status, err(wrong)]).toEqual([409, 'run_changed']);
    expect(stop).not.toHaveBeenCalled();
    expect((await call('POST', `/conversations/${C1}/cancel`, { run_id: sent.run_id, generation: sent.generation })).status).toBe(202);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await turns(C1)).at(-1)).toMatchObject({ user_text: '帮我看看', state: 'cancelled', reply: '' });
  });

  it('plays a scripted reply that stop() cuts with a cancelled final frame and nothing after', () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];
    const stop = playOnce(replyScript({ line_id: 'l1', conversation_id: C1, character_id: 'si' }), false, (e: StreamEvent) => events.push(JSON.parse(e.data) as Record<string, unknown>));
    vi.advanceTimersByTime(500);
    expect(stop()).toBe(true);
    const seen = events.length;
    expect(events.at(-1)).toMatchObject({ final: true, cancelled: true });
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(seen);
    expect(stop()).toBe(false);
  });
});

describe('chat mock › revisions', () => {
  it('starts a new topic at revision 1 and refuses a stale version on PUT, DELETE and activate', async () => {
    const { call, list } = setup();
    const made = (await call('POST', '/conversations', { character_id: OTHER })).body as WireConversation;
    expect(made.revision).toBe(1);

    const stale = await call('PUT', `/conversations/${C2}`, { expected_version: 1, title: '改名' });
    expect([stale.status, err(stale)]).toEqual([409, 'version_conflict']);
    const renamed = await call('PUT', `/conversations/${C2}`, { expected_version: 2, title: '改名' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as WireConversation).revision).toBe(3);
    expect((await call('PUT', `/conversations/${C2}`, { expected_version: 2, title: '再改' })).status).toBe(409);

    // Not the busy present character: her activate and delete answer busy before the version is read.
    for (const stale of [() => call('POST', `/conversations/${HANDOVER}/activate`, { expected_version: 5 }), () => call('DELETE', `/conversations/${HANDOVER}`, { expected_version: 5 })]) {
      const r = await stale();
      expect([r.status, err(r)]).toEqual([409, 'version_conflict']);
    }
    expect((await list(OTHER)).some((c) => c.id === HANDOVER)).toBe(true);
    expect((await call('POST', `/conversations/${HANDOVER}/activate`, { expected_version: 1 })).status).toBe(200);
    expect((await call('DELETE', `/conversations/${HANDOVER}`, { expected_version: 2 })).status).toBe(200);
  });
});

describe('chat mock › archive and delete', () => {
  it('gives the owner a fresh active 新对话 when her active topic is archived or deleted', async () => {
    const { call, list } = setup();
    const archived = await call('PUT', `/conversations/${HANDOVER}`, { expected_version: 1, archived: true });
    expect((archived.body as WireConversation).active).toBe(false);
    const active = (await list(OTHER)).filter((c) => c.active);
    expect(active.map((c) => [c.title, c.revision, c.archived])).toEqual([['新对话', 1, false]]);

    expect((await call('DELETE', `/conversations/${active[0]!.id}`, { expected_version: 1 })).status).toBe(200);
    const next = (await list(OTHER)).filter((c) => c.active);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(active[0]!.id);
  });

  it('answers 409 busy for archiving the busy present character\'s active topic, but not another one', async () => {
    const { call } = setup();
    const busy = await call('PUT', `/conversations/${C1}`, { expected_version: 6, archived: true });
    expect([busy.status, err(busy)]).toEqual([409, 'busy']);
    expect((await call('PUT', `/conversations/${C2}`, { expected_version: 2, archived: true })).status).toBe(200);
  });
});

describe('chat mock › create', () => {
  it('rejects an owner that is not on the roster', async () => {
    const { call } = setup();
    for (const character_id of ['absent-from-catalog', 7]) {
      const r = await call('POST', '/conversations', { character_id });
      expect([r.status, err(r)]).toEqual([404, 'unknown_character']);
    }
  });
});

describe('chat mock › sparse demo', () => {
  it('lists only the owner\'s topics and lets its row be renamed, activated and sent to', async () => {
    const { call, list } = setup();
    const mine = await list('si', '&demo=sparse');
    expect(mine.map((c) => [c.id, c.active])).toEqual([[S1, true]]);
    expect(await list(OTHER, '&demo=sparse')).toEqual([]);

    const renamed = await call('PUT', `/conversations/${S1}`, { expected_version: 1, title: '早上' });
    expect(renamed.status).toBe(200);
    expect((await call('POST', `/conversations/${S1}/messages`, { text: '继续' })).status).toBe(202);
    expect((await list('si', '&demo=sparse'))[0]).toMatchObject({ id: S1, title: '早上', turn_count: 5 });
    const full = await list('si');
    expect(full.some((c) => c.id === S1)).toBe(false);
  });
});
