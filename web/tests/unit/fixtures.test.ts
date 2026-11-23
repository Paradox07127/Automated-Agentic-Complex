// @vitest-environment node
// Consistency rules for the shared fixtures: backend constraints and one source per fact.
import { describe, expect, it } from 'vitest';
import { effectiveState, runTiming } from '../../src/domain';
import * as F from '../../src/mock/fixtures';
import { T6 } from '../../src/mock/fixtures/ids';

const ctx = { activeRuns: F.ACTIVE_RUNS, sessions: F.SESSIONS, pending: F.PENDING };
const task = (id: string) => {
  const t = F.TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

describe('backend constraints', () => {
  it('keeps every approval window ≤ 55 s and its timer inside the window', () => {
    for (const a of F.APPROVALS) {
      expect(a.window_s).toBeLessThanOrEqual(55);
      expect(a.seconds_left).toBeGreaterThan(0);
      expect(a.seconds_left).toBeLessThanOrEqual(a.window_s);
      expect(a.since).toBe(F.NOW - (a.window_s - a.seconds_left) * 1000);
    }
    for (const d of F.APPROVAL_DECISIONS) expect(d.duration_ms).toBeLessThanOrEqual(55_000);
  });

  it('returns at most 50 runs', () => {
    expect(F.RUNS.length).toBeLessThanOrEqual(50);
  });

  it('keeps valence within baseline ± 0.6 and lets it go negative', () => {
    const { baseline, valence } = F.CHARACTER_STATE;
    if (baseline == null || valence == null) throw new Error('fixture has no baseline or valence');
    const all = [valence, ...F.STATE_LOG.d24.map((p) => p.valence), ...F.STATE_LOG.d7.map((p) => p.valence)];
    for (const v of all) expect(Math.abs(v - baseline)).toBeLessThanOrEqual(F.VALENCE_SPAN + 1e-9);
    expect(valence).toBeLessThan(0);
  });

  it('reports gpu in milliseconds', () => {
    for (const s of F.RENDER_STATS) {
      expect(Object.keys(s)).not.toContain('gpu_pct');
      if (s.gpu_ms != null) expect(s.gpu_ms).toBeLessThan(1000 / F.PIPELINE.fps_target);
    }
    expect(F.RENDER_STATS.at(-1)?.gpu_ms).toBe(6.1);
  });

  it('never puts a timestamp after NOW', () => {
    const times = [
      ...F.RUNS.flatMap((r) => [r.started_at, r.ended_at ?? 0]),
      ...F.PENDING.map((p) => p.since),
      ...F.TURNS.map((t) => t.started_at + t.duration_ms),
      ...F.TURN_DOTS.map((t) => t.started_at),
      ...F.EPISODES.map((e) => e.start),
      ...F.DELIVERIES.flatMap((d) => [d.produced_at, d.presented_at ?? 0, d.viewed_at ?? 0, d.decided_at ?? 0]),
    ];
    for (const t of times) expect(t).toBeLessThanOrEqual(F.NOW);
  });
});

describe('one state per task everywhere', () => {
  it('gives every task with an open pending item the waiting state, and only those plus needs_review', () => {
    // Approvals carry no task; their task waits through its session.
    const awaiting = F.SESSIONS.filter((s) => s.state === 'awaiting_approval').map((s) => s.task_id);
    const withPending = new Set([...F.PENDING.map((p) => p.task_id), ...awaiting]);
    for (const t of F.TASKS) {
      const waiting = effectiveState(t, ctx) === 'waiting';
      expect(waiting, t.id).toBe(withPending.has(t.id) || t.status === 'needs_review');
    }
  });

  it('matches session and live-run states with the pending approvals', () => {
    // External sessions meet their approvals on display_session, own sessions on session_id; an own row's since is its own updated_at.
    for (const s of F.SESSIONS) {
      const approvals = F.APPROVALS.filter((a) => (s.own ? a.session_id === s.id : a.display_session === s.display_session));
      expect(s.state === 'awaiting_approval', s.id).toBe(approvals.length > 0);
      if (approvals.length && !s.own) expect(s.since).toBe(Math.min(...approvals.map((a) => a.since)));
      for (const a of approvals) expect(a.task_id).toBeNull();
    }
    for (const [id, run] of Object.entries(F.ACTIVE_RUNS)) {
      expect(task(id).run_id).toBe(run.run_id);
      expect(['running', 'needs_review']).toContain(task(id).status);
    }
  });

  it('places t6 at 10:12–10:15 in the task, its run and the character cause', () => {
    const t6 = task(T6);
    const runs = F.RUNS.filter((r) => r.run_id === task(T6).run_id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ started_at: F.at(10, 12), ended_at: F.at(10, 15), state: 'failed' });
    expect(t6.ended_at).toBe(F.at(10, 15));
    expect(F.CHARACTER_STATE.causes.find((c) => c.cause === 'task_failed')?.at).toBe(F.at(10, 15));
    expect(F.STEP_EVENTS[T6]?.at(-1)?.at).toBe(F.at(10, 15));
  });

  it('keeps candidate facts and counts aligned', () => {
    expect(Object.values(F.FACT_COUNTS).reduce((a, b) => a + b, 0)).toBe(F.FACTS.length);
    expect(F.FACTS.find((f) => f.text.startsWith('构建习惯'))?.state).toBe('candidate');
  });
});

