import { useEffect, useRef, useState } from 'react';
import type { ProcessState } from '../../bridge/protocol';
import { demo as slot } from './demoSlot';
import type { ProcKey } from './status';

/** One supervisor.state read: CPU (share of one core, %) and memory (MB) per process. */
export interface ProcSample {
  at: number;
  cpu: Partial<Record<ProcKey, number | null>>;
  mem: Partial<Record<ProcKey, number | null>>;
}

const KEEP_MS = 30 * 60_000;
/** Without a diag stream push supervisor.state is read again this often. */
const POLL_MS = 2000;

interface SupervisorRead {
  data: Partial<Record<ProcKey, ProcessState>> | null | undefined;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

/**
 * The process readings since the page opened, at most the last 30 minutes, lost when the page closes. Each new
 * supervisor.state read adds one; `base` is the page clock at mount, so the times line up with the page's other data.
 */
export function useProcSamples(read: SupervisorRead, base: number, poll: boolean, seed: readonly ProcSample[] = []): ProcSample[] {
  const [samples, setSamples] = useState<ProcSample[]>(() => [...seed]);
  const t0 = useRef(Date.now());
  const { data, dataUpdatedAt } = read;
  useEffect(() => {
    if (!data || !dataUpdatedAt) return;
    const at = base + Math.max(0, dataUpdatedAt - t0.current);
    const keys = Object.keys(data) as ProcKey[];
    const s: ProcSample = {
      at,
      cpu: Object.fromEntries(keys.map((k) => [k, data[k]?.cpuPercent ?? null])),
      mem: Object.fromEntries(keys.map((k) => [k, data[k]?.memoryMB ?? null])),
    };
    setSamples((x) => [...x.filter((p) => p.at > at - KEEP_MS && p.at < at), s]);
  }, [data, dataUpdatedAt, base]);

  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!poll) return;
    const id = setInterval(() => {
      if (Date.now() - latest.current.dataUpdatedAt >= POLL_MS) void latest.current.refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);
  return samples;
}

/** The `full` demo's process curves are named by their row. */
const SEED_KEY: Readonly<Record<string, ProcKey>> = { 后台服务: 'agentd', 角色: 'avatar' };

/** The `full` demo's process history as page samples. */
export function seedOf(full: boolean): ProcSample[] {
  const h = full ? slot.full?.procHistory : undefined;
  if (!h) return [];
  const first = h.cpu[0]?.pts ?? [];
  return first.map(([at], i) => {
    const pick = (list: typeof h.cpu) => Object.fromEntries(list.filter((s) => SEED_KEY[s.label]).map((s) => [SEED_KEY[s.label], s.pts[i]?.[1] ?? null]));
    return { at, cpu: pick(h.cpu), mem: pick(h.mem) };
  });
}
