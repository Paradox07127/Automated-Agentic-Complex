import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type StreamEvent } from '../../bridge';
import { useRuntimePublic } from '../../data/runtime';
import type { ActiveRun, ErrorEntry, Plan, StepStatus } from '../../domain';
import type { DemoState } from '../../shell/demo';
import { usePlugins } from '../../shell/plugins';
import { errText } from './errors';
import { runtimeOf, withRuntime } from './kernel';
import { clock, emptyWork, overviewOf, readDay, readFailedTurns, readRole, readRunning, readSnapshot, sparseWork, type RoleRead, type RunningRead, type SnapshotRead } from './load';
import { loadBrief, readMood, type MoodPoint, type OverviewBrief } from './loadBrief';
import type { WireDaySegments } from './wire';

export type { OverviewSnapshot, Reminder } from './load';

/** `demo=sparse` reads the full mocks and keeps a quiet day's share; only the fake bridge honours it. */
const sparseDemo = (demo: string | null) => demo === 'sparse' && !window.agenticComplex;

function sparseBrief(b: OverviewBrief): OverviewBrief {
  return { episodes: b.episodes && b.episodes.slice(-2), convs: b.convs && b.convs.slice(0, 1).map((c) => ({ ...c, busy: false, turns: c.turns.slice(-1) })), spoke: b.spoke && b.spoke.slice(-1) };
}

/** Feed events after which the snapshot is read again. */
const RELOAD_ON: ReadonlySet<string> = new Set(['agent_run', 'agent_interaction', 'delivery', 'commitment']);
const STEP_STATUS: ReadonlySet<string> = new Set(['pending', 'in_progress', 'waiting', 'completed', 'failed']);
const REFRESH_MS = 60_000;

interface FeedPlan {
  run_id: string;
  revision: number;
  title?: string;
  status?: string;
  at?: number;
  steps?: Array<{ text?: string; status?: string }>;
}

function planOf(d: FeedPlan): Plan {
  return {
    revision: d.revision,
    run_id: d.run_id,
    ...(d.title ? { title: d.title } : {}),
    ...(d.status ? { status: d.status } : {}),
    steps: (d.steps ?? []).map((s) => ({ text: s.text ?? '', status: (STEP_STATUS.has(s.status ?? '') ? s.status : 'pending') as StepStatus, since: null })),
  };
}

/** Plans and the current tool per run, from the feed (agentd's run rows carry neither); `lost` after a feed reset or gap. */
function useLive(seq: string | null, reload: (reset?: boolean) => void, lostAtStart: boolean) {
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [tools, setTools] = useState<Record<string, string>>({});
  const [lost, setLost] = useState(lostAtStart);
  const after = useRef(seq);
  after.current = seq;
  const again = useRef(reload);
  again.current = reload;
  const ready = seq != null;

  useEffect(() => {
    if (!ready) return;
    const bridge = getBridge();
    const onFeed = (e: StreamEvent) => {
      if (e.event === 'plan') {
        const d = JSON.parse(e.data) as FeedPlan;
        setPlans((p) => ((p[d.run_id]?.revision ?? -1) > d.revision ? p : { ...p, [d.run_id]: planOf(d) }));
        setLost(false);
      } else if (e.event === 'agent_item') {
        const d = JSON.parse(e.data) as { run_id?: string; kind?: string; name?: string | null; status?: string };
        if (d.kind !== 'tool_call' || !d.run_id) return;
        const run = d.run_id;
        // agentd sends an item as started, then delta, then completed.
        setTools((t) => {
          const { [run]: _, ...rest } = t;
          return d.status !== 'completed' && d.name ? { ...rest, [run]: d.name } : rest;
        });
      } else if (RELOAD_ON.has(e.event)) again.current();
    };
    const offFeed = bridge.feed.subscribe(
      onFeed,
      () => {
        // Reset or gap: plans are not replayed, so rows fall back to their state until the next plan event.
        setPlans({});
        setTools({});
        setLost(true);
        again.current(true);
      },
      after.current ?? undefined,
    );
    // Hook approvals are not on the feed; the broker's approval.* decisions are on the diag stream.
    const offDiag = bridge.diag.subscribe(
      (e) => {
        if (e.event === 'decision' && String((JSON.parse(e.data) as { kind?: unknown }).kind).startsWith('approval.')) again.current();
      },
      () => again.current(),
    );
    return () => {
      offFeed();
      offDiag();
    };
  }, [ready]);

  return { plans, tools, lost };
}

/** A failed read carries its short Chinese reason, which the sections and the page top show as is. */
const said = <T>(read: () => Promise<T>) => () =>
  read().catch((e: unknown) => {
    throw new Error(errText(e), { cause: e });
  });

/** `demo=kernel-off` reads the settings mock's signed-out kernel; only the fake bridge honours it. */
const runtimeDemo = (demo: string | null) => (demo === 'kernel-off' ? 'logged-out' : null);

