// Character page agentd reads and writes: wire shapes in, domain objects out.
import { AgentdCallError, CONFLICT_CODES, del, get } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';
import { getPlugins } from '../../shell/plugins';
import {
  characterStateReset,
  fromCharacterState,
  fromStatePoint,
  fromTaskRow,
  isoToMs,
  isoWithOffset,
  msToEpochSec,
  type CharacterState,
  type StatePoint,
  type WireCharacterState,
  type WireStatePoint,
  type WireTaskRow,
} from '../../domain';

export type StateRange = '24h' | '7d';

/** Who settled a behavior tick: behavior.py `reason`, with stale and repeat results counted as rules. */
export type BeatSource = 'model' | 'rules' | 'hard';

/** One behavior.ticked that chose an activity. */
export interface Beat {
  id: string;
  at: number;
  chosen: string;
  source: BeatSource;
}

interface WireDecision {
  event_id: string;
  kind: string;
  t_wall: string;
  attrs: Record<string, unknown>;
}

const SPAN_MS: Record<StateRange, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };
/** agentd's upper bound; a week at one row a minute can still pass it, and then the oldest rows are left out. */
export const HISTORY_LIMIT = 5000;

const noState = (e: unknown) => e instanceof AgentdCallError && e.status === 503 && e.code === 'no_state';

/** GET /character/state; null while agentd has no state yet (503 no_state). */
export async function readState(): Promise<CharacterState | null> {
  try {
    return fromCharacterState(await get<WireCharacterState>('/character/state'));
  } catch (e) {
    if (noState(e)) return null;
    throw e;
  }
}

/** GET /character/state/history for the range ending at `now`, oldest first; empty without a state. */
export async function readHistory(range: StateRange, now: number): Promise<StatePoint[]> {
  const since = msToEpochSec(now - SPAN_MS[range]);
  try {
    const r = await get<{ items: WireStatePoint[] }>(`/character/state/history?since=${since}&limit=${HISTORY_LIMIT}`);
    return r.items.map(fromStatePoint);
  } catch (e) {
    if (noState(e)) return [];
    throw e;
  }
}

/** DELETE /character/state for the character whose state was read; agentd answers with the fresh state. */
export async function resetState(s: CharacterState): Promise<CharacterState> {
  return fromCharacterState(await del<WireCharacterState>('/character/state', characterStateReset(s)));
}

const SOURCE: Record<string, BeatSource> = { model: 'model', hard_rule: 'hard' };

/** behavior.ticked since `since`, oldest first; ticks that chose nothing (she was speaking) are left out. */
export async function readBeats(since: number): Promise<Beat[]> {
  const r = await get<{ events: WireDecision[] }>(`/trace/decisions?kind=behavior.ticked&since=${encodeURIComponent(isoWithOffset(since))}&limit=200`);
  return r.events
    .filter((e) => e.kind === 'behavior.ticked' && typeof e.attrs.chosen === 'string')
    .map((e) => ({ id: e.event_id, at: isoToMs(e.t_wall), chosen: e.attrs.chosen as string, source: SOURCE[String(e.attrs.reason)] ?? 'rules' }))
    .sort((a, b) => a.at - b.at);
}

/** Character tasks running now among the newest 100 (`/agent/tasks`, agentd's page maximum); a switch pauses their input for a moment. None without 个人代理. */
export async function readRunningTasks(): Promise<Array<{ title: string }>> {
  if (!getPlugins().personal_agent) return [];
  const r = await get<{ tasks: WireTaskRow[] }>('/agent/tasks?limit=100');
  return r.tasks.map((row) => fromTaskRow(row)).filter((t) => t.status === 'running');
}

const REASONS: Record<string, string> = {
  no_state: '还没有状态',
  invalid_character_id: '没有读到当前角色',
  invalid_since: '时间范围不对',
  invalid_limit: '条数超出范围',
  not_found: '后台没有这个接口',
};

export type Failure = { kind: 'offline' | 'conflict' | 'other'; text: string };

/** What the page says about a failed agentd call. */
export function failure(e: unknown): Failure {
  if (e instanceof AgentdCallError) {
    if (e.code === 'offline') return { kind: 'offline', text: '后台已断开' };
    const fault = serverFaultText(e);
    if (fault) return { kind: 'other', text: fault };
    if (e.status === 409 || CONFLICT_CODES.has(e.code)) return { kind: 'conflict', text: '已在别处更新' };
    return { kind: 'other', text: REASONS[e.code] ?? (e.status === 0 ? '请求没有发出' : `后台返回 ${e.status}`) };
  }
  return { kind: 'other', text: '没有给出原因' };
}
