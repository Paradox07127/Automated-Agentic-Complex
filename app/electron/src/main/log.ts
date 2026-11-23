// `<support_dir>/logs/`.
import { chmodSync, closeSync, copyFileSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, truncateSync,
  writeSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_LOG, type ErrorInput, ErrorLog } from '../common/error-record.ts';

const prepared = new Set<string>();

/** A log past this moves to `<name>.1`, at shell start and while it runs. */
export const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
/** How often appendLog looks at every log of its support dir, in ms. */
const ROTATE_CHECK_MS = 60_000;
/** When each support dir's logs were last looked at for rotation, in ms. */
const rotationChecked = new Map<string, number>();

/** Copied to `.1` and emptied in place: a child holding it open in append mode writes on at its start. */
function rotate(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size <= LOG_ROTATE_BYTES) return;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
  } catch { /* gone meanwhile, or not ours to rotate */ }
}

/** Each `.log`, error.jsonl and agentd-error.jsonl of `<supportDir>/logs` past LOG_ROTATE_BYTES, including the ones children hold open. */
export function rotateLogs(supportDir: string): void {
  rotationChecked.set(supportDir, Date.now());
  const logs = join(supportDir, 'logs');
  let names: string[] = [];
  try {
    names = readdirSync(logs);
  } catch {
    return;
  }
  for (const name of names) if (name.endsWith('.log') || name.endsWith('error.jsonl')) rotate(join(logs, name));
}

/** Once per support dir: the directories 0700, every log 0600, a `.log` over 20 MiB moved to `.log.1`. */
export function prepareLogs(supportDir: string): void {
  if (prepared.has(supportDir)) return;
  prepared.add(supportDir);
  const logs = join(supportDir, 'logs');
  for (const dir of [supportDir, logs]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch { /* the next write reports nothing either */ }
  }
  let names: string[] = [];
  try {
    names = readdirSync(logs);
  } catch { /* no logs yet */ }
  for (const name of names) {
    const path = join(logs, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      chmodSync(path, 0o600);
      if (name.endsWith('.log') && st.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch { /* gone meanwhile */ }
  }
  rotationChecked.set(supportDir, Date.now());
}

/** `yyyy-MM-ddTHH:mm:ss.SSS±hh:mm` in local time. */
function timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const offset = -d.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** Appends timestamped lines to `<supportDir>/logs/<file>`, which moves to `.1` once past LOG_ROTATE_BYTES; at most once a
 *  minute it looks at the other logs too (rotateLogs). */
export function appendLog(supportDir: string, component: string, line: string, file = 'companion.log'): void {
  prepareLogs(supportDir);
  const prefix = `${timestamp(new Date())} pid=${process.pid} ${component}: `;
  const path = join(supportDir, 'logs', file);
  let fd: number;
  try {
    fd = openSync(path, 'a', 0o600);
  } catch {
    return;
  }
  let size = 0;
  try {
    fchmodSync(fd, 0o600);
    const text = line.split(/\r?\n|\r/).filter((part) => part !== '').map((part) => prefix + part + '\n').join('');
    writeSync(fd, text);
    size = fstatSync(fd).size;
  } catch { /* a log line is not worth failing for */ } finally {
    closeSync(fd);
  }
  if (size > LOG_ROTATE_BYTES) rotate(path);
  if (Date.now() - (rotationChecked.get(supportDir) ?? 0) >= ROTATE_CHECK_MS) rotateLogs(supportDir);
}

const errorLogs = new Map<string, ErrorLog>();

/** Adds a record to `<supportDir>/logs/error.jsonl` (common/error-record.ts ErrorLog); its held counts go out within a minute. */
export function recordError(supportDir: string, input: ErrorInput): void {
  let log = errorLogs.get(supportDir);
  if (!log) {
    prepareLogs(supportDir);
    const path = join(supportDir, 'logs', 'error.jsonl');
    log = new ErrorLog((text) => {
      let fd: number;
      try {
        fd = openSync(path, 'a', 0o600);
      } catch {
        return;
      }
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, text);
      } catch { /* as appendLog */ } finally {
        closeSync(fd);
      }
    });
    errorLogs.set(supportDir, log);
    const flushing = log;
    setInterval(() => flushing.flush(), ERROR_LOG.windowMs).unref();
  }
  log.record(input);
}

/** At quit: every count still held. */
export function flushErrors(): void {
  for (const log of errorLogs.values()) log.flush(true);
}
