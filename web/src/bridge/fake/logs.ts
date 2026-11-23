// The fake bridge's `logs.*`: the seven sources with demo lines in each format's words, written around the mock turns
// of the last two hours; a new line every 1.1 s unless the page is still. `state=error` answers as an old shell
// (not_implemented), `state=loading` never answers.
import { isoToMs } from '../../domain';
import { TRACE_TURNS } from '../../mock/diag';
import { NOW } from '../../mock/fixtures';
import type { LogLevel, LogLine, LogsOps, LogSourceId, LogSourceInfo } from '../logs';

const SIZES: Record<LogSourceId, [string, number]> = {
  agentd: ['agentd.log', 1_240_000], companion: ['companion.log', 78_300], avatar: ['avatar.log', 529_400], helper: ['helper.log', 0],
  services: ['services.log', 3_100], ui: ['ui.log', 5_000], motion: ['motion.jsonl', 214_400],
};
const ORDER = Object.keys(SIZES) as LogSourceId[];

type Row = Omit<LogLine, 'off' | 'turn'>;
const L = (source: LogSourceId, at: number, level: LogLevel, text: string, more: string[] = []): Row => ({ source, at, level, text, more });
const ago = (s: number) => NOW - s * 1000;

function seed(): Row[] {
  const rows: Row[] = [
    L('companion', ago(4170), 'info', 'supervisor: STATUS agentd=running'),
    L('agentd', ago(4168), 'info', 'agentd: listening on 127.0.0.1:48800'),
    L('avatar', ago(4167), 'info', 'AAC_HOSTLINK connected protocol=3'),
    L('services', ago(4161), 'err', 'tts: ssh: connect to host tts-box port 22: Connection refused'),
    L('companion', ago(4160), 'err', 'supervisor: STATUS tts=backoff(5)'),
    L('services', ago(4155), 'info', 'tts: ssh: tunnel up 127.0.0.1:50021 -> tts-box:50021'),
    L('motion', ago(4090), 'dbg', 'think · relax_loop → idle · 0.72 s'),
    L('avatar', ago(3600), 'dbg', 'AAC_HOSTLINK fps=60 p95=15.6ms gpu=6.1ms'),
    L('companion', ago(3118), 'warn', 'permissions: automation not granted; browser url and terminal jump disabled'),
    L('agentd', ago(1650), 'err', 'agentd: ritual settle failed: TimeoutError'),
    L('agentd', ago(1650), 'err', 'Traceback (most recent call last):', ['  File "daemon/turns.py", line 671, in _settle_ritual', '    self.ritual.settle(timeout=5)',
      '  File "daemon/ritual.py", line 88, in settle', '    raise TimeoutError()', 'TimeoutError']),
    L('agentd', ago(1649), 'info', 'agentd: ritual will retry at 14:10'),
    L('ui', ago(1078), 'err', "#/memory · TypeError: Cannot read properties of undefined (reading 'facts')", ['at FactList (memory/FactList.tsx:58:21)',
      'at renderWithHooks (react-dom.js:15486:18)', 'at mountIndeterminateComponent (react-dom.js:20103:13)', 'at beginWork (react-dom.js:21626:16)']),
    L('motion', ago(1020), 'dbg', 'idle · idle → sit_window_top · 1.10 s'),
    L('companion', ago(370), 'warn', 'helper: hello timed out after 5s; retrying'),
    L('companion', ago(365), 'info', 'helper: ready version=0.9.4'),
    L('avatar', ago(190), 'warn', 'AAC_HOSTLINK frame budget exceeded p95=24.1ms (window resize)'),
    L('avatar', ago(12), 'dbg', 'AAC_HOSTLINK fps=60 p95=15.7ms gpu=6.0ms'),
  ];
  for (const t of TRACE_TURNS) {
    const t0 = isoToMs(t.started_at);
    if (NOW - t0 > 2 * 3600_000) continue;
    const end = t0 + t.duration_ms;
    rows.push(L('agentd', t0 + 12, 'info', `turn ${t.turn_id.slice(0, 4)} input source=${t.source}${t.len != null ? ` len=${t.len}` : ''}`));
    if (t.result === 'failed') {
      rows.push(L('agentd', end - 6, 'err', `model ${t.model ?? 'model'} call failed: ${t.error_code ?? 'error'}`));
      rows.push(L('companion', end + 1550, 'info', 'hostlink: line final lane=side'));
    }
    if (t.result === 'interrupted') {
      rows.push(L('agentd', end - 40, 'info', 'cancel requested by=ptt target=speech'));
      rows.push(L('avatar', end - 30, 'info', 'AAC_HOSTLINK playback interrupted reason=ptt'));
    }
    if (t.result !== 'open') rows.push(L('agentd', end, 'info', `turn ${t.turn_id.slice(0, 4)} settled state=${t.turn_state ?? t.result}`));
    if (t.result === 'ok' && t.producers.includes('avatar')) rows.push(L('motion', end - 300, 'dbg', 'acknowledge · think → relax · 0.68 s'));
  }
  return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

const STREAM: Array<[LogSourceId, LogLevel, string]> = [
  ['avatar', 'dbg', 'AAC_HOSTLINK fps=60 p95=15.7ms gpu=6.0ms'],
  ['companion', 'info', 'hostlink: heartbeat ok rtt=4ms'],
  ['agentd', 'info', 'feed seq=18431 line partial lane=side'],
  ['motion', 'dbg', 'think · think → relax · 0.68 s'],
  ['companion', 'info', 'supervisor: STATUS agentd=running'],
];

const state = () => new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '').get('state');

