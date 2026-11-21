// Turn reads behind the turn tags, memory tags and 轮次详情: `/trace/turns` paired by turn_id (front-end
// version), one turn's events, and the facts whose recent uses name the turn. Demos `full` and `sparse` read the
// prototype data on the fake bridge instead.
import { useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { isoToMs, isoWithOffset } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { demo as slot } from './demoSlot';
import type { ChatDemoSource, DemoFact } from './demoTypes';
import { buildTurnTrace, type TiMem, type TraceEvent, type TurnTrace } from './turnTrace';
import { clock } from './useChatData';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** trace_store.py PAGE_MAX. */
const ROW_LIMIT = 200;

/** The prototype data of `full` / `sparse`, only on the fake bridge. */
export function demoSource(demo: string | null): ChatDemoSource | null {
  if (window.agenticComplex) return null;
  return demo === 'full' ? (slot.sources?.full ?? null) : demo === 'sparse' ? (slot.sources?.sparse ?? null) : null;
}

/** `/trace/turns` of the last 24 h by turn_id. */
export function useTraceRows(enabled: boolean, src: ChatDemoSource | null) {
  return useQuery({
    queryKey: ['chat-trace-rows', src ? src.rows.length : 'live'],
    queryFn: async (): Promise<Map<string, WireTraceTurn>> => {
      const rows = src ? src.rows : (await get<{ turns: WireTraceTurn[] }>(`/trace/turns?since=${encodeURIComponent(isoWithOffset(clock() - DAY_MS))}&limit=${ROW_LIMIT}`)).turns;
      return new Map(rows.map((r) => [r.turn_id, r]));
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Turns per hour over the 24 h ending at `now`, oldest first, by conversation; rows without one are skipped. */
export function hourlyOf(rows: Iterable<WireTraceTurn>, now: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const h = Math.floor((now - isoToMs(r.started_at)) / HOUR_MS);
    if (!r.conversation_id || h < 0 || h >= 24) continue;
    const row = (out[r.conversation_id] ??= Array.from({ length: 24 }, () => 0));
    row[23 - h] = (row[23 - h] ?? 0) + 1;
  }
  return out;
}

/** A saved link can name a turn outside the recent list. Ask the store for that exact row. */
export function useTraceRow(id: string | null, by: 'turn_id' | 'trace_id', enabled = true) {
  return useQuery({
    queryKey: ['trace-exact', by, id],
    queryFn: async () => (await get<{ turns: WireTraceTurn[] }>(`/trace/turns?${by}=${encodeURIComponent(id ?? '')}&limit=1`)).turns[0] ?? null,
    enabled: enabled && id != null,
    retry: false,
    staleTime: 5_000,
  });
}

/** Facts injected into each turn (memory.py `uses`: recent_uses line_id is the turn_id). */
export function useTurnFacts(enabled: boolean, src: ChatDemoSource | null) {
  return useQuery({
    queryKey: ['chat-turn-facts', src ? 'demo' : 'live', src?.facts.length ?? 0],
    queryFn: async (): Promise<Map<string, TiMem[]>> => {
      const facts: DemoFact[] = src ? src.facts : (await get<{ facts: DemoFact[] }>('/memory')).facts;
      const by = new Map<string, TiMem[]>();
      for (const f of facts)
        for (const u of f.recent_uses)
          if (u.mode === 'injected' && !(by.get(u.line_id) ?? []).some((m) => m.id === f.fact_id)) by.set(u.line_id, [...(by.get(u.line_id) ?? []), { id: f.fact_id, text: f.text }]);
      return by;
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Facts a turn added: only the demo source knows them (`/memory/runs` does not name the turn). */
export function learnedOf(src: ChatDemoSource | null, turnId: string): TiMem[] {
  if (!src) return [];
  return (src.learned[turnId] ?? []).flatMap((id) => {
    const f = src.facts.find((x) => x.fact_id === id);
    return f ? [{ id: f.fact_id, text: f.text }] : [];
  });
}

/** One turn for the inspector: its row, events and facts. */
export function useTurnTrace(row: WireTraceTurn | null, no: number, mems: TiMem[], src: ChatDemoSource | null) {
  const q = useQuery({
    queryKey: ['chat-turn-events', row?.trace_id ?? null, src ? 'demo' : 'live'],
    queryFn: async (): Promise<{ events: TraceEvent[]; skew_ms?: Record<string, number> }> => src ? { events: src.events[row?.trace_id ?? ''] ?? [] } : get(`/trace/turns/${seg(row?.trace_id ?? '')}`),
    enabled: row != null,
    retry: false,
    staleTime: 3_000,
    refetchInterval: row?.result === 'open' ? 3_000 : false,
  });
  const trace: TurnTrace | null = row && q.data ? buildTurnTrace({ no, row, events: q.data.events, skew: q.data.skew_ms ?? {}, mems, learned: learnedOf(src, row.turn_id) }) : null;
  return { query: q, trace };
}
