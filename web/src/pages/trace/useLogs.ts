// The 日志 tab's lines: each source's tail once, then what was written since every POLL_MS while `poll` is on. Each line
// gets a sequence number in arrival order; a paused view shows the lines up to the one it paused at.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '../../bridge';
import type { LogLevel, LogLine, LogSourceId, LogSourceInfo } from '../../bridge/logs';

export const LOG_IDS: LogSourceId[] = ['agentd', 'companion', 'avatar', 'helper', 'services', 'ui', 'motion'];
export const LOG_NAME: Readonly<Record<LogSourceId, string>> = { agentd: '后台服务', companion: '外壳', avatar: '角色', helper: '辅助程序', services: '外部服务', ui: '界面', motion: '动作' };
export const LEVEL_NAME: Readonly<Record<LogLevel, string>> = { err: '错误', warn: '警告', info: '信息', dbg: '调试' };

const POLL_MS = 1500;
/** Lines kept, newest; older ones drop off the front. */
const KEEP = 3000;

export type Seq = LogLine & { seq: number; key: string };

export interface Logs {
  status: 'loading' | 'ok' | 'missing' | 'error';
  error: string | null;
  sources: LogSourceInfo[];
  dirs: { support: string; web: string } | null;
  lines: Seq[];
  /** The last sequence number given out. */
  last: number;
  /** Sources whose tail did not reach back to the file's start. */
  truncated: ReadonlySet<LogSourceId>;
  retry: () => void;
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export function useLogs(enabled: boolean, poll: boolean): Logs {
  const [state, setState] = useState<Omit<Logs, 'retry'>>({ status: 'loading', error: null, sources: [], dirs: null, lines: [], last: 0, truncated: new Set() });
  const cursor = useRef<Partial<Record<LogSourceId, number>> | null>(null);
  const seq = useRef(0);
  const [round, setRound] = useState(0);

  const add = useCallback((got: LogLine[]) => got.map((l): Seq => ({ ...l, seq: (seq.current += 1), key: `${l.source}:${l.off}` })), []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const bridge = getBridge();
    const fail = (e: unknown) => live && setState((s) => ({ ...s, status: codeOf(e) === 'not_implemented' ? 'missing' : 'error', error: e instanceof Error ? e.message : String(e) }));
    void Promise.all([bridge.logs.sources(), ...LOG_IDS.map((id) => bridge.logs.read({ sources: [id] }))])
      .then(([info, ...reads]) => {
        if (!live) return;
        cursor.current = Object.assign({}, ...reads.map((r) => r.cursor));
        const lines = reads.flatMap((r) => r.lines).sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
        const tagged = add(lines).slice(-KEEP);
        setState({ status: 'ok', error: null, sources: info.sources, dirs: info.dirs, lines: tagged, last: seq.current, truncated: new Set(reads.flatMap((r) => r.truncated)) });
      })
      .catch(fail);
    return () => {
      live = false;
    };
  }, [enabled, round, add]);

  useEffect(() => {
    if (!enabled || !poll || state.status !== 'ok') return;
    let live = true;
    const bridge = getBridge();
    const tick = async () => {
      if (!cursor.current) return;
      try {
        const [info, r] = await Promise.all([bridge.logs.sources(), bridge.logs.read({ sources: LOG_IDS, after: cursor.current })]);
        if (!live) return;
        cursor.current = { ...cursor.current, ...r.cursor };
        const fresh = add(r.lines);
        setState((s) => ({ ...s, sources: info.sources, lines: fresh.length ? [...s.lines, ...fresh].slice(-KEEP) : s.lines, last: seq.current }));
      } catch {
        // The next tick asks again; a shell that went away shows in the top bar's lamp.
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled, poll, state.status, add]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }));
    setRound((n) => n + 1);
  }, []);
  return { ...state, retry };
}
