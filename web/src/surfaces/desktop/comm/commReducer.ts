// 通讯条 state machine: IDLE (no bar) → STREAMING → LINGER → FADING → IDLE; INTERRUPTED and ERROR stay
// their own time; HELD (hover or expanded) and PINNED stop the clock. Pure, so the timing is unit-tested.

/** `reason` of a proactive, ritual or tap `line` (proactive.py `line_reason`, rituals_glue.py `tap`). */
export interface LineReason {
  code: string;
  minutes?: number;
  away_min?: number;
  dwell_min?: number;
  /** A proactive line's gate category (what 「关闭此类」 mutes); a ritual's ritual. */
  kind?: string;
  /** agentd's 「为什么现在说」 for a proactive line. */
  text?: string;
}

/** One `/feed` `line` event, as server.py `_line` publishes it. */
export interface LineEvent {
  id: string;
  delta: string;
  final: boolean;
  cancelled: boolean;
  error: string | null;
  /** `agent`: the role's foreground run answers (run_id set); `side`: a line outside that run while it works;
   * `character` otherwise. */
  lane: 'agent' | 'side' | 'character';
  reason: LineReason | null;
}

/** thinking: agentd accepted the user's turn and no word of the answer has come yet. */
export type Phase = 'thinking' | 'streaming' | 'linger' | 'interrupted' | 'error' | 'fading';

export interface Bar {
  id: string;
  /** side: a read-only side session's answer while the foreground run works. */
  kind: 'main' | 'side';
  text: string;
  phase: Phase;
  reason: LineReason | null;
  pinned: boolean;
  held: boolean;
  /** ms left in the current timed phase; total is that phase's whole time. */
  left: number;
  total: number;
  /** Count of main lines this panel has shown, for the eyebrow. */
  seq: number;
}

export interface CommState {
  bars: Bar[];
  /** line_id of the foreground run's line until its final. */
  run: string | null;
  seq: number;
}

export type CommAction =
  | { type: 'line'; line: LineEvent }
  | { type: 'accepted'; id: string; side: boolean }
  | { type: 'tick'; dt: number }
  | { type: 'hold'; id: string; held: boolean }
  | { type: 'pin'; id: string; pinned: boolean }
  | { type: 'close'; id: string };

export const INTERRUPTED_MS = 4000;
export const ERROR_MS = 8000;
export const FADE_MS = 200;
/** A thinking bar whose line never came goes after this long. */
export const THINKING_MAX_MS = 120_000;
export const MAX_BARS = 2;

export const INITIAL: CommState = { bars: [], run: null, seq: 0 };

/** How long a finished line stays: clamp(3.5 s + 70 ms × characters, 4 s, 15 s). */
export function lingerMs(text: string): number {
  return Math.min(15000, Math.max(4000, 3500 + 70 * [...text].length));
}

const obj = (v: unknown): Record<string, unknown> | null => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The `data` of a `line` event; null when it is not one. */
export function parseLine(data: string): LineEvent | null {
  let d: Record<string, unknown> | null;
  try {
    d = obj(JSON.parse(data));
  } catch {
    return null;
  }
  if (!d || typeof d.line_id !== 'string' || !d.line_id) return null;
  const r = obj(d.reason);
  return {
    id: d.line_id,
    delta: typeof d.text_delta === 'string' ? d.text_delta : '',
    final: d.final === true,
    cancelled: d.cancelled === true,
    error: typeof d.error === 'string' && d.error ? d.error : null,
    lane: d.lane === 'agent' ? 'agent' : d.lane === 'side' ? 'side' : 'character',
    reason: r && typeof r.code === 'string' ? (r as unknown as LineReason) : null,
  };
}

/** The line id and side flag of a `turn_accepted` event; null when it is not one. */
export function parseAccepted(data: string): { id: string; side: boolean } | null {
  let d: Record<string, unknown> | null;
  try {
    d = obj(JSON.parse(data));
  } catch {
    return null;
  }
  if (!d || typeof d.line_id !== 'string' || !d.line_id || typeof d.side !== 'boolean') return null;
  return { id: d.line_id, side: d.side };
}

/** The phase a final event moves a streaming bar to; null when nothing is left to show. */
function settle(bar: Bar, e: LineEvent): Bar | null {
  if (!e.final) return bar;
  if (e.error) return { ...bar, phase: 'error', left: ERROR_MS, total: ERROR_MS };
  if (!bar.text.trim()) return null;
  if (e.cancelled) return { ...bar, phase: 'interrupted', left: INTERRUPTED_MS, total: INTERRUPTED_MS };
  const t = lingerMs(bar.text);
  return { ...bar, phase: 'linger', left: t, total: t };
}

