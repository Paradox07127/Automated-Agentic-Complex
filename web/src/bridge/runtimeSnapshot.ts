// app.runtime / app.onRuntime payload.

export type RuntimeProcessName = 'agentd' | 'avatar' | 'tunnel';

export type RuntimeChildState =
  | 'stopped' | 'starting' | 'running' | 'backoff' | 'port_in_use' | 'gpu_hold' | 'external' | 'failed';

export interface RuntimeProcess {
  state: RuntimeChildState;
  pid: number | null;
  /** Seconds until the next start; only in `backoff`. */
  backoff: number | null;
  /** Only in `failed`. */
  reason: string | null;
  /** agentd's /health stage or the avatar's loading stage. */
  stage: string | null;
}

/** Ids only; names come from `character.list`. */
export interface RuntimeSnapshot {
  /** +1 on every change. */
  revision: number;
  phase: 'config_failed' | 'starting' | 'avatar_only' | 'agentd_only' | 'interactive' | 'degraded';
  config_error: string | null;
  processes: Record<RuntimeProcessName, RuntimeProcess>;
  character: {
    current: string | null;
    shown: string | null;
    agentd: string | null;
    pending: string | null;
    switching: boolean;
    failure: { target: string; stage: 'prepare' | 'avatar' | 'commit'; reason: string } | null;
  };
  visibility: { hidden: boolean; reason: string | null; fullscreen_hidden: boolean; click_through_all: boolean };
  tts: {
    provider: 'remote-ws' | 'none';
    state: 'unknown' | 'probing' | 'ready' | 'cold' | 'unreachable' | 'off';
    reason: string | null;
    retry_after_s: number | null;
    muted: boolean;
    /** null when no tunnel host is configured. */
    tunnel: RuntimeChildState | null;
  };
  voice_input: 'on' | 'off' | 'denied';
  degraded: { source: 'agentd' | 'config' | 'tunnel' | 'voice' | 'avatar'; code: string; detail: string | null }[];
}
