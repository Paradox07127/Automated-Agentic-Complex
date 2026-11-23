// `<support_dir>/logs/`.
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const prepared = new Set<string>();

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
      if (name.endsWith('.log') && st.size > 20 * 1024 * 1024) renameSync(path, `${path}.1`);
    } catch { /* gone meanwhile */ }
  }
}

/** `yyyy-MM-ddTHH:mm:ss.SSS±hh:mm` in local time. */
function timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const offset = -d.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** Appends timestamped lines to `<supportDir>/logs/<file>`. */
export function appendLog(supportDir: string, component: string, line: string, file = 'companion.log'): void {
  prepareLogs(supportDir);
  const prefix = `${timestamp(new Date())} pid=${process.pid} ${component}: `;
  let fd: number;
  try {
    fd = openSync(join(supportDir, 'logs', file), 'a', 0o600);
  } catch {
    return;
  }
  try {
    fchmodSync(fd, 0o600);
    const text = line.split(/\r?\n|\r/).filter((part) => part !== '').map((part) => prefix + part + '\n').join('');
    writeSync(fd, text);
  } catch { /* a log line is not worth failing for */ } finally {
    closeSync(fd);
  }
}
