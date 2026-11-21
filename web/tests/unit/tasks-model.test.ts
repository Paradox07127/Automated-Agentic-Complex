import { describe, expect, it } from 'vitest';
import { countWaiting, effectiveState } from '../../src/domain';
import { buildLanes } from '../../src/features/task/waterfall';
import { ACTIVE_RUNS, APPROVALS, DELIVERIES, GOALS, NOW, PENDING, QUESTIONS, SESSIONS, STEP_EVENTS, TASKS, TOOL_ITEMS } from '../../src/mock/fixtures';
import { routes } from '../../src/mock/tasks';
import { deriveView, emptyLocal, nextAfter } from '../../src/pages/tasks/model';
import type { TasksBase } from '../../src/pages/tasks/useTasksData';
import { A1, A2, A3, DLV_T1_V2, T1, T2, T4, T6 } from '../../src/mock/fixtures/ids';

const base: TasksBase = {
  tasks: TASKS,
  deliveries: DELIVERIES,
  sessions: SESSIONS,
  approvals: APPROVALS,
  questions: QUESTIONS,
  goals: GOALS,
  activeRuns: ACTIVE_RUNS,
  roleMissing: false,
};

describe('task page model', () => {
  it('derives the same pending set as the shared PENDING fixture', () => {
    const view = deriveView(base, emptyLocal());
    expect(view.pending.map((p) => p.id).sort()).toEqual(PENDING.map((p) => p.id).sort());
  });

  it('tab count and countWaiting agree', () => {
    const view = deriveView(base, emptyLocal());
    expect(view.waiting).toEqual(countWaiting(TASKS, { activeRuns: ACTIVE_RUNS, sessions: SESSIONS, pending: PENDING }));
    expect(view.waiting.items).toBe(PENDING.length);
  });

  it('the 待处理 band starts with the dangerous approval, then the shortest deadline', () => {
    const ids = deriveView(base, emptyLocal()).pending.map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual([A1, A2, A3]);
  });

  it('the next item takes the decided one’s place', () => {
    expect(nextAfter([A1, A2, A3], A1)).toBe(A2);
    expect(nextAfter([A1, A2, A3], A3)).toBe(A2);
    expect(nextAfter([A1], A1)).toBeNull();
  });

  it('accepting the review leaves t1 waiting only on its question', () => {
    const local = { ...emptyLocal(), decided: { [DLV_T1_V2]: { state: 'accepted' as const, at: NOW } } };
    const view = deriveView(base, local);
    expect(view.pending.some((p) => p.kind === 'review')).toBe(false);
    expect(view.tasks.find((t) => t.id === T1)?.status).toBe('accepted');
    expect(view.effective[T1]).toBe('waiting');
  });

  it('a stopped task drops its pending items and live run', () => {
    const view = deriveView(base, { ...emptyLocal(), stopped: { [T2]: NOW } });
    expect(view.effective[T2]).toBe('stopped');
    expect(view.pending.some((p) => p.task_id === T2)).toBe(false);
    expect(view.activeRuns[T2]).toBeUndefined();
    expect(effectiveState(view.tasks.find((t) => t.id === T2)!, view.ctx)).toBe('stopped');
  });
});

describe('run waterfall lanes', () => {
  it('numbers runs within the task while preserving their isolation generations', () => {
    const steps = (STEP_EVENTS[T1] ?? []).map((s) => ({ ...s, generation:s.generation+42 }));
    const lanes = buildLanes(steps, [], [], NOW);
    expect(lanes?.rows.map((r) => r.label)).toEqual(['第 1 次','第 2 次']);
    expect(lanes?.generations.map((g) => g.generation)).toEqual([42,43]);
  });
  it('draws one lane per generation and no terminal while the last run is live', () => {
    const lanes = buildLanes(STEP_EVENTS[T1] ?? [], TOOL_ITEMS[T1] ?? [], DELIVERIES, NOW);
    expect(lanes?.rows.map((r) => r.id)).toEqual(['g0', 'g1']);
    expect(lanes?.terminal).toBeNull();
    expect(lanes?.segments.filter((s) => s.status === 'current')).toHaveLength(1);
    expect(lanes?.marks.map((m) => m.label)).toEqual(expect.arrayContaining(['v1 已退回', '交付 v2']));
  });

  it('ends with ✕ on failure and ✓ on success', () => {
    const failed = buildLanes(STEP_EVENTS[T6] ?? [], TOOL_ITEMS[T6] ?? [], [], NOW);
    expect(failed?.terminal).toBe('failed');
    expect(failed?.segments.at(-1)?.status).toBe('failed');
    expect(buildLanes(STEP_EVENTS[T4] ?? [], [], [], NOW)?.terminal).toBe('ok');
    expect(buildLanes([], [], [], NOW)).toBeNull();
  });
});

describe('task mock endpoints', () => {
  const find = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  const req = (query = '') => ({ method: 'GET' as const, path: '', params: { id: DLV_T1_V2 }, query: new URLSearchParams(query), body: null });

  it('answers 404 for /agent/tasks in the error demo', async () => {
    expect((await find('GET', '/agent/tasks').handler(req('fail=1'))).status).toBe(404);
    expect((await find('GET', '/agent/tasks').handler(req())).status).toBe(200);
  });

  it('returns the decision failure code it is asked for', async () => {
    const res = await find('POST', '/agent/tasks/:id/accept').handler({ ...req('fail=delivery_scope_revoked'), method: 'POST', params: { id: T1 } });
    expect((res.body as { error?: string }).error).toBe('delivery_scope_revoked');
  });
});
