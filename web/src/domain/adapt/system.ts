// agentd character, runtime, trace and diagnostics rows → domain objects.
// Pure functions: anything clock-dependent takes the clock as an argument.
import type { AgentdConnection, ProcessState, SupervisorTarget } from '../../bridge/protocol';
import type { Turn } from '../context';
import type { TurnResult } from '../states';
import type { Budget, CharacterState, Cooldown, Health, ModelCall, RuntimeInfo, StatePoint, TurnNow } from '../system';
import { isoToMs, secToMs } from '../units';
import { voiceState } from '../voiceState';
import type {
  WireCharacterState,
  WireDiagBudget,
  WireDiagConnections,
  WireDiagGate,
  WireDiagTurn,
  WireRuntimePublic,
  WireStatePoint,
  WireTraceTurn,
  WireUsage,
} from '../wire';

// ---- character, diagnostics, kernel ----

export function fromCharacterState(w: WireCharacterState): CharacterState {
  return {
    character_id: w.character_id,
    affects_behavior: w.affects_behavior,
    energy: w.energy,
    valence: w.valence,
    engagement: w.engagement,
    labels: w.labels ?? { energy: '', mood: '', engagement: '' },
    activity: w.activity,
    causes: w.causes.map((c) => ({
      attr: c.attr,
      cause: c.cause,
      delta: c.delta,
      at: isoToMs(c.at),
    })),
  };
}

export function fromStatePoint(w: WireStatePoint): StatePoint {
  return {
    at: secToMs(w.at),
    energy: w.energy,
    valence: w.valence,
    cause: w.cause,
  };
}

/** Backends that run an installed CLI with its own login; Pi has neither. */
const CLI_BACKENDS: ReadonlySet<RuntimeInfo['id']> = new Set(['codex', 'claude']);

/** `/character/runtime` → one row per backend, plus the saved choice. */
export function fromRuntimePublic(w: WireRuntimePublic): {
  runtimes: RuntimeInfo[];
  selected: RuntimeInfo['id'];
  ready: boolean;
  error: string | null;
  busy: boolean;
} {
  const runtimes = w.available_backends.map((b): RuntimeInfo => {
    const cli = CLI_BACKENDS.has(b.id);
    const found =
      (w.selected_runtime && w.selected_runtime.backend === b.id ? w.selected_runtime : null) ??
      w.installed_runtimes.find((r) => r.backend === b.id && r.runtime_source !== 'bundled') ??
      w.installed_runtimes.find((r) => r.backend === b.id) ??
      null;
    return {
      id: b.id,
      name: b.title,
      path: found?.path ?? null,
      // Pi is no discovered CLI: its version is the SDK its last session ran.
      version: b.id === 'pi' ? (w.pi_session?.sdk_version ?? null) : (found?.version ?? null),
      entry_supported: cli ? (found?.entry_supported ?? false) : b.available,
      boundary_verified: found?.boundary_verified ?? null,
      // product_login runs the kernel in agentd's own profile; an account not probed yet is absent and not signed in.
      authenticated: !cli || (w.backend === b.id && w.auth_source === 'api_key') ? null
        : w.backend === b.id && w.auth_source === 'product_login' ? (w.product_login.accounts[b.id]?.signed_in ?? false)
        : (found?.authenticated ?? false),
      ...(found ? { runtime_source: found.runtime_source === 'bundled' ? 'bundled' : 'local' } : {}),
      ...(found && found.auth_method !== undefined ? { auth_method: found.auth_method } : {}),
      login_command: typeof found?.login_command === 'string' ? found.login_command : null,
      available: b.available,
      reason: b.reason,
    };
  });
  return {
    runtimes,
    selected: w.backend,
    ready: w.ready,
    error: w.error,
    busy: w.busy,
  };
}

const TURN_RESULT: Readonly<Record<string, TurnResult>> = {
  completed: 'ok',
  text_generated: 'ok',
  open: 'running',
  blocked: 'skipped',
  unknown: 'unknown',
  failed: 'failed',
  interrupted: 'interrupted',
};

