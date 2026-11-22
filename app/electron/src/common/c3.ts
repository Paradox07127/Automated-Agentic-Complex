// C3 (protocol/C3-host-ipc/CONTRACT.md) as the Companion speaks it: the NDJSON framing, the messages this shell reads
// and sends, the Companion's hello and the heartbeat watchdog of rule 17. Sockets and processes are src/main's.

/** One line, its `\n` included (CONTRACT 「传输」). */
export const MAX_LINE = 65536;
export const PROTOCOL = 1;

/** Every message has `v` 1 and a `type`; unknown fields are kept and ignored. */
export interface C3Message { v: 1; type: string; [field: string]: unknown }

export interface AvatarHello extends C3Message {
  type: 'hello';
  role: 'avatar';
  pid: number;
  protocol: number;
  character?: string;
  appearance?: string;
  appearances?: { id: string; name: string }[];
  capabilities: string[];
  build?: Record<string, unknown>;
}

export interface Heartbeat extends C3Message { type: 'heartbeat'; seq: number; click_through: boolean; frames?: number; render?: string }
export interface Stats extends C3Message { type: 'stats'; fps: number; frame_ms_p95: number | null; gpu_ms: number | null }

export interface ActionRow {
  id: string;
  name: string;
  section: string;
  duration: number | null;
  trigger: string;
  required_reason: string | null;
  missing: string | null;
  media?: { bgm: boolean; face: boolean; camera: boolean };
  pose?: string;
  default_enabled?: boolean;
}

export interface Actions extends C3Message { type: 'actions'; character: string; actions: ActionRow[]; switches: Record<string, boolean>; error?: string }
export interface ActionPlayed extends C3Message { type: 'action_played'; play_id: string; id: string; phase: string; reason: string | null }

/**
 * What this shell always lists in its `hello`: it reads global hit capsules, watches heartbeats (rule 17), reads and drives
 * actions (rules 27–29) and asks her to walk clear of its main window (rule 42). A capability is added
 * here with the code that honours it.
 */
export const COMPANION_CAPABILITIES = ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings'];

const encoder = new TextEncoder();

/** The message as one line with its `\n`; throws when it would exceed MAX_LINE bytes. */
export function encodeLine(message: C3Message): string {
  const line = `${JSON.stringify(message)}\n`;
  if (encoder.encode(line).length > MAX_LINE) throw new Error(`C3 line over ${MAX_LINE} bytes: ${message.type}`);
  return line;
}

/** A line (without its `\n`) as a message; null when it is not a JSON object with `v` 1 and a string `type`. */
export function decodeLine(line: string): C3Message | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  return m.v === 1 && typeof m.type === 'string' ? m as C3Message : null;
}

export class LineTooLong extends Error {
  constructor() {
    super(`行超过 ${MAX_LINE} 字节`);
  }
}

/** Splits a byte stream into lines without their `\n`; a line over MAX_LINE throws LineTooLong (the reader then closes). */
export class LineFramer {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly decoder = new TextDecoder();

  append(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      if (this.pendingBytes + nl - start + 1 > MAX_LINE) throw new LineTooLong();
      this.pending.push(chunk.subarray(start, nl));
      lines.push(this.take());
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    // The pending part plus its eventual `\n` would already exceed the limit.
    if (this.pendingBytes + rest.length >= MAX_LINE) throw new LineTooLong();
    if (rest.length > 0) {
      this.pending.push(rest.slice());
      this.pendingBytes += rest.length;
    }
    return lines;
  }