export function fakeLogs(still: boolean): LogsOps {
  const opened = Date.now();
  const files = new Map<LogSourceId, LogLine[]>(ORDER.map((id) => [id, []]));
  const write = (r: Row) => {
    const list = files.get(r.source)!;
    // Offsets count on from a file this size; a new line takes its text's length.
    const last = list[list.length - 1];
    const off = last ? last.off + last.text.length + 1 : Math.max(0, SIZES[r.source][1] - 64);
    list.push({ ...r, off, turn: null });
  };
  seed().forEach(write);
  let streamed = 0;
  const catchUp = () => {
    if (still) return;
    const due = Math.floor((Date.now() - opened) / 1100);
    for (; streamed < due; streamed += 1) {
      const [source, level, text] = STREAM[streamed % STREAM.length]!;
      write(L(source, NOW + (streamed + 1) * 1100, level, text));
    }
  };
  const end = (id: LogSourceId) => {
    const last = files.get(id)!.at(-1);
    return last ? last.off + last.text.length + 1 : 0;
  };
  const answer = async <T>(value: () => T): Promise<T> => {
    const s = state();
    if (s === 'loading') return new Promise<T>(() => {});
    if (s === 'error') throw Object.assign(new Error('not_implemented: logs.read'), { code: 'not_implemented', detail: 'logs.read' });
    return value();
  };
  return {
    sources: () => answer(() => {
      catchUp();
      const sources: LogSourceInfo[] = ORDER.map((id) => {
        const size = SIZES[id][1] === 0 ? 0 : Math.max(SIZES[id][1], end(id));
        return { id, file: SIZES[id][0], bytes: size, mtime: size ? (files.get(id)!.at(-1)?.at ?? NOW) : null, exists: true };
      });
      return { dirs: { support: '~/Library/Application Support/local.agenticcomplex.companion/logs', web: '~/Library/Logs/AgenticComplex' }, sources };
    }),
    read: (req) => answer(() => {
      catchUp();
      const lines: LogLine[] = [];
      const cursor: Partial<Record<LogSourceId, number>> = {};
      for (const id of req.sources) {
        const after = req.after?.[id];
        const all = files.get(id) ?? [];
        lines.push(...(after == null ? all.slice(-Math.floor(1000 / req.sources.length)) : all.filter((l) => l.off >= after)));
        cursor[id] = end(id);
      }
      lines.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      return { lines: lines.map((l) => ({ ...l, more: [...l.more] })), cursor, truncated: [] };
    }),
  };
}
