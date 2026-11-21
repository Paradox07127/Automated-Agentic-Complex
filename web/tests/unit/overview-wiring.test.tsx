// Overview wiring: the page's reads, writes and feed against agentd's real shapes.
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge, type StreamEvent } from '../../src/bridge';
import { AgentdCallError } from '../../src/bridge/agentd';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { fromInteraction, isoWithOffset, sortPending, type Approval, type Question } from '../../src/domain';
import { mockRoutes, type MockRoute } from '../../src/mock';
import { at, DAY, MINUTE, NOW, WIRE_CHARACTER_STATE, WIRE_DIAG_BUDGET, WIRE_DIAG_CONNECTIONS, WIRE_DIAG_GATE, WIRE_INTERACTION_APPROVAL, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { A1, A2, A3, DLV_T1_V2, Q1, Q_APPROVAL, S_5E10, S_C07A, T1, T2, T3, T6 } from '../../src/mock/fixtures/ids';
import { errText } from '../../src/pages/overview/errors';
import { RUNTIME_KEY } from '../../src/data/runtime';
import { runtimeOf, withRuntime } from '../../src/pages/overview/kernel';
import { readDay, readFailedTurns, readRole, readRunning, readSnapshot, type OverviewSnapshot } from '../../src/pages/overview/load';
import { useOverview } from '../../src/pages/overview/useOverview';
import { nextMorning, useOverviewActions } from '../../src/pages/overview/useOverviewActions';
import { loadOverview } from './overviewReads';
import { pluginsOn, pluginsReset } from './plugins';

/** The other pages' routes for these reads, answered here in agentd's shapes. */
const WIRE_SIDE: MockRoute[] = [
  { method: 'GET', path: '/character/state', handler: () => ({ status: 200, body: WIRE_CHARACTER_STATE }) },
  { method: 'GET', path: '/character/runtime', handler: () => ({ status: 200, body: WIRE_RUNTIME }) },
  { method: 'GET', path: '/diag/state', handler: () => ({ status: 200, body: { budget: WIRE_DIAG_BUDGET, gate: WIRE_DIAG_GATE, connections: WIRE_DIAG_CONNECTIONS } }) },
];

/** `hold(path)` keeps a request waiting until it answers its own promise; it answers immediately with `null`. */
function serve(extra: MockRoute[] = [], hold: (path: string) => Promise<void> | null = () => null) {
  const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes, ...WIRE_SIDE, ...extra]);
  return vi.spyOn(getBridge().agentd, 'request').mockImplementation(async (method, path, body) => {
    await hold(path);
    return dispatch(method, path, body);
  });
}

/** Today's failed turns, read with the snapshot. */
const TURNS_READ = `GET /trace/turns?since=${encodeURIComponent(isoWithOffset(new Date(NOW).setHours(0, 0, 0, 0)))}&result=failed&limit=50`;

function gate() {
  let open: () => void = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open: () => act(() => open()) };
}

// 进行中 reads only with 编码会话 and 个人代理 on.
beforeEach(() => pluginsOn());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
});