  private take(): string {
    const whole = new Uint8Array(this.pending.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.pending) {
      whole.set(p, at);
      at += p.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    return this.decoder.decode(whole);
  }
}

/** The avatar's `hello`, or null when the message is not one (rule: the first message must be it). */
export function avatarHello(m: C3Message): AvatarHello | null {
  if (m.type !== 'hello' || m.role !== 'avatar' || !Array.isArray(m.capabilities)) return null;
  return m as AvatarHello;
}

/** `traceEpoch` goes on the line when `capabilities` lists `trace` (rule 22). */
export function companionHello(pid: number, build: Record<string, string>, capabilities: string[] = COMPANION_CAPABILITIES,
  traceEpoch?: number): C3Message {
  const hello: C3Message = { v: 1, type: 'hello', role: 'companion', pid, protocol: PROTOCOL, capabilities, build };
  if (capabilities.includes('trace')) hello.trace_epoch = traceEpoch;
  return hello;
}

export type FpsTier = 'interactive' | 'working';

/** `interactive` while `idle_low_fps` is off or `active` (her drag, the pointer on
 *  her, her speech or line, a conversation or her bubble on screen), else `working`. */
export function fpsTierFor(o: { idleLowFps: boolean; active: boolean }): FpsTier {
  return !o.idleLowFps || o.active ? 'interactive' : 'working';
}

/** Rule 13 and the fps table: `paused` 0 while hidden or paused, else `interactive` 60 or `working` 30. */
export function fpsTier(o: { paused: boolean; tier: FpsTier; userFps: number; batteryLow: boolean }): C3Message {
  const tier = o.paused ? { tier: 'paused', fps: 0 } : { tier: o.tier, fps: o.tier === 'interactive' ? 60 : 30 };
  return { v: 1, type: 'fps_tier', ...tier, user_fps: o.userFps, battery_low: o.batteryLow };
}

/** config.json's rule 45 switches; a missing key keeps its default (pinch off, the rest on), and any
 *  value but a boolean is false. */
export function touchSettings(saved: Record<string, unknown>): { regions: boolean; pat: boolean; pinch: boolean; greet: boolean } {
  const bool = (v: unknown, missing: boolean) => (v === undefined ? missing : v === true);
  return { regions: bool(saved.touch_regions, true), pat: bool(saved.head_pat, true), pinch: bool(saved.cheek_pinch, false),
    greet: bool(saved.greet_on_resume, true) };
}

/** Seconds; rule 17's watchdog. */
export const WATCHDOG = { firstHeartbeat: 10, receiving: 0.8, clickThrough: 10, stale: 0.3, renderStall: 4 } as const;

export type WatchdogVerdict = { kill: 'first_heartbeat_timeout' | 'heartbeat_timeout' | 'render_stall' } | { log: 'stale' | 'resumed' } | null;

/** Rule 17 for one handshaken connection; times in seconds on one clock. */
export class Watchdog {
  private readonly helloAt: number;
  private last: { at: number; clickThrough: boolean } | null = null;
  private stale = false;
  private frames = 0;
  private active = false;
  private progressAt: number;

  constructor(helloAt: number) {
    this.helloAt = helloAt;
    this.progressAt = helloAt;
  }

  /** Returns 'resumed' when it ends a stale gap that was logged. */
  heartbeat(h: Heartbeat, now: number): WatchdogVerdict {
    this.last = { at: now, clickThrough: h.click_through };
    if (Number.isInteger(h.frames) && (h.render === 'active' || h.render === 'idle')) {
      const frames = h.frames as number, active = h.render === 'active';
      if (frames > this.frames || (active && !this.active)) this.progressAt = now;
      this.frames = Math.max(this.frames, frames);
      this.active = active;
    }
    if (!this.stale) return null;
    this.stale = false;
    return { log: 'resumed' };
  }

  /** `receiving`: the window takes the mouse (the last heartbeat's click_through false and not hidden), or a drag runs. */
  check(now: number, hidden: boolean): WatchdogVerdict {
    if (this.last === null) return now - this.helloAt > WATCHDOG.firstHeartbeat ? { kill: 'first_heartbeat_timeout' } : null;
    const silent = now - this.last.at;
    const receiving = !this.last.clickThrough && !hidden;
    if (silent > (receiving ? WATCHDOG.receiving : WATCHDOG.clickThrough)) return { kill: 'heartbeat_timeout' };
    if (silent > WATCHDOG.stale) {
      if (this.stale) return null;
      this.stale = true;
      return { log: 'stale' };
    }
    if (this.active && now - this.progressAt > WATCHDOG.renderStall) return { kill: 'render_stall' };
    return null;
  }
}

/** One `hit_capsules` item: the segment `a`–`b` grown by `r`, in window or global points. */
export interface Capsule { ax: number; ay: number; bx: number; by: number; r: number }
export interface Box { x: number; y: number; w: number; h: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The well-formed items of `hit_capsules.capsules`; the others are dropped. */
export function readCapsules(list: unknown): Capsule[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Record<string, unknown> | null) => {
    const a = item?.a, b = item?.b;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2 || ![...a, ...b, item!.r].every(finite)) return [];
    return [{ ax: a[0] as number, ay: a[1] as number, bx: b[0] as number, by: b[1] as number, r: item!.r as number }];
  });
}

/** Rule 1: the point lies within `r` of a capsule's segment. */
export function capsuleHit(p: { x: number; y: number }, capsules: Capsule[]): boolean {
  return capsules.some((c) => {
    const dx = c.bx - c.ax, dy = c.by - c.ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - c.ax) * dx + (p.y - c.ay) * dy) / len2));
    const ex = c.ax + t * dx - p.x, ey = c.ay + t * dy - p.y;
    return ex * ex + ey * ey <= c.r * c.r;
  });
}

/** CGRect.contains: the min edges are inside, the max edges are not. */
export const boxContains = (b: Box, p: { x: number; y: number }): boolean => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

