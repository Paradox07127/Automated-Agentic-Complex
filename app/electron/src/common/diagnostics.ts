// 复制诊断信息: version, child process states, the last error lines of the logs, the last error records and the last lines
// of avatar.log and ui.log; no chat content. Reading the logs is the caller's.

export const MAX_ERROR_LINES = 50;
export const MAX_LINE_LENGTH = 240;
/** Lines of avatar.log and of ui.log. */
export const MAX_TAIL_LINES = 40;

/** companion.log has no level field: an error line says so in words (`=failed(`, `… failed:`, `KILL`), or carries a
 *  non-2xx `status=`. */
export function isCompanionError(line: string): boolean {
  if (line.includes('closed(quit) child=')) return false;
  const exit = /exit child=\w+ status=(\d+)/.exec(line);
  if (exit) return exit[1] !== '0';
  if (/exit child=\w+ signal=\d+/.test(line)) return true;
  const lower = line.toLowerCase();
  if (['fail', 'error', 'unreadable', 'timed out', 'refused', 'rejected', 'denied', 'bad_', 'kill', '=backoff('].some((w) => lower.includes(w))) {
    return true;
  }
  const status = /status=(\d+)/.exec(line);
  if (!status) return false;
  const n = Number(status[1]);
  return n < 200 || n >= 300;
}

/** agentd.log is agentd's stdout and stderr: Python tracebacks and their exception lines, each perhaps prefixed with
 *  `<ISO time> pid=<n> `. */
export function isAgentdError(line: string): boolean {
  const bare = line.replace(/^\S+ pid=\d+ /, '');
  return bare.startsWith('Traceback') || /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(bare);
}

const lines = (text: string) => text.split(/\r\n|\r|\n/).filter((l) => l !== '');
const clip = (l: string) => [...l].slice(0, MAX_LINE_LENGTH).join('');

/** The last `limit` lines, each cut to MAX_LINE_LENGTH, leaving out the lines of a pretty-printed JSON block (the renderer's
 *  run report at its exit). */
export function logTail(text: string, limit = MAX_TAIL_LINES): string[] {
  const kept = lines(text).filter((l) => !/^[\s{}[\]]/.test(l));
  return kept.slice(Math.max(0, kept.length - limit)).map(clip);
}

/** The last `limit` records of error.jsonl as `t component code message[ · detail][ ×count]`; a line that is not one is skipped. */
export function errorRecords(text: string, limit = MAX_ERROR_LINES): string[] {
  const out = lines(text).flatMap((l) => {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(l) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof r !== 'object' || r === null || typeof r.code !== 'string' || typeof r.message !== 'string') return [];
    const detail = typeof r.detail === 'string' && r.detail !== '' ? ` · ${r.detail}` : '';
    const count = typeof r.count === 'number' && r.count > 1 ? ` ×${r.count}` : '';
    return [`${String(r.t)} ${String(r.component)} ${r.code} ${r.message}${detail}${count}`];
  });
  return out.slice(Math.max(0, out.length - limit)).map(clip);
}

/** companion.log's error lines, then agentd.log's, each cut to `MAX_LINE_LENGTH`; the last `limit` of them. */
export function errorLines(companionLog: string, agentdLog: string, limit = MAX_ERROR_LINES): string[] {
  const all = [...lines(companionLog).filter(isCompanionError), ...lines(agentdLog).filter(isAgentdError)];
  return all.slice(Math.max(0, all.length - limit)).map(clip);
}

/** `children` are (name, state) in the order shown; `more` the error records (errorRecords) and the tails (logTail). */
export function diagnosticsText(version: string, build: string, children: [string, string][], errors: string[],
  more?: { records: string[]; avatar: string[]; ui: string[] }): string {
  return [`Agentic Complex ${version} (${build})`, '', '子进程', ...children.map(([n, s]) => `${n}: ${s}`), '',
    `最近 ${errors.length} 行错误（companion.log、agentd.log）`, ...errors,
    ...(more ? ['', `最近 ${more.records.length} 条错误记录（error.jsonl）`, ...more.records, '', `avatar.log 最后 ${more.avatar.length} 行`,
      ...more.avatar, '', `ui.log 最后 ${more.ui.length} 行`, ...more.ui] : [])].join('\n');
}
