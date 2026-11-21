// One turn's /trace/turns/{id} events → the chat page's TurnTrace, which its TurnInspector draws.
import type { Turn } from '../../domain';
import { isoWithOffset } from '../../domain/units';
import { buildTurnTrace, type TurnTrace } from '../chat/turnTrace';
import type { WireTraceEvent } from './wire';

const WIRE_RESULT: Readonly<Record<Turn['result'], string>> = { ok: 'ok', failed: 'failed', interrupted: 'interrupted', skipped: 'skipped', running: 'open', unknown: 'unknown' };

/** `no` is the turn's ordinal among the day's turns of the same source group. */
export function inspectorOf(turn: Turn, events: readonly WireTraceEvent[], no: number, skew: Record<string, number> = {}): TurnTrace {
  const row = {
    trace_id: turn.id,
    turn_id: turn.turn_id,
    source: turn.source,
    head: turn.head ?? null,
    len: turn.len ?? null,
    producers: turn.producers ?? [],
    started_at: isoWithOffset(turn.started_at),
    result: turn.trace_result ?? WIRE_RESULT[turn.result],
    ...(turn.turn_state ? { turn_state: turn.turn_state } : {}),
    duration_ms: turn.duration_ms,
  };
  return buildTurnTrace({ no, row, events: [...events], skew });
}