/** The capsules' bounding rectangle; null without any. */
export function capsulesBox(capsules: Capsule[]): Box | null {
  if (capsules.length === 0) return null;
  const x0 = Math.min(...capsules.map((c) => Math.min(c.ax, c.bx) - c.r)), y0 = Math.min(...capsules.map((c) => Math.min(c.ay, c.by) - c.r));
  const x1 = Math.max(...capsules.map((c) => Math.max(c.ax, c.bx) + c.r)), y1 = Math.max(...capsules.map((c) => Math.max(c.ay, c.by) + c.r));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Seconds and points of rules 1 and 36. */
export const CURSOR = { sample: 1 / 60, keepalive: 0.1, fresh: 0.5, near: 120, margin: 10, pointerInterval: 0.1, pointerSpeedStep: 50 } as const;

const within = (p: { x: number; y: number }, box: Box | null, distance: number) =>
  box !== null && Math.hypot(Math.max(box.x - p.x, 0, p.x - box.x - box.w), Math.max(box.y - p.y, 0, p.y - box.y - box.h)) <= distance;
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export interface PointerState { speed: number; hoverMs: number; near: boolean; shake: boolean }

/** Speed, shake, hover and near from the cursor samples, for `pointer`. */
export class CursorKinematics {
  static readonly speedWindow = 0.1;
  static readonly shakeWindow = 0.6;
  static readonly shakeReversals = 4;
  static readonly nearDistance = 120;
  /** Leaving near takes this much, so a cursor resting near 120 pt does not flip it. */
  static readonly nearExitDistance = 160;
  /** Near is judged against the union of this long's bounds, so a retracted arm does not shrink them at once. */
  static readonly nearBoundsWindow = 1;
  private samples: { ts: number; x: number; y: number }[] = [];
  private hoverSince: number | null = null;
  private near = false;
  private recentBounds: { ts: number; box: Box }[] = [];

  sample(ts: number, p: { x: number; y: number }, box: Box | null, hit: boolean): void {
    this.samples = this.samples.filter((s) => ts - s.ts <= CursorKinematics.shakeWindow);
    this.samples.push({ ts, x: p.x, y: p.y });
    this.hoverSince = hit ? this.hoverSince ?? ts : null;
    this.recentBounds = box === null ? [] : [...this.recentBounds.filter((b) => ts - b.ts <= CursorKinematics.nearBoundsWindow), { ts, box }];
    const all = this.recentBounds.reduce<Box | null>((u, b) => (u === null ? b.box : union(u, b.box)), null);
    this.near = within(p, all, this.near ? CursorKinematics.nearExitDistance : CursorKinematics.nearDistance);
  }

  state(now: number): PointerState {
    const fast = this.samples.filter((s) => now - s.ts <= CursorKinematics.speedWindow);
    let speed = 0;
    const first = fast[0], last = fast.at(-1);
    if (first && last && last.ts > first.ts) {
      let path = 0;
      for (let i = 1; i < fast.length; i++) path += Math.hypot(fast[i]!.x - fast[i - 1]!.x, fast[i]!.y - fast[i - 1]!.y);
      speed = path / (last.ts - first.ts);
    }
    const recent = this.samples.filter((s) => now - s.ts <= CursorKinematics.shakeWindow);
    const directions = recent.slice(1).map((s, i) => s.x - recent[i]!.x).filter((d) => d !== 0);
    const reversals = directions.slice(1).filter((d, i) => (d > 0) !== (directions[i]! > 0)).length;
    return { speed, shake: reversals >= CursorKinematics.shakeReversals,
      hoverMs: this.hoverSince === null ? 0 : Math.round((now - this.hoverSince) * 1000), near: this.near };
  }
}

const id64 = (v: unknown) => typeof v === 'string' && v !== '' && encoder.encode(v).length <= 64;
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** C6 §4.1's required fields of an avatar T1 event in a `trace` (rule 22); null when it keeps them. */
export function traceEventProblem(e: Record<string, unknown>, epoch: number): string | null {
  if (e.v !== 1) return 'v';
  if (e.producer !== 'avatar') return 'producer';
  if (e.producer_epoch !== epoch) return 'producer_epoch';
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) return 'seq';
  for (const key of ['kind', 'event_id', 'trace_id', 't_wall', 'status']) if (typeof e[key] !== 'string' || e[key] === '') return key;
  if (!count(e.t_mono_ms)) return 't_mono_ms';
  if (typeof e.attrs !== 'object' || e.attrs === null || Array.isArray(e.attrs)) return 'attrs';
  return null;
}

export const BEHAVIOR_PHASES = ['prepared', 'rejected', 'running', 'completed', 'blocked', 'cancelled', 'expired'];
export const TERMINAL_BEHAVIOR_PHASES = ['rejected', 'completed', 'blocked', 'cancelled', 'expired'];

/** Rule 25's `behavior_receipt` fields; null when they hold. */
export function behaviorReceiptProblem(m: Record<string, unknown>): string | null {
  if (!id64(m.behavior_id)) return 'behavior_id';
  if (typeof m.phase !== 'string' || !BEHAVIOR_PHASES.includes(m.phase)) return 'phase';
  if (typeof m.reason !== 'string' && m.reason !== null) return 'reason';
  if ((m.phase === 'rejected' || m.phase === 'blocked') && (typeof m.reason !== 'string' || m.reason === '')) return 'reason';
  if (!count(m.at_ms)) return 'at_ms';
  if (!count(m.turn_generation)) return 'turn_generation';
  return null;
}

