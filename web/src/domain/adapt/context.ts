// agentd step, conversation and memory rows → domain objects.
// Pure functions: anything clock-dependent takes the clock as an argument.
import type { AppTime, AttentionSummary, Conversation, Episode, Fact, FactUse, Message } from '../context';
import type { FactKind, ItemStatus, StepPhase } from '../states';
import { isoToMs, secToMs, secToMsOrNull } from '../units';
import type {
  WireAttention,
  WireBrowser,
  WireBrowserMedia,
  WireConversation,
  WireEpisode,
  WireFact,
  WireObservationDetail,
  WireRunItem,
  WireStep,
  WireSummaryRun,
  WireTurn,
} from '../wire';
import type { StepEvent, ToolItem } from '../work';

const DAY_MS = 86_400_000;

// ---- steps and conversation ----

const STEP_PHASE: Readonly<Record<string, StepPhase>> = {
  queued: 'prepare',
  task_started: 'prepare',
  started: 'prepare',
  verifying: 'verify',
  returned: 'verify',
  waiting_user: 'awaiting',
  awaiting_approval: 'awaiting',
  interrupted: 'suspended',
  suspended: 'suspended',
  completed: 'end',
  succeeded: 'end',
  failed: 'end',
  cancelled: 'end',
  needs_review: 'end',
  accepted: 'end',
  rejected: 'end',
};

export function fromStep(w: WireStep): StepEvent {
  return {
    step_id: w.step_id,
    run_id: w.run_id,
    generation: w.generation,
    kind: w.kind,
    status: w.status,
    phase: (w.phase ? STEP_PHASE[w.phase] : undefined) ?? 'execute',
    raw_phase: w.phase,
    name: w.name,
    summary: w.summary,
    at: secToMs(w.at),
  };
}

const ITEM_STATUS: ReadonlySet<string> = new Set(['in_progress', 'completed', 'failed']);

/** Tool call item; other kinds give null. Unknown statuses count as completed once the row has an update time. */
export function fromToolItem(w: WireRunItem): ToolItem | null {
  if (w.kind !== 'tool_call') return null;
  const status = (ITEM_STATUS.has(w.status) ? w.status : w.updated_at != null ? 'completed' : 'in_progress') as ItemStatus;
  return {
    kind: 'tool_call',
    name: w.name ?? '工具',
    status,
    created_at: secToMs(w.created_at),
    updated_at: status === 'in_progress' ? null : secToMs(w.updated_at),
    ...(w.summary ? { summary: w.summary } : {}),
  };
}

const sameLocalDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function fromConversation(w: WireConversation, nowMs: number): Conversation {
  const updated = secToMs(w.updated_at);
  return {
    id: w.id,
    character_id: w.character_id,
    title: w.title,
    group: w.pinned ? '置顶' : sameLocalDay(updated, nowMs) ? '今天' : '更早',
    updated_at: updated,
    created_at: secToMs(w.created_at),
    revision: w.revision,
    pinned: w.pinned,
    active: w.active,
    turn_count: w.turn_count,
    preview: w.preview,
    archived: w.archived,
  };
}

/** Conversation turns, oldest first, as a me / ai message pair each. */
export function turnsToMessages(turns: readonly WireTurn[]): Message[] {
  const out: Message[] = [];
  for (const t of turns) {
    const start = secToMs(t.started_at);
    const end = secToMsOrNull(t.ended_at);
    if (t.user_text && (t.source === 'text' || t.source === 'voice')) out.push({ kind: 'me', at: start, text: t.user_text });
    if (t.reply || (t.turn_id && ['failed', 'cancelled', 'interrupted'].includes(t.state)))
      out.push({
        kind: 'ai',
        at: end ?? start,
        text: t.reply,
        turn_ms: end == null ? 0 : end - start,
        ...(t.turn_id ? { turn_id: t.turn_id } : {}),
        state: t.state,
        source: t.source,
        character_id: t.character_id,
      });
  }
  return out;
}

// ---- memory ----

const FACT_HOW: Readonly<Record<WireFact['source'], string>> = {
  asserted_by_user: '用户陈述',
  confirmed_by_user: '用户确认',
  observed_context: '观察所得',
  inferred_hypothesis: '推断',
};
const STALE_AFTER_MS = 30 * DAY_MS;
const EPISODE_REF = /^episode:(\d+)@(\d{4}-\d{2}-\d{2})$/;

const localMidnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function fromFact(w: WireFact, nowMs: number): Fact {
  const lastUsed = secToMsOrNull(w.last_used_at);
  const recorded = secToMs(w.recorded_at);
  const uses: FactUse[] = w.recent_uses.map((u) => {
    const at = secToMs(u.at);
    return {
      at,
      line_id: u.line_id,
      how: u.mode,
      days_ago: Math.round((localMidnight(nowMs) - localMidnight(at)) / DAY_MS),
    };
  });
  const episodeRefs = w.evidence.flatMap((e) => {
    const m = EPISODE_REF.exec(e);
    return m?.[1] && m[2] ? [{ id: m[1], date: m[2] }] : [];
  });
  const observed = w.source === 'observed_context' || w.source === 'inferred_hypothesis';
  return {
    id: w.fact_id,
    version: w.version,
    owner: w.owner,
    kind: w.kind as FactKind,
    text: w.text,
    source: w.source,
    ...(w.state === 'candidate' ? { state: 'candidate' as const } : {}),
    recorded_at: recorded,
    how: FACT_HOW[w.source],
    uses_today: w.uses_today,
    last_used_at: lastUsed,
    uses,
    ...(observed && w.score != null ? { score: w.score } : {}),
    evidence: w.evidence,
    episode_refs: episodeRefs,
    occurred_at: secToMsOrNull(w.occurred_at),
    last_mentioned_at: secToMsOrNull(w.last_mentioned_at),
    locked: w.locked,
    quiet: w.quiet,
    ...(nowMs - (lastUsed ?? recorded) > STALE_AFTER_MS ? { stale: true } : {}),
  };
}

export function fromEpisode(w: WireEpisode): Episode {
  return {
    id: String(w.id),
    start: isoToMs(w.start),
    end: isoToMs(w.end),
    title: w.title,
    apps: w.apps ?? [],
    ...(w.hosts ? { hosts: w.hosts } : {}),
    ...(w.description != null ? { description: w.description } : {}),
    ...(w.presence != null ? { presence: w.presence } : {}),
    ...(w.outcome != null ? { outcome: w.outcome } : {}),
    ...(w.edited != null ? { edited: w.edited } : {}),
  };
}

/** `/attention/summary?by=app` and `?by=domain` → totals plus per-app and per-host time. */
export function fromAttention(app: WireAttention, domain?: WireAttention): { summary: AttentionSummary; apps: AppTime[]; hosts: AppTime[] } {
  const rows = (w: WireAttention | undefined): AppTime[] => (w?.items ?? []).map((i) => ({ app: i.key, seconds: i.seconds }));
  return {
    summary: {
      active_s: app.active_s,
      afk_s: app.afk_s,
      unknown_s: app.unknown_s,
    },
    apps: rows(app),
    hosts: rows(domain),
  };
}

/** `/attention/browser` without the site list (the by=domain summary already carries it). */
export interface BrowserNow {
  connected: boolean;
  focused: boolean;
  /** Null while paused, unfocused or older than 15 s. */
  current: {
    at: number;
    host: string;
    /** Percent now and the deepest this page went; null when the page does not scroll. */
    scroll: { now: number; deepest: number } | null;
    tabs: number;
    audibleTabs: number;
    media: WireBrowserMedia | null;
  } | null;
  pageSwitches: number;
}

export function fromBrowser(w: WireBrowser): BrowserNow {
  const c = w.current;
  const pct = c?.scroll_percent;
  return {
    connected: w.connected,
    focused: w.focused,
    current: c && {
      at: secToMs(c.at),
      host: c.url_host,
      scroll: pct == null ? null : { now: pct, deepest: Math.max(c.max_scroll_percent ?? pct, pct) },
      tabs: c.tab_count,
      audibleTabs: c.audible_tab_count,
      media: c.media,
    },
    pageSwitches: w.page_switches,
  };
}

/** `/diag/observations/<id>` with epoch-ms times. */
export interface ObservationDetail {
  id: string;
  mode: string;
  status: string;
  reason: string | null;
  app: string | null;
  requestedAt: number | null;
  observedAt: number | null;
  current: boolean;
  description: string | null;
  truncated: boolean;
  usedInLastTurn: boolean | null;
}

export function fromObservationDetail(w: WireObservationDetail): ObservationDetail {
  return {
    id: w.request_id,
    mode: w.mode,
    status: w.status,
    reason: w.reason,
    app: w.app,
    requestedAt: w.requested_at == null ? null : isoToMs(w.requested_at),
    observedAt: w.observed_at == null ? null : isoToMs(w.observed_at),
    current: w.current,
    description: w.description,
    truncated: w.description_truncated,
    usedInLastTurn: w.used_in_last_turn,
  };
}

/** One `/summary/runs` row with epoch-ms times. */
export interface SummaryRun {
  id: string;
  kind: string;
  at: number;
  span: [number, number] | null;
  outcome: string;
  error: string | null;
  attempt: number;
  durationMs: number;
  backend: string;
  model: string;
  episodeId: number | null;
}

export function fromSummaryRun(w: WireSummaryRun): SummaryRun {
  return {
    id: w.run_id,
    kind: w.kind,
    at: isoToMs(w.started_at),
    span: w.span_start != null && w.span_end != null ? [isoToMs(w.span_start), isoToMs(w.span_end)] : null,
    outcome: w.outcome,
    error: w.error,
    attempt: w.attempt,
    durationMs: w.duration_ms,
    backend: w.backend,
    model: w.model,
    episodeId: w.episode_id,
  };
}
