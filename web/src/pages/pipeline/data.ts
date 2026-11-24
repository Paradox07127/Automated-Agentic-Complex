// 记忆管线读的接口，照 agentd 的回包：/diag/state、/summary/runs、/episodes、/memory/runs(/{id})。
import { useQueries, useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { fromSummaryRun, type SummaryRun, type WireContextBlock, type WireDiagObservation, type WireEpisode, type WireSummaryRun } from '../../domain';
import { secToMs } from '../../domain/units';
import { KEY } from '../observe/data';

/** The /diag/state blocks this page reads. */
export interface DiagRead {
  context?: WireContextBlock;
  budget?: { screenshots: { used: number; reserved: number; released: number; limit: number } | null };
  observation?: Partial<WireDiagObservation>;
  proactive?: { focus: { category: string; dwell_s: number } | null } | null;
}

/** 「现在」的写操作刷新 KEY.diag，本页读同一份。 */
export const DIAG_KEY = KEY.diag;
export const readDiag = () => get<DiagRead>('/diag/state');

/** One interpretation run, with the episode it produced read as 「应用 · 标题」. */
export interface InterpRun extends SummaryRun {
  piece: string | null;
}

/** Today's observation_interpret runs, newest first; `day` as /summary/runs?date= takes it. */
export function useInterp(enabled: boolean, day: string) {
  const runs = useQuery({
    queryKey: ['pipeline', 'interp', day],
    queryFn: async () =>
      (await get<{ runs: WireSummaryRun[] }>(`/summary/runs?date=${day}&kinds=observation_interpret`)).runs.map(fromSummaryRun).sort((a, b) => b.at - a.at),
    enabled,
  });
  const eps = useQuery({
    queryKey: ['pipeline', 'episodes', day],
    queryFn: async () => (await get<{ episodes: WireEpisode[] }>(`/episodes?date=${day}`)).episodes,
    enabled: enabled && (runs.data ?? []).some((r) => r.episodeId != null),
    retry: false,
  });
  const piece = (id: number | null) => {
    const e = id == null ? undefined : eps.data?.find((x) => x.id === id);
    return e ? [e.apps?.[0], e.title].filter(Boolean).join(' │ ') : null;
  };
  const data: InterpRun[] | undefined = runs.data?.map((r) => ({ ...r, piece: piece(r.episodeId) }));
  return { ...runs, data };
}

/** GET /memory/runs row (memory_service.py `list`); times are epoch seconds. */
interface WireRun {
  run_id: string;
  backend: string;
  model: string;
  started_at: number;
  finished_at: number | null;
  state: string;
  prompt_version: string;
  redacted_reason: string | null;
}

/** GET /memory/runs/{id}: only what the table needs is kept from it. */
interface WireRunDetail extends WireRun {
  detail: {
    proposals: Array<{
      proposal: { operation: string; text?: string; target_quote?: string };
      receipt: { outcome?: string; fact_id?: string | null; error?: { code?: string } | null };
    }>;
  } | null;
  events: Array<{ event: string; reason?: unknown }>;
}

/** 用途：后台整理（memory_pipeline.py）或对话中（这一轮对话里写的）。 */
export type Purpose = 'extract' | 'chat' | 'other';
const PURPOSE: Readonly<Record<string, Purpose>> = { memory_extract: 'extract', conversation: 'chat' };
export const PURPOSE_LABEL: Readonly<Record<Purpose, string>> = { extract: '后台整理', chat: '对话中', other: '其他' };

export interface Run {
  id: string;
  purpose: Purpose;
  state: string;
  at: number;
  end: number | null;
  backend: string;
  model: string;
  /** Set once agentd dropped the run's detail (expired, memory changed, context revoked). */
  redacted: string | null;
}

/** One change a run wrote: 新增 / 更新 / 删除, the earlier text, and whether it waits for the user. */
export interface Change {
  op: 'add' | 'upd' | 'del';
  text: string;
  was?: string;
  cand: boolean;
}

export interface Digest {
  changes: Change[];
  /** The last reason code a failed or rejected run left in its events. */
  code: string | null;
}

/** Receipt outcomes that wrote something (memory_service.py); `unchanged`, `rejected` and the rest wrote nothing. */
const OP: Readonly<Record<string, Change['op']>> = { stored: 'add', candidate: 'add', corrected: 'upd', forgotten: 'del' };
const RUNS_READ = 12;

export function digestOf(d: WireRunDetail): Digest {
  const changes = (d.detail?.proposals ?? []).flatMap(({ proposal: p, receipt: r }): Change[] => {
    const op = r.outcome == null ? undefined : OP[r.outcome];
    const text = p.text || p.target_quote || '';
    if (!op || !text) return [];
    return [{ op, text, ...(op === 'upd' && p.target_quote && p.target_quote !== text ? { was: p.target_quote } : {}), cand: r.outcome === 'candidate' }];
  });
  const code = [...d.events].reverse().find((e) => typeof e.reason === 'string' && e.reason)?.reason;
  return { changes, code: typeof code === 'string' ? code : null };
}

const runOf = (w: WireRun): Run => ({
  id: w.run_id,
  purpose: PURPOSE[w.prompt_version.replace(/-v\d+$/, '')] ?? 'other',
  state: w.state,
  at: secToMs(w.started_at),
  end: w.finished_at == null ? null : secToMs(w.finished_at),
  backend: w.backend,
  model: w.model,
  redacted: w.redacted_reason,
});

export const RUNS_KEY = ['pipeline', 'runs'] as const;

/** The newest memory runs of both purposes and, per run, what it wrote; the detail itself is not kept, only its digest. */
export function useRuns(enabled: boolean) {
  const runs = useQuery({
    queryKey: RUNS_KEY,
    queryFn: async () => (await get<{ runs: WireRun[] }>(`/memory/runs?limit=${RUNS_READ}`)).runs.map(runOf),
    enabled,
  });
  const details = useQueries({
    queries: (runs.data ?? []).map((r) => ({
      queryKey: ['pipeline', 'run', r.id, r.state, r.redacted],
      queryFn: async () => digestOf(await get<WireRunDetail>(`/memory/runs/${seg(r.id)}`)),
      staleTime: r.state === 'running' ? 0 : 60_000,
      gcTime: 0,
      retry: false,
    })),
  });
  const digest = new Map<string, Digest>();
  (runs.data ?? []).forEach((r, i) => {
    const d = details[i]?.data;
    if (d) digest.set(r.id, d);
  });
  return { ...runs, digest };
}
