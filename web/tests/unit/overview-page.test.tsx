// 总览：01 待处理、02 进行中、03 今日简报，读数和跳转。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { sortPending } from '../../src/domain';
import { mockRoutes } from '../../src/mock';
import { at, DAY, NOW } from '../../src/mock/fixtures';
import { Brief } from '../../src/pages/overview/Brief';
import { briefLanes, briefWindow, codeCounts, nextReminder, reminderTime, runRows, workSpans, type RunRow } from '../../src/pages/overview/briefModel';
import { sparseWork, type OverviewSnapshot } from '../../src/pages/overview/load';
import { loadBrief, readMood, type DayConv, type MoodPoint, type OverviewBrief } from '../../src/pages/overview/loadBrief';
import { PendingSection } from '../../src/pages/overview/PendingSection';
import { demos } from '../../src/pages/overview/demos';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { loadOverview } from './overviewReads';

const noop = () => {};
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

afterEach(cleanup);

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
  it('the window runs from the first item, at least 5½ h back, to the hour after now', () => {
    expect(briefWindow(NOW, at(9, 2))).toEqual([at(9, 0), at(16, 0)]);
    expect(briefWindow(NOW, at(13, 10))).toEqual([at(9, 0), at(16, 0)]);
    expect(briefWindow(NOW, at(7, 40))).toEqual([at(7, 0), at(16, 0)]);
  });

  it('merges overlapping chat turns and coding sessions into one block and counts them', () => {
    const c: DayConv = { id: 'c', title: '闲聊', busy: false, updated_at: at(10, 5), turn_count: 2, turns: [{ t0: at(10, 0), t1: at(10, 0) }, { t0: at(10, 2), t1: at(10, 3) }], last: '好' };
    const empty = { ...snap, day: { runs: [], segments: [], lane_errors: {} }, sessions: [] };
    const spans = workSpans(empty, [c], NOW);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ t0: at(10, 0), t1: at(10, 6), who: ['对话 │ 闲聊'], to: { page: 'chat', conv: 'c' } });
  });

  it('three lanes: 用户活动, 对话与任务, 主动发言; reminders become ▼ on the ruler, past ones greyed', () => {
    const tl = briefLanes(snap, brief, NOW);
    expect(tl.lanes.map((l) => l.label)).toEqual(['用户活动', '对话与任务', '主动发言']);
    expect(tl.marks.find((m) => m.label.startsWith('提醒 │ 站会'))?.kind).toBe('done');
    expect(tl.marks.find((m) => m.label === '提醒 │ 交报销单')?.kind).toBeUndefined();
  });

  it('a reminder whose card was on screen says when it was shown', () => {
    const labels = briefLanes(snap, brief, NOW).marks.map((m) => m.label);
    expect(labels).toContain('提醒 │ 站会，已提醒，已显示');
    expect(labels).toContain('提醒 │ 午餐，已提醒');
    const later = { ...snap, reminders: snap.reminders.map((r) => (r.title === '站会' ? { ...r, seen_at: at(10, 42) } : r)) };
    expect(briefLanes(later, brief, NOW).marks.map((m) => m.label)).toContain('提醒 │ 站会，已提醒，已显示 10:42');
  });

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
  it('only the first item sits on a white paper card; the rest are record rows with a yellow state block, and one 展开 turns them into cards', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '展开 ›' }));
    expect(go).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-stub="Paper"]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-pending-row]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /收起/ }));
    expect(container.querySelectorAll('[data-stub="Paper"]')).toHaveLength(1);
  });

  it('a click on a record row opens that item as its card in place', () => {
    const items = sortPending(snap.pending);
    const { container } = render(<PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    const row = container.querySelector<HTMLElement>('[data-pending-row]')!;
    const id = row.getAttribute('data-pending-row')!;
    expect(row.getAttribute('data-nav-target')).toBe(`item-${id}`);
    fireEvent.click(row);
    expect(container.querySelector(`[data-item="${id}"] [data-stub="Paper"]`)).not.toBeNull();
    expect(container.querySelectorAll('[data-pending-row]')).toHaveLength(3);
  });

  it('decides a non-dangerous approval on its card', () => {
    const items = sortPending(snap.pending).filter((p) => p.kind === 'approval' && !p.dangerous);
    const onApprove = vi.fn();
    render(<PendingSection q={READY} items={items} now={NOW} at={NOW} sessions={snap.sessions} receipt={null} go={noop} onApprove={onApprove} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /^批准/ }));
    expect(onApprove).toHaveBeenLastCalledWith(items[0], 'allow', undefined);
  });

  it('nothing waiting says so in one line', () => {
    render(<PendingSection q={READY} items={[]} now={NOW} at={NOW} sessions={[]} receipt={null} go={noop} onApprove={noop} onAnswer={noop} onReply={noop} onJumpSession={noop} />);
    expect(screen.getByText('当前没有待处理事项')).toBeTruthy();
  });
});