/**
 * The overview's section reads (load.ts) plus the feed. Each section has its own query and shows as soon as it answers;
 * 待处理 reads `/agent/snapshot` alone. `state=loading` never reads (skeletons); `state=error` lets the first snapshot read
 * land and fails the refresh after it, so 待处理 shows its last data as stale, as a real failed refresh does.
 * `today` false (日报与简报 off) reads only the role band's core routes; 进行中 reads only what 编码会话 and 个人代理 have on.
 */
export function useOverview(demo: string | null, state: DemoState | null, today = true) {
  const client = useQueryClient();
  const failRefresh = useRef(false);
  const core = { enabled: state !== 'loading', retry: false, staleTime: Number.POSITIVE_INFINITY } as const;
  const once = { ...core, enabled: core.enabled && today };
  // The reads a feed event changes share this key prefix; a feed reset re-reads all overview queries.
  const all = useMemo(() => ['overview', demo], [demo]);
  const work = useMemo(() => ['overview', demo, 'work'], [demo]);
  const q = useQuery<SnapshotRead, Error>({ queryKey: [...work, 'snapshot'], queryFn: said(() => readSnapshot(demo, demo === 'fail' || failRefresh.current)), ...once });
  const plugins = usePlugins();
  const runOn = { sessions: plugins.coding_sessions, runs: plugins.personal_agent };
  const running = useQuery<RunningRead, Error>({
    queryKey: [...work, 'running', runOn.sessions, runOn.runs],
    queryFn: said(() => readRunning(runOn)),
    ...once,
    enabled: once.enabled && (runOn.sessions || runOn.runs),
  });
  const turns = useQuery<ErrorEntry[], Error>({ queryKey: [...work, 'turns'], queryFn: said(() => readFailedTurns(clock())), ...once });
  const role = useQuery<RoleRead, Error>({ queryKey: ['overview', demo, 'role'], queryFn: said(() => readRole(demo)), ...core });
  const day = useQuery<WireDaySegments, Error>({ queryKey: ['overview', demo, 'day'], queryFn: said(() => readDay(demo, clock())), ...once, refetchInterval: REFRESH_MS });
  const bq = useQuery<OverviewBrief, Error>({ queryKey: ['overview', demo, 'brief'], queryFn: said(() => loadBrief(clock())), ...once, refetchInterval: REFRESH_MS });
  const mood = useQuery<MoodPoint[], Error>({ queryKey: ['overview', demo, 'mood'], queryFn: said(() => readMood(clock())), ...once });
  const kernel = useRuntimePublic({ demo: runtimeDemo(demo), select: runtimeOf });
  const { refetch } = q;
  useEffect(() => {
    if (state !== 'error' || !q.isSuccess || failRefresh.current) return;
    failRefresh.current = true;
    void refetch();
  }, [state, q.isSuccess, refetch]);

  // One read at a time; an event that lands during a read asks for one more after it.
  const busy = useRef(false);
  const dirty = useRef(false);
  const full = useRef(false);
  const reload = useCallback(
    (reset = false) => {
      dirty.current = true;
      if (reset) full.current = true;
      if (busy.current) return;
      busy.current = true;
      void (async () => {
        while (dirty.current) {
          const queryKey = full.current ? all : work;
          // A read already under way started before the event: wait for it, then read again.
          const wait = client.isFetching({ queryKey }) > 0;
          dirty.current = wait;
          if (!wait) full.current = false;
          await client.refetchQueries({ queryKey }, { cancelRefetch: false });
        }
        busy.current = false;
      })();
    },
    [all, client, work],
  );

  const live = useLive(q.data ? String(q.data.wire.seq) : null, reload, demo === 'plan-lost');
  const data = useMemo(() => {
    const parts = { snapshot: q.data, running: running.data, runningError: running.error?.message, turns: turns.data, role: role.data, day: day.data, dayError: day.error?.message };
    const s = withRuntime(overviewOf(parts), kernel.data);
    return state === 'empty' ? emptyWork(s) : sparseDemo(demo) ? sparseWork(s) : s;
  }, [q.data, running.data, running.error, turns.data, role.data, day.data, day.error, kernel.data, state, demo]);
  const brief = useMemo(() => {
    const b = bq.data;
    if (!b) return b;
    if (state === 'empty') return { episodes: [], convs: [], spoke: [] };
    return sparseDemo(demo) ? sparseBrief(b) : b;
  }, [bq.data, state, demo]);
  const activeRuns = useMemo(() => {
    const out: Record<string, ActiveRun> = {};
    for (const [k, r] of Object.entries(data.active_runs)) {
      const tool = live.tools[r.run_id];
      out[k] = { ...r, plan: live.plans[r.run_id] ?? r.plan, ...(tool ? { tool, state: 'running_tool' as const } : {}) };
    }
    return out;
  }, [data, live.plans, live.tools]);
  return { q, reads: { running, turns, role, day, brief: bq, mood }, data, brief, activeRuns, lost: live.lost };
}