const order = (bars: Bar[]) => [...bars.filter((b) => b.kind === 'main'), ...bars.filter((b) => b.kind === 'side')];

function add(old: Bar[], fresh: Bar): Bar[] {
  // A new main line replaces the main bar unless it is pinned; a side session supersedes the one before it.
  const bars = [...old.filter((b) => b.kind !== fresh.kind || (fresh.kind === 'main' && b.pinned)), fresh];
  while (bars.length > MAX_BARS) {
    const drop = bars.findIndex((b) => b !== fresh && !b.pinned);
    bars.splice(drop >= 0 ? drop : 0, 1);
  }
  return order(bars);
}

function onLine(s: CommState, e: LineEvent): CommState {
  const run = e.lane === 'agent' ? (e.final ? (s.run === e.id ? null : s.run) : e.id) : s.run;
  const at = s.bars.findIndex((b) => b.id === e.id);
  const old = s.bars[at];
  if (old) {
    if (old.phase === 'thinking' ? !e.delta && !e.final : old.phase !== 'streaming') return { ...s, run };
    const next = settle({ ...old, phase: 'streaming', text: old.text + e.delta }, e);
    return { ...s, run, bars: next ? s.bars.map((b, i) => (i === at ? next : b)) : s.bars.filter((_, i) => i !== at) };
  }
  if (!e.delta && !(e.final && e.error)) return { ...s, run };
  const kind = e.lane === 'side' || (e.lane === 'character' && s.run !== null) ? 'side' : 'main';
  const seq = kind === 'main' ? s.seq + 1 : s.seq;
  const fresh = settle({ id: e.id, kind, text: e.delta, phase: 'streaming', reason: e.reason, pinned: false, held: false, left: 0, total: 0, seq }, e);
  if (!fresh) return { ...s, run };
  return { bars: add(s.bars, fresh), run, seq };
}

function onAccepted(s: CommState, id: string, side: boolean): CommState {
  if (s.bars.some((b) => b.id === id)) return s;
  const kind = side ? 'side' : 'main';
  const seq = kind === 'main' ? s.seq + 1 : s.seq;
  const fresh: Bar = { id, kind, text: '', phase: 'thinking', reason: null, pinned: false, held: false, left: THINKING_MAX_MS, total: THINKING_MAX_MS, seq };
  return { ...s, bars: add(s.bars.filter((b) => b.phase !== 'thinking'), fresh), seq };
}

function onTick(s: CommState, dt: number): CommState {
  let changed = false;
  const bars: Bar[] = [];
  for (const b of s.bars) {
    if (b.phase === 'streaming' || (b.phase !== 'fading' && (b.pinned || b.held))) {
      bars.push(b);
      continue;
    }
    changed = true;
    const left = b.left - dt;
    if (left > 0) bars.push({ ...b, left });
    else if (b.phase !== 'fading' && b.phase !== 'thinking') bars.push({ ...b, phase: 'fading', left: FADE_MS });
  }
  return changed ? { ...s, bars } : s;
}

export function commReducer(s: CommState, a: CommAction): CommState {
  switch (a.type) {
    case 'line':
      return onLine(s, a.line);
    case 'accepted':
      return onAccepted(s, a.id, a.side);
    case 'tick':
      return onTick(s, a.dt);
    case 'hold':
    case 'pin': {
      const key = a.type === 'hold' ? 'held' : 'pinned';
      const value = a.type === 'hold' ? a.held : a.pinned;
      if (!s.bars.some((b) => b.id === a.id && b[key] !== value)) return s;
      return { ...s, bars: s.bars.map((b) => (b.id === a.id ? { ...b, [key]: value } : b)) };
    }
    case 'close':
      return { ...s, bars: s.bars.filter((b) => b.id !== a.id) };
  }
}

/** /feedback counts proactive lines only; a ritual or tap line is a reply to a tap (turns.py `start_line`). */
export const asksFeedback = (r: LineReason | null) => r != null && r.code !== 'ritual' && r.code !== 'tap';

/** 「关闭此类」 needs the line's category (POST /feedback `mute`, GET /proactive/mutes). */
export const canMute = (r: LineReason | null) => asksFeedback(r) && typeof r?.kind === 'string';
