import type { AppTime, AttentionSummary, Episode, Fact, FactCounts, PresenceSpan } from '../../domain';
import { fromAttention, fromEpisode, fromFact } from '../../domain/adapt';
import { at, NOW } from './clock';
import { WIRE_ATTENTION_APP, WIRE_ATTENTION_DOMAIN, WIRE_EPISODES, WIRE_FACTS } from './wire/memory';

/** `GET /memory` facts read at NOW. Candidates get「确认 / 删除」by state, not by source. */
export const FACTS: Fact[] = WIRE_FACTS.map((f) => fromFact(f, NOW));

/** `GET /memory` counts by source, derived from FACTS so the source bar and the list agree. */
export const FACT_COUNTS: FactCounts = {
  asserted_by_user: FACTS.filter((f) => f.source === 'asserted_by_user').length,
  confirmed_by_user: FACTS.filter((f) => f.source === 'confirmed_by_user').length,
  observed_context: FACTS.filter((f) => f.source === 'observed_context').length,
  inferred_hypothesis: FACTS.filter((f) => f.source === 'inferred_hypothesis').length,
};

/** `/episodes?date=` for today. */
export const EPISODES: Episode[] = WIRE_EPISODES.map(fromEpisode);

/** Presence bands (lower track). */
export const PRESENCE_SPANS: PresenceSpan[] = [
  { start: at(8, 40), end: at(12, 0), kind: 'active' },
  { start: at(12, 0), end: at(13, 10), kind: 'away' },
  { start: at(13, 10), end: at(13, 25), kind: 'unknown' },
  { start: at(13, 25), end: null, kind: 'active' },
];

const attention = fromAttention(WIRE_ATTENTION_APP, WIRE_ATTENTION_DOMAIN);

/** `/attention/summary`; its active time matches PRESENCE_SPANS (active 4 h 27 m). */
export const ATTENTION_SUMMARY: AttentionSummary = attention.summary;

/** Foreground time per app; the backend only counts overlap with active spans, so the sum stays ≤ active_s. */
export const APP_TIME: AppTime[] = attention.apps;

/** Browser hosts with foreground time (same rule as APP_TIME, a subset of Safari's time). */
export const HOST_TIME: AppTime[] = attention.hosts;

/** Last 10 memory generation batches (`/memory/runs?limit=10`). */
export const MEMORY_RUNS: Array<'ok' | 'fail' | 'skip'> = ['ok', 'ok', 'ok', 'fail', 'ok', 'ok', 'skip', 'ok', 'ok', 'ok'];
