// The companion's runtime state in one value: the shell's
// parts send events, each effective change bumps `revision` and goes to the observers; `runtimeJson` is the `app.runtime`
// wire (web/src/bridge/runtimeSnapshot.ts).
import type { ChildState } from './agentd.ts';
import { SERVICE_IDS, type ServiceId, type ServiceMode } from './config.ts';
import type { Cancel } from './page.ts';
import type { SwitchFailure } from './switch.ts';

export type RuntimeChild = 'agentd' | 'avatar';

/** A slot's state: a child's, or `external`, which only an ssh service reaches (its port already had this
 *  user's ssh listener). */
export type SlotState = ChildState | { kind: 'external' };

/** One process slot as the runtime spine sees it. */
export interface ProcessStage {
  state: SlotState;
  pid: number | null;
  /** agentd's /health stage; null when not reported for this run, and always for the avatar. */
  stage: string | null;
  /** When `state` last changed, in ms. */
  since: number;
}

export interface CharacterView {
  current: string | null;
  shown: string | null;
  agentd: string | null;
  pending: string | null;
  switching: boolean;
  failure: SwitchFailure | null;
}

export interface VisibilityView { hidden: boolean; reason: string | null; fullscreenHidden: boolean; clickThroughAll: boolean }

export type TtsPhase = 'unknown' | 'probing' | 'ready' | 'cold' | 'unreachable' | 'off';
const TTS_PHASES: readonly string[] = ['unknown', 'probing', 'ready', 'cold', 'unreachable', 'off'];

export interface TtsView {
  /** "remote-ws" or "none". */
  provider: string;
  phase: TtsPhase;
  reason: string | null;
  retryAfterS: number | null;
}

/** Until agentd's current run reports its voice. */
const NO_TTS: TtsView = { provider: 'none', phase: 'unknown', reason: null, retryAfterS: null };

/** One of `services` as the shell runs it. */
export interface ServiceView {
  mode: ServiceMode;
  /** The tunnel's or the local process's; null under `url` and `off`. */
  state: SlotState | null;
  pid: number | null;
  /** The last failure's text. */
  detail: string | null;
}

export interface DegradedReason {
  /** agentd, config, service, voice or avatar; a service's `detail` is its id. */
  source: string;
  code: string;
  detail: string | null;
}

export interface Runtime {
  /** +1 on every effective change. */
  revision: number;
  configError: string | null;
  processes: Record<RuntimeChild, ProcessStage>;
  character: CharacterView;
  visibility: VisibilityView;
  tts: TtsView;
  services: Record<ServiceId, ServiceView>;
  degraded: DegradedReason[];
  /** The ready plan finished for the current agentd run. */
  agentdReady: boolean;
}

export type RuntimeEvent =
  | { kind: 'child'; name: RuntimeChild; state: SlotState; pid: number | null }
  | { kind: 'agentdHealth'; stage: string | null; degraded: string[] }
  | { kind: 'agentdReady' }
  | { kind: 'character'; view: CharacterView }
  | { kind: 'visibility'; view: VisibilityView }
  | { kind: 'tts'; view: TtsView }
  | { kind: 'service'; id: ServiceId; view: ServiceView }
  | { kind: 'configError'; error: string | null };

export type RuntimePhase = 'config_failed' | 'starting' | 'avatar_only' | 'agentd_only' | 'interactive' | 'degraded';

export function initialRuntime(since: number): Runtime {
  const stopped = (): ProcessStage => ({ state: { kind: 'stopped' }, pid: null, stage: null, since });
  return {
    revision: 0, configError: null, processes: { agentd: stopped(), avatar: stopped() },
    character: { current: null, shown: null, agentd: null, pending: null, switching: false, failure: null },
    visibility: { hidden: false, reason: null, fullscreenHidden: false, clickThroughAll: false },
    tts: NO_TTS,
    services: Object.fromEntries(SERVICE_IDS.map((id) => [id, { mode: 'off', state: null, pid: null, detail: null }])) as Record<ServiceId, ServiceView>,
    degraded: [], agentdReady: false,
  };
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k)
    && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `s` after `e`; `s` itself when `e` changes nothing. */
export function reduced(s: Runtime, e: RuntimeEvent, now: number): Runtime {
  const next: Runtime = { ...s, processes: { ...s.processes } };
  const withoutAgentd = () => s.degraded.filter((d) => d.source !== 'agentd');
  switch (e.kind) {
    case 'child': {
      const old = s.processes[e.name];
      if (equal(old.state, e.state)) {
        next.processes[e.name] = { ...old, pid: e.pid };
      } else {
        next.processes[e.name] = { state: e.state, pid: e.pid, stage: null, since: now };
        if (e.name === 'agentd') {
          next.agentdReady = false;
          next.degraded = withoutAgentd();
          next.tts = NO_TTS;
        }
      }
      break;
    }
    case 'agentdHealth':
      next.processes.agentd = { ...s.processes.agentd, stage: e.stage };
      next.degraded = [...withoutAgentd(), ...e.degraded.map((code) => ({ source: 'agentd', code, detail: null }))];
      break;
    case 'agentdReady':
      next.agentdReady = true;
      break;
    case 'character':
      next.character = e.view;
      break;
    case 'visibility':
      next.visibility = e.view;
      break;
    case 'tts':
      next.tts = e.view;
      break;
    case 'service': {
      next.services = { ...s.services, [e.id]: e.view };
      const failed = SERVICE_IDS.filter((id) => next.services[id].state?.kind === 'failed');
      next.degraded = [...s.degraded.filter((d) => d.source !== 'service'),
        ...failed.map((id) => ({ source: 'service', code: 'service_failed', detail: id }))];
      break;
    }
    case 'configError':
      next.configError = e.error;
      break;
  }
  if (equal(next, s)) return s;
  next.revision = s.revision + 1;
  return next;
}

