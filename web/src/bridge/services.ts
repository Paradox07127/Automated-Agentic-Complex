// `services.*` types: the external services config.json's `services` connects (app/electron/src/common/config.ts
// `ServiceRecord`), re-exported by protocol.ts.

export type ServiceId = 'tts' | 'motion' | 'llm';
/** `off` not used; `url` connected as it is; `ssh` through a tunnel to `ssh_host`; `local` a command the shell runs here. */
export type ServiceMode = 'off' | 'url' | 'ssh' | 'local';

export interface ServiceRecord {
  mode: ServiceMode;
  /** Under `ssh` and `local` a loopback address with a port. */
  url: string;
  ssh_host: string;
  /** Run over ssh on `ssh_host` with `ensure`, `stop` or `status`; only under `ssh`. */
  start_script: string;
  /** argv run under `local`. */
  command: string[];
  /** `command`'s working directory; empty leaves it unset. */
  cwd: string;
}

export type ServicesSaveResult =
  | { ok: true; /** The TTS address moved to another scheme, host or port, or off: the old service's token is gone. */ ttsTokenCleared?: true }
  | { ok: false; error: 'unknown_service' | 'config_unreadable' | 'declined' }
  | { ok: false; error: 'invalid_record'; field: string; message: string }
  | { ok: false; error: 'token_not_cleared' | 'write_failed'; message: string };

/** `line`: the remote start script's first line, null without one. */
export type ServiceActionResult =
  | { ok: true; line: string | null }
  | { ok: false; error: 'not_supervised' | 'unknown_service' | 'ensure_failed' | 'stop_failed'; line: string | null };

/** Main surface only. */
export interface ServicesOps {
  read(): Promise<Record<ServiceId, ServiceRecord>>;
  /** Writes the record whole and restarts the service and the backend. */
  save(id: ServiceId, record: ServiceRecord): Promise<ServicesSaveResult>;
  start(id: ServiceId): Promise<ServiceActionResult>;
  stop(id: ServiceId): Promise<ServiceActionResult>;
  restart(id: ServiceId): Promise<ServiceActionResult>;
}