describe('overview reads', () => {
  it('each section reads its own agentd routes; 待处理 reads only the snapshot', async () => {
    const spy = serve();
    const calls = async (read: () => Promise<unknown>) => {
      spy.mockClear();
      await read();
      expect(spy.mock.calls.every(([, , body]) => body === undefined)).toBe(true);
      return spy.mock.calls.map(([m, p]) => `${m} ${p}`).sort();
    };
    expect(await calls(() => readSnapshot(null, false))).toEqual(['GET /agent/snapshot?demo=']);
    expect(await calls(() => readRunning({ sessions: true, runs: true }))).toEqual(['GET /agent/runs', 'GET /sessions']);
    expect(await calls(() => readRunning({ sessions: false, runs: true }))).toEqual(['GET /agent/runs']);
    expect(await calls(() => readFailedTurns(NOW))).toEqual([TURNS_READ]);
    expect(await calls(() => readRole(null))).toEqual(['GET /character/state', 'GET /diag/state', 'GET /state']);
    expect(await calls(() => readDay(null, NOW))).toEqual(['GET /day/segments?date=2026-10-29']);
    const r = runtimeOf(WIRE_RUNTIME);
    expect(r.kernel?.runtime.id).toBe('codex');
    expect(r.runtime.name).toBe('Codex');
  });

  it('shows pending from the snapshot parts: approvals, the open question and the unreviewed delivery', async () => {
    serve();
    const s = await loadOverview(null, false);
    expect(s.seq).toBe('18422');
    expect(sortPending(s.pending).map((p) => p.id)).toEqual([A1, A2, A3, Q1, `r-${DLV_T1_V2}`]);
    const a2 = s.pending.find((p) => p.id === A2) as Approval;
    // seconds_left 23 of a 55 s window, read at NOW: it opened 32 s ago.
    expect(a2.since).toBe(NOW - 32_000);
    expect(a2.generation).toBe(7);
  });

  it('lists role runs from /agent/runs and the own coding session T2 from /sessions under 进行中', async () => {
    serve();
    const s = await loadOverview(null, false);
    expect(Object.keys(s.active_runs).sort()).toEqual([T1, T2, T3].sort());
    expect(s.active_runs[T2]).toMatchObject({ run_id: S_C07A, state: 'awaiting_approval', started_at: at(14, 20) });
    expect(s.active_runs[T1]).toMatchObject({ run_id: 'run-8d03', state: 'running', started_at: at(14, 22, 5) });
  });

  it('turns commitments, observation, segments and runs into the page units', async () => {
    serve();
    const s = await loadOverview('pause', false);
    expect(s.reminders).toEqual([
      { id: 'c2b3c4d5e6f7', title: '站会', due_at: at(10, 30), triggered: true, seen_at: at(10, 30, 5) },
      { id: 'c3c4d5e6f7a8', title: '午餐', due_at: at(12, 0), triggered: true, seen_at: null },
      { id: 'c0a1b2c3d4e5', title: '交报销单', due_at: at(15, 0), triggered: false, seen_at: null },
      { id: 'c0f6a7b8c9d0', title: '周会', due_at: at(16, 30), triggered: false, seen_at: null },
      { id: 'c1a2b3c4d5e6', title: '给房东打电话', due_at: at(9, 0) + DAY, triggered: false, seen_at: null },
    ]);
    expect(s.pause).toEqual({ paused_until: NOW + 18 * MINUTE, quiet_until: null, meeting: false, off: false });
    const sessions = s.day.segments.flatMap((g) => g.sessions);
    expect(sessions.find((x) => x.id === S_C07A)).toMatchObject({ started_at: at(14, 20), ended_at: null });
    // The ledger's bare id is matched to the live registry session, which is still waiting.
    expect(sessions.find((x) => x.id === S_5E10)).toMatchObject({ started_at: at(13, 51), ended_at: null });
    expect(sessions.find((x) => x.last_gate === 'fail')).toMatchObject({ ended_at: at(11, 40), agents_failed: 1 });
    expect(s.day.runs.find((r) => r.run_id === 'run-8d03')?.task_id).toBe(T1);
    expect(s.errors.filter((e) => e.kind === 'task')).toEqual([{ id: T6, kind: 'task', at: at(10, 15), title: '下载资源索引', reason: '资料授权已撤销', fix: '查看任务' }]);
    expect(s.errors.filter((e) => e.kind === 'turn').map((e) => [e.reason, e.fix])).toEqual([['这一轮没有完成', '看时间线']]);
  });

  it('reads the status column from /character/state, /character/runtime and /diag/state', async () => {
    serve();
    const s = withRuntime(await loadOverview(null, false), runtimeOf(WIRE_RUNTIME));
    expect(s.character.mood).toEqual({ energy: 0.31, valence: -0.1, engagement: 0.72, labels: { energy: 'sleepy', mood: 'low', engagement: 'absorbed' } });
    expect(s.quota).toEqual({ screenshots: { used: 37, reserved: 1, released: 3, limit: 200 }, gate: { today: 6, daily_limit: 12, blocked_today: 3 } });
    expect(s.health?.runtime.name).toBe('Codex');
    expect(s.health?.voice.state).toBe('unreachable');
    expect(s.kernel?.runtime.id).toBe('codex');
  });

  it('a side read that fails or cannot be read blanks only its region', async () => {
    serve([{ method: 'GET', path: '/diag/state', handler: () => ({ status: 200, body: {} }) }]);
    const s = withRuntime(await loadOverview('ov2-lane-error', false), runtimeOf(WIRE_RUNTIME));
    expect(s.quota).toBeNull();
    expect(s.health).toBeNull();
    expect(s.diag_error).toBe('回复无法读取');
    expect(s.kernel?.runtime.id).toBe('codex');
    expect(s.day.lane_errors).toEqual({ code: '读取编码记录失败：后台出错（500）' });
    expect(s.pending).toHaveLength(5);
  });

  it('a failed snapshot fails the read with a short reason', async () => {
    serve();
    const e = await readSnapshot(null, true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentdCallError);
    expect(errText(e)).toBe('后台出错（500）');
    expect(errText(new AgentdCallError(0, 'offline', undefined, null, 'offline'))).toBe('后台已断开');
  });
});