export function runtimePhase(s: Runtime): RuntimePhase {
  if (s.configError !== null) return 'config_failed';
  const agentd = s.processes.agentd.state.kind === 'running' && s.agentdReady;
  const avatar = s.processes.avatar.state.kind === 'running';
  if (!agentd) return avatar ? 'avatar_only' : 'starting';
  if (!avatar) return 'agentd_only';
  if (s.character.shown === null) return 'starting';
  if (s.degraded.length > 0) return 'degraded';
  return 'interactive';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** agentd's voice state wire (`provider`, `state`, `reason`, `retry_after_s`); null when `v` is not one. An unknown `state`
 *  reads `unknown`. */
function ttsView(v: unknown): TtsView | null {
  if (!isObject(v)) return null;
  if (typeof v.provider !== 'string' || typeof v.state !== 'string') return null;
  if (v.reason != null && typeof v.reason !== 'string') return null;
  if (v.retry_after_s != null && typeof v.retry_after_s !== 'number') return null;
  return { provider: v.provider, phase: TTS_PHASES.includes(v.state) ? v.state as TtsPhase : 'unknown',
    reason: (v.reason as string | undefined) ?? null, retryAfterS: (v.retry_after_s as number | undefined) ?? null };
}

/** agentd's `voice_state` event; null when `data` is not a voice state agentd reports. */
export function agentdTts(data: string): TtsView | null {
  try {
    return ttsView(JSON.parse(data));
  } catch {
    return null;
  }
}

/** The voice in a `GET /diag/state` body (`connections.tts`): agentd sends `voice_state` only on a change, so a run's
 *  first state is read there. */
export function diagTts(body: unknown): TtsView | null {
  return isObject(body) && isObject(body.connections) ? ttsView(body.connections.tts) : null;
}

const WIRE_STATE: Record<SlotState['kind'], string> = {
  stopped: 'stopped', starting: 'starting', running: 'running', backoff: 'backoff', portInUse: 'port_in_use', failed: 'failed',
  external: 'external',
};

/** A slot's state on the wire: `kind` snake_case, with `seconds` in backoff and `reason` when failed. */
export function wireState(state: SlotState): { kind: string; seconds?: number; reason?: string } {
  return { kind: WIRE_STATE[state.kind], ...(state.kind === 'backoff' && { seconds: state.seconds }),
    ...(state.kind === 'failed' && { reason: state.reason }) };
}

/** The `app.runtime` wire: snake_case keys, every optional present as null so the web sees a fixed shape. */
export function runtimeJson(s: Runtime) {
  const process = (p: ProcessStage) => ({
    state: WIRE_STATE[p.state.kind], pid: p.pid, backoff: p.state.kind === 'backoff' ? p.state.seconds : null,
    reason: p.state.kind === 'failed' ? p.state.reason : null, stage: p.stage,
  });
  const c = s.character, v = s.visibility, t = s.tts;
  return {
    revision: s.revision,
    phase: runtimePhase(s),
    config_error: s.configError,
    processes: { agentd: process(s.processes.agentd), avatar: process(s.processes.avatar) },
    character: { current: c.current, shown: c.shown, agentd: c.agentd, pending: c.pending, switching: c.switching,
      failure: c.failure && { target: c.failure.target, stage: c.failure.stage, reason: c.failure.reason } },
    visibility: { hidden: v.hidden, reason: v.reason, fullscreen_hidden: v.fullscreenHidden, click_through_all: v.clickThroughAll },
    tts: { provider: t.provider, state: t.phase, reason: t.reason, retry_after_s: t.retryAfterS },
    services: Object.fromEntries(SERVICE_IDS.map((id) => {
      const v = s.services[id];
      return [id, { mode: v.mode, state: v.state && wireState(v.state), pid: v.pid, detail: v.detail }];
    })) as Record<ServiceId, { mode: ServiceMode; state: ReturnType<typeof wireState> | null; pid: number | null; detail: string | null }>,
    degraded: s.degraded.map((d) => ({ source: d.source, code: d.code, detail: d.detail })),
  };
}

/** Owns the one `Runtime`; producers `send`, everything else observes. */
export class RuntimeCoordinator {
  private current: Runtime;
  private readonly now: () => number;
  private observers: { id: number; f: (s: Runtime) => void }[] = [];
  private lastId = 0;
  private queue: RuntimeEvent[] = [];
  private delivering = false;

  constructor(now: () => number) {
    this.now = now;
    this.current = initialRuntime(now());
  }

  get snapshot(): Runtime { return this.current; }

  /** A send from inside an observer is queued and reduced after every observer has seen the current change. */
  send(e: RuntimeEvent): void {
    this.queue.push(e);
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.queue.length > 0) {
        const next = reduced(this.current, this.queue.shift()!, this.now());
        if (next.revision === this.current.revision) continue;
        this.current = next;
        for (const o of [...this.observers]) o.f(next);
      }
    } finally {
      this.delivering = false;
    }
  }

  /** Calls `f` with the current snapshot now and after every change, until cancelled. */
  observe(f: (s: Runtime) => void): Cancel {
    const id = ++this.lastId;
    this.observers.push({ id, f });
    f(this.current);
    return () => { this.observers = this.observers.filter((o) => o.id !== id); };
  }
}
