// 总览：01 待处理、02 进行中，读数和跳转。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { fromInteraction, sortPending, type Approval, type Question } from '../../src/domain';
import { mockRoutes } from '../../src/mock';
import { APPROVALS, at, DAY, NOW, pick, WIRE_INTERACTION_APPROVAL_DANGER, WIRE_INTERACTIONS } from '../../src/mock/fixtures';
import { A2 } from '../../src/mock/fixtures/ids';
import { useOverviewActions } from '../../src/pages/overview/useOverviewActions';
import { codeCounts, nextReminder, reminderTime, runRows, type RunRow } from '../../src/pages/overview/briefModel';
import type { OverviewSnapshot } from '../../src/pages/overview/load';
import { loadBrief, readMood, type MoodPoint, type OverviewBrief } from '../../src/pages/overview/loadBrief';
import { PendingSection } from '../../src/pages/overview/PendingSection';
import { demos } from '../../src/pages/overview/demos';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { loadOverview } from './overviewReads';

const noop = async () => {};
/** A section read that has answered. */
const READY = { status: 'success', data: true } as const;
let snap: OverviewSnapshot;
let brief: OverviewBrief;
let mood: MoodPoint[];

beforeAll(async () => {
  const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
  const spy = vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => dispatch(method, path, body));
  snap = await loadOverview(null, false);
  brief = await loadBrief(NOW);
  mood = await readMood(NOW);
  spy.mockRestore();
});

afterEach(() => {
  cleanup();
  // Folds remember their state for the session.
  sessionStorage.clear();
});

describe(' overview demos', () => {
  it('lists default, sparse, light, loading, error and full', () => {
    const names = demos.map((d) => d.name);
    for (const n of ['default', 'sparse', 'light', 'loading', 'error', 'full']) expect(names).toContain(n);
  });
});

describe(' brief reads', () => {
  it('reads episodes and today’s conversations with their turns; 24 h of state is a read of its own', () => {
    expect(brief.episodes?.length).toBeGreaterThan(0);
    expect(brief.convs?.every((c) => c.turns.every((t) => t.t0 <= t.t1))).toBe(true);
    expect(mood.length).toBeGreaterThan(0);
  });

  it('never reads the whole /memory to count today’s facts', async () => {
    const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
    const spy = vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => dispatch(method, path, body));
    await loadBrief(NOW);
    expect(spy.mock.calls.some(([, p]) => p.startsWith('/memory'))).toBe(false);
    spy.mockRestore();
  });

  it('主动发言 counts the lines proactive.py let through (back / break / stuck / comment), not announcements or refusals', async () => {
    const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
    const ev = (kind: string, speak: boolean, t: number) => ({ event_id: kind + t, trace_id: 't', kind: 'gate.decided', status: speak ? 'ok' : 'blocked', t_wall: new Date(t).toISOString(), attrs: { kind, level: 'P2', speak, reason: speak ? null : 'cooldown' } });
    const events = [ev('comment', true, at(10, 0)), ev('stuck', true, at(11, 0)), ev('break', false, at(12, 0)), ev('dispatch_done', true, at(13, 0))];
    const spy = vi
      .spyOn(getBridge().agentd, 'request')
      .mockImplementation((method, path, body) => (path.startsWith('/trace/decisions') ? Promise.resolve({ status: 200, body: { events } as never }) : dispatch(method, path, body)));
    const b = await loadBrief(NOW);
    spy.mockRestore();
    expect(b.spoke?.map((s) => s.t)).toEqual([at(10, 0), at(11, 0)]);
  });

  it('the role band line comes from /diag/state: app, body and observation sources', () => {
    expect(snap.role?.app).toBe('Terminal');
    expect(snap.role?.doing).toBe('坐着');
    expect(snap.role?.sources).toContain('窗口文字');
  });
});

describe(' brief model', () => {
  it('the summary parts: coding sessions by state and the next armed reminder', () => {
    const n = codeCounts(snap);
    expect(n.running + n.waiting + n.done).toBe(n.total);
    expect(nextReminder(snap.reminders, NOW)?.title).toBe('交报销单');
    expect(reminderTime(at(9, 0) + DAY, NOW)).toBe('明天 09:00');
  });

  it('02 puts a conversation mid-turn first and counts conversations and coding sessions', () => {
    const r = runRows(snap, brief.convs ?? []);
    expect(r.rows[0]?.k).toBe('conv');
    expect(r.rows.every((x) => x.k !== 'conv' || x.conv.busy)).toBe(true);
    expect(r.rows.every((x) => x.k !== 'code' || x.session.state !== 'idle')).toBe(true);
    expect(r.code).toBe(r.rows.filter((x) => x.k === 'code').length);
  });
});