async function snap(): Promise<OverviewSnapshot> {
  serve();
  const s = await loadOverview(null, false);
  vi.restoreAllMocks();
  return s;
}

function actions(s: OverviewSnapshot, extra: MockRoute[] = []) {
  const spy = serve(extra);
  const go = vi.fn();
  const toast = vi.fn();
  const refetch = vi.fn();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useOverviewActions(s, NOW, go, toast, refetch), { wrapper });
  return { spy, go, toast, refetch, client, hook };
}

describe('overview writes', () => {
  it('decides a hook approval with its generation and a character approval through its interaction', async () => {
    const s = await snap();
    const { spy, hook } = actions(s);
    const a2 = s.pending.find((p) => p.id === A2) as Approval;
    act(() => hook.result.current.onApprove(a2, 'allow'));
    expect(spy).toHaveBeenCalledWith('POST', `/approvals/${A2}/decision`, { generation: 7, decision: 'allow' });
    const q = fromInteraction(WIRE_INTERACTION_APPROVAL, NOW) as Question;
    act(() => hook.result.current.onAnswer(q, '拒绝'));
    expect(spy).toHaveBeenCalledWith('POST', `/agent/interactions/${Q_APPROVAL}/answer`, { expected_version: 1, answers: { decision: ['拒绝'] } });
  });

  it('a 409 on a decision says it was settled elsewhere and reads again', async () => {
    const s = await snap();
    const { toast, refetch, hook } = actions(s, [{ method: 'POST', path: '/approvals/:id/decision', handler: () => ({ status: 409, body: { ok: false, error: 'generation_mismatch' } }) }]);
    act(() => hook.result.current.onApprove(s.pending.find((p) => p.id === A2) as Approval, 'deny'));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('提交决定：已在别处更新，已重新读取', { severity: 'warning' });
  });

  it('snoozes by 10 or 60, completes and cancels reminders without a body', async () => {
    const s = await snap();
    const { spy, toast, hook } = actions(s);
    const r = s.reminders.find((x) => !x.triggered)!;
    act(() => hook.result.current.onSnooze(r, 10));
    act(() => hook.result.current.onComplete(r));
    act(() => hook.result.current.onCancel(r));
    expect(spy).toHaveBeenCalledWith('POST', `/commitments/${r.id}/snooze`, { minutes: 10 });
    expect(spy).toHaveBeenCalledWith('POST', `/commitments/${r.id}/complete`, undefined);
    expect(spy).toHaveBeenCalledWith('POST', `/commitments/${r.id}/cancel`, undefined);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已延后 10 分钟：交报销单'));
    await waitFor(() => expect(hook.result.current.gone[r.id]).toBe(true));
  });

  it('pauses and resumes through the three PUT /observation routes and shows what agentd answered', async () => {
    const s = await snap();
    const { spy, hook } = actions(s);
    act(() => hook.result.current.onPause('observe', 60));
    await waitFor(() => expect(hook.result.current.pause.paused_until).toBe(NOW + 60 * MINUTE));
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/paused', { minutes: 60 });
    act(() => hook.result.current.onPause('quiet', 30));
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/quiet', { until: Math.floor((NOW + 30 * MINUTE) / 1000) });
    await waitFor(() => expect(hook.result.current.pause.quiet_until).toBe(NOW + 30 * MINUTE));
    act(() => hook.result.current.onPause('quiet', null));
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/quiet', { until: new Date(2026, 9, 30, 7).getTime() / 1000 });
    act(() => hook.result.current.onPause('meeting', null));
    await waitFor(() => expect(hook.result.current.pause.meeting).toBe(true));
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/meeting', { on: true });
    act(() => hook.result.current.onResume('observe'));
    act(() => hook.result.current.onResume('quiet'));
    act(() => hook.result.current.onResume('meeting'));
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/paused', { minutes: 0 });
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/quiet', { until: null });
    expect(spy).toHaveBeenCalledWith('PUT', '/observation/meeting', { on: false });
    await waitFor(() => expect(hook.result.current.pause).toEqual({ paused_until: null, quiet_until: null, meeting: false, off: false }));
  });

  it('「到明早」 ends at the next 07:00', () => {
    expect(nextMorning(NOW)).toBe(new Date(2026, 9, 30, 7).getTime());
    expect(nextMorning(new Date(2026, 9, 29, 6).getTime())).toBe(new Date(2026, 9, 29, 7).getTime());
  });

  it('rechecks the kernel with GET /character/runtime?refresh=1 and switches by navigating only', async () => {
    const s = await snap();
    const { spy, go, toast, refetch, client, hook } = actions(s);
    act(() => hook.result.current.onKernel('recheck'));
    // The reply replaces the shared runtime entry the overview reads.
    await waitFor(() => expect(runtimeOf(client.getQueryData(RUNTIME_KEY)!).kernel?.runtime.id).toBe('codex'));
    expect(spy.mock.calls).toEqual([['GET', '/character/runtime?refresh=1', undefined]]);
    expect(refetch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('已重新检测内核');
    spy.mockClear();
    act(() => hook.result.current.onKernel('switch', 'pi'));
    expect(go).toHaveBeenCalledWith({ page: 'settings', group: 'kernel' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('overview feed', () => {
  function live(hold?: (path: string) => Promise<void> | null) {
    const spy = serve([], hold);
    let emit: (e: StreamEvent) => void = () => {};
    let reload: () => void = () => {};
    let diag: (e: StreamEvent) => void = () => {};
    const feed = vi.spyOn(getBridge().feed, 'subscribe').mockImplementation((onEvent, onReload) => {
      emit = onEvent;
      reload = onReload;
      return () => {};
    });
    vi.spyOn(getBridge().diag, 'subscribe').mockImplementation((onEvent) => {
      diag = onEvent;
      return () => {};
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useOverview(null, null), { wrapper });
    const snapshots = () => spy.mock.calls.filter(([, p]) => p.startsWith('/agent/snapshot')).length;
    const send = (event: string, data: unknown) => act(() => emit({ event, id: null, data: JSON.stringify(data) }));
    return { hook, spy, feed, snapshots, send, reload: () => act(() => reload()), diag: (data: unknown) => act(() => diag({ event: 'decision', id: null, data: JSON.stringify(data) })) };
  }

  it('subscribes after the snapshot seq and lays plans and tools over the live runs', async () => {
    const { hook, feed, send } = live();
    await waitFor(() => expect(hook.result.current.q.data).toBeDefined());
    await waitFor(() => expect(feed).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), '18422'));
    send('plan', { run_id: 'run-8d03', revision: 3, title: '周报', status: 'in_progress', steps: [{ text: '按项目重写', status: 'completed' }, { text: '生成统计表', status: 'in_progress' }] });
    const item = { run_id: 'run-8d03', item_id: 'i1', kind: 'tool_call', phase: null, name: 'Bash · python 统计', summary: null, parent_item_id: null, conversation_id: 'conv-1', generation: 1, item_seq: 4, at: 1 };
    send('agent_item', { ...item, status: 'started' });
    const run = hook.result.current.activeRuns[T1]!;
    expect(run.plan?.steps.map((x) => [x.text, x.status])).toEqual([
      ['按项目重写', 'completed'],
      ['生成统计表', 'in_progress'],
    ]);
    expect(run).toMatchObject({ tool: 'Bash · python 统计', state: 'running_tool' });
    send('agent_item', { ...item, status: 'delta' });
    expect(hook.result.current.activeRuns[T1]).toMatchObject({ tool: 'Bash · python 统计', state: 'running_tool' });
    send('agent_item', { ...item, status: 'completed' });
    expect(hook.result.current.activeRuns[T1]!.tool).toBeUndefined();
    expect(hook.result.current.activeRuns[T1]!.state).toBe('running');
    send('plan', { run_id: 'run-8d03', revision: 2, steps: [] });
    expect(hook.result.current.activeRuns[T1]!.plan?.revision).toBe(3);
  });

  it('shows the page before the kernel scan answers; an event reads only the snapshot, /sessions, /agent/runs and the failed turns of today', async () => {
    const scan = gate();
    const { hook, spy, send } = live((p) => (p === '/character/runtime' ? scan.wait : null));
    await waitFor(() => expect(hook.result.current.q.data).toBeDefined());
    expect(hook.result.current.data?.kernel).toBeNull();
    expect(hook.result.current.data?.health).toBeNull();
    scan.open();
    await waitFor(() => expect(hook.result.current.data?.kernel?.runtime.id).toBe('codex'));
    expect(hook.result.current.data?.health?.runtime.name).toBe('Codex');
    spy.mockClear();
    send('agent_run', { run_id: 'run-8d03', kind: 'tool_started', tool: 'Bash' });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('GET', '/agent/snapshot?demo=', undefined));
    await waitFor(() => expect(hook.result.current.q.isFetching).toBe(false));
    expect(spy.mock.calls.map(([m, p]) => `${m} ${p}`).sort()).toEqual(['GET /agent/runs', 'GET /agent/snapshot?demo=', 'GET /sessions', TURNS_READ].sort());
    expect(hook.result.current.data?.kernel?.runtime.id).toBe('codex');
    expect(hook.result.current.data?.quota).not.toBeNull();
  });

  it('an event that lands while a read is under way reads again once that read ends', async () => {
    let held: ReturnType<typeof gate> | null = null;
    const { hook, snapshots, send } = live((p) => (p.startsWith('/agent/snapshot') && held ? held.wait : null));
    await waitFor(() => expect(hook.result.current.q.data).toBeDefined());
    await waitFor(() => expect(hook.result.current.q.isFetching).toBe(false));
    const n = snapshots();
    held = gate();
    const first = held;
    send('agent_run', { run_id: 'run-8d03', kind: 'verifying' });
    await waitFor(() => expect(snapshots()).toBe(n + 1));
    expect(hook.result.current.q.isFetching).toBe(true);
    send('agent_run', { run_id: 'run-8d03', kind: 'completed' });
    send('delivery', { action: 'produced' });
    held = null;
    first.open();
    await waitFor(() => expect(snapshots()).toBe(n + 2));
    await waitFor(() => expect(hook.result.current.q.isFetching).toBe(false));
    expect(snapshots()).toBe(n + 2);
  });

  it('reads again on agent_run, agent_interaction, delivery, commitment and approval decisions; a reset drops the plans', async () => {
    const { hook, snapshots, send, reload, diag } = live();
    await waitFor(() => expect(hook.result.current.q.data).toBeDefined());
    const n = snapshots();
    send('commitment', { action: 'snoozed', commitment: {} });
    await waitFor(() => expect(snapshots()).toBe(n + 1));
    await waitFor(() => expect(hook.result.current.q.isFetching).toBe(false));
    diag({ kind: 'approval.opened', attrs: {} });
    await waitFor(() => expect(snapshots()).toBe(n + 2));
    await waitFor(() => expect(hook.result.current.q.isFetching).toBe(false));
    send('plan', { run_id: 'run-8d03', revision: 1, steps: [{ text: 'a', status: 'completed' }] });
    reload();
    expect(hook.result.current.lost).toBe(true);
    expect(hook.result.current.activeRuns[T1]!.plan).toBeNull();
    await waitFor(() => expect(snapshots()).toBe(n + 3));
  });

  it('re-reads role, day, brief and mood when the feed resets, and refreshes day and brief every 60 s', async () => {
    vi.useFakeTimers();
    try {
      const { spy, reload } = live();
      await act(() => vi.advanceTimersByTimeAsync(100));
      spy.mockClear();
      reload();
      await act(() => vi.advanceTimersByTimeAsync(100));
      const resetPaths = spy.mock.calls.map(([, p]) => p);
      expect(resetPaths).toContain('/character/state');
      expect(resetPaths).toContain('/day/segments?date=2026-10-29');
      expect(resetPaths).toContain('/episodes?date=2026-10-29');
      expect(resetPaths.some((p) => p.startsWith('/character/state/history?since='))).toBe(true);
      spy.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      const tickPaths = spy.mock.calls.map(([, p]) => p);
      expect(tickPaths).toContain('/day/segments?date=2026-10-29');
      expect(tickPaths).toContain('/episodes?date=2026-10-29');
    } finally {
      vi.useRealTimers();
    }
  });
});
