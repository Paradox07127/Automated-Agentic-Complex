import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse, StreamEvent } from '../../src/bridge/protocol';
import { formatClock, fromDelivery, type Delivery, type Task } from '../../src/domain';
import { TaskDrawer } from '../../src/features/task';
import { APPROVALS, atS, DELIVERIES, GOALS, NOW, pick, QUESTIONS, TASKS, WIRE_DELIVERIES, WIRE_RUNTIME, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { A2, DLV_T1_V2, G1, Q1, S_C07A, S_5E10, T1, T2, T3, T5, T6 } from '../../src/mock/fixtures/ids';
import { WIRE_SESSIONS } from '../../src/mock/fixtures/wire/work';
import { resetSchedules } from '../../src/mock/schedules';
import type { WireSchedule } from '../../src/domain/schedules';
import type { WireSession } from '../../src/domain/wire';
import { TasksPage } from '../../src/pages/tasks/Page';
import type { TasksListPage } from '../../src/data/tasksBase';
import { pluginsOn, pluginsReset } from './plugins';
import { createTasksActions, failMessage, NATIVE_OFF, type ActionDeps } from '../../src/pages/tasks/actions';
import { sendReceipt } from '../../src/pages/tasks/deliveryCalls';
import { Artifacts } from '../../src/pages/tasks/Artifacts';
import { draftFor, type CreateDraft } from '../../src/pages/tasks/CreateForm';
import { draftProblem, submitDraft } from '../../src/pages/tasks/create';
import { deriveView, emptyLocal, type TasksView } from '../../src/pages/tasks/model';
import { ApprovalPaper } from '../../src/pages/tasks/Papers';
import { TaskDetail } from '../../src/pages/tasks/TaskDetail';
import { useTaskDesk, type TaskDesk } from '../../src/pages/tasks/useTaskDesk';
import { kernelName, loadSessionLines, loadTaskExtras, parsePlanEvent, useTasksFeed, watchTasksFeed } from '../../src/pages/tasks/useTasksData';
import type { TasksBase } from '../../src/pages/tasks/useTasksData';
import { ToastHost } from '../../src/shell/toast';

type Call = { method: string; path: string; body: unknown };

/** Fake bridge with the normal mock; `override(method, path)` may answer instead. Returns the sent requests. */
function install(override: (method: string, path: string, body: unknown) => AgentdResponse<unknown> | null = () => null) {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const real = bridge.agentd.request.bind(bridge.agentd);
  const calls: Call[] = [];
  vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
    calls.push({ method, path, body });
    return (override(method, path, body) ?? (await real(method, path, body))) as never;
  });
  window.agenticComplex = bridge;
  return { bridge, calls };
}

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
  pluginsReset();
});

