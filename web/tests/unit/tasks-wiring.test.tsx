import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgentdResponse, StreamEvent } from '../../src/bridge/protocol';
import { fromDelivery, type Delivery } from '../../src/domain';
import { APPROVALS, atS, GOALS, NOW, pick, QUESTIONS, TASKS, WIRE_DELIVERIES, WIRE_RUNTIME, WIRE_TASK_ROWS } from '../../src/mock/fixtures';
import { A2, DLV_T1_V2, G1, Q1, S_C07A, S_5E10, T1, T2, T3, T5, T6 } from '../../src/mock/fixtures/ids';
import { createTasksActions, failMessage, NATIVE_OFF, sendReceipt, type ActionDeps } from '../../src/pages/tasks/actions';
import { ArtifactTable } from '../../src/pages/tasks/ArtifactTable';
import { draftFor, type CreateDraft } from '../../src/pages/tasks/CreateForm';
import { draftProblem, submitDraft } from '../../src/pages/tasks/create';
import { DeliverySection } from '../../src/pages/tasks/DeliverySection';
import { deriveView, emptyLocal, type TasksView } from '../../src/pages/tasks/model';
import { PendingDetail } from '../../src/pages/tasks/PendingDetail';
import { SelectedTask } from '../../src/pages/tasks/SelectedTask';
import { useTaskDesk } from '../../src/pages/tasks/TaskDetailHost';
import { TaskView } from '../../src/pages/tasks/TaskView';
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
});

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
    expect(said.join()).toContain('这个任务待验收，不能停止');
  });

  it('cancelled:false on a job that already ended says it ended, not that it waits for review', async () => {
    install((m, p) => (m === 'POST' && p.endsWith('/cancel') ? { status: 202, body: { job_id: hexOf(T1), cancelled: false } } : null));
    const v = view();
    const d = deps({ ...v, tasks: v.tasks.map((t) => (t.id === T1 ? { ...t, status: 'succeeded' as const } : t)) });
    await createTasksActions(d).stopNow([T1]);
    const said = d.push.mock.calls.map((c) => String(c[0])).join();
    expect(said).toContain('这个任务已经结束，不用停止');
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
    expect(d.push).toHaveBeenCalledWith('已发送到编码会话');
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
    expect(d.push).toHaveBeenCalledWith('已在别处更新', { severity: 'danger' });
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
    expect(d.push).toHaveBeenCalledWith('后台已断开', { severity: 'danger' });
  });
});

describe('tasks: create', () => {
  it('role → POST /agent/jobs {title, text, expected_outputs}', async () => {
    const { calls } = install();
    const draft: CreateDraft = { ...draftFor('role'), title: '汇总纪要', brief: '合成一份', artifact: '会议/汇总.md', sections: '待办、负责人' };
    const r = await submitDraft(draft);
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/agent/jobs', body: { title: '汇总纪要', text: '合成一份', expected_outputs: { artifacts: [{ path: '会议/汇总.md', checks: { required_sections: ['待办', '负责人'] } }] } } },
    ]);
    expect(r.select).toMatch(/^job:[a-f0-9]{32}$/);
  });

  it('code → POST /sessions {target, cwd: picked handle, prompt, mode}; goal → POST /agent/goals {title, objective}', async () => {
    const { calls } = install();
    const cwd = { handle: 'h-1', displayName: 'agent' };
    await submitDraft({ ...draftFor('code'), brief: '补测试', agent: 'codex', cwd, mode: 'workspace_write' });
    await submitDraft({ ...draftFor('goal'), title: '迁移桌面层', objective: '浮窗栈与就地输入' });
    expect(writes(calls)).toEqual([
      { method: 'POST', path: '/sessions', body: { target: 'codex', cwd, prompt: '补测试', mode: 'workspace_write' } },
      { method: 'POST', path: '/agent/goals', body: { title: '迁移桌面层', objective: '浮窗栈与就地输入' } },
    ]);
  });

  it('a code task needs a picked folder; an artifact must be a relative md/txt/csv/json path', () => {
    expect(draftProblem({ ...draftFor('code'), cwd: null }, true)).toBe('先选目录');
    expect(draftProblem({ ...draftFor('code'), cwd: null }, false)).toBe('这台电脑的外壳不支持原生目录选择');
    expect(draftProblem({ ...draftFor('role'), title: '测试', brief: '测试要求', acceptanceOpen: true, artifact: '/abs/a.md' }, true)).toContain('相对路径');
    expect(draftProblem({ ...draftFor('role'), title: '测试', brief: '测试要求', acceptanceOpen: true, artifact: 'a.docx' }, true)).toContain('相对路径');
    expect(draftProblem({ ...draftFor('goal'), title: '目标', objective: '' }, true)).toBe('先写目标说明');
  });
});

