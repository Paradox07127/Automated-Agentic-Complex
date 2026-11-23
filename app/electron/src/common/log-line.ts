// The shell's log files 诊断's 日志 tab reads (`logs.*`): each source's fixed file name, and its lines read as time,
// level, text and continuation lines. The page names a source by id, never by path.
import { isAgentdError, isCompanionError } from './diagnostics.ts';

export type LogSourceId = 'agentd' | 'companion' | 'avatar' | 'helper' | 'services' | 'ui' | 'motion';
export type LogLevel = 'err' | 'warn' | 'info' | 'dbg';

/** `dir`: `support` is `<support dir>/logs`, `web` the pages' logs dir (config.ts `webLogsDir`). */
export const LOG_SOURCES: ReadonlyArray<{ id: LogSourceId; file: string; dir: 'support' | 'web' }> = [
  { id: 'agentd', file: 'agentd.log', dir: 'support' },
  { id: 'companion', file: 'companion.log', dir: 'support' },
  { id: 'avatar', file: 'avatar.log', dir: 'support' },
  { id: 'helper', file: 'helper.log', dir: 'support' },
  { id: 'services', file: 'services.log', dir: 'support' },
  { id: 'ui', file: 'ui.log', dir: 'web' },
  { id: 'motion', file: 'motion.jsonl', dir: 'support' },
];

export const isLogSource = (v: unknown): v is LogSourceId => LOG_SOURCES.some((s) => s.id === v);

/** A traceback, JSON block or stack keeps at most this many continuation lines. */
export const MAX_MORE = 200;

export interface LogLine {
  source: LogSourceId;
  /** Byte offset of the line in its file; with `source`, the line's identity. */
  off: number;
  /** Epoch ms; a line without its own time carries the one before it, else the read's `fallback`. */
  at: number | null;
  level: LogLevel;
  text: string;
  more: string[];
  /** The `turn_id=` or `trace_id=` the line names. */
  turn: string | null;
}

/** One line of a file and its byte offset, without the line break. */
export interface RawLine { off: number; text: string }

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (?:pid=\d+ )?(.*)$/;
// NSLog: local time, then `Process[pid:tid] `.
const NSLOG = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \S+\[\d+:[0-9a-fx]+\] (.*)$/;
const EXCEPTION = /^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b/;
const TURN = /\b(?:turn_id|trace_id)=([\w-]+)/;

function childLevel(text: string): LogLevel {
  if (/^DEBUG\b/.test(text)) return 'dbg';
  if (isAgentdError(text) || /\b(failed|error)\b/i.test(text)) return 'err';
  if (/\bwarn(ing)?\b|\bretry|timed out|backoff/i.test(text)) return 'warn';
  return 'info';
}

function companionLevel(text: string): LogLevel {
  if (/\bretry/i.test(text)) return 'warn';
  if (isCompanionError(text)) return 'err';
  if (/\bwarn(ing)?\b|not granted/i.test(text)) return 'warn';
  return 'info';
}

function avatarLevel(text: string): LogLevel {
  if (/\berror\b|\bfailed\b/i.test(text)) return 'err';
  if (/exceeded|dropped|\bwarn/i.test(text)) return 'warn';
  // The renderer's frame-rate samples come every few seconds.
  if (/\bfps(_caps)?\b|\bp95=/.test(text)) return 'dbg';
  return 'info';
}

function motionText(raw: string): { at: number | null; text: string } {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { at: null, text: raw };
  }
  if (typeof o !== 'object' || o === null) return { at: null, text: raw };
  const r = o as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const parts = [s('activity'), s('from') && s('to') ? `${s('from')} → ${s('to')}` : null,
    typeof r.duration === 'number' ? `${r.duration.toFixed(2)} s` : null].filter((p): p is string => p !== null);
  return { at: typeof r.at_ms === 'number' ? r.at_ms : null, text: parts.length > 0 ? parts.join(' · ') : raw };
}

/** `rows` of one source in file order; `fallback` is the time of a leading line that has none. */
export function parseLog(source: LogSourceId, rows: readonly RawLine[], fallback: number | null): LogLine[] {
  const out: LogLine[] = [];
  let at = fallback;
  let traceback = false;
  const push = (off: number, own: number | null, level: LogLevel, text: string, more: string[] = []) => {
    if (own !== null) at = own;
    out.push({ source, off, at, level, text, more, turn: TURN.exec(text)?.[1] ?? null });
  };
  // A continuation line that opens a read starts an entry of its own.
  const attach = (off: number, text: string) => {
    const last = out[out.length - 1];
    if (!last) push(off, null, 'info', text);
    else if (last.more.length < MAX_MORE) last.more.push(text);
  };
  for (const { off, text: line } of rows) {
    if (line.trim() === '') continue;
    if (source === 'motion') {
      const m = motionText(line);
      push(off, m.at, 'dbg', m.text);
      continue;
    }
    if (source === 'ui') {
      const f = line.split('\t');
      const t = Date.parse(f[0] ?? '');
      if (f.length < 4 || Number.isNaN(t)) {
        attach(off, line);
        continue;
      }
      const message = f[3] ?? '';
      const info = message.startsWith('info: ');
      push(off, t, info ? 'info' : 'err', `${f[2] ?? ''} · ${message}`, (f[4] ?? '').split('\\n').filter((x) => x !== '').slice(0, MAX_MORE));
      continue;
    }
    if (source === 'avatar') {
      const m = NSLOG.exec(line);
      if (!m) {
        attach(off, line);
        continue;
      }
      const [, y, mo, d, h, mi, s, ms, text = ''] = m;
      push(off, new Date(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms!).getTime(), avatarLevel(text), text);
      continue;
    }
    const m = ISO.exec(line);
    const own = m ? Date.parse(m[1]!) : null;
    const bare = m ? (m[2] ?? '') : line;
    const last = out[out.length - 1];
    if (last && (/^\s/.test(bare) || (traceback && EXCEPTION.test(bare)))) {
      if (own !== null) at = own;
      attach(off, bare);
      if (!/^\s/.test(bare)) traceback = false;
      continue;
    }
    traceback = bare.startsWith('Traceback');
    push(off, own, source === 'companion' ? companionLevel(bare) : childLevel(bare), bare);
  }
  return out;
}