/** The whole tasks page at `/tasks?still=1<search>`, its feeds quiet; the bottom bar renders in place. */
function mountPage(bridge: ReturnType<typeof createFakeBridge>, search: string) {
  resetSchedules();
  vi.spyOn(bridge.feed, 'subscribe').mockImplementation(() => () => {});
  vi.spyOn(bridge.diag, 'subscribe').mockImplementation(() => () => {});
  const root = createRootRoute({
    component: () => (
      <>
        <TasksPage />
        <ToastHost />
      </>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/tasks?still=1${search}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const SCOPE = '5c0be1f2a3d4e5f60718293a4b5c6d7e';
const NOW_S = NOW / 1000;
const SCHED: WireSchedule = {
  schedule_id: 'schedule-9',
  title: '周报汇总',
  instruction: '汇总本周资料',
  trigger: { kind: 'session_done', target: null, project: null },
  enabled: false,
  created_from: 'user',
  conversation_id: null,
  scope_id: SCOPE,
  next_run_at: null,
  last_run_at: NOW_S - 600,
  last_job_id: null,
  last_error: 'scope_revoked',
  created_at: NOW_S - 86_400,
  updated_at: NOW_S - 600,
  accepted_at: NOW_S - 86_400,
};
const listed = (s: WireSchedule = SCHED) => ({ status: 200, body: { schedules: [s] } });
const runBtn = () => screen.findByRole('button', { name: '立即运行' });
const off = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';

const hexOf = (id: string) => id.slice(id.indexOf(':') + 1);
const delivery = (id: string): Delivery => fromDelivery(WIRE_DELIVERIES.find((d) => d.delivery_id === id)!);

function view(): TasksView {
  const deliveries = WIRE_DELIVERIES.map(fromDelivery);
  const base: TasksBase = { tasks: TASKS, deliveries, sessions: [], approvals: APPROVALS, questions: QUESTIONS, goals: GOALS, activeRuns: {}, roleMissing: false };
  base.sessions = [
    { id: S_C07A, task_id: T2, kind: 'code', own: true, target: 'codex', display_session: null, agent: 'Codex', title: 'companion', state: 'running', since: NOW, cwd: '~/Endfield/app' },
    { id: S_5E10, task_id: T5, kind: 'ext', own: false, target: 'claude', display_session: S_5E10, agent: 'Claude Code', title: 'Endfield', state: 'running', since: NOW, cwd: '~/Endfield' },
  ];
  return deriveView(base, emptyLocal());
}

function deps(v: TasksView = view()) {
  const push = vi.fn();
  const reload = vi.fn();
  const setDecideFail = vi.fn();
  const d: ActionDeps = {
    view: v,
    setLocal: vi.fn(),
    push,
    order: v.pending.map((p) => p.id),
    select: vi.fn(),
    failCode: null,
    setDecideFail,
    setBusy: vi.fn(),
    askStop: vi.fn(),
    retrySteps: vi.fn(),
    reload,
    now: () => NOW,
    nativeOff: vi.fn(),
  };
  return { ...d, push, reload, setDecideFail };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

/** One task's detail on the tasks page, over the fixture view; `over` replaces desk fields. */
function mountDetail(id: string, v: TasksView = view(), over: Partial<TaskDesk> = {}) {
  const d = deps(v);
  const desk = { view: v, actions: createTasksActions(d), local: emptyLocal(), receipt: vi.fn(), kernel: { data: '默认内核' }, now: NOW, push: d.push, retry: 0, busy: false, decideFail: null, nativeOff: {}, ...over } as unknown as TaskDesk;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TaskDetail task={pick(v.tasks, id)} desk={desk} who="陈千语" convTitle={() => null} onGoChat={() => {}} note={false} onNote={() => {}} />
      <ToastHost />
    </QueryClientProvider>,
  );
  return d;
}

const noop = () => {};
const files = (arts: Delivery['artifacts'], over: Partial<Parameters<typeof Artifacts>[0]> = {}) =>
  render(<Artifacts deliveries={[{ ...delivery(DLV_T1_V2), artifacts: arts }]} canReveal={false} nativeOff={{}} onOpen={noop} onReveal={noop} onCopy={noop} onRevert={noop} {...over} />);

describe('tasks: stop goes to the route of the task source', () => {
  it('role job → /agent/jobs/{hex}/cancel {}; own coding session → /sessions/{id}/interrupt with no body', async () => {
    const { calls } = install();
    const d = deps();
    await createTasksActions(d).stopNow([T1, T2]);
    expect(writes(calls)).toEqual([
      { method: 'POST', path: `/agent/jobs/${hexOf(T1)}/cancel`, body: {} },
      { method: 'POST', path: `/sessions/${S_C07A}/interrupt`, body: undefined },
    ]);
    expect(d.reload).toHaveBeenCalled();
    expect(String(d.push.mock.calls[0]?.[0])).toContain('已停止');
    // No 重新交派 action on the toast (redispatch is gone).
    expect(d.push.mock.calls[0]?.[1]).toBeUndefined();
  });
});

describe('tasks: stop replies in agentd\'s shapes', () => {
  it('a job waiting for review is not stopped (jobs.py cancel answers cancelled:false), so no 已停止', async () => {
    install();
    const d = deps();
    expect(pick(TASKS, T1).status).toBe('needs_review');
    await createTasksActions(d).stopNow([T1]);
    const said = d.push.mock.calls.map((c) => String(c[0]));
    expect(said.some((t) => t.includes('已停止'))).toBe(false);
    expect(said.join()).toContain('当前任务待复核，无法停止');
  });

  it('cancelled:false on a job that already ended says it ended, not that it waits for review', async () => {
    install((m, p) => (m === 'POST' && p.endsWith('/cancel') ? { status: 202, body: { job_id: hexOf(T1), cancelled: false } } : null));
    const v = view();
    const d = deps({ ...v, tasks: v.tasks.map((t) => (t.id === T1 ? { ...t, status: 'succeeded' as const } : t)) });
    await createTasksActions(d).stopNow([T1]);
    const said = d.push.mock.calls.map((c) => String(c[0])).join();
    expect(said).toContain('该任务已结束，无需停止');
    expect(said).not.toContain('验收');
    expect(said).not.toContain('已停止');
  });

  it('mock: a run cancel answers 202 {run_id, cancellation_requested}; resuming an unknown job is 400 unknown_job', async () => {
    const { bridge } = install();
    expect(await bridge.agentd.request('POST', '/agent/runs/run-9c1e/cancel', { generation: 1 })).toMatchObject({ status: 202, body: { run_id: 'run-9c1e', cancellation_requested: true } });
    const res = await bridge.agentd.request('POST', `/agent/jobs/${'0'.repeat(32)}/resume`, {});
    expect(res).toMatchObject({ status: 400, body: { error: 'unknown_job' } });
  });
});

describe('tasks: delivery decisions', () => {
  it('accept sends {expected_revision, generation, delivery_id} to /agent/tasks/{cid}/accept', async () => {
    const { calls } = install();
    const d = deps();
    const v2 = delivery(DLV_T1_V2);
    await createTasksActions(d).onTask(pick(TASKS, T1))({ kind: 'accept', deliveryId: DLV_T1_V2 });
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agent/tasks/${T1}/accept`, body: { expected_revision: v2.revision, generation: v2.generation, delivery_id: DLV_T1_V2 } }]);
    expect(d.reload).toHaveBeenCalled();
    expect(d.push).toHaveBeenCalledWith(`已接受 v${v2.version}`);
  });

  it('reject takes no note; the note goes on as the job resume text', async () => {
    const { calls } = install();
    const v2 = delivery(DLV_T1_V2);
    await createTasksActions(deps()).onTask(pick(TASKS, T1))({ kind: 'reject', deliveryId: DLV_T1_V2, note: '按作者拆一列', useCurrentKernel: false });
    expect(writes(calls)).toEqual([
      { method: 'POST', path: `/agent/tasks/${T1}/reject`, body: { expected_revision: v2.revision, generation: v2.generation, delivery_id: DLV_T1_V2 } },
      { method: 'POST', path: `/agent/jobs/${hexOf(T1)}/resume`, body: { text: '按作者拆一列', use_current_backend: false } },
    ]);
  });

  it('a 409 shows the decision failure and reloads', async () => {
    install((method, path) => (path.endsWith('/accept') ? { status: 409, body: { error: 'delivery_version_changed' }, error: { code: 'delivery_version_changed' } } : null));
    const d = deps();
    await createTasksActions(d).onTask(pick(TASKS, T1))({ kind: 'accept', deliveryId: DLV_T1_V2 });
    expect(d.setDecideFail).toHaveBeenLastCalledWith('delivery_version_changed');
    expect(d.reload).toHaveBeenCalled();
  });

  it('receipts send {expected_revision, generation} and return the reply delivery', async () => {
    const wire = WIRE_DELIVERIES.find((x) => x.delivery_id === DLV_T1_V2)!;
    const { calls } = install((method, path) => (path.endsWith('/viewed') ? { status: 200, body: { delivery: { ...wire, revision: wire.revision + 1, viewed_at: atS(14, 32) } } } : null));
    const d = { ...delivery(DLV_T1_V2), viewed_at: null };
    const next = await sendReceipt(d, 'viewed');
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agent/deliveries/${DLV_T1_V2}/viewed`, body: { expected_revision: d.revision, generation: d.generation } }]);
    expect(next.revision).toBe(d.revision + 1);
    expect(next.viewed_at).toBeGreaterThan(1e12);
  });
});

describe('tasks: opening an artifact', () => {
  it('a delivered file → POST /agent/deliveries/{id}/opened {artifact_id} on its newest delivery, then reload; another file posts nothing', async () => {
    const { bridge, calls } = install();
    vi.spyOn(bridge.open, 'artifact').mockResolvedValue(undefined as never);
    const d = deps();
    const art = delivery(DLV_T1_V2).artifacts[0]!;
    await createTasksActions(d).onTask(pick(TASKS, T1))({ kind: 'open_artifact', path: art.path });
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agent/deliveries/${DLV_T1_V2}/opened`, body: { artifact_id: art.artifact_id } }]);
    expect(d.reload).toHaveBeenCalled();
    expect(d.setLocal).not.toHaveBeenCalled();
    calls.length = 0;
    await createTasksActions(deps()).onTask(pick(TASKS, T1))({ kind: 'open_artifact', path: '/Users/me/other.md' });
    expect(writes(calls)).toEqual([]);
  });
});

describe('tasks: continue, session message, approvals, questions, goals', () => {
  it('continue on a job → /agent/jobs/{hex}/resume {text, use_current_backend}', async () => {
    const { calls } = install();
    await createTasksActions(deps()).onTask(pick(TASKS, T3))({ kind: 'continue', note: '保留两位小数', useCurrentKernel: true });
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agent/jobs/${hexOf(T3)}/resume`, body: { text: '保留两位小数', use_current_backend: true } }]);
  });

  it('a message to the coding session → /sessions/{id}/messages {text}', async () => {
    const { calls } = install();
    const d = deps();
    await createTasksActions(d).onTask(pick(TASKS, T2))({ kind: 'send_session', text: '先跑测试' });
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/sessions/${S_C07A}/messages`, body: { text: '先跑测试' } }]);
    expect(d.push).toHaveBeenCalledWith('已发送至编码会话');
  });

  it('approval decision carries the card generation; a 409 says 已在别处更新 and reloads', async () => {
    const a2 = pick(APPROVALS, A2);
    const { calls } = install();
    await createTasksActions(deps()).approve([A2], 'allow');
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/approvals/${A2}/decision`, body: { generation: a2.generation, decision: 'allow' } }]);
    cleanup();
    vi.restoreAllMocks();
    install(() => ({ status: 409, body: { ok: false, error: 'generation_mismatch' }, error: { code: 'generation_mismatch' } }));
    const d = deps();
    await createTasksActions(d).approve([A2], 'deny');
    expect(d.push).toHaveBeenCalledWith('已在其他位置更新', { severity: 'danger' });
    expect(d.reload).toHaveBeenCalled();
  });

  it('answer sends {expected_version, answers}; dismiss sends {expected_version}', async () => {
    const q = pick(QUESTIONS, Q1);
    const { calls } = install();
    const a = createTasksActions(deps());
    await a.answer(q, { scope: ['单列一节'] });
    await a.cancelQuestion(q);
    expect(writes(calls)).toEqual([
      { method: 'POST', path: `/agent/interactions/${Q1}/answer`, body: { expected_version: q.revision, answers: { scope: ['单列一节'] } } },
      { method: 'POST', path: `/agent/interactions/${Q1}/dismiss`, body: { expected_version: q.revision } },
    ]);
  });

  it('goal pause → POST /agent/goals/{id} {expected_version, state}', async () => {
    const g = pick(GOALS, G1);
    const { calls } = install();
    await createTasksActions(deps()).goal(g, 'pause');
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agent/goals/${G1}`, body: { expected_version: g.revision, state: 'paused' } }]);
  });

  it('offline says 后台已断开', async () => {
    install((method) => (method === 'POST' ? { status: 0, body: null, error: { code: 'offline' } } : null));
    const d = deps();
    await createTasksActions(d).goal(pick(GOALS, G1), 'pause');
    expect(d.push).toHaveBeenCalledWith('后台服务已断开', { severity: 'danger' });
  });
});

describe('tasks: create', () => {
  it('role with 不读资料 → POST /agent/jobs {title, text, scope_id: null, expected_outputs}', async () => {
    const { calls } = install();
    const draft: CreateDraft = { ...draftFor('role'), title: '汇总纪要', brief: '合成一份', artifact: '会议/汇总.md', sections: '待办、负责人' };
    const r = await submitDraft(draft);
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/agent/jobs', body: { title: '汇总纪要', text: '合成一份', scope_id: null, expected_outputs: { artifacts: [{ path: '会议/汇总.md', checks: { required_sections: ['待办', '负责人'] } }] } } },
    ]);
    expect(r.select).toMatch(/^job:[a-f0-9]{32}$/);
  });

  it('code → POST /sessions {target, cwd: picked handle, prompt, mode}; a role task with a scope sends scope_id', async () => {
    const { calls } = install();
    const cwd = { handle: 'h-1', displayName: 'agent' };
    await submitDraft({ ...draftFor('code'), brief: '补测试', agent: 'codex', cwd, mode: 'workspace_write' });
    await submitDraft({ ...draftFor('role'), title: '汇总纪要', brief: '合成一份', scopeId: 'scope-1' });
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/sessions', body: { target: 'codex', cwd, prompt: '补测试', mode: 'workspace_write' } },
      { method: 'POST', path: '/agent/jobs', body: { title: '汇总纪要', text: '合成一份', scope_id: 'scope-1' } },
    ]);
  });

  it('a code task needs a picked folder; an artifact must be a relative md/txt/csv/json path', () => {
    expect(draftProblem({ ...draftFor('code'), cwd: null }, true)).toBe('请先选择工作目录');
    expect(draftProblem({ ...draftFor('code'), cwd: null }, false)).toBe('当前客户端环境不支持原生目录选择');
    expect(draftProblem({ ...draftFor('role'), title: '测试', brief: '测试要求', acceptanceOpen: true, artifact: '/abs/a.md' }, true)).toContain('相对路径');
    expect(draftProblem({ ...draftFor('role'), title: '测试', brief: '测试要求', acceptanceOpen: true, artifact: 'a.docx' }, true)).toContain('相对路径');
  });
});

describe('tasks: reads', () => {
  it('refreshes a cached task when it finished on another page', async () => {
    const task = WIRE_TASK_ROWS.find((row) => row.canonical_task_id === T1)!;
    let rows = [{ ...task, state: 'running' as const, delivery: null } as typeof task];
    install((method, path) => method === 'GET' && path.startsWith('/agent/tasks?') ? { status: 200, body: { tasks: rows, next_cursor: null } } : null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useTaskDesk(null, null, null), { wrapper });
    await waitFor(() => expect(first.result.current.view?.tasks.find((t) => t.id === T1)?.status).toBe('running'));
    first.unmount();
    rows = [task];
    const returned = renderHook(() => useTaskDesk(null, null, null), { wrapper });
    await waitFor(() => expect(returned.result.current.view?.tasks.find((t) => t.id === T1)?.status).toBe('needs_review'));
    expect(returned.result.current.view?.tasks.find((t) => t.id === T1)?.summary).toContain('142 条');
  });

  it('extras: steps by canonical id, items of each step run (tool calls only), files, plan item and run failure', async () => {
    const { calls } = install();
    const x = await loadTaskExtras(pick(TASKS, T6), false);
    const gets = calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(gets).toEqual(expect.arrayContaining([`/agent/tasks/${T6}/steps`, `/agent/tasks/${T6}/files`, '/agent/runs?run_id=run-0f11', '/agent/runs/run-0f11/items']));
    expect(x.steps[0]?.at).toBeGreaterThan(1e12);
    expect(x.tools.every((t) => t.kind === 'tool_call')).toBe(true);
    expect(x.failure?.reason).toContain('资料访问授权已撤销');
    expect(x.moreSteps).toBe(false);
    const t1 = await loadTaskExtras(pick(TASKS, T1), false);
    expect(t1.plan?.steps.map((s) => s.status)).toContain('in_progress');
    expect(t1.files[0]?.path.startsWith('/')).toBe(true);
  });

  it('extras: a tool call still open when its run ended shows as failed, not running', async () => {
    const real = createFakeBridge({ surface: 'main', still: true });
    const listed = (await real.agentd.request('GET', '/agent/runs/run-0f11/items', undefined)) as AgentdResponse<{ items: Record<string, unknown>[] }>;
    const open = { ...listed.body!.items[0]!, status: 'started' };
    install((method, path) => (method === 'GET' && path === '/agent/runs/run-0f11/items' ? { status: 200, body: { items: [open] } } as never : null));
    const x = await loadTaskExtras(pick(TASKS, T6), false);
    expect(x.tools.map((t) => t.status)).toEqual(['failed']);
  });

  it('an external task reads nothing', async () => {
    const { calls } = install();
    const x = await loadTaskExtras(pick(TASKS, T5), false);
    expect(calls).toEqual([]);
    expect(x.steps).toEqual([]);
  });

  it('kernel name from /character/runtime; session lines from /sessions/{id}/lines', async () => {
    const { calls } = install();
    const selected = WIRE_RUNTIME.available_backends.find((b) => b.id === WIRE_RUNTIME.backend)?.title;
    expect(kernelName(WIRE_RUNTIME)).toBe(selected);
    expect((await loadSessionLines(S_C07A)).lines.length).toBeGreaterThan(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /sessions/${S_C07A}/lines`]);
  });

  it('feed: plan events become plans by run; task events ask for a reload', () => {
    let emit: (e: StreamEvent) => void = () => {};
    const { bridge } = install();
    vi.spyOn(bridge.feed, 'subscribe').mockImplementation((on) => {
      emit = on;
      return () => {};
    });
    const onPlan = vi.fn();
    const onChange = vi.fn();
    const off = watchTasksFeed(onPlan, onChange, () => true);
    emit({ event: 'plan', id: '5', data: JSON.stringify({ run_id: 'run-8d03', revision: 3, title: 't', steps: [{ text: 'a', status: 'completed' }], status: 'in_progress', at: 1_800_000_000 }) });
    expect(onPlan).toHaveBeenCalledWith('run-8d03', expect.objectContaining({ revision: 3, at: 1_800_000_000_000 }));
    emit({ event: 'delivery', id: '6', data: '{}' });
    emit({ event: 'agent_item', id: '7', data: JSON.stringify({ run_id: 'run-8d03', item_id: 'i1' }) });
    emit({ event: 'line', id: '8', data: '{}' });
    expect(onChange.mock.calls).toEqual([['base'], ['extras']]);
    off();
    expect(parsePlanEvent('not json')).toBeNull();
  });
});