describe(' 01 待处理', () => {
  it('only the first item sits on a white paper card; the rest are expandable rows with a yellow state block, no 展开 text button', () => {
    const items = sortPending(snap.pending);
    const go = vi.fn();
    const { container } = render(<PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={go} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    expect(container.querySelectorAll('[data-stub="Paper"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-stub="ApprovalCard"]')).toHaveLength(1);
    const rows = container.querySelectorAll('[data-pending-row]');
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.querySelector('[data-stub="StatusTag"]')?.getAttribute('data-tone')).toBe('waiting');
    // The 01 head counts them; no 「另有 N 项待处理」 says it again.
    expect(container.textContent).not.toContain('另有');
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull();
    for (const r of rows) fireEvent.click(r.querySelector('[aria-expanded]')!);
    expect(go).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-stub="Paper"]')).toHaveLength(5);
    fireEvent.keyDown(rows[0]!.querySelector('[aria-expanded]')!, { key: 'ArrowLeft' });
    expect(container.querySelectorAll('[data-stub="Paper"]')).toHaveLength(4);
  });

  it('a click on a record row opens that item as its card under the row; the row stays its landing target', () => {
    const items = sortPending(snap.pending);
    const { container } = render(<PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    const row = container.querySelector<HTMLElement>('[data-pending-row]')!;
    const id = row.getAttribute('data-pending-row')!;
    expect(row.getAttribute('data-nav-target')).toBe(`item-${id}`);
    fireEvent.click(row.querySelector('[aria-expanded]')!);
    expect(row.querySelector(`[data-item="${id}"] [data-stub="Paper"]`)).not.toBeNull();
    expect(container.querySelectorAll('[data-pending-row]')).toHaveLength(4);
    expect(container.querySelectorAll(`[data-nav-target="item-${id}"]`)).toHaveLength(1);
  });

  it('decides a non-dangerous approval on its card', () => {
    const items = sortPending(snap.pending).filter((p) => p.kind === 'approval' && !p.dangerous);
    const onApprove = vi.fn(async () => {});
    render(<PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={noop} onApprove={onApprove} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    expect(onApprove).toHaveBeenLastCalledWith(items[0], 'allow', undefined, undefined);
  });

  it('a new focus request starts with no session grant and no draft left from the one before', () => {
    const a = pick(APPROVALS, A2);
    const b = { ...a, id: 'approval-b', generation: 11, title: 'Edit: Other.swift' };
    const onApprove = vi.fn(async () => {});
    const props = { q: READY, now: NOW, at: NOW, sessions: [], receipt: null, go: noop, onApprove, onAnswer: noop, onReply: noop, onJumpSession: noop };
    const { rerender } = render(<PendingSection {...props} items={[a]} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /本会话都允许/ }));
    rerender(<PendingSection {...props} items={[b]} />);
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    expect(onApprove).toHaveBeenLastCalledWith(b, 'allow', undefined, undefined);
    cleanup();

    const x = fromInteraction(WIRE_INTERACTIONS[0]!, NOW) as Question;
    const y = { ...x, id: 'question-y', title: '另一个问题' };
    const r = render(<PendingSection {...props} items={[x]} />);
    fireEvent.change(screen.getByRole('textbox', { name: '写下回答' }), { target: { value: '只写给 X 的' } });
    r.rerender(<PendingSection {...props} items={[y]} />);
    expect((screen.getByRole('textbox', { name: '写下回答' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('sends one decision per request while its reply is out', () => {
    const request = vi.spyOn(getBridge().agentd, 'request').mockImplementation(() => new Promise(() => {}));
    const items = [pick(APPROVALS, A2)];
    function Harness() {
      const a = useOverviewActions(undefined, NOW, noop, noop, noop);
      return <PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={a.onApprove} onAnswer={a.onAnswer} onReply={a.onReply} onJumpSession={noop} />;
    }
    render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    fireEvent.click(screen.getByRole('button', { name: /^拒绝(?!并)/ }));
    expect(request.mock.calls.filter(([m, p]) => m === 'POST' && p.startsWith('/approvals/'))).toHaveLength(1);
    request.mockRestore();
  });

  it('approving a dispatch on its card sends the mode picked there', () => {
    const request = vi.spyOn(getBridge().agentd, 'request').mockImplementation(() => new Promise(() => {}));
    const d: Approval = {
      ...pick(APPROVALS, A2),
      approval_kind: 'dispatch',
      scope_ok: false,
      dispatch: { target: 'codex', cwd: '/w/p', prompt: '修好构建', source: 'text', utterance: null, modes: ['read_only', 'workspace_write'], mode: 'read_only', verify_cmd: null, cwd_from: { source: 'explicit' } },
    };
    function Harness() {
      const a = useOverviewActions(undefined, NOW, noop, noop, noop);
      return <PendingSection q={READY} items={[d]} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={a.onApprove} onAnswer={a.onAnswer} onReply={a.onReply} onJumpSession={noop} />;
    }
    render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('radio', { name: '可改工作区' }));
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    expect(request).toHaveBeenCalledWith('POST', `/approvals/${A2}/decision`, { generation: 7, decision: 'allow', mode: 'workspace_write' });
    request.mockRestore();
  });

  it('a question card offers no 取消请求 it cannot send', () => {
    render(<PendingSection q={READY} items={[fromInteraction(WIRE_INTERACTIONS[0]!, NOW)]} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    expect(screen.queryByRole('button', { name: '取消请求' })).toBeNull();
  });

  it('a character approval shows its call and danger rule, and a dangerous 批准 is not taken by Enter', () => {
    const q = fromInteraction(WIRE_INTERACTION_APPROVAL_DANGER, NOW) as Question;
    const onAnswer = vi.fn(async () => {});
    const { container } = render(<PendingSection q={READY} items={[q]} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={noop} onAnswer={onAnswer} onReply={noop} onJumpSession={noop} />);
    const card = container.querySelector<HTMLElement>('[data-stub="ApprovalCard"]')!;
    expect(card.getAttribute('data-dangerous')).toBe('true');
    expect(card.textContent).toContain('rm -rf ~/x');
    expect(card.textContent).toContain('强制递归删除');
    expect(screen.queryByRole('button', { name: '本对话都允许' })).toBeNull();
    fireEvent.keyDown(card, { key: 'Enter' });
    const approve = screen.getByRole('button', { name: /^批准/ });
    expect(approve.getAttribute('data-mouse-only')).toBe('true');
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(approve);
    expect(onAnswer).toHaveBeenCalledWith(q, '允许');
  });

  it('nothing waiting says so in one line', () => {
    render(<PendingSection q={READY} items={[]} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    expect(screen.getByText('当前没有待处理事项')).toBeTruthy();
  });
});

describe(' 02 进行中', () => {
  it('shows at most 3 rows and folds the rest into 另有 N 个, its titles as the summary', () => {
    const conv = (i: number): RunRow => ({ k: 'conv', id: `c${i}`, conv: { id: `c${i}`, title: `闲聊 ${i}`, busy: true, updated_at: NOW - 60_000, turn_count: 1, turns: [], last: '好' } });
    const rows = [1, 2, 3, 4, 5].map(conv);
    const go = vi.fn();
    const { container } = render(<RunningSection q={READY} rows={rows} convs={5} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={noop} />);
    expect(container.querySelectorAll('[data-run]').length).toBe(3);
    const fold = screen.getByRole('button', { name: /另有 2 个/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toContain('闲聊 4 │ 闲聊 5');
    fireEvent.click(fold);
    expect(container.querySelectorAll('[data-run]').length).toBe(5);
    expect(go).not.toHaveBeenCalled();
  });

  it('keeps 另有 N 个 shut when a folded row waits on you: 01 待处理 holds what it asks', () => {
    const r = runRows(snap, brief.convs ?? []);
    expect(r.rows.length).toBeGreaterThan(3);
    expect(r.rows.slice(3).some((x) => x.k === 'code' && x.session.state.startsWith('awaiting'))).toBe(true);
    const { container } = render(<RunningSection q={READY} rows={r.rows} convs={r.convs} code={r.code} activeRuns={snap.active_runs} now={NOW} lost={false} go={noop} onJumpSession={noop} />);
    expect(screen.getByRole('button', { name: new RegExp(`另有 ${r.rows.length - 3} 个`) }).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-run]').length).toBe(3);
  });

  it('without coding sessions a ghost row says so; 派发任务 stays in the action band only', () => {
    const go = vi.fn();
    const { container } = render(<RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={noop} />);
    expect(screen.getByText('当前没有编码会话')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '派发编码任务' })).toBeNull();
    expect(container.textContent).not.toContain('派发任务');
  });
});

describe('今天 console: the 进行中 frames', () => {
  it('running work has a solid frame, a role task a dashed one, an idle conversation a chip fill', () => {
    const r = runRows(snap, brief.convs ?? []);
    const busy = r.rows.find((x) => x.k === 'conv' && x.conv.busy)!;
    const task = r.rows.find((x) => x.k === 'task')!;
    const idle: RunRow = { k: 'conv', id: 'idle', conv: { id: 'idle', title: '闲聊', busy: false, updated_at: NOW - 60_000, turn_count: 1, turns: [], last: '好' } };
    const { container } = render(<RunningSection q={READY} rows={[busy, task, idle]} convs={2} code={0} activeRuns={snap.active_runs} now={NOW} lost={false} go={noop} onJumpSession={noop} />);
    const frame = (id: string) => container.querySelector(`[data-run="${id}"] button`)?.getAttribute('data-frame');
    expect([frame(busy.id), frame(task.id), frame('idle')]).toEqual(['run', 'bg', 'idle']);
  });
});

describe(' 02 进行中 durations', () => {
  it('a row that started this second reads 刚开始, not 0 秒', () => {
    const own = snap.sessions.find((x) => x.own)!;
    render(<RunningSection q={READY} rows={[{ k: 'code', id: own.id, session: own, started: NOW }]} convs={0} code={1} activeRuns={{}} now={NOW} lost={false} go={noop} onJumpSession={noop} />);
    expect(screen.getByText('刚开始')).toBeTruthy();
    expect(screen.queryByText('0 秒')).toBeNull();
  });
});
