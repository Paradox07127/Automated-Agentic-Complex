// `/diag/state` blocks → what the settings rows show. Each block is optional: an older agentd may lack one.
import { fromCooldowns } from '../../domain/adapt';
import type { Cooldown } from '../../domain';
import { isoToMs, isoToMsOrNull } from '../../domain/units';
import { voiceState, type Voice } from '../../domain/voiceState';
import type { WireSummaryRun, WireVoice } from '../../domain/wire';
import type { WireDiagSlice, WireGateEvent } from './wire';

/** Running timed actions: resume times in epoch ms, meeting mode on or off. */
export interface Pauses {
  quiet: number | null;
  observe: number | null;
  meeting: boolean;
}

export interface Hook {
  /** null: no settings file, or it could not be read. */
  installed: boolean | null;
  last_at: number | null;
}

export interface DiagView {
  gate: { today: number; daily_limit: number; blocked_today: number } | null;
  cooldowns: Cooldown[];
  screenshots: { used: number; reserved: number; released: number; limit: number } | null;
  redactions: Array<{ label: string; count: number }> | null;
  /** Model calls today across every purpose. */
  calls: number | null;
  hooks: Record<'claude' | 'codex', Hook> | null;
  voice: Voice | null;
  /** The voice's provider and reason; null when agentd sends no provider. */
  voiceSource: Pick<WireVoice, 'provider' | 'reason'> | null;
  /** agentd was started without a TTS (provider none, reason not_configured). */
  voiceNone: boolean;
  pauses: Pauses | null;
  /** agentd's live mute (config.json, or a spoken「静音」since it started); null when not reported. */
  muted: boolean | null;
  /** When the running agentd started, epoch ms. */
  agentdStartedAt: number | null;
}

const hook = (h: { installed: boolean | null; last_at: string | null } | undefined): Hook => ({
  installed: h?.installed ?? null,
  last_at: typeof h?.last_at === 'string' ? isoToMsOrNull(h.last_at) : null,
});

export function diagView(d: WireDiagSlice | null): DiagView {
  const gate = d?.gate && typeof d.gate.today === 'number' ? d.gate : null;
  const budget = d?.budget;
  const red = budget?.redactions;
  const tts = d?.connections?.tts;
  const obs = d?.observation;
  const voice = tts ? voiceState(tts) : null;
  return {
    gate: gate && { today: gate.today, daily_limit: gate.daily_limit, blocked_today: gate.blocked_today },
    cooldowns: gate?.cooldown_s ? fromCooldowns(gate) : [],
    screenshots: budget?.screenshots ?? null,
    redactions: red && typeof red.key === 'number' ? [
      { label: '密钥', count: red.key },
      { label: '邮箱', count: red.email },
      { label: '电话', count: red.phone },
    ] : null,
    calls: typeof budget?.model?.calls === 'number' ? budget.model.calls : null,
    hooks: d?.hooks && 'claude' in d.hooks ? { claude: hook(d.hooks.claude), codex: hook(d.hooks.codex) } : null,
    voice,
    voiceSource: tts?.provider ? { provider: tts.provider, reason: tts.reason ?? null } : null,
    voiceNone: tts?.provider === 'none' && tts.reason === 'not_configured',
    pauses: obs && 'paused_until' in obs ? { quiet: isoToMsOrNull(obs.quiet_until), observe: isoToMsOrNull(obs.paused_until), meeting: obs.meeting } : null,
    muted: typeof d?.mouth_voice?.muted === 'boolean' ? d.mouth_voice.muted : null,
    agentdStartedAt: typeof d?.connections?.agentd?.started_at === 'string' ? isoToMsOrNull(d.connections.agentd.started_at) : null,
  };
}

/** One event on today's cumulative step chart; blocked ones are drawn as ✕ and not counted. */
export interface DayEvent {
  t: number;
  kind: 'ok' | 'blocked';
}

/** Local midnight of the day holding `ms`. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's chart span: 08:00–23:00, widened to the hour of an earlier event or a later now. */
export function daySpan(events: Array<{ t: number }>, now: number): [number, number] {
  const d0 = dayStart(now);
  const H = 3_600_000;
  const first = Math.min(now, ...events.map((e) => e.t));
  const t0 = Math.min(d0 + 8 * H, d0 + Math.floor((first - d0) / H) * H);
  const t1 = Math.max(d0 + 23 * H, d0 + Math.ceil((now - d0) / H) * H);
  return [t0, t1];
}

/** Local YYYY-MM-DD, the `date=` agentd's day reads take. */
export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Screenshots sent today; a run that ended in an error gave its screenshot back. */
export const shotEvents = (runs: WireSummaryRun[]): DayEvent[] =>
  runs.filter((r) => r.kind === 'observation_vision' || r.kind === 'user_vision').map((r) => ({ t: isoToMs(r.started_at), kind: r.error != null ? 'blocked' : 'ok' }));

/** agentd proactive.py's gate categories; announcements pass the same gate under their own kinds (gate_fail, ci_green…). */
const PROACTIVE = new Set(['back', 'break', 'stuck', 'comment']);

/** Proactive lines the gate let through today, and the ones it blocked. */
export const gateEvents = (events: WireGateEvent[]): DayEvent[] =>
  events.filter((e) => e.kind === 'gate.decided' && PROACTIVE.has(e.attrs.kind ?? '')).map((e) => ({ t: isoToMs(e.t_wall), kind: e.attrs.speak === false ? 'blocked' : 'ok' }));

/** A line the gate blocked: `kind` is its gate category, `reason` the gate's code. */
export interface BlockedLine {
  t: number;
  kind: string;
  reason: string;
}

/** Every line the gate blocked, of any category (thoughts and announcements too), newest first. */
export const blockedLines = (events: WireGateEvent[]): BlockedLine[] =>
  events
    .filter((e) => e.kind === 'gate.decided' && e.attrs.speak === false)
    .map((e) => ({ t: isoToMs(e.t_wall), kind: e.attrs.kind ?? '', reason: e.attrs.reason ?? '' }))
    .sort((a, b) => b.t - a.t);