const MOTION_STATE_PHASES = ['started', 'cycle_end', 'ended', 'expired', 'rejected'];

/** Rule 54's `motion_state` fields; null when they hold. */
export function motionStateProblem(m: Record<string, unknown>): string | null {
  if (m.origin !== 'agent' && m.origin !== 'local') return 'origin';
  if (!(id64(m.behavior_id) || m.behavior_id === null && m.origin === 'local')) return 'behavior_id';
  if (typeof m.phase !== 'string' || !MOTION_STATE_PHASES.includes(m.phase)) return 'phase';
  if (typeof m.resting !== 'boolean') return 'resting';
  if (typeof m.busy !== 'boolean') return 'busy';
  if (!id64(m.clip)) return 'clip';
  return null;
}

const MOTION_KINDS = ['turn', 'walk', 'window_loop', 'sit_enter', 'sit_loop', 'sit_exit', 'lean'];

/** Rule 40's `motion_request` fields, `bytes` its line's length without the newline; null when they hold. */
export function motionRequestProblem(m: Record<string, unknown>, bytes: number): string | null {
  if (bytes > 4096) return 'size';
  if (typeof m.request_id !== 'string' || !/^mr-[0-9a-f]{16}$/.test(m.request_id)) return 'request_id';
  if (!id64(m.behavior_id)) return 'behavior_id';
  if (typeof m.kind !== 'string' || !MOTION_KINDS.includes(m.kind)) return 'kind';
  if (!finite(m.seconds) || m.seconds < 1 || m.seconds > 10) return 'seconds';
  if (typeof m.geometry !== 'object' || m.geometry === null || Array.isArray(m.geometry)) return 'geometry';
  const g = m.geometry as Record<string, unknown>;
  const point = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(finite);
  const fits = m.kind === 'turn' ? finite(g.yaw) && Math.abs(g.yaw) <= 180
    : m.kind === 'walk' ? point(g.to, 2) && finite(g.end_yaw)
      : m.kind === 'window_loop' ? point(g.hips, 3)
        : m.kind === 'lean' ? ['left', 'right'].includes(g.hand as string) && point(g.grip, 3)
          : point(g.seat, 3);
  return fits ? null : 'geometry';
}

/** Rule 21: the largest coordinate either side accepts. */
export const MAX_COORDINATE = 100000;
type Fields = Record<string, unknown>;
const object = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v !== '' && encoder.encode(v).length <= max;
const atLeast = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
const inRange = (v: unknown, min: number, max: number): v is number => finite(v) && v >= min && v <= max;
const coordinate = (v: unknown) => inRange(v, -MAX_COORDINATE, MAX_COORDINATE);
const rect = (v: unknown) => object(v) && [v.x, v.y, v.w, v.h].every(coordinate) && (v.w as number) > 0 && (v.h as number) > 0;
const only = (m: Fields, keys: string[]) => Object.keys(m).every((k) => keys.includes(k));

/** Rule 45 (a)'s regions are `[a-z_]`, 1–32 bytes. */
const CLICK_REGION = /^[a-z_]{1,32}$/;

/** Rule 10's `click`; `regions` is that both sides list `touch` (rule 45 (g)). Null when it holds. */
export function clickProblem(m: Fields, regions: boolean): string | null {
  if (m.button !== 'left' && m.button !== 'right') return 'button';
  if (m.count !== 1 && !(m.count === 2 && m.button === 'left')) return 'count';
  if (!coordinate(m.x) || !coordinate(m.y)) return 'coordinate';
  if (m.region === undefined) return null;
  if (!regions) return 'region_capability';
  return typeof m.region === 'string' && CLICK_REGION.test(m.region) && m.button === 'left' && m.count === 1 ? null : 'region';
}

/** The `behavior_capabilities` of an `actions` list without `error`, at most 16 behavior ids to
 *  null or an unavailable reason (at most 512 bytes); null when the list has none or they are invalid. */
export function behaviorCapabilities(m: Fields): Record<string, string | null> | null {
  const table = m.behavior_capabilities;
  if (m.error !== undefined || !text(m.character, Infinity) || !object(table) || Object.keys(table).length > 16) return null;
  const valid = Object.entries(table).every(([k, v]) => id64(k) && (v === null || text(v, 512)));
  return valid ? table as Record<string, string | null> : null;
}

/** `speech_cancelled.reason` as agentd's `/speech/cancel` reason. */
export const SPEECH_CANCEL_REASONS: Record<string, string> = { client_cancel: 'client_cancel', playback_failed: 'error' };

export function speechCancelledProblem(m: Fields): string | null {
  if (!id64(m.speech_id)) return 'speech_id';
  return typeof m.reason === 'string' && Object.hasOwn(SPEECH_CANCEL_REASONS, m.reason) ? null : 'reason';
}

