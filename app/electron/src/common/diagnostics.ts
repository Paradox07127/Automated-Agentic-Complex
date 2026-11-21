// 复制诊断信息: version, child process states and the last error lines of the logs; no
// chat content. Reading the logs is the caller's.

export const MAX_ERROR_LINES = 50;
export const MAX_LINE_LENGTH = 240;

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

/** companion.log's error lines, then agentd.log's, each cut to `MAX_LINE_LENGTH`; the last `limit` of them. */
export function errorLines(companionLog: string, agentdLog: string, limit = MAX_ERROR_LINES): string[] {
  const all = [...lines(companionLog).filter(isCompanionError), ...lines(agentdLog).filter(isAgentdError)];
  return all.slice(Math.max(0, all.length - limit)).map((l) => [...l].slice(0, MAX_LINE_LENGTH).join(''));
}

/** `children` are (name, state) in the order shown. */
export function diagnosticsText(version: string, build: string, children: [string, string][], errors: string[]): string {
  return [`Agentic Complex ${version} (${build})`, '', '子进程', ...children.map(([n, s]) => `${n}: ${s}`), '',
    `最近 ${errors.length} 行错误（companion.log、agentd.log）`, ...errors].join('\n');
}