describe(' 02 进行中', () => {
  it('shows at most 3 rows and folds the rest', () => {
    const r = runRows(snap, brief.convs ?? []);
    const go = vi.fn();
    const { container } = render(<RunningSection q={READY} rows={r.rows} convs={r.convs} code={r.code} activeRuns={snap.active_runs} now={NOW} lost={false} go={go} onJumpSession={noop} />);
    expect(container.querySelectorAll('[data-run]').length).toBe(Math.min(3, r.rows.length));
    expect(r.rows.length).toBeGreaterThan(3);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`另有 ${r.rows.length - 3} 个`) }));
    expect(container.querySelectorAll('[data-run]').length).toBe(r.rows.length);
    expect(go).not.toHaveBeenCalled();
  });

  it('without coding sessions a ghost row offers 派发任务', () => {
    const go = vi.fn();
    render(<RunningSection q={READY} rows={[]} convs={0} code={0} activeRuns={{}} now={NOW} lost={false} go={go} onJumpSession={noop} />);
    fireEvent.click(screen.getByRole('button', { name: '派发编码任务' }));
    expect(go).toHaveBeenLastCalledWith({ page: 'overview', create: 'code', focus: 'task-create' });
  });
});

describe(' 03 今日简报 and the role band', () => {
  it('writes one summary sentence and two number links to 管线 and 诊断', () => {
    const go = vi.fn();
    const { container } = render(<Brief q={READY} snap={snap} brief={brief} now={NOW} go={go} />);
    expect(container.textContent).toMatch(/今天 \d+ 段对话，\d+ 个编码会话（/);
    expect(container.textContent).toContain('下一条提醒');
    fireEvent.click(screen.getByRole('button', { name: /^截图 37 \/ 200/ }));
    expect(go).toHaveBeenLastCalledWith({ page: 'pipeline' });
    fireEvent.click(screen.getByRole('button', { name: /^出错/ }));
    expect(go).toHaveBeenLastCalledWith({ page: 'diag' });
    expect(screen.queryByRole('button', { name: /^新增记忆/ })).toBeNull();
    expect(within(container).getByRole('group', { name: /^今日时间轴：用户活动 \d+ 项，对话与任务 \d+ 项，主动发言 \d+ 项/ })).toBeTruthy();
  });

  it('sparse: no coding sessions reads 还没有编码会话', () => {
    const { container } = render(<Brief q={READY} snap={sparseWork(snap)} brief={brief} now={NOW} go={noop} />);
    expect(container.textContent).toContain('还没有编码会话');
  });

  it('a screenshot count that could not be read says why, not 后台暂不提供', () => {
    const { container } = render(<Brief q={READY} snap={{ ...snap, quota: null, diag_error: '后台出错（500）' }} brief={brief} now={NOW} go={noop} />);
    expect(screen.getByRole('button', { name: '截图计数没读到的原因' }).parentElement?.closest('button')).toBeNull();
    expect(container.textContent).toContain('没读到：后台出错（500）');
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