describe('readouts that must agree', () => {
  it('sums today\'s by_call tokens to 1.24 M', () => {
    expect(F.TOKENS_TODAY_M).toBeCloseTo(1.24, 6);
  });

  it('keeps screenshot counts consistent and screen recording granted while screenshots are used', () => {
    const used = F.BUDGET.screenshots?.used;
    if (used == null) throw new Error('fixture has no screenshot budget');
    expect(F.SHOTS_BY_HOUR.reduce((a, b) => a + b, 0)).toBe(used);
    expect(F.SHOTS_7D.at(-1)).toBe(used);
    if (used > 0) expect(F.PERMISSIONS.find((p) => p.kind === 'screenRecording')?.state).toBe('granted');
  });

  it('keeps per-app foreground time within active time', () => {
    const appTotal = F.APP_TIME.reduce((n, a) => n + a.seconds, 0);
    expect(F.ATTENTION_SUMMARY.active_s).toBe(4 * 3600 + 27 * 60 + 10);
    expect(appTotal).toBeLessThanOrEqual(F.ATTENTION_SUMMARY.active_s);
    const safari = F.APP_TIME.find((a) => a.app === 'Safari')?.seconds ?? 0;
    expect(F.HOST_TIME.reduce((n, h) => n + h.seconds, 0)).toBeLessThanOrEqual(safari);
  });

  it('never lets a step stall exceed its run elapsed time', () => {
    for (const run of Object.values(F.ACTIVE_RUNS)) {
      const step = run.plan?.steps.find((s) => s.status === 'in_progress');
      const since = step?.since ?? run.since;
      expect(since).toBeGreaterThanOrEqual(run.started_at);
      const { elapsed_ms, stall_ms } = runTiming(run.started_at, since, F.NOW);
      expect(stall_ms ?? 0).toBeLessThanOrEqual(elapsed_ms);
    }
  });

  it('spreads run durations with a long tail', () => {
    const done = F.RUNS.filter((r) => r.ended_at != null).map((r) => ((r.ended_at ?? 0) - r.started_at) / 1000);
    expect(new Set(done).size).toBeGreaterThanOrEqual(30);
    expect(done.filter((d) => d > 1000).length).toBeGreaterThanOrEqual(1);
    expect(F.RUNS.some((r) => r.state === 'cancelled')).toBe(true);
  });

  it('keeps delivery timestamps in order', () => {
    for (const d of F.DELIVERIES) {
      const ts = [d.produced_at, d.presented_at, d.viewed_at, d.decided_at].filter((t): t is number => t != null);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
      expect(d.decided_at == null).toBe(!['accepted', 'rejected'].includes(d.state));
    }
  });

  it('points every reference at an existing record', () => {
    const ids = new Set<string>(F.TASKS.map((t) => t.id));
    const runs = new Set(F.RUNS.map((r) => r.run_id));
    for (const t of F.TASKS) if (t.run_id) expect(runs.has(t.run_id), t.id).toBe(true);
    for (const p of F.PENDING) if (p.task_id) expect(ids.has(p.task_id), p.id).toBe(true);
    for (const s of F.SESSIONS) if (s.task_id) expect(ids.has(s.task_id), s.id).toBe(true);
    for (const g of F.GOALS) for (const id of g.task_ids) expect(ids.has(id), id).toBe(true);
    const episodes = new Set(F.EPISODES.map((e) => e.id));
    for (const f of F.FACTS) for (const e of f.episode_refs) expect(episodes.has(e.id), `${f.id} ${e.id}`).toBe(true);
    expect(F.RUNTIMES.some((r) => r.id === F.SELECTED_RUNTIME && r.authenticated)).toBe(true);
  });
});