const PLAYBACK_STATES = ['started', 'buffering', 'resumed', 'ended', 'interrupted', 'failed', 'degraded'];

/** Rule 23's `playback` fields. */
export function playbackProblem(m: Fields): string | null {
  if (!id64(m.speech_id)) return 'speech_id';
  if (typeof m.clause_id !== 'string' && m.clause_id !== null) return 'clause_id';
  if (typeof m.state !== 'string' || !PLAYBACK_STATES.includes(m.state)) return 'state';
  if (!count(m.sample)) return 'sample';
  if (!atLeast(m.rate, 1)) return 'rate';
  if (['interrupted', 'failed', 'degraded'].includes(m.state) && (typeof m.reason !== 'string' || m.reason === '')) return 'reason';
  if (m.utterance_id !== undefined && (typeof m.utterance_id !== 'string' || m.utterance_id === '')) return 'utterance_id';
  if (m.spoken_text_revision !== undefined && !count(m.spoken_text_revision)) return 'spoken_text_revision';
  return null;
}

/** Rule 51 (j)'s limits. */
export const MOTION_OVERRIDES = { chains: 512, pools: 64, poolEntries: 64, blendIn: 512, keyBytes: 128, weight: 100000, blendSeconds: 2 } as const;
const OVERRIDE_REASONS: Record<string, string[]> = {
  chain: ['unknown_chain', 'required'],
  pool: ['unknown_pool', 'unknown_clip', 'excluded_family', 'no_return', 'stance_mismatch'],
  blend_in: ['unknown_clip'],
};
const overrideKey = (v: unknown) => text(v, MOTION_OVERRIDES.keyBytes);
const tally = (v: unknown, max: number) => Number.isInteger(v) && inRange(v, 0, max);

export interface MotionOverridesReceipt {
  req: number;
  character: string;
  applied: { chains: number; pools: number; blend_in: number };
  adjusted: { kind: string; key: string; reason: string }[];
  truncated: boolean;
}

/** Rule 51 (g)'s `motion_overrides` (MotionOverridesReceipt.parse); a string names the field that fails. */
export function readMotionOverrides(m: Fields): MotionOverridesReceipt | string {
  if (!atLeast(m.req, 1)) return 'req';
  if (typeof m.character !== 'string' || m.character === '') return 'character';
  const a = m.applied;
  if (!object(a) || !tally(a.chains, MOTION_OVERRIDES.chains) || !tally(a.pools, MOTION_OVERRIDES.pools)
    || !tally(a.blend_in, MOTION_OVERRIDES.blendIn)) return 'applied';
  const raw = m.adjusted;
  if (!Array.isArray(raw) || raw.length > MOTION_OVERRIDES.chains + MOTION_OVERRIDES.pools + MOTION_OVERRIDES.blendIn) return 'adjusted';
  if (!raw.every((x) => object(x) && typeof x.kind === 'string' && overrideKey(x.key) && OVERRIDE_REASONS[x.kind]?.includes(x.reason as string))) {
    return 'adjusted';
  }
  if (m.truncated !== undefined && m.truncated !== true) return 'truncated';
  return { req: m.req as number, character: m.character, applied: { chains: a.chains as number, pools: a.pools as number,
    blend_in: a.blend_in as number }, adjusted: raw.map((x) => ({ kind: x.kind, key: x.key, reason: x.reason })), truncated: m.truncated === true };
}

/** Rules 32, 33: `track_surface` and `untrack_surface`. */
export function surfaceTrackProblem(m: Fields): string | null {
  if (!id64(m.track_id)) return 'track_id';
  if (m.type === 'untrack_surface') return null;
  if (!atLeast(m.window_id, 1)) return 'window_id';
  return m.generation === undefined || atLeast(m.generation, 1) ? null : 'generation';
}

/** Rule 34: `attach` names a `track_id` or is null. */
export const attachProblem = (m: Fields): string | null => (m.track_id === null || id64(m.track_id) ? null : 'track_id');

export const DROP_LIMITS = { items: 16, textBytes: 16384 } as const;

/** Rule 38's `drop`: 1–16 items of one field each. */
export function dropProblem(m: Fields): string | null {
  if (!coordinate(m.x) || !coordinate(m.y)) return 'coordinate';
  const items = m.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > DROP_LIMITS.items) return 'items';
  const fits = (i: unknown) => object(i) && (
    (i.kind === 'file' && only(i, ['kind', 'path']) && typeof i.path === 'string' && i.path.startsWith('/'))
    || (i.kind === 'url' && only(i, ['kind', 'url']) && typeof i.url === 'string' && i.url !== '')
    || (i.kind === 'text' && only(i, ['kind', 'text']) && text(i.text, DROP_LIMITS.textBytes)));
  if (!items.every(fits)) return 'item';
  return m.truncated === undefined || typeof m.truncated === 'boolean' ? null : 'truncated';
}

