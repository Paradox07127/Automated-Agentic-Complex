// app.runtime / app.onRuntime payload.
import type { ServiceId, ServiceMode } from './services';

export type RuntimeProcessName = 'agentd' | 'avatar';

export type RuntimeChildState =
  | 'stopped' | 'starting' | 'running' | 'backoff' | 'port_in_use' | 'external' | 'failed';

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

/** The process the shell runs for an `ssh` (the tunnel) or `local` service. */
export interface RuntimeServiceState {
  kind: RuntimeChildState;
  /** Only in `backoff`. */
  seconds?: number;
  /** Only in `failed`. */
  reason?: string;
}

export interface RuntimeService {
  mode: ServiceMode;
  /** null under `url` and `off`. */
  state: RuntimeServiceState | null;
  pid: number | null;
  /** The last failure's text. */
  detail: string | null;
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
  };
  services: Record<ServiceId, RuntimeService>;
  /** A `service` entry's `detail` is the service id. */
  degraded: { source: 'agentd' | 'config' | 'service' | 'voice' | 'avatar'; code: string; detail: string | null }[];
}
