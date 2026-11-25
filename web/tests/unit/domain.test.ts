// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countByEffectiveState,
  countWaiting,
  effectiveState,
  formatClock,
  formatDuration,
  formatElapsed,
  formatMs,
  formatRemaining,
  isUrgent,
  runTiming,
  sortPending,
  stateVisual,
  type EffectiveContext,
  type VisualStateKey,
} from '../../src/domain';
import { formatAgo, formatSpan } from '../../src/domain/time';
import { ACTIVE_RUNS, at, PENDING, SESSIONS, TASKS } from '../../src/mock/fixtures';
import { A1, A2, A3, DLV_T1_V2, Q1, T1, T10, T2, T3, T4, T5, T6, T7, T9 } from '../../src/mock/fixtures/ids';

const X = 'task:x' as const;

const ctx: EffectiveContext = { activeRuns: ACTIVE_RUNS, sessions: SESSIONS, pending: PENDING };

describe('effectiveState', () => {
  it('puts needs_review, awaiting runs, awaiting sessions and open pending items into waiting', () => {
    expect(effectiveState({ id: X, status: 'needs_review' })).toBe('waiting');
    expect(effectiveState({ id: X, status: 'running' }, { activeRuns: { [X]: { state: 'awaiting_input' } } })).toBe('waiting');
    expect(effectiveState({ id: X, status: 'running' }, { sessions: [{ task_id: X, state: 'awaiting_approval' }] })).toBe('waiting');
    expect(effectiveState({ id: X, status: 'running' }, { sessions: [{ task_id: X, state: 'awaiting_input' }] })).toBe('waiting');
    expect(effectiveState({ id: X, status: 'running' }, { pending: [{ task_id: X }] })).toBe('waiting');
    expect(effectiveState({ id: X, status: 'running' }, { pending: [{ task_id: X, resolved: true }] })).toBe('running');
  });

  it('maps the remaining statuses', () => {
    expect(effectiveState({ id: X, status: 'queued' })).toBe('running');
    expect(effectiveState({ id: X, status: 'succeeded' })).toBe('done');
    expect(effectiveState({ id: X, status: 'failed' })).toBe('failed');
    expect(effectiveState({ id: X, status: 'interrupted' })).toBe('stopped');
    expect(effectiveState({ id: X, status: 'cancelled' })).toBe('stopped');
    expect(effectiveState({ id: X, status: 'running' }, { sessions: [{ task_id: X, state: 'idle' }] })).toBe('idle');
    expect(effectiveState({ id: X, status: 'running' }, { sessions: [{ task_id: X, state: 'error' }] })).toBe('failed');
  });

  it('gives the same "等你" count in the task legend, the 待处理 tab and the overview badge', () => {
    // Task legend: tasks grouped by effectiveState.
    const legend = countByEffectiveState(TASKS, ctx).waiting;
    // 待处理 tab: pending items deduplicated by task; an approval carries no task, so its session stands in.
    const tab = new Set(sortPending(PENDING.filter((p) => !p.resolved)).map((p) => (p.kind === 'approval' ? (p.task_id ?? p.display_session) : p.task_id))).size;
    // Overview / sidebar / desktop badge: the shared counter.
    const badge = countWaiting(TASKS, ctx).tasks;
    expect(legend).toBe(3);
    expect(tab).toBe(legend);
    expect(badge).toBe(legend);
    expect(countWaiting(TASKS, ctx).items).toBe(PENDING.length);
  });

  it('treats t2 and t5 as waiting although their backend status is running', () => {
    const byId = Object.fromEntries(TASKS.map((t) => [t.id, effectiveState(t, ctx)]));
    expect(byId).toMatchObject({ [T1]: 'waiting', [T2]: 'waiting', [T5]: 'waiting', [T3]: 'running', [T9]: 'running', [T10]: 'idle', [T4]: 'done', [T6]: 'failed', [T7]: 'stopped' });
  });
});

