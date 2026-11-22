// @vitest-environment node
// The fake agentd answers each fixture-backed route with the shape agentd answers it with (protocol/C6-agentd-api/fixtures).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AGENTD_ROUTES } from '../../src/bridge/agentd-routes.generated';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { DIAG_STATE } from '../../src/mock/diag';
import { C1 } from '../../src/mock/fixtures/ids';
import { mismatches } from './shape';

const FIXTURES = new URL('../../../protocol/C6-agentd-api/fixtures/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const loose = read('loose-fields.json') as { nullable: Record<string, string[]>; free_keys: Record<string, string[]> };
const backed = AGENTD_ROUTES.filter((r) => r.response !== undefined);
// Ids the fake data has a row for.
const PARAMS: Record<string, string> = { conversation_id: C1, task_id: 'task-hostlink', date: '2026-11-04' };
const fill = (template: string) => template.replace(/:(\w+)/g, (_, name: string) => PARAMS[name] ?? `:${name}`);
// Native reads these host-only routes itself and pushes the body to a desktop panel's event.
const PUSHED: Record<string, (b: AgenticComplexBridge) => Promise<unknown>> = {
  'GET /desktop/presence': (b) => new Promise((resolve) => b.desktop.onPresence(resolve)),
};

async function body(r: (typeof backed)[number]): Promise<unknown> {
  const pushed = PUSHED[`${r.method} ${r.path}`];
  if (pushed) return pushed(createFakeBridge({ surface: 'stack', still: true }));
  const res = await createFakeBridge({ surface: 'main', still: true }).agentd.request(r.method, fill(r.templates[0] ?? r.path), r.method === 'GET' ? undefined : {});
  expect(res.status).toBe(200);
  return res.body;
}

describe('fake agentd bodies match the C6 fixtures', () => {
  it('GET /diag/state', async () => {
    const name = 'diag-state.json';
    const res = await createFakeBridge({ surface: 'main', still: true }).agentd.request('GET', '/diag/state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DIAG_STATE);
    expect(DIAG_STATE.gate.companion_mode).toBe(true);
    expect(DIAG_STATE.proactive.held).toBeNull();
    expect(mismatches(read(name), res.body, loose.nullable[name] ?? [], loose.free_keys[name] ?? [])).toEqual([]);
  });

  it('matches the observation state when observation is not authorized', async () => {
    const fixture: unknown = JSON.parse(readFileSync(new URL('../../../protocol/ui-bridge/responses/observation-state-unauthorized.json', import.meta.url), 'utf8'));
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const res = await bridge.agentd.request('GET', '/observation/state?demo=unauthorized');
    expect(res.status).toBe(200);
    expect(mismatches(fixture, res.body, [], [])).toEqual([]);
    expect(res.body).toEqual({ available: false, state: 'paused', tasks: [] });
  });

  it('has fixture-backed routes', () => {
    expect(backed.length).toBeGreaterThan(0);
  });

  it('pins idle state focus and presence role as well as the running fixtures', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const state = await bridge.agentd.request('GET', '/state?demo=empty');
    expect(state.status).toBe(200);
    const name = 'state-idle.json';
    expect(mismatches(read(name), { focus: (state.body as { focus: unknown }).focus }, loose.nullable[name] ?? [], [])).toEqual([]);
    vi.stubGlobal('location', { hash: '#/?demo=empty' });
    try {
      const presence = await new Promise<unknown>((resolve) => createFakeBridge({ surface: 'stack', still: true }).desktop.onPresence(resolve));
      const idle = 'desktop-presence-idle.json';
      expect(mismatches(read(idle), { role: (presence as { role: unknown }).role }, loose.nullable[idle] ?? [], [])).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('compares a fake presence row of every pending kind but reminders with the fixture', async () => {
    const presence = (await PUSHED['GET /desktop/presence']?.(createFakeBridge({ surface: 'stack', still: true }))) as { pending: Record<string, unknown> };
    const name = 'desktop-presence.json';
    for (const kind of ['questions', 'approvals', 'tasks', 'results']) expect(presence.pending[kind], kind).not.toEqual([]);
    const fixture = (read(name) as { pending: unknown }).pending;
    expect(mismatches({ pending: fixture }, { pending: presence.pending }, loose.nullable[name] ?? [], [])).toEqual([]);
  });

  it('compares active and candidate memory rows with the same fixture', async () => {
    const res = await createFakeBridge({ surface: 'main', still: true }).agentd.request<{ facts: Array<{ state: string }> }>('GET', '/memory');
    const facts = res.body?.facts ?? [];
    expect(facts.some((f) => f.state === 'active')).toBe(true);
    expect(facts.some((f) => f.state === 'candidate')).toBe(true);
    for (const fact of facts) {
      expect(mismatches(read('memory.json'), { ...res.body, facts: [fact] }, loose.nullable['memory.json'] ?? [], [])).toEqual([]);
    }
  });

  it('compares populated episode thread rows with the normalized fixture', async () => {
    const res = await createFakeBridge({ surface: 'main', still: true }).agentd.request<{ episodes: Array<{ threads: unknown[] }> }>('GET', '/episodes');
    const episodes = res.body?.episodes ?? [];
    expect(episodes.some((e) => e.threads.length > 0)).toBe(true);
    for (const episode of episodes) {
      for (const thread of episode.threads) {
        expect(mismatches(read('episodes.json'), { ...res.body, episodes: [{ ...episode, threads: [thread] }] }, loose.nullable['episodes.json'] ?? [], [])).toEqual([]);
      }
    }
  });

  it('reads work-memory fixtures and corrects a task with revision checks', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    for (const [path, name] of [
      ['/memory/sessions?day=2026-11-04', 'memory-sessions.json'],
      ['/memory/tasks', 'memory-tasks.json'],
      ['/memory/tasks/task-hostlink', 'memory-task.json'],
      ['/memory/days?from=2026-11-04&to=2026-11-04', 'memory-days.json'],
    ]) {
      const res = await bridge.agentd.request('GET', path!);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(read(name!));
    }
    const days = read('memory-days.json') as { days: unknown[] };
    expect((await bridge.agentd.request('GET', '/memory/days/2026-11-04')).body).toEqual(days.days[0]);
    const filtered = await bridge.agentd.request('GET', '/memory/tasks?status=done,uncertain');
    expect(filtered.body).toEqual({ tasks: [], counts: { active: 1, done: 0, parked: 0, uncertain: 0 } });
    const path = '/memory/tasks/task-hostlink';
    const stale = await bridge.agentd.request('PATCH', path, { expected_revision: 0, title: '覆盖' });
    expect(stale.status).toBe(409);
    const fixture = read('memory-task.json') as { task: Record<string, unknown> };
    expect(stale.body).toEqual({ error: 'revision_conflict', task: fixture.task });
    const edited = await bridge.agentd.request('PATCH', path, { expected_revision: 1, goal: '保留会话', status: 'done' });
    expect(edited.status).toBe(200);
    expect(edited.body).toEqual({ ...fixture.task, goal: '保留会话', goal_authority: 'user_corrected', status: 'done', edited: true, revision: 2 });
  });

  it.each(backed.map((r) => [`${r.method} ${r.templates[0]}`, r] as const))('%s', async (_, r) => {
    const name = r.response ?? '';
    const wire: unknown = JSON.parse(JSON.stringify(await body(r)));
    expect(mismatches(read(name), wire, loose.nullable[name] ?? [], loose.free_keys[name] ?? [])).toEqual([]);
  });
});
