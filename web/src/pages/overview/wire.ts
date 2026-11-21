// agentd shapes the overview reads that domain/wire does not declare yet. Times are epoch seconds unless typed ISO.
import type { WireApproval, WireDelivery, WireInteraction, WireLedgerTask, WireObservation, WireTaskRow } from '../../domain';

/** commitments.py:10 COLUMNS; GET /commitments → {commitments}. */
export interface WireCommitment {
  id: string;
  text: string;
  /** null while a trigger reminder waits for its event. */
  due_at: number | null;
  state: 'armed' | 'triggered' | 'fulfilled' | 'missed' | 'cancelled';
  created_at: number;
  created_line: string | null;
  delivered_line: string | null;
  updated_at: number;
  /** null: once; daily or weekdays: re-armed at its next time after it is due. */
  repeat: 'daily' | 'weekdays' | null;
  /** null: timed; otherwise armed with due_at null until it fires, missed after 24 h unfired. */
  trigger:
    | { kind: 'session_done'; agent: 'claude' | 'codex' | null; session_id?: string }
    | { kind: 'approval_waiting'; minutes: number }
    | null;
  /** When its card was first on screen since it last came due; null: not yet. */
  seen_at: number | null;
}

/** server.py:3178-3194 GET /agent/snapshot: each part is that route's body, null when it answered 503. */
export interface WireAgentSnapshot {
  stream_epoch: string;
  /** Feed watermark: subscribe after it so nothing changed during the read is missed. */
  seq: number;
  interactions: { requests: WireInteraction[] } | null;
  tasks: { tasks: WireLedgerTask[] } | null;
  personal_tasks: { tasks: WireTaskRow[]; next_cursor: string | null } | null;
  deliveries: { deliveries: WireDelivery[]; next_cursor: string | null } | null;
  commitments: { commitments: WireCommitment[] } | null;
  approvals: { approvals: WireApproval[] } | null;
}

/** server.py:3257-3263 GET /state, the keys the overview reads. */
export interface WireState {
  character: string | null;
  observation: WireObservation;
}

/** day_summary.py:84-86,96 ledger session row; times from the coding ledger, null when a row has none. */
export interface WireDaySession {
  session_id: string;
  started_at: number | null;
  ended_at: number | null;
  agents_done: number;
  agents_failed: number;
  last_gate: { at: number | null; passed: boolean } | null;
  guard_blocks: number;
}

/** day_summary.py:106-108 own coding session started that day. */
export interface WireDayOwn {
  session_id: string;
  title: string | null;
  state: string;
  last_line: string | null;
  started_at: number;
  updated_at: number;
  task_id: string | null;
}

/** trace_store.py decision row; GET /trace/decisions → {events}. The overview reads proactive gate decisions. */
export interface WireDecisionEvent {
  event_id: string;
  trace_id: string;
  kind: string;
  status: string;
  /** ISO time. */
  t_wall: string;
  attrs: Record<string, unknown>;
}

/** GET /day/segments?date= → {date, projects}. */
export interface WireDaySegments {
  date: string;
  projects: Array<{ project: string; name: string; sessions: WireDaySession[]; own: WireDayOwn[] }>;
}
