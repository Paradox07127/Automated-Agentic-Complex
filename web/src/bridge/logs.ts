// `logs.*` types: the shell's log files, read for the 运行记录 page's 日志 tab (app/electron/src/common/log-line.ts), re-exported by protocol.ts.

export type LogSourceId = 'agentd' | 'companion' | 'avatar' | 'helper' | 'tunnel' | 'ui' | 'motion';
export type LogLevel = 'err' | 'warn' | 'info' | 'dbg';

export interface LogSourceInfo {
  id: LogSourceId;
  file: string;
  bytes: number;
  /** Epoch ms; null when the file is not there. */
  mtime: number | null;
  exists: boolean;
}

export interface LogLine {
  source: LogSourceId;
  /** Byte offset in its file; with `source`, the line's identity. */
  off: number;
  /** Epoch ms; a line without its own time carries the one before it, null when none came before. */
  at: number | null;
  level: LogLevel;
  text: string;
  /** Continuation lines: a traceback, a JSON block, a stack. */
  more: string[];
  /** The `turn_id=` or `trace_id=` the line names. */
  turn: string | null;
}

export interface LogRead {
  /** Oldest first. */
  lines: LogLine[];
  /** Pass back as `after` to read only what was written since. */
  cursor: Partial<Record<LogSourceId, number>>;
  /** Sources whose read began past where it was asked to (a big tail or a big jump): older lines were left out. */
  truncated: LogSourceId[];
}

/** Read-only; the page names sources by id, never by path. Main surface only. */
export interface LogsOps {
  sources(): Promise<{ dirs: { support: string; web: string }; sources: LogSourceInfo[] }>;
  /** Without `after` for a source: its last lines. At most 1000 lines a call. */
  read(req: { sources: LogSourceId[]; after?: Partial<Record<LogSourceId, number>> }): Promise<LogRead>;
}
