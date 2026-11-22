// `logs.sources` and `logs.read`: the 运行记录 page's 日志 tab. Read-only, the fixed files of common/log-line.ts, and the
// lines go to that page only; one read returns at most MAX_LINES lines out of at most MAX_BYTES of the files.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import { webLogsDir } from '../../common/config.ts';
import { isLogSource, LOG_SOURCES, type LogLine, type LogSourceId, parseLog, type RawLine } from '../../common/log-line.ts';
import { DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR } from '../config.ts';
import type { Ops, OpsContext } from './context.ts';

export const MAX_LINES = 1000;
export const MAX_BYTES = 2 * 1024 * 1024;

/** `start`..`end` of the file as lines that end in a line break; `skipFirst` drops the partial line a mid-file start lands in. */
function readLines(path: string, start: number, end: number, skipFirst: boolean): { rows: RawLine[]; next: number } {
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  try {
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  const rows: RawLine[] = [];
  let from = 0;
  if (skipFirst) {
    const nl = buf.indexOf(0x0a);
    from = nl < 0 ? buf.length : nl + 1;
  }
  for (let nl = buf.indexOf(0x0a, from); nl >= 0; nl = buf.indexOf(0x0a, from)) {
    const cut = nl > from && buf[nl - 1] === 0x0d ? nl - 1 : nl;
    rows.push({ off: start + from, text: buf.toString('utf8', from, cut) });
    from = nl + 1;
  }
  // An unfinished last line waits for the next read.
  return { rows, next: start + from };
}

export function logsOps(ctx: OpsContext): Ops {
  const dirs = () => {
    const support = ctx.config.supportDir;
    if (support === null) throw new BridgeFailure('failed', '没有数据目录（配置出错）');
    return { support: join(support, 'logs'), web: webLogsDir(support, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR) };
  };
  return {
    'logs.sources': () => {
      const d = dirs();
      return {
        dirs: d,
        sources: LOG_SOURCES.map((s) => {
          const st = statSync(join(d[s.dir], s.file), { throwIfNoEntry: false });
          const file = st?.isFile() ?? false;
          return { id: s.id, file: s.file, bytes: file ? st!.size : 0, mtime: file ? st!.mtimeMs : null, exists: file };
        }),
      };
    },
    // `after` holds the cursor a source's last read returned: lines written since; without one, the file's last lines.
    'logs.read': ([req]) => {
      const r = (typeof req === 'object' && req !== null ? req : {}) as { sources?: unknown; after?: unknown };
      if (!Array.isArray(r.sources) || r.sources.length === 0 || !r.sources.every(isLogSource)) throw new BridgeFailure('invalid_args', 'sources');
      const after = (typeof r.after === 'object' && r.after !== null ? r.after : {}) as Record<string, unknown>;
      if (Object.entries(after).some(([k, v]) => !isLogSource(k) || !Number.isSafeInteger(v) || (v as number) < 0)) throw new BridgeFailure('invalid_args', 'after');
      const ids = [...new Set(r.sources as LogSourceId[])];
      const d = dirs();
      const budget = Math.floor(MAX_BYTES / ids.length), share = Math.floor(MAX_LINES / ids.length);
      const cursor: Partial<Record<LogSourceId, number>> = {}, truncated: LogSourceId[] = [];
      const lines: LogLine[] = [];
      for (const id of ids) {
        const s = LOG_SOURCES.find((x) => x.id === id)!;
        const path = join(d[s.dir], s.file);
        const st = statSync(path, { throwIfNoEntry: false });
        if (!st?.isFile()) {
          cursor[id] = 0;
          continue;
        }
        const size = st.size;
        const asked = after[id] as number | undefined;
        // A file shorter than the cursor was rotated or emptied: read the new one from its start.
        const from = asked === undefined ? size : asked > size ? 0 : asked;
        const tail = asked === undefined;
        const start = tail ? Math.max(0, size - budget) : Math.max(from, size - budget);
        if (start > 0 && (tail || start > from)) truncated.push(id);
        if (start >= size) {
          cursor[id] = asked === undefined || asked > size ? size : asked;
          continue;
        }
        const read = readLines(path, start, size, tail ? start > 0 : start > from);
        cursor[id] = read.next;
        const parsed = parseLog(id, read.rows, tail ? null : Date.now());
        lines.push(...(tail ? parsed.slice(-share) : parsed));
      }
      lines.sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
      return { lines: lines.slice(-MAX_LINES), cursor, truncated };
    },
  };
}