describe('tasks: what the page shows', () => {
  it('artifacts: each file names its check, its version in the hover title; open and copy use the absolute path', () => {
    const arts = delivery(DLV_T1_V2).artifacts;
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    files(arts, { onOpen, onCopy });
    const tile = within(screen.getByRole('group', { name: '产物' })).getByRole('button', { name: new RegExp(arts[0]!.name) });
    expect(tile.getAttribute('title')).toContain(`v${arts[0]!.version}`);
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledWith(arts[0]!.absolute_path);
    fireEvent.contextMenu(tile);
    fireEvent.click(within(screen.getByRole('menu', { name: arts[0]!.name })).getByRole('menuitem', { name: '复制路径' }));
    expect(onCopy).toHaveBeenCalledWith(arts[0]!.absolute_path);
  });

  it('a revoked delivery shows one placeholder line instead of the files', () => {
    render(<Artifacts deliveries={[{ ...delivery(DLV_T1_V2), redacted: true, artifacts: [] }]} canReveal={false} nativeOff={{}} onOpen={noop} onReveal={noop} onCopy={noop} onRevert={noop} />);
    expect(document.body.textContent).toContain('该版本已撤回');
    expect(screen.queryByRole('group', { name: '产物' })).toBeNull();
  });
});

const callError = (status: number, code: string) => new AgentdCallError(status, code, undefined, { error: code }, code);