describe('tasks: reads', () => {
  it('refreshes a cached task when it finished on another page', async () => {
    const task = WIRE_TASK_ROWS.find((row) => row.canonical_task_id === T1)!;
    let rows = [{ ...task, state: 'running' as const, delivery: null } as typeof task];
    install((method, path) => method === 'GET' && path.startsWith('/agent/tasks?') ? { status: 200, body: { tasks: rows, next_cursor: null } } : null);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useTaskDesk(null, null, false), { wrapper });
    await waitFor(() => expect(first.result.current.view?.tasks.find((t) => t.id === T1)?.status).toBe('running'));
    first.unmount();
    rows = [task];
    const returned = renderHook(() => useTaskDesk(null, null, false), { wrapper });
    await waitFor(() => expect(returned.result.current.view?.tasks.find((t) => t.id === T1)?.status).toBe('needs_review'));
    expect(returned.result.current.view?.tasks.find((t) => t.id === T1)?.summary).toContain('142 条');
  });

  it('extras: steps by canonical id, items of each step run (tool calls only), files, plan item and run failure', async () => {
    const { calls } = install();
    const x = await loadTaskExtras(pick(TASKS, T6), false);
    const gets = calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(gets).toEqual(expect.arrayContaining([`/agent/tasks/${T6}/steps`, `/agent/tasks/${T6}/files`, '/agent/runs', '/agent/runs/run-0f11/items']));
    expect(x.steps[0]?.at).toBeGreaterThan(1e12);
    expect(x.tools.every((t) => t.kind === 'tool_call')).toBe(true);
    expect(x.failure?.reason).toContain('资料授权已撤销');
    expect(x.moreSteps).toBe(false);
    const t1 = await loadTaskExtras(pick(TASKS, T1), false);
    expect(t1.plan?.steps.map((s) => s.status)).toContain('in_progress');
    expect(t1.files[0]?.path.startsWith('/')).toBe(true);
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
  it('artifact table: 版本 column; open and copy use the absolute path', () => {
    const arts = delivery(DLV_T1_V2).artifacts;
    const onOpen = vi.fn();
    render(<ArtifactTable artifacts={arts} onOpen={onOpen} />);
    const table = screen.getByRole('grid', { name: '产物' });
    expect(within(table).getByRole('columnheader', { name: '版本' })).toBeTruthy();
    within(table).getAllByRole('button', { name: arts[0]!.name })[0]!.click();
    expect(onOpen).toHaveBeenCalledWith(arts[0]!.absolute_path);
  });

  it('a revoked delivery shows one placeholder line instead of the table', () => {
    const d = { ...delivery(DLV_T1_V2), redacted: true, artifacts: [] };
    const { container } = render(<DeliverySection deliveries={[d]} countInBar={false} onOpen={() => {}} onReveal={() => {}} onCopyPath={() => {}} />);
    expect(container.textContent).toContain('这一版已撤回');
    expect(container.querySelector('[role="grid"]')).toBeNull();
  });
});

const callError = (status: number, code: string) => new AgentdCallError(status, code, undefined, { error: code }, code);

describe('tasks: failure reasons and native entries', () => {
  it('renders an untruncated structured task result and strips the leading delivery marker', () => {
    const task = { ...pick(TASKS, T1), summary: '[int:explain] ## 推荐\n\n- 先做 **A**\n- 再做 C\n\n| 方案 | 成本 |\n| --- | --- |\n| A + C | 32 |\n\n最终预算余量 8' };
    render(<TaskView task={task} effective="done" now={NOW} />);
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
    expect(d.push).toHaveBeenCalledWith('会话正在执行这一轮，等它结束再发', { severity: 'danger' });
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

  it('entries marked off: the artifact name is no button, menu items and 跳到终端 are disabled with the reason', () => {
    const arts = delivery(DLV_T1_V2).artifacts;
    const onOpen = vi.fn();
    render(<ArtifactTable artifacts={arts} onOpen={onOpen} nativeOff={{ artifact: NATIVE_OFF.artifact, copy: NATIVE_OFF.copy }} />);
    expect(screen.queryByRole('button', { name: arts[0]!.name })).toBeNull();
    cleanup();
    const v = view();
    const t2 = pick(v.tasks, T2);
    render(<TaskView task={t2} effective="running" now={NOW} sessionId={S_C07A} sessionLines={['a']} nativeOff={{ jump: NATIVE_OFF.jump }} />);
    const jump = screen.getByRole('button', { name: /跳到终端/ });
    expect(jump.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain(NATIVE_OFF.jump);
  });

  it('a failed /sessions/{id}/lines read says 会话输出没读到 with a retry, not 还没有输出', async () => {
    let fail = true;
    const { calls } = install((method, path) => (path.endsWith('/lines') && fail ? { status: 500, body: { error: 'internal' }, error: { code: 'internal' } } : null));
    const v = view();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SelectedTask task={pick(v.tasks, T2)} view={v} now={NOW} stoppedAt={null} stepsFail={false} retry={0} toolFocus={null} decideFail={null} busy={false} canReveal={false} onReceipt={() => {}} onAction={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.body.textContent).toContain('会话输出没读到'));
    expect(document.body.textContent).not.toContain('还没有输出');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/lines'))).toHaveLength(2));
  });

  it('a JSON approval preview sums up as server · tool; the JSON stays in the fold', () => {
    const preview_text = JSON.stringify({ server: 'files', tool: 'write_file', arguments: { path: '/a.md' } }, null, 2);
    const q = { ...pick(QUESTIONS, Q1), interaction_kind: 'approval' as const, preview_text };
    const noop = () => {};
    const { container } = render(<PendingDetail item={q} pending={[]} now={NOW} onApprove={noop} onAnswer={noop} onCancelQuestion={noop} onOpenSession={noop} onOpenChat={noop} onMouseOnly={noop} />);
    const lines = [...container.querySelectorAll('[data-summary] li')].map((l) => l.textContent ?? '');
    expect(lines).toEqual(['files │ write_file']);
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
  function mountSelected(task: typeof T2 | typeof T5 = T2) {
    const v = view();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SelectedTask task={pick(v.tasks, task)} view={v} now={NOW} stoppedAt={null} stepsFail={false} retry={0} toolFocus={null} decideFail={null} busy={false} canReveal={false} onReceipt={() => {}} onAction={() => {}} />
        <ToastHost />
      </QueryClientProvider>,
    );
  }
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
    expect(await screen.findByText('已改名：HostLink 重连')).toBeTruthy();
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
    fireEvent.click(within(dlg).getByRole('button', { name: '不删除' }));
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
    expect(await screen.findByText('已在别处更新')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/sessions')).toHaveLength(2));
    code = 'busy';
    await item('删除…');
    fireEvent.click(within(screen.getByRole('dialog', { name: /删除会话/ })).getByRole('button', { name: '删除' }));
    expect(await screen.findByText('会话正在执行这一轮，先停下再归档或删除')).toBeTruthy();
  });

  it('an external session has no ⋯ session menu', async () => {
    install();
    mountSelected(T5);
    await screen.findByText(/外部会话：这里只显示状态/);
    expect(screen.queryByRole('button', { name: '会话操作' })).toBeNull();
  });
});

