import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdConnection, AgentdResponse } from '../../src/bridge/protocol';
import { loadPending, loadRestOfList, loadTasksList } from '../../src/data/tasksBase';
import { WIRE_DELIVERIES, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { T6 } from '../../src/mock/fixtures/ids';
import { classify, loadTasksBase, TasksLoadError } from '../../src/pages/tasks/useTasksData';

/** Fake bridge whose agentd answers `override(path)` when it returns a response, else the normal mock. */
function install(conn: AgentdConnection, override: (path: string) => AgentdResponse<unknown> | null = () => null) {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const real = bridge.agentd.request.bind(bridge.agentd);
  vi.spyOn(bridge.agentd, 'connection').mockResolvedValue(conn);
  vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => (override(path) ?? (await real(method, path, body))) as never);
  window.agenticComplex = bridge;
}

async function failure(p: Promise<unknown>): Promise<TasksLoadError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(TasksLoadError);
  return e as TasksLoadError;
}

afterEach(() => {
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('task page load errors', () => {
  it('classifies 404, disconnected and other failures', () => {
    expect(classify({ status: 200 }, 'connected')).toBeNull();
    expect(classify({ status: 404 }, 'connected')).toBe('not_found');
    expect(classify({ status: 500 }, 'connected')).toBe('other');
    expect(classify({ status: 401 }, 'unauthorized')).toBe('other');
    expect(classify({ status: 0, error: { code: 'offline' } }, 'connected')).toBe('disconnected');
    expect(classify({ status: 0, error: { code: 'route_class' } }, 'connected')).toBe('other');
    expect(classify({ status: 503 }, 'offline')).toBe('disconnected');
  });

  it('404 on /agent/tasks only hides role tasks', async () => {
    install('connected', (path) => (path.startsWith('/agent/tasks?') ? { status: 404, body: null, error: { code: 'not_found' } } : null));
    const base = await loadTasksBase(false, { sessions: true, agent: true });
    expect(base.roleMissing).toBe(true);
    expect(base.offline).toBe(false);
    expect(base.tasks.length).toBeGreaterThan(0);
  });

  it('a failed request while agentd is offline is a disconnect, not an empty list', async () => {
    install('offline', () => ({ status: 0, body: null, error: { code: 'offline' } }));
    expect((await failure(loadTasksBase(false, { sessions: true, agent: true }))).kind).toBe('disconnected');
  });

  it('other failures surface with their status instead of an empty list', async () => {
    install('connected', (path) => (path === '/sessions' ? { status: 500, body: null, error: { code: 'internal', detail: 'boom' } } : null));
    const e = await failure(loadTasksBase(false, { sessions: true, agent: true }));
    expect(e.kind).toBe('other');
    expect(e.message).toBe('读取任务失败：后台出错了');
    expect(e.code).toBe('internal');
  });

  it('data the bridge still serves while offline is kept and marked offline', async () => {
    install('offline');
    const base = await loadTasksBase(false, { sessions: true, agent: true });
    expect(base.offline).toBe(true);
    expect(base.tasks.length).toBeGreaterThan(0);
  });
});

describe('task page reads split', () => {
  it('the pending read asks only /approvals and /agent/interactions', async () => {
    const paths: string[] = [];
    install('connected', (path) => {
      paths.push(path);
      return null;
    });
    const p = await loadPending();
    expect(paths.sort()).toEqual(['/agent/interactions', '/approvals']);
    expect(p.approvals.length + p.questions.length).toBeGreaterThan(0);
  });

  it('a pending read failure names 待处理 and keeps the cause apart', async () => {
    install('connected', (path) => (path === '/approvals' ? { status: 500, body: null, error: { code: 'internal' } } : null));
    const e = await failure(loadPending());
    expect(e.message).toBe('读取待处理失败：后台出错了');
    expect(e.reason).toBe('后台出错了');
  });

  it('the list reads the first page of tasks and deliveries; the rest joins it later', async () => {
    const t6 = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T6)!;
    const [d1, ...ds] = WIRE_DELIVERIES;
    const paths: string[] = [];
    install('connected', (path) => {
      paths.push(path);
      if (path === '/agent/tasks?limit=100') return { status: 200, body: { tasks: WIRE_TASK_ROWS.filter((r) => r !== t6), next_cursor: 'p2' } };
      if (path === '/agent/tasks?limit=100&cursor=p2') return { status: 200, body: { tasks: [t6], next_cursor: null } };
      if (path === '/agent/deliveries?limit=100') return { status: 200, body: { deliveries: [d1], next_cursor: 'd2' } };
      if (path === '/agent/deliveries?limit=100&cursor=d2') return { status: 200, body: { deliveries: ds, next_cursor: null } };
      return null;
    });
    const first = await loadTasksList(false, { sessions: true, agent: true });
    expect(first.next).toEqual({ tasks: 'p2', deliveries: 'd2' });
    expect(first.tasks.some((t) => t.id === T6)).toBe(false);
    expect(paths.some((p) => p.includes('cursor='))).toBe(false);
    expect(paths).not.toContain('/approvals');
    const all = await loadRestOfList(first, false);
    expect(all.next).toEqual({ tasks: null, deliveries: null });
    expect(all.tasks.some((t) => t.id === T6)).toBe(true);
    expect(paths.filter((p) => p.startsWith('/agent/tasks?') || p.startsWith('/agent/deliveries?')).sort()).toEqual([
      '/agent/deliveries?limit=100',
      '/agent/deliveries?limit=100&cursor=d2',
      '/agent/tasks?limit=100',
      '/agent/tasks?limit=100&cursor=p2',
    ]);
  });
});
