import { useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { fromEpisode, type Fact, type WireEpisode } from '../../domain';
import { hm, stamp } from './model';

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
/** Background consolidation runs (memory_pipeline.py); conversation turns arrive on /feed instead. */
const isExtract = (r: WireRun) => r.prompt_version.startsWith('memory_extract') && (r.state === 'committed' || r.state === 'completed');

const readRun = (id: string) => get<WireRunDetail>(`/memory/runs/${seg(id)}`);
const runKey = (id: string) => ['memory', 'run', id] as const;

/** When the last consolidation batch finished; `pending` until the runs are read. */
export function useLastConsolidation(enabled: boolean) {
  const runs = useQuery({ queryKey: RUNS_KEY, queryFn: () => get<{ runs: WireRun[] }>(`/memory/runs?limit=${RUNS_READ}`), enabled });
  const last = (runs.data?.runs ?? []).find(isExtract);
  return { lastAt: last ? (last.finished_at ?? last.started_at) * 1000 : null, pending: runs.isPending };
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