describe('tasks: failure reasons and native entries', () => {
  it('renders an untruncated structured task result and strips the leading delivery marker', () => {
    const task = { ...pick(TASKS, T1), summary: '[int:explain] ## 推荐\n\n- 先做 **A**\n- 再做 C\n\n| 方案 | 成本 |\n| --- | --- |\n| A + C | 32 |\n\n最终预算余量 8' };
    const v = view();
    mountDetail(T1, { ...v, tasks: v.tasks.map((t) => (t.id === T1 ? task : t)) });
    const result = screen.getByRole('region', { name: '任务结果' });
    expect(result.textContent).not.toContain('[int:explain]');
    expect(within(result).getAllByRole('listitem')).toHaveLength(2);
    expect(within(within(result).getByRole('table')).getByRole('cell', { name: '32' }).textContent).toBe('32');
    expect(result.textContent).toContain('最终预算余量 8');
  });

  it('a message while the session runs a turn (409 busy) says to wait, not 已在别处更新, and does not reload', async () => {
    install((method, path) => (path.endsWith('/messages') ? { status: 409, body: { error: 'busy' }, error: { code: 'busy' } } : null));
    const d = deps();
    await createTasksActions(d).onTask(pick(TASKS, T2))({ kind: 'send_session', text: '先跑测试' });
    expect(d.push).toHaveBeenCalledWith('会话正在执行当前轮次，请等待结束后发送', { severity: 'danger' });
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('goal and job codes agentd sends have Chinese reasons', () => {
    for (const code of ['goal_results_not_verified', 'goal_results_not_current', 'job_not_resumable', 'goal_not_active']) {
      const text = failMessage(callError(400, code));
      expect(text).not.toContain(code);
      expect(text).not.toContain('没有完成');
    }
  });

  it('a decision failure outside DECIDE_FAIL reloads once', async () => {
    install((method, path) => (path.endsWith('/accept') ? { status: 409, body: { error: 'version_conflict' }, error: { code: 'version_conflict' } } : null));
    const d = deps();
    await createTasksActions(d).onTask(pick(TASKS, T1))({ kind: 'accept', deliveryId: DLV_T1_V2 });
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('op_not_allowed on open, copy or jump marks the entry off once', async () => {
    const { bridge } = install();
    vi.spyOn(bridge.open, 'artifact').mockRejectedValue({ code: 'op_not_allowed' });
    vi.spyOn(bridge.clipboard, 'writeText').mockRejectedValue({ code: 'not_implemented' });
    vi.spyOn(bridge.open, 'jumpToSession').mockRejectedValue({ code: 'op_not_allowed' });
    const d = { ...deps(), nativeOff: vi.fn() };
    const on = createTasksActions(d).onTask(pick(TASKS, T1));
    await on({ kind: 'open_artifact', path: '/a.md' });
    await on({ kind: 'copy_path', path: '/a.md' });
    await on({ kind: 'jump_terminal', sessionId: S_C07A });
    expect(d.nativeOff.mock.calls).toEqual([['artifact'], ['copy'], ['jump']]);
  });

  it('entries marked off: a file opens nothing and says why; 打开 and 复制路径 are disabled with the reason', () => {
    const arts = delivery(DLV_T1_V2).artifacts;
    const onOpen = vi.fn();
    files(arts, { onOpen, nativeOff: { artifact: NATIVE_OFF.artifact, copy: NATIVE_OFF.copy } });
    const tile = within(screen.getByRole('group', { name: '产物' })).getByRole('button', { name: new RegExp(arts[0]!.name) });
    fireEvent.click(tile);
    expect(onOpen).not.toHaveBeenCalled();
    expect(tile.getAttribute('title')).toContain(NATIVE_OFF.artifact);
    fireEvent.contextMenu(tile);
    for (const [name, why] of [['打开', NATIVE_OFF.artifact], ['复制路径', NATIVE_OFF.copy]] as const) {
      // The shared menu writes the reason after the label.
      const it = screen.getByRole('menuitem', { name: `${name}${why}` });
      expect(it.getAttribute('aria-disabled')).toBe('true');
      expect(it.getAttribute('title')).toBe(why);
    }
  });

  it('a failed /sessions/{id}/lines read says 会话输出没读到 with a retry, not 还没有输出', async () => {
    let fail = true;
    const { calls } = install((method, path) => (path.endsWith('/lines') && fail ? { status: 500, body: { error: 'internal' }, error: { code: 'internal' } } : null));
    mountDetail(T2);
    await waitFor(() => expect(document.body.textContent).toContain('未能读取会话输出'));
    expect(document.body.textContent).not.toContain('还没有输出');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/lines'))).toHaveLength(2));
  });

  it('a JSON approval preview names the call as server │ tool; the JSON follows as it came', () => {
    const preview_text = JSON.stringify({ server: 'files', tool: 'write_file', arguments: { path: '/a.md' } }, null, 2);
    const q = { ...pick(QUESTIONS, Q1), interaction_kind: 'approval' as const, preview_text };
    const { container } = render(<ApprovalPaper item={q} kernelName="默认内核" scopeLabel="这个任务里都允许" onDecide={noop} onMouseOnly={noop} />);
    expect(container.querySelector('code')?.textContent).toBe('files │ write_file');
    expect(container.querySelector('pre')?.textContent).toBe(preview_text);
  });
});

describe('tasks: feed reads only what changed', () => {
  function feed(selected: (runId: string) => boolean) {
    let emit: (e: StreamEvent) => void = () => {};
    const { bridge } = install();
    vi.spyOn(bridge.feed, 'subscribe').mockImplementation((on) => {
      emit = on;
      return () => {};
    });
    const onChange = vi.fn();
    watchTasksFeed(() => {}, onChange, selected);
    return { emit: (event: string, data: object) => emit({ event, id: '1', data: JSON.stringify(data) }), onChange };
  }

  it('agent_run reloads the snapshot only when the run lifecycle phase changes', () => {
    const { emit, onChange } = feed(() => true);
    emit('agent_run', { run_id: 'run-1', phase: 'running' });
    emit('agent_run', { run_id: 'run-1', phase: 'tool_started' });
    emit('agent_run', { run_id: 'run-1', phase: 'tool_finished' });
    emit('agent_run', { run_id: 'run-1', phase: 'first_token' });
    emit('agent_run', { run_id: 'run-1', phase: 'verifying' });
    expect(onChange.mock.calls).toEqual([['base'], ['base']]);
  });

  it('agent_item re-reads details only for a run of the selected task', () => {
    const { emit, onChange } = feed((r) => r === 'run-mine');
    emit('agent_item', { run_id: 'run-other', item_id: 'i1' });
    emit('agent_item', { run_id: 'run-mine', item_id: 'i2' });
    expect(onChange.mock.calls).toEqual([['extras']]);
  });

  it('a burst while a read is in flight runs one more read after it, not one per event', async () => {
    vi.useFakeTimers();
    try {
      let emit: (e: StreamEvent) => void = () => {};
      const { bridge } = install();
      vi.spyOn(bridge.feed, 'subscribe').mockImplementation((on) => {
        emit = on;
        return () => {};
      });
      let finish: () => void = () => {};
      const onChange = vi.fn(() => new Promise<void>((r) => (finish = r)));
      renderHook(() => useTasksFeed(onChange, () => true));
      emit({ event: 'delivery', id: '1', data: '{}' });
      await vi.advanceTimersByTimeAsync(300);
      expect(onChange).toHaveBeenCalledTimes(1);
      emit({ event: 'delivery', id: '2', data: '{}' });
      await vi.advanceTimersByTimeAsync(300);
      emit({ event: 'delivery', id: '3', data: '{}' });
      await vi.advanceTimersByTimeAsync(300);
      expect(onChange).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tasks: own coding session rename, archive, delete (⋯)', () => {
  const mountSelected = (task: typeof T2 | typeof T5 = T2) => mountDetail(task);
  const item = async (name: string | RegExp) => {
    fireEvent.click(await screen.findByRole('button', { name: '会话操作' }));
    const it = await screen.findByRole('menuitem', { name });
    expect(it.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(it);
  };

  it('rename PUTs /sessions/{own id} with expected_version from GET /sessions and the trimmed title', async () => {
    const { calls } = install();
    mountSelected();
    await item('重命名…');
    const dlg = screen.getByRole('dialog', { name: '重命名会话' });
    const input = within(dlg).getByRole('textbox', { name: '会话标题' }) as HTMLInputElement;
    expect(input.value).toBe('修 HostLink 断线重连');
    fireEvent.change(input, { target: { value: '  HostLink 重连  ' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(writes(calls)).toEqual([{ method: 'PUT', path: `/sessions/${S_C07A}`, body: { expected_version: 1, title: 'HostLink 重连' } }]));
    expect(await screen.findByText('已重命名为：HostLink 重连')).toBeTruthy();
  });

  it('archive PUTs {expected_version, archived: true}', async () => {
    const { calls } = install();
    mountSelected();
    await item('归档');
    await waitFor(() => expect(writes(calls)).toEqual([{ method: 'PUT', path: `/sessions/${S_C07A}`, body: { expected_version: 1, archived: true } }]));
    expect(await screen.findByText('已归档会话')).toBeTruthy();
  });

  it('delete asks first; confirming DELETEs with {expected_version}; cancelling sends nothing', async () => {
    const { calls } = install();
    mountSelected();
    await item('删除…');
    let dlg = screen.getByRole('dialog', { name: /删除会话「修 HostLink 断线重连」/ });
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    expect(writes(calls)).toEqual([]);
    await item('删除…');
    dlg = screen.getByRole('dialog', { name: /删除会话/ });
    fireEvent.click(within(dlg).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(writes(calls)).toEqual([{ method: 'DELETE', path: `/sessions/${S_C07A}`, body: { expected_version: 1 } }]));
    expect(await screen.findByText('已删除会话')).toBeTruthy();
  });

  it('a 409 version_conflict says 已在别处更新 and reads /sessions again; 409 busy says to stop first', async () => {
    let code = 'version_conflict';
    const { calls } = install((method, path) => (method !== 'GET' && path.startsWith('/sessions/own:') ? { status: 409, body: { error: code }, error: { code } } : null));
    mountSelected();
    await item('归档');
    expect(await screen.findByText('已在其他位置更新')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/sessions')).toHaveLength(2));
    code = 'busy';
    await item('删除…');
    fireEvent.click(within(screen.getByRole('dialog', { name: /删除会话/ })).getByRole('button', { name: '删除' }));
    expect(await screen.findByText('会话正在执行当前轮次，请先停止后再归档或删除')).toBeTruthy();
  });

  it('an external session has no ⋯ session menu', async () => {
    install();
    mountSelected(T5);
    await screen.findByRole('heading', { name: pick(TASKS, T5).title });
    expect(screen.queryByRole('button', { name: '会话操作' })).toBeNull();
  });
});


describe('chat TaskDrawer: what it offers', () => {
  const t1 = pick(TASKS, T1);
  const v2 = pick(DELIVERIES, DLV_T1_V2);
  const continueBox = () => document.querySelector('[data-stub="RejectBox"][data-mode="continue"]');

  it('a failed role job whose latest version was decided still offers 继续', () => {
    const decided: Delivery = { ...v2, state: 'rejected', decided_at: NOW - 60_000 };
    render(<TaskDrawer task={{ ...t1, status: 'failed' }} effective="failed" now={NOW} delivery={decided} />);
    expect(screen.getByText(/当前版本已驳回/)).toBeTruthy();
    expect(continueBox()).not.toBeNull();
  });

  it('a running foreground ledger task offers no 继续 agentd would refuse as character_busy', () => {
    const ledger: Task = { ...t1, id: 'task:character-run-77a2', job_id: null, task_id: 'character-run-77a2', target: 'character', status: 'running' };
    render(<TaskDrawer task={ledger} effective="running" now={NOW} />);
    expect(continueBox()).toBeNull();
  });

  it('while a reject is being sent, 接受这一版 and the reject toggle are locked', () => {
    const onAction = vi.fn();
    render(<TaskDrawer task={t1} effective="waiting" now={NOW} delivery={v2} rejecting busy onAction={onAction} />);
    const accept = screen.getByText('接受这一版').closest('button')!;
    expect(accept.getAttribute('aria-disabled') === 'true' || accept.disabled).toBe(true);
    fireEvent.click(accept);
    fireEvent.click(screen.getByText('收起').closest('button')!);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText('驳回并继续')).toBeTruthy();
  });

  it('a cancelled task with no stop time given shows when it ended', () => {
    const ended = NOW - 5 * 60_000;
    render(<TaskDrawer task={{ ...t1, status: 'cancelled', ended_at: ended }} effective="stopped" now={NOW} />);
    expect(screen.getByRole('status').textContent).toContain(formatClock(ended));
  });
});

describe('tasks: 立即运行 on a schedule', () => {
  // Under a bridge the page clock is the wall clock; the fixture scope is in force at NOW.
  beforeEach(() => void vi.spyOn(Date, 'now').mockReturnValue(NOW));

  it('a schedule whose last run failed but whose scope is in force can run now; a scope gone now blocks it', async () => {
    const { bridge } = install((m, p) => (m === 'GET' && p === '/schedules' ? listed() : null));
    mountPage(bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    await waitFor(async () => expect(off(await runBtn())).toBe(false));
    cleanup();
    const gone = install((m, p) => (m === 'GET' && p === '/schedules' ? listed({ ...SCHED, scope_id: 'f'.repeat(32) }) : null));
    mountPage(gone.bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    await screen.findByText('原授权当前不可用');
    expect(off(await runBtn())).toBe(true);
  });

  it('a refused run still reads /schedules again', async () => {
    const { bridge, calls } = install((m, p) =>
      m === 'GET' && p === '/schedules' ? listed() : m === 'POST' && p.endsWith('/run') ? { status: 409, body: { error: 'scope_revoked' }, error: { code: 'scope_revoked' } } : null,
    );
    mountPage(bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    await waitFor(async () => expect(off(await runBtn())).toBe(false));
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/schedules').length;
    const before = reads();
    await act(async () => fireEvent.click(await runBtn()));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('two clicks before agentd answers send one run', async () => {
    let answer: (r: unknown) => void = () => {};
    const { bridge, calls } = install((m, p) =>
      m === 'GET' && p === '/schedules' ? listed() : m === 'POST' && p.endsWith('/run') ? (new Promise((r) => (answer = r)) as never) : null,
    );
    mountPage(bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    await waitFor(async () => expect(off(await runBtn())).toBe(false));
    const btn = await runBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => answer({ status: 202, body: { schedule_id: SCHED.schedule_id, job_id: 'j' } }));
    expect(writes(calls).filter((c) => c.path.endsWith('/run'))).toHaveLength(1);
  });
});

describe('tasks: 看那次任务 opens that job where it is', () => {
  beforeEach(() => void vi.spyOn(Date, 'now').mockReturnValue(NOW));

  it("a schedule whose last job is still running shows that job's detail on 进行中", async () => {
    const { bridge } = install((m, p) => (m === 'GET' && p === '/schedules' ? listed({ ...SCHED, last_job_id: hexOf(T3) }) : null));
    mountPage(bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    fireEvent.click(await screen.findByRole('button', { name: '查看该次任务' }));
    expect(await screen.findByRole('heading', { name: '汇总 10 月开销表' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /进行中/ }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.querySelector(`[data-row="${T3}"]`)?.getAttribute('aria-selected')).toBe('true'));
  });

  it('a selection that is not among the rows says so instead of showing the first row', async () => {
    const { bridge } = install();
    mountPage(bridge, `&tab=done&sel=${T3}`);
    expect(await screen.findByText('未在当前列表中找到该项')).toBeTruthy();
    expect(document.querySelector('[data-row][aria-selected="true"]')).toBeNull();
  });

  it('a selected finished task past the first page of 已完成 shows its detail', async () => {
    const t6 = WIRE_TASK_ROWS.find((r) => r.canonical_task_id === T6)!;
    const old = Array.from({ length: 25 }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(32, '0');
      return { ...t6, canonical_task_id: `job:${hex}`, job_id: hex, run_id: null, run_count: 0, title: `旧任务 ${i + 1}`, created_at: t6.created_at - 3600 * (i + 1), updated_at: t6.updated_at - 3600 * (i + 1) };
    });
    const { bridge } = install((m, p) => (m === 'GET' && p.startsWith('/agent/tasks?') ? { status: 200, body: { tasks: [...WIRE_TASK_ROWS, ...old], next_cursor: null } } : null));
    mountPage(bridge, `&tab=done&sel=${old[24]!.canonical_task_id}`);
    expect(await screen.findByRole('heading', { name: '旧任务 25' })).toBeTruthy();
    expect(screen.queryByText('未在当前列表中找到该项')).toBeNull();
  });
});

describe('tasks: a pending read that half failed', () => {
  beforeEach(() => void vi.spyOn(Date, 'now').mockReturnValue(NOW));

  it('says so on 进行中 instead of listing no approvals', async () => {
    const { bridge } = install((m, p) => (m === 'GET' && p === '/approvals' ? { status: 503, body: null, error: { code: 'unavailable' } } : null));
    mountPage(bridge, '');
    expect(await screen.findByText('待处理任务未能完整读取')).toBeTruthy();
  });

  it('a part whose plug-in is off is not a failure', async () => {
    const { bridge } = install((m, p) => (m === 'GET' && p === '/agent/interactions' ? { status: 409, body: { error: 'plugin_off' }, error: { code: 'plugin_off' } } : null));
    mountPage(bridge, '');
    expect(await screen.findByRole('tab', { name: /进行中/ })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-row]')).not.toBeNull());
    expect(screen.queryByText('待处理任务未能完整读取')).toBeNull();
  });
});

describe('tasks: an accepted proposal that was paused', () => {
  beforeEach(() => void vi.spyOn(Date, 'now').mockReturnValue(NOW));

  it('is listed under 暂停 with its ON/OFF switch, not as a proposal to decline', async () => {
    const paused: WireSchedule = { ...SCHED, created_from: 'agent_proposal', enabled: false, accepted_at: NOW_S - 3600, last_error: null, scope_id: null };
    const { bridge } = install((m, p) => (m === 'GET' && p === '/schedules' ? listed(paused) : null));
    mountPage(bridge, `&tab=sched&sel=${SCHED.schedule_id}`);
    const group = await screen.findByRole('listbox', { name: '已暂停' });
    expect(within(group).getByRole('option', { name: `${SCHED.title}，已暂停` })).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: '角色建议' })).toBeNull();
    expect(screen.getByRole('switch', { name: `启用「${SCHED.title}」` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '忽略' })).toBeNull();
  });
});

describe('tasks: a coding session made from the editor', () => {
  const OWN: WireSession = { ...WIRE_SESSIONS.find((w) => w.own)!, session_id: 'own:0f1e2d3c4b5a', cwd: '/Users/me/agent', title: '补测试', state: 'accepted', last_line: null, started_at: NOW_S, updated_at: NOW_S, task_id: null };
  const send = async (bridge: ReturnType<typeof createFakeBridge>) => {
    vi.spyOn(bridge.files, 'pickFolder').mockResolvedValue({ handle: 'h-1', displayName: 'agent' } as never);
    mountPage(bridge, '&create=code');
    const form = await screen.findByRole('form', { name: '派发任务' });
    fireEvent.change(within(form).getByLabelText('任务要求'), { target: { value: '补测试' } });
    fireEvent.click(within(form).getByRole('button', { name: '选择…' }));
    await waitFor(() => expect((within(form).getByLabelText('目录') as HTMLInputElement).value).toBe('agent'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '立即派发' })));
  };

  it('gets its own row in 进行中, selected', async () => {
    pluginsOn('personal_agent', 'coding_sessions');
    let made = false;
    const { bridge } = install((m, p) => {
      if (m === 'POST' && p === '/sessions') made = true;
      return m === 'GET' && p === '/sessions' && made ? { status: 200, body: { sessions: [...WIRE_SESSIONS, OWN] } } : null;
    });
    await send(bridge);
    const row = await waitFor(() => {
      const r = document.querySelector(`[data-row="${OWN.session_id}"]`);
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: '补测试' })).toBeTruthy();
  });

  it('with 编码会话 off the editor offers no 编码会话', async () => {
    pluginsOn('personal_agent');
    const { bridge } = install();
    mountPage(bridge, '&create=role');
    const form = await screen.findByRole('form', { name: '派发任务' });
    expect(within(form).getByRole('radio', { name: /角色任务/ })).toBeTruthy();
    expect(within(form).queryByRole('radio', { name: '编码会话' })).toBeNull();
  });

  it('a plugin_off refusal says the switch is off', async () => {
    const { bridge } = install((m, p) => (m === 'POST' && p === '/sessions' ? { status: 409, body: { error: 'plugin_off', plugin: 'coding_sessions' }, error: { code: 'plugin_off' } } : null));
    await send(bridge);
    expect(await screen.findByText('派发失败：已在设置中关闭「编码会话」')).toBeTruthy();
  });
});

describe('tasks: a receipt reply against a newer delivery', () => {
  it('does not put an older, unredacted revision over a redacted newer one', async () => {
    const wire = WIRE_DELIVERIES.find((x) => x.delivery_id === DLV_T1_V2)!;
    let answer: (r: unknown) => void = () => {};
    const rows = WIRE_TASK_ROWS.map((t) => (t.delivery?.delivery_id === DLV_T1_V2 ? { ...t, delivery: { ...t.delivery, viewed_at: null } } : t));
    const { calls } = install((m, p) =>
      m === 'POST' && p.endsWith('/viewed') ? (new Promise((r) => (answer = r)) as never) : m === 'GET' && p.startsWith('/agent/tasks?') ? { status: 200, body: { tasks: rows, next_cursor: null } } : null,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const desk = renderHook(() => useTaskDesk(null, null, null), { wrapper });
    await waitFor(() => expect(desk.result.current.view?.deliveries.find((d) => d.id === DLV_T1_V2)?.viewed_at).toBeNull());
    act(() => desk.result.current.receipt(DLV_T1_V2, 'viewed'));
    await waitFor(() => expect(writes(calls).map((c) => c.path)).toEqual([`/agent/deliveries/${DLV_T1_V2}/viewed`]));
    const r = wire.revision;
    const redact = (b: TasksListPage | undefined) => b && { ...b, deliveries: b.deliveries.map((x) => (x.id === DLV_T1_V2 ? { ...x, revision: r + 2, redacted: true, artifacts: [] } : x)) };
    act(() => void client.setQueriesData<TasksListPage>({ queryKey: ['tasks-page'] }, redact));
    await act(async () => answer({ status: 200, body: { delivery: { ...wire, revision: r + 1, viewed_at: atS(14, 32) } } }));
    const cached = client.getQueriesData<TasksListPage>({ queryKey: ['tasks-page'] }).flatMap(([, b]) => b?.deliveries ?? []).filter((x) => x.id === DLV_T1_V2);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.every((x) => x.revision === r + 2 && x.redacted)).toBe(true);
  });
});