export const REACTION_TRIGGERS = ['pat', 'pinch', 'greet'] as const;
export type ReactionTrigger = typeof REACTION_TRIGGERS[number];

/** Rule 55's `reaction`: `v`, `type` and `trigger` only. */
export function reactionProblem(m: Fields): string | null {
  if (!only(m, ['v', 'type', 'trigger'])) return 'keys';
  return (REACTION_TRIGGERS as readonly unknown[]).includes(m.trigger) ? null : 'trigger';
}

/** Rule 39's `motion.stroke`. */
export const motionStrokeProblem = (m: Fields): string | null => (!id64(m.token) ? 'token' : text(m.clip, 256) ? null : 'clip');

/** Rule 47's `pose_state`. */
export function poseStateProblem(m: Fields): string | null {
  if (typeof m.character !== 'string') return 'character';
  if (m.id !== null && !id64(m.id)) return 'id';
  return typeof m.locked === 'boolean' ? null : 'locked';
}

/** Rule 50's `captured`. */
export function capturedProblem(m: Fields): string | null {
  if (!atLeast(m.req, 1)) return 'req';
  if (typeof m.file !== 'string' || m.file === '' || m.file.includes('/')) return 'file';
  return atLeast(m.width, 1) && atLeast(m.height, 1) ? null : 'size';
}

/** Rule 49 (h)'s `camera_gesture`. */
export function cameraGestureProblem(m: Fields): string | null {
  if (!['began', 'changed', 'ended'].includes(m.phase as string)) return 'phase';
  if (!coordinate(m.dx) || !coordinate(m.dy)) return 'delta';
  return finite(m.zoom) && m.zoom > 0 ? null : 'zoom';
}

/** CONTRACT「Optional presentation capability」's `presentation_state`. */
export function presentationStateProblem(m: Fields, character: string | null): string | null {
  if (!count(m.req)) return 'req';
  if (typeof m.character !== 'string' || m.character === '' || m.character !== character) return 'character';
  if (!['state', 'applied', 'rejected'].includes(m.phase as string)) return 'phase';
  if (m.phase === 'applied' && !count(m.frame)) return 'frame';
  if (m.phase === 'rejected' && (typeof m.reason !== 'string' || m.reason === '')) return 'reason';
  const ex = m.expressions;
  if (!Array.isArray(ex) || ex.length > 512 || new Set(ex).size !== ex.length || !ex.every((e) => typeof e === 'string' && e !== '')) {
    return 'expressions';
  }
  if (m.expression != null && !ex.includes(m.expression)) return 'expression';
  if (typeof m.weather_supported !== 'boolean' || typeof m.face_effect_supported !== 'boolean') return 'supported';
  const cov = m.coverage;
  if (!object(cov) || ![cov.drops, cov.wetness, cov.snow].every((v) => inRange(v, 0, 1))) return 'coverage';
  const clips = m.facial_animations;
  const ids = Array.isArray(clips) ? clips.map((c) => (object(c) ? c.id : undefined)) : [];
  if (clips != null && (!Array.isArray(clips) || clips.length > 512 || new Set(ids).size !== clips.length
    || !clips.every((c) => object(c) && id64(c.id) && typeof c.name === 'string' && c.name !== '' && finite(c.duration) && c.duration > 0
      && c.duration <= 300))) return 'facial_animations';
  const play = m.facial_animation;
  if (play != null && (!object(play) || !finite(play.time) || play.time < 0 || typeof play.completed !== 'boolean'
    || (play.id !== null && !ids.includes(play.id)))) return 'facial_animation';
  return null;
}

/** CONTRACT「Optional presentation capability」's `set_presentation` inputs;
 *  `weight`, `rate` and `valid_for_seconds` may be left out (the contract's `?`). Null when they hold. */
export function presentationInputProblem(m: Fields): string | null {
  const groups = ['weather', 'expression', 'face_effect', 'facial_animation'];
  if (!only(m, [...groups, 'valid_for_seconds'])) return 'field';
  if (!groups.some((k) => m[k] !== undefined)) return 'empty';
  const keys = (v: unknown, required: string[], optional: string[]): v is Fields => object(v) && required.every((k) => k in v)
    && only(v, [...required, ...optional]);
  const unit = (x: unknown) => x === undefined || inRange(x, 0, 1);
  const w = m.weather;
  if (w !== undefined && (!keys(w, ['condition', 'intensity'], ['wetness', 'snow']) || !['clear', 'rain', 'snow'].includes(w.condition as string)
    || !inRange(w.intensity, 0, 1) || (w.condition === 'clear' && w.intensity !== 0) || !unit(w.wetness) || !unit(w.snow))) return 'weather';
  const e = m.expression;
  if (e !== undefined && (!keys(e, ['pose'], ['weight']) || (e.pose !== null && !text(e.pose, 256)) || !unit(e.weight))) return 'expression';
  const f = m.face_effect;
  if (f !== undefined && (!keys(f, ['index', 'blend'], []) || !Number.isInteger(f.index) || !inRange(f.index, 0, 3) || !inRange(f.blend, 0, 1))) {
    return 'face_effect';
  }
  const a = m.facial_animation;
  if (a !== undefined && (!keys(a, ['id'], ['rate', 'weight']) || (a.id !== null && !text(a.id, 64))
    || !(a.rate === undefined || inRange(a.rate, 0.5, 2)) || !unit(a.weight))) return 'facial_animation';
  return m.valid_for_seconds === undefined || inRange(m.valid_for_seconds, 1, 3600) ? null : 'valid_for_seconds';
}

