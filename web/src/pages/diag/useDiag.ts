import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { get, seg } from '../../bridge/agentd';
import type { AgentdConnection } from '../../bridge/protocol';
import { appNow } from '../../bridge/clock';
import { useRuntimePublic } from '../../data/runtime';
import type { RenderSample, WireRuntimePublic, WireTraceTurn } from '../../domain';
import { DAY, isoWithOffset } from '../../domain/units';
import { turnsView, TURN_LIMIT, type DiagTurns } from './model';
import type { WireDiagState } from '../../domain/wire';
import type { WireCapabilities, WireDiagItem, WireTraceEvent, WireTurnEvents } from './wire';

export const clock = appNow;

const opts = { retry: false, staleTime: Number.POSITIVE_INFINITY } as const;

/** `/diag/state` and when it arrived (agentd sends no clock of its own). */
export interface DiagSnap {
  state: WireDiagState;
  at: number;
}

export const STATE_KEY = ['diag', 'state'] as const;

export function useDiagState(enabled: boolean) {
  return useQuery<DiagSnap, Error>({ queryKey: STATE_KEY, queryFn: async () => ({ state: await get<WireDiagState>('/diag/state'), at: clock() }), enabled, ...opts });
}

/** Bridge-side readings the page needs besides `/diag/state`; each push of the diag stream re-reads them. */
export function useSideReads(enabled: boolean) {
  const bridge = getBridge();
  const supervisor = useQuery({ queryKey: ['diag', 'supervisor'], queryFn: () => bridge.supervisor.state(), enabled, ...opts });
  const connection = useQuery({ queryKey: ['diag', 'connection'], queryFn: () => bridge.agentd.connection(), enabled, ...opts });
  const caps = useQuery({ queryKey: ['diag', 'capabilities'], queryFn: () => get<WireCapabilities>('/capabilities'), enabled, ...opts });
  const avatar = useQuery({ queryKey: ['diag', 'avatar'], queryFn: () => bridge.avatar.details(), enabled: enabled && bridge.capabilities.avatar, ...opts });
  const runtime = useRuntimePublic({ select: (r: WireRuntimePublic) => (Array.isArray(r.available_backends) ? r : null) });
  const perms = useQuery({ queryKey: ['diag', 'permissions'], queryFn: () => bridge.permissions.status(), enabled, ...opts });
  const app = useQuery({ queryKey: ['diag', 'app'], queryFn: () => bridge.app.info(), enabled, ...opts });
  return { supervisor, connection, caps, runtime, avatar, perms, app };
}

/** The shell's runtime push: agentd out of running marks the connection offline (the diag stream reconnects silently),
 *  its return re-reads every diag query. */
export function useAgentdRuntime(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let up = true;
    return getBridge().app.onRuntime((s) => {
      const now = s.processes.agentd.state === 'running';
      if (!now) qc.setQueryData<AgentdConnection>(['diag', 'connection'], 'offline');
      else if (!up) void qc.invalidateQueries({ queryKey: ['diag'] });
      up = now;
    });
  }, [enabled, qc]);
}

/** diag.subscribe while live: `state` replaces the snapshot and re-reads the bridge side, trace and decision items go to `onItem`, a reload re-reads everything. */
export function useDiagStream(live: boolean, onItem: (kind: 'trace' | 'decision', item: WireDiagItem) => void, onReload?: () => void) {
  const qc = useQueryClient();
  const item = useRef(onItem);
  item.current = onItem;
  const reload = useRef(onReload);
  reload.current = onReload;
  useEffect(() => {
    if (!live) return;
    const reset = () => {
      void qc.invalidateQueries({ queryKey: ['diag'] });
      void qc.invalidateQueries({ queryKey: ['trace-exact'] });
      reload.current?.();
    };
    return getBridge().diag.subscribe(
      (e) => {
        if (e.event === 'state') {
          // feed.py Feed.publish adds the stream's `seq` beside the blocks; every other key is a block.
          const { seq: _seq, ...state } = JSON.parse(e.data) as WireDiagState & { seq?: number };
          qc.setQueryData<DiagSnap>(STATE_KEY, { state, at: clock() });
          void qc.invalidateQueries({ queryKey: ['diag', 'supervisor'] });
          void qc.invalidateQueries({ queryKey: ['diag', 'connection'] });
          void qc.invalidateQueries({ queryKey: ['diag', 'avatar'] });
        } else if (e.event === 'trace' || e.event === 'decision') item.current(e.event, JSON.parse(e.data) as WireDiagItem);
        else if (e.event === 'reset' || e.event === 'gap') reset();
      },
      reset,
    );
  }, [live, qc]);
}

export function useTurns(range: '24h' | '7d', enabled: boolean) {
  return useQuery<DiagTurns, Error>({
    queryKey: ['diag', 'turns', range],
    queryFn: async () => {
      const end = clock();
      const start = end - (range === '7d' ? 7 * DAY : DAY);
      const r = await get<{ turns: WireTraceTurn[] }>(`/trace/turns?since=${encodeURIComponent(isoWithOffset(start))}&limit=${TURN_LIMIT}`);
      return turnsView(r.turns, start, end);
    },
    enabled,
    ...opts,
  });
}

/** Events of the last hour's failed turns, to place each failure on its node. */
export function useFailEvents(ids: readonly string[]) {
  return useQueries({ queries: ids.map((id) => ({ queryKey: ['diag', 'turn', id], queryFn: () => get<WireTurnEvents>(`/trace/turns/${seg(id)}`), ...opts })) });
}

const HOUR = 3_600_000;

/** The last hour of /trace/decisions: the coding-tool lane's sessions and approvals. */
export function useDecisions(enabled: boolean) {
  return useQuery<WireTraceEvent[], Error>({
    queryKey: ['diag', 'decisions', 'hour'],
    queryFn: async () => (await get<{ events: WireTraceEvent[] }>(`/trace/decisions?since=${encodeURIComponent(isoWithOffset(clock() - HOUR))}&limit=100`)).events,
    enabled,
    ...opts,
  });
}

/** The last 60 one-second avatar.onStats samples; nothing is read while paused or without the avatar capability. */
export function useRenderStats(enabled: boolean): RenderSample[] {
  const [samples, setSamples] = useState<RenderSample[]>([]);
  useEffect(() => {
    if (!enabled) return;
    return getBridge().avatar.onStats((s) =>
      setSamples((x) => {
        const at = s.at ?? clock();
        const next: RenderSample = { at, fps: s.fps, p95_ms: s.frameMsP95 ?? null, gpu_ms: s.gpuMs ?? null };
        const last = x.at(-1);
        return (last && at - last.at < 1000 ? [...x.slice(0, -1), next] : [...x, next]).slice(-60);
      }),
    );
  }, [enabled]);
  return samples;
}
