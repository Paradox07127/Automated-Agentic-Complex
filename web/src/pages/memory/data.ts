import { useQueries, useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { fromEpisode, type Fact, type WireEpisode } from '../../domain';
import type { RegionSource } from '../../ui';
import { errorText } from './errors';
import { hm, stamp, type Batch, type Change } from './model';

/** GET /memory/runs row (memory_service.py `list`). */
interface WireRun {
  run_id: string;
  started_at: number;
  finished_at: number | null;
  state: string;
  prompt_version: string;
}

/** GET /memory/runs/{id}: `detail` is null once redacted (48 h). */
interface WireRunDetail extends WireRun {
  detail: {
    user_input: string;
    proposals: Array<{
      proposal: { operation: string; text?: string; evidence_quote?: string; target_quote?: string };
      receipt: { outcome?: string; fact_id?: string | null; error?: unknown };
    }>;
  } | null;
}

export const RUNS_KEY = ['memory', 'runs'] as const;
const RUNS_READ = 10;
/** Batches 最近变化 lists; only the newest opens by default. */
const BATCHES_SHOWN = 3;
/** Background consolidation runs (memory_pipeline.py); conversation turns arrive on /feed instead. */
const isExtract = (r: WireRun) => r.prompt_version.startsWith('memory_extract') && (r.state === 'committed' || r.state === 'completed');
const OP: Readonly<Record<string, Change['op']>> = { add: 'add', correct: 'upd', forget: 'del' };

const readRun = (id: string) => get<WireRunDetail>(`/memory/runs/${seg(id)}`);
const runKey = (id: string) => ['memory', 'run', id] as const;

function changesOf(d: WireRunDetail): Change[] {
  return (d.detail?.proposals ?? []).flatMap(({ proposal: p, receipt: r }) => {
    const op = OP[p.operation];
    if (!op || r.error != null || r.outcome === 'rejected') return [];
    const text = p.text || p.target_quote || '';
    return text ? [{ op, id: r.fact_id ?? null, text, ...(op === 'upd' && p.target_quote ? { was: p.target_quote } : {}) }] : [];
  });
}

/** The newest consolidation batches with what each changed, and when the last one finished. */
export function useBatches(enabled: boolean) {
  const runs = useQuery({ queryKey: RUNS_KEY, queryFn: () => get<{ runs: WireRun[] }>(`/memory/runs?limit=${RUNS_READ}`), enabled });
  const extract = (runs.data?.runs ?? []).filter(isExtract);
  const details = useQueries({
    queries: extract.slice(0, BATCHES_SHOWN + 2).map((r) => ({ queryKey: runKey(r.run_id), queryFn: () => readRun(r.run_id), staleTime: Infinity })),
  });
  const batches: Batch[] = details
    .flatMap((q) => (q.data ? [{ id: q.data.run_id, at: (q.data.finished_at ?? q.data.started_at) * 1000, items: changesOf(q.data) }] : []))
    .filter((b) => b.items.length > 0)
    .slice(0, BATCHES_SHOWN);
  const last = extract[0];
  const pending = runs.isPending || details.some((q) => q.isPending);
  const shown = runs.data != null && !(pending && batches.length === 0);
  return {
    batches,
    lastAt: last ? (last.finished_at ?? last.started_at) * 1000 : null,
    pending,
    error: runs.isError,
    /** 最近变化's own read for a Region: the batch list once the runs and their details are in. */
    source: {
      status: runs.isError ? 'error' : shown ? 'success' : 'pending',
      data: shown ? batches : undefined,
      error: runs.error && new Error(errorText(runs.error)),
      isFetching: runs.isFetching,
      dataUpdatedAt: runs.dataUpdatedAt,
      refetch: runs.refetch,
    } satisfies RegionSource<Batch[]>,
  };
}

/** What a fact or candidate was read from: a chat line (agent_run ref) or an activity episode. */
export interface Evidence {
  k: 'chat' | 'obs';
  when: string;
  /** The episode's title; null for a chat line or an episode no longer listed. */
  title: string | null;
  /** The line she read it from, or the episode's apps; null once the run's detail is gone (48 h). */
  quote: string | null;
}

const RUN_REF = /^(?:agent_run|role_run):(.+)$/;
const EPISODE_REF = /^episode:(\d+)@(\d{4}-\d{2}-\d{2})$/;

/** The fact's latest evidence ref, read through `/memory/runs/{id}` or `/episodes?date=`; null when it has none (added by hand). */
export function useEvidence(f: Fact, now: number): { ev: Evidence | null; pending: boolean } {
  const ref = f.evidence.at(-1) ?? '';
  const run = RUN_REF.exec(ref)?.[1] ?? null;
  const ep = EPISODE_REF.exec(ref);
  const runQ = useQuery({ queryKey: runKey(run ?? ''), queryFn: () => readRun(run ?? ''), enabled: run != null, retry: false, staleTime: Infinity });
  const epQ = useQuery({
    queryKey: ['memory', 'episodes', ep?.[2] ?? ''],
    queryFn: () => get<{ episodes: WireEpisode[] }>(`/episodes?date=${ep?.[2] ?? ''}`),
    enabled: ep != null,
    retry: false,
  });
  if (run != null) {
    const d = runQ.data;
    const said = d?.detail?.proposals.find((p) => p.receipt.fact_id === f.id)?.proposal.evidence_quote || d?.detail?.user_input || null;
    return { ev: { k: 'chat', when: stamp(d ? d.started_at * 1000 : f.recorded_at, now), title: null, quote: said }, pending: runQ.isPending };
  }
  if (ep) {
    const w = epQ.data?.episodes.find((e) => String(e.id) === ep[1]);
    const e = w ? fromEpisode(w) : null;
    const [, m, d] = ep[2]?.split('-').map(Number) ?? [];
    const day = e ? stamp(e.start, now).split(' ')[0] : `${m}月${d}日`;
    const span = e ? `${hm(e.start)}${e.end != null ? `–${hm(e.end)}` : ''}` : '';
    return {
      ev: { k: 'obs', when: `${day}${span ? ` ${span}` : ''}`, title: e?.title ?? null, quote: e?.apps.length ? e.apps.join(' │ ') : null },
      pending: epQ.isPending,
    };
  }
  return { ev: null, pending: false };
}