describe('sortPending', () => {
  it('orders urgent approvals first, then dangerous, then less time left, then waited longer', () => {
    const items = [
      { id: 'review-new', kind: 'review' as const, since: 300 },
      { id: 'q-old', kind: 'question' as const, since: 100 },
      { id: 'a-30', kind: 'approval' as const, seconds_left: 30, since: 200 },
      { id: 'a-danger', kind: 'approval' as const, dangerous: true, seconds_left: 50, since: 250 },
      { id: 'a-10', kind: 'approval' as const, seconds_left: 10, since: 260 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-10', 'a-danger', 'a-30', 'q-old', 'review-new']);
    expect(items[0]?.id).toBe('review-new');
  });

  it('same time left orders approval, then question, then review, before wait time', () => {
    const items = [
      { id: 'review-old', kind: 'review' as const, since: 100 },
      { id: 'q-new', kind: 'question' as const, since: 300 },
      { id: 'a-open', kind: 'approval' as const, since: 400 },
      { id: 'q-old', kind: 'question' as const, since: 200 },
    ];
    expect(sortPending(items).map((x) => x.id)).toEqual(['a-open', 'q-old', 'q-new', 'review-old']);
  });

  it('orders the shared fixture list the same way everywhere', () => {
    expect(sortPending(PENDING).map((p) => p.id)).toEqual([A1, A2, A3, Q1, `r-${DLV_T1_V2}`]);
  });
});

describe('time formatting', () => {
  it('formats wall clock in local time', () => {
    expect(formatClock(at(9, 5, 7))).toBe('09:05');
    expect(formatClock(at(14, 32, 4), { seconds: true })).toBe('14:32:04');
  });

  it('formats elapsed counters and durations by flooring', () => {
    expect(formatElapsed(42_900)).toBe('00:42');
    expect(formatElapsed(595_000)).toBe('09:55');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('00:00');
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(59_999)).toBe('59 秒');
    expect(formatDuration(6 * 60_000 + 59_000)).toBe('6 分');
    expect(formatDuration(95 * 60_000)).toBe('1 小时 35 分');
    expect(formatDuration(-5)).toBe('0 秒');
    expect(formatDuration(59_999, { seconds: true })).toBe('59 秒');
    expect(formatDuration(6 * 60_000 + 5_000, { seconds: true })).toBe('6 分 05 秒');
    expect(formatDuration(95 * 60_000 + 7_000, { seconds: true })).toBe('1 小时 35 分');
    expect(formatMs(880)).toBe('880 ms');
    expect(formatMs(1240)).toBe('1.2 s');
    expect(formatMs(42_000)).toBe('42 s');
  });

  it('formats time ago in its largest whole unit', () => {
    expect(formatAgo(-5)).toBe('刚刚');
    expect(formatAgo(59_999)).toBe('刚刚');
    expect(formatAgo(6 * 60_000 + 59_000)).toBe('6 分前');
    expect(formatAgo(60 * 60_000)).toBe('1 小时前');
    expect(formatAgo(95 * 60_000)).toBe('1 小时前');
    expect(formatAgo(24 * 3_600_000 - 1)).toBe('23 小时前');
    expect(formatAgo(24 * 3_600_000)).toBe('1 天前');
    expect(formatAgo((541 * 60 + 12) * 60_000)).toBe('22 天前');
  });

  it('formats a running span in its largest whole unit', () => {
    expect(formatSpan(-5)).toBe('0 秒');
    expect(formatSpan(59_999)).toBe('59 秒');
    expect(formatSpan(7 * 60_000 + 59_000)).toBe('7 分');
    expect(formatSpan(95 * 60_000)).toBe('1 小时');
    expect(formatSpan(24 * 3_600_000 - 1)).toBe('23 小时');
    expect(formatSpan(3 * 24 * 3_600_000 + 5 * 3_600_000)).toBe('3 天');
  });

  it('formats remaining time and urgency', () => {
    expect(formatRemaining(41)).toBe('剩余 41 秒');
    expect(formatRemaining(125)).toBe('剩余 2 分 05 秒');
    expect(formatRemaining(0)).toBe('已超时');
    // A fraction of a second still decides: it reads 1 秒, not 已超时.
    expect(formatRemaining(0.7)).toBe('剩余 1 秒');
    expect(formatRemaining(59.5)).toBe('剩余 1 分 00 秒');
    expect(formatRemaining(null)).toBe('不限时');
    expect(isUrgent(10)).toBe(true);
    expect(isUrgent(11)).toBe(false);
    expect(isUrgent(null)).toBe(false);
  });

  it('never reports a step stall longer than its run', () => {
    const now = at(14, 32);
    expect(runTiming(at(14, 22, 5), at(14, 26, 20), now)).toEqual({ elapsed_ms: 595_000, stall_ms: 340_000 });
    const early = runTiming(at(14, 30), at(14, 20), now);
    expect(early.stall_ms).toBe(early.elapsed_ms);
    expect(runTiming(at(14, 30), null, now).stall_ms).toBeNull();
  });
});

describe('stateVisual', () => {
  const css = readFileSync(fileURLToPath(new URL('../../src/design/tokens.css', import.meta.url)), 'utf8');
  const keys: VisualStateKey[] = [
    'queued', 'thinking', 'running_tool', 'verifying', 'running', 'in_progress', 'current', 'awaiting_input',
    'awaiting_approval', 'needs_review', 'waiting', 'produced', 'presented', 'viewed', 'warning', 'succeeded',
    'completed', 'accepted', 'ok', 'done', 'failed', 'error', 'broken', 'cancelled', 'interrupted', 'stopped',
    'rejected', 'idle', 'pending', 'todo', 'unreachable', 'skipped', 'waiting_user', 'proposed', 'approved', 'returned',
    'denied', 'expired',
  ];

  it('gives every state a colour token that exists, a shape and a label', () => {
    for (const k of keys) {
      const v = stateVisual(k);
      expect(css, `${k} -> ${v.token}`).toContain(`${v.token}:`);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it('keeps the intuitive colour meanings and shapes', () => {
    expect(stateVisual('succeeded')).toMatchObject({ tone: 'ok', shape: 'check', token: '--ef-state-ok' });
    expect(stateVisual('failed')).toMatchObject({ tone: 'failed', shape: 'square', token: '--ef-state-failed' });
    expect(stateVisual('blocked')).toMatchObject({ tone: 'warning', shape: 'triangle', label: '已阻塞' });
    expect(stateVisual('paused')).toMatchObject({ tone: 'cancelled', shape: 'hollow-square', label: '已暂停' });
    expect(stateVisual('awaiting_approval')).toMatchObject({ tone: 'waiting', shape: 'diamond', label: '待批准' });
    expect(stateVisual('running_tool')).toMatchObject({ tone: 'running', shape: 'ring', token: '--ef-state-running' });
    expect(stateVisual('warning')).toMatchObject({ tone: 'warning', shape: 'triangle' });
    expect(stateVisual('interrupted')).toMatchObject({ tone: 'cancelled', shape: 'hollow-square', label: '已中断' });
    expect(stateVisual('cancelled').shape).toBe('hollow-square');
    expect(stateVisual('pending')).toMatchObject({ tone: 'idle', shape: 'dot' });
  });
});