/** A 「桌面表面」 window item; `layering` allows `above` (rule 34). */
function surfaceWindowProblem(w: unknown, layering: boolean): string | null {
  if (!object(w) || !atLeast(w.window_id, 1) || !atLeast(w.generation, 1) || !atLeast(w.display_id, 1)) return 'window';
  if (!rect(w.frame) || !count(w.order)) return 'window';
  const edges = w.edges;
  if (!Array.isArray(edges) || edges.length > 3) return 'edges';
  for (const e of edges) {
    if (!object(e) || !['top', 'left', 'right'].includes(e.side as string)) return 'side';
    const segments = e.segments;
    if (!Array.isArray(segments) || segments.length > 8) return 'segments';
    let end = -Infinity;
    for (const s of segments) {
      if (!Array.isArray(s) || s.length !== 2 || !s.every(coordinate) || s[1] - s[0] < 40 || s[0] < end) return 'segments';
      end = s[1];
    }
  }
  if (w.above === undefined) return null;
  if (!layering) return 'above_capability';
  return Array.isArray(w.above) && w.above.length <= 8 && w.above.every(rect) ? null : 'above';
}

const RENDER_FILTERS = ['none', ...Array.from({ length: 8 }, (_, i) => `filter_${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `sp_filter_${i + 1}`)];

/** Rules 43, 49 (b), (i): a `set_render` against what both sides list. */
function setRenderProblem(m: Fields, both: (c: string) => boolean): string | null {
  const groups = ['camera', 'light', 'outline', 'facing', 'grounding', 'ambient', 'filter', 'dof', 'photo'];
  const present = Object.keys(m).filter((k) => !['v', 'type', 'req'].includes(k));
  if (present.length === 0) return 'empty';
  if (!present.every((k) => groups.includes(k))) return 'group';
  if (m.req !== undefined && !atLeast(m.req, 1)) return 'req';
  const group = (v: unknown, fields: Record<string, (x: unknown) => boolean>) => object(v) && Object.entries(v).every(([k, x]) => fields[k]?.(x) === true);
  const oneOf = (...xs: string[]) => (x: unknown) => xs.includes(x as string);
  const bool = (x: unknown) => typeof x === 'boolean';
  const free = both('camera_free');
  const camera: Record<string, (x: unknown) => boolean> = { mode: oneOf('show', 'overview', 'document'),
    yaw: (x) => inRange(x, free ? -180 : -90, 180), pitch: (x) => inRange(x, -20, 20) };
  if (free) Object.assign(camera, { zoom: (x: unknown) => inRange(x, 1, 4), sway: bool, closeup: bool, live: bool });
  if (both('camera_track')) camera.track = oneOf('off', 'stage');
  if (both('camera_bust')) camera.framing = oneOf('full', 'bust');
  if (m.camera !== undefined && !group(m.camera, camera)) return 'camera';
  if (m.light !== undefined && !group(m.light, { yaw: (x) => inRange(x, -15, 15), pitch: (x) => inRange(x, -10, 10),
    strength: (x) => inRange(x, 0.5, 1.5) })) return 'light';
  if (m.outline !== undefined && !oneOf('original', 'subtle', 'contrast')(m.outline)) return 'outline';
  if (m.facing !== undefined && !oneOf('auto', 'front', 'side', 'back')(m.facing)) return 'facing';
  if (m.grounding !== undefined && !group(m.grounding, { mode: oneOf('off', 'contact') })) return 'grounding';
  if (m.ambient !== undefined && !group(m.ambient, { mode: oneOf('off', 'wallpaper', 'screen'), light_wrap: bool })) return 'ambient';
  if (m.filter !== undefined && (!both('filters') || !RENDER_FILTERS.includes(m.filter as string))) return 'filter';
  if ((m.dof !== undefined || m.photo !== undefined) && !both('photo')) return 'photo_capability';
  if (m.dof !== undefined && !group(m.dof, { mode: oneOf('off', 'closeup') })) return 'dof';
  if (m.photo !== undefined && !group(m.photo, { active: bool, aperture: (x) => inRange(x, 1.4, 32),
    focus: (x) => x === 'auto' || inRange(x, 0.1, 10) })) return 'photo';
  return null;
}

/** Rule 51 (j)'s `set_motion_overrides` tables. */
function motionOverridesProblem(m: Fields): string | null {
  const { chains, pools, blend_in: blend } = m;
  if (!object(chains) || !object(pools) || !object(blend)) return 'missing';
  const chainList = Object.entries(chains), poolList = Object.entries(pools), blendList = Object.entries(blend);
  if (chainList.length > MOTION_OVERRIDES.chains || !chainList.every(([k, v]) => overrideKey(k) && typeof v === 'boolean')) return 'chains';
  if (poolList.length > MOTION_OVERRIDES.pools) return 'pools';
  for (const [k, entries] of poolList) {
    if (!overrideKey(k) || !Array.isArray(entries) || entries.length < 1 || entries.length > MOTION_OVERRIDES.poolEntries) return 'pools';
    if (!entries.every((e) => object(e) && overrideKey(e.clip) && Number.isInteger(e.weight) && inRange(e.weight, 1, MOTION_OVERRIDES.weight))) {
      return 'pools';
    }
    if (new Set(entries.map((e) => (e as Fields).clip)).size !== entries.length) return 'pools';
  }
  if (blendList.length > MOTION_OVERRIDES.blendIn || !blendList.every(([k, v]) => overrideKey(k) && inRange(v, 0, MOTION_OVERRIDES.blendSeconds))) {
    return 'blend_in';
  }
  return null;
}

/** Why an outgoing message breaks CONTRACT's fields for its type, or null; `both` tells a capability both sides list. */
export function outboundProblem(m: C3Message, both: (c: string) => boolean): string | null {
  const side = (x: unknown) => x === 'left' || x === 'right';
  switch (m.type) {
    case 'surfaces': {
      if (!count(m.seq)) return 'seq';
      const windows = m.windows;
      if (!Array.isArray(windows) || windows.length > 32) return 'windows';
      for (const w of windows) {
        const why = surfaceWindowProblem(w, false);
        if (why !== null) return why;
      }
      return new Set(windows.map((w) => (w as Fields).window_id)).size === windows.length ? null : 'repeated_window';
    }
    case 'surface':
      if (!id64(m.track_id)) return 'track_id';
      if (m.state === 'tracking') return only(m, ['v', 'type', 'track_id', 'state', 'window']) ? surfaceWindowProblem(m.window, both('layering')) : 'field';
      if (m.state !== 'gone' || !only(m, ['v', 'type', 'track_id', 'state', 'reason'])) return 'state';
      return ['closed', 'generation', 'not_listed', 'too_many'].includes(m.reason as string) ? null : 'reason';
    case 'covered':
      if (m.window_id === null) return only(m, ['v', 'type', 'window_id']) ? null : 'field';
      return atLeast(m.window_id, 1) && atLeast(m.generation, 1) && rect(m.frame) ? null : 'field';
    case 'pass_through':
      return Array.isArray(m.rects) && m.rects.length <= 8 && m.rects.every(rect) ? null : 'rects';
    case 'attention_side':
      if (m.source !== 'panel' && m.source !== 'focus') return 'source';
      return text(m.kind, 256) && side(m.side) && count(m.generation) ? null : 'field';
    case 'present':
      if (!id64(m.token)) return 'token';
      return side(m.side) && (m.phase === 'open' || m.phase === 'close') ? null : 'field';
    case 'ambient_sample': {
      if (!['screen', 'wallpaper', 'appearance'].includes(m.source as string)) return 'source';
      const c = m.colors;
      return object(c) && Object.keys(c).length === 5 && ['mean', 'top', 'bottom', 'left', 'right'].every((k) => Array.isArray(c[k])
        && (c[k] as unknown[]).length === 3 && (c[k] as unknown[]).every((x) => inRange(x, 0, 1))) ? null : 'colors';
    }
    case 'touch_settings':
      return ['regions', 'pat', 'pinch', 'greet'].every((k) => typeof m[k] === 'boolean') ? null : 'field';
    case 'set_render': return setRenderProblem(m, both);
    case 'set_pose':
      if (!atLeast(m.req, 1)) return 'req';
      return typeof m.character === 'string' && m.character !== '' && (m.id === null || id64(m.id)) && typeof m.lock === 'boolean' ? null : 'field';
    case 'set_motion_overrides':
      if (!atLeast(m.req, 1)) return 'req';
      return typeof m.character === 'string' && m.character !== '' ? motionOverridesProblem(m) : 'character';
    case 'play_chain':
      if (!atLeast(m.req, 1)) return 'req';
      if (!id64(m.play_id) || typeof m.character !== 'string' || m.character === '' || !overrideKey(m.start)) return 'field';
      return m.speed === undefined || [0.5, 1, 2].includes(m.speed as number) ? null : 'speed';
    case 'capture':
      return atLeast(m.req, 1) && m.background === 'transparent' ? null : 'field';
    default: return null;
  }
}