/** `/trace/turns` row; the list has no stages or marks. */
export function fromTraceTurn(w: WireTraceTurn): Turn {
  return {
    id: w.trace_id,
    turn_id: w.turn_id,
    head: w.head,
    len: w.len,
    producers: w.producers,
    started_at: isoToMs(w.started_at),
    source: w.source,
    result: TURN_RESULT[w.result] ?? 'unknown',
    trace_result: w.result,
    ...(w.turn_state ? { turn_state: w.turn_state } : {}),
    duration_ms: w.duration_ms,
    stages: [],
    marks: [],
  };
}

const CALL_LABEL: Readonly<Record<string, string>> = {
  mouth: '对话回复',
  character_agent: '角色运行',
  observe_summary: '观察摘要',
  decision: '动作决策',
  judge: '主动判断',
};

const modelCall = (key: string, u: WireUsage): ModelCall => ({
  label: CALL_LABEL[key] ?? key,
  calls: u.calls,
  input_tokens: u.input_tokens,
  cache_tokens: u.cache_creation_input_tokens + u.cache_read_input_tokens,
  output_tokens: u.output_tokens,
  cost_usd: u.cost_usd,
  unpriced: u.unpriced,
});

/** `/diag/state` budget block plus the gate counters. */
export function fromDiagBudget(budget: WireDiagBudget, gate: WireDiagGate): Budget {
  const m = budget.model;
  return {
    screenshots: budget.screenshots,
    gate: {
      today: gate.today,
      daily_limit: gate.daily_limit,
      blocked_today: gate.blocked_today,
    },
    model: m
      ? {
          by_call: Object.fromEntries(Object.entries(m.by_call).map(([k, u]) => [k, modelCall(k, u)])),
          cost_usd: m.cost_usd,
          unpriced: m.unpriced,
        }
      : null,
  };
}

const COOLDOWN_LABEL: Readonly<Record<string, string>> = {
  comment: '评论',
  proactive: '主动发言',
  rest: '休息提醒',
  observe: '观察摘要',
};

/** gate.cooldown_s {kind: seconds left} → rows; agentd has no total. */
export function fromCooldowns(gate: WireDiagGate): Cooldown[] {
  return Object.entries(gate.cooldown_s).map(([key, left]) => ({
    key,
    label: COOLDOWN_LABEL[key] ?? key,
    left_s: left,
    total_s: null,
  }));
}

/** server.py PHASES order with their display labels. */
const PHASE_LABEL: ReadonlyArray<[string, string]> = [
  ['received', '收到输入'],
  ['waiting_observation', '等观察'],
  ['assembling', '组装上下文'],
  ['calling_model', '调模型'],
  ['streaming', '出字'],
  ['synthesizing', '合成'],
  ['playing', '播放'],
  ['ended', '结束'],
];

/** `/diag/state` turn block; null before the first turn. */
export function fromTurnNow(w: WireDiagTurn): TurnNow | null {
  if (w.trace_id == null || w.turn_id == null) return null;
  const known = PHASE_LABEL.filter(([k]) => k in w.phases_ms).map(([key, label]) => ({ key, label, ms: w.phases_ms[key] ?? 0 }));
  const other = Object.keys(w.phases_ms)
    .filter((k) => !PHASE_LABEL.some(([p]) => p === k))
    .map((key) => ({ key, label: key, ms: w.phases_ms[key] ?? 0 }));
  return {
    id: w.trace_id,
    turn_id: w.turn_id,
    phase: w.phase,
    phases_ms: [...known, ...other],
  };
}

/** Link health from the bridge connection, `/character/runtime`, supervisor state and `/diag/state` connections. */
export function composeHealth(
  connection: AgentdConnection,
  runtime: WireRuntimePublic | null,
  supervisor: Partial<Record<SupervisorTarget, ProcessState>> | null,
  diag: { connections: WireDiagConnections } | null,
  fps: number | null = null,
): Health {
  const tts = diag?.connections.tts;
  const voice = tts ? voiceState(tts) : { state: 'off' as const, retryAfterS: null };
  return {
    agentd: {
      up: connection === 'connected',
      started_at: diag ? isoToMs(diag.connections.agentd.started_at) : 0,
    },
    runtime: {
      ready: runtime?.ready ?? false,
      name: runtime ? (runtime.available_backends.find((b) => b.id === runtime.backend)?.title ?? runtime.backend) : '',
      error: runtime?.error ?? null,
    },
    avatar: {
      child: supervisor?.avatar?.state === 'running' ? 'running' : 'stopped',
      fps,
    },
    voice,
  };
}
