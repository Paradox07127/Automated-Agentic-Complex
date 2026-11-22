// The 运行记录 page's log reads: each source's line format, and `logs.read` over files in a scratch support dir
// (tails, increments, a rotated file, the caps and the refused requests).
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BridgeFailure } from '../src/common/bridge.ts';
import { type LogLine, parseLog, type RawLine } from '../src/common/log-line.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { logsOps, MAX_LINES } from '../src/main/ops/logs.ts';

const rows = (...lines: string[]): RawLine[] => {
  let off = 0;
  return lines.map((text) => {
    const r = { off, text };
    off += Buffer.byteLength(text) + 1;
    return r;
  });
};
const brief = (l: LogLine[]) => l.map((x) => [x.level, x.text, x.more.length]);

test('agentd lines: ISO and pid stripped, a traceback with its frames and exception is one error line', () => {
  const input = rows(
    '2026-11-22T14:05:00.000+08:00 pid=7 agentd: ritual settle failed: TimeoutError',
    '2026-11-22T14:05:00.001+08:00 pid=7 Traceback (most recent call last):',
    '2026-11-22T14:05:00.001+08:00 pid=7   File "daemon/turns.py", line 671, in _settle_ritual',
    '2026-11-22T14:05:00.001+08:00 pid=7     self.ritual.settle(timeout=5)',
    '2026-11-22T14:05:00.002+08:00 pid=7 TimeoutError',
    'agentd listening on 127.0.0.1:48800',
    '2026-11-22T14:05:01.000+08:00 pid=7 agentd: ritual will retry at 14:10',
    '2026-11-22T14:05:02.000+08:00 pid=7 DEBUG feed seq=4',
  );
  const got = parseLog('agentd', input, null);
  assert.deepEqual(brief(got), [
    ['err', 'agentd: ritual settle failed: TimeoutError', 0],
    ['err', 'Traceback (most recent call last):', 3],
    ['info', 'agentd listening on 127.0.0.1:48800', 0],
    ['warn', 'agentd: ritual will retry at 14:10', 0],
    ['dbg', 'DEBUG feed seq=4', 0],
  ]);
  assert.equal(got[0]!.at, Date.parse('2026-11-22T14:05:00.000+08:00'));
  // A line without its own time carries the one before it.
  assert.equal(got[2]!.at, Date.parse('2026-11-22T14:05:00.002+08:00'));
  assert.equal(got[2]!.off, input[5]!.off);
});

test('companion lines take the diagnostics error words; a retry is a warning', () => {
  const got = parseLog('companion', rows(
    '2026-11-22T13:25:09.302+08:00 pid=3 supervisor: STATUS tunnel=backoff(5)',
    '2026-11-22T14:26:00.000+08:00 pid=3 helper: hello timed out after 5s; retrying',
    '2026-11-22T13:40:12.301+08:00 pid=3 permissions: automation not granted',
    '2026-11-22T13:25:02.410+08:00 pid=3 supervisor: STATUS agentd=running',
  ), null);
  assert.deepEqual(got.map((l) => l.level), ['err', 'warn', 'warn', 'info']);
});

test('avatar NSLog lines: local time, a JSON block folds under its line, frame-rate samples are debug', () => {
  const got = parseLog('avatar', rows(
    '2026-11-21 10:50:20.770 AgenticComplexMetalAvatar[3837:124819335] AAC_HOSTLINK fps=30',
    '2026-11-21 10:50:21.000 AgenticComplexMetalAvatar[3837:124819335] AAC_HOSTLINK frame budget exceeded p95=24.1ms',
    '2026-11-21 10:50:22.000 AgenticComplexMetalAvatar[3837:124819335] AAC_HOSTLINK pipeline',
    '{',
    '  "window_state_mask" : 31',
    '}',
    '2026-11-21 10:50:35.385 AgenticComplexMetalAvatar[3837:124818739] AAC_HOSTLINK load failed reason=missing',
  ), null);
  assert.deepEqual(brief(got), [
    ['dbg', 'AAC_HOSTLINK fps=30', 0],
    ['warn', 'AAC_HOSTLINK frame budget exceeded p95=24.1ms', 0],
    ['info', 'AAC_HOSTLINK pipeline', 3],
    ['err', 'AAC_HOSTLINK load failed reason=missing', 0],
  ]);
  assert.equal(got[0]!.at, new Date(2026, 10, 21, 10, 50, 20, 770).getTime());
});

test('ui.log rows: fragment and message, the stack as continuation lines, info rows as info', () => {
  const got = parseLog('ui', rows(
    '2026-11-22T06:02:31.880Z\tmain\t#/memory\tTypeError: Cannot read properties of undefined\tat FactList (memory/FactList.tsx:58:21)\\nat renderWithHooks',
    '2026-11-20T00:46:17.607Z\tstack\t#/ring\tinfo: mounted ring #/ring\t',
  ), null);
  assert.deepEqual(brief(got), [['err', '#/memory · TypeError: Cannot read properties of undefined', 2], ['info', '#/ring · info: mounted ring #/ring', 0]]);
  assert.equal(got[0]!.at, Date.parse('2026-11-22T06:02:31.880Z'));
});

test('motion.jsonl rows are debug lines at their at_ms; a line naming a turn carries it', () => {
  const got = parseLog('motion', rows('{"activity":"think","at_ms":1795276206919,"duration":0.25,"from":"a","to":"b"}', 'not json'), 5);
  assert.deepEqual(got.map((l) => [l.level, l.text, l.at]), [['dbg', 'think · a → b · 0.25 s', 1795276206919], ['dbg', 'not json', 1795276206919]]);
  assert.equal(parseLog('agentd', rows('2026-11-22T14:05:00.000+08:00 pid=7 turn settled turn_id=t-42 state=completed'), null)[0]!.turn, 't-42');
  assert.equal(parseLog('helper', rows('ready'), 9)[0]!.at, 9, 'a line with no time anywhere takes the fallback');
});

const dir = mkdtempSync(join(tmpdir(), 'logs-ops-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const logs = join(dir, 'logs');
mkdirSync(logs, { recursive: true });
const ctx = { config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null } } as OpsContext;
const ops = logsOps(ctx);
type Read = { lines: LogLine[]; cursor: Record<string, number>; truncated: string[] };
const read = (req: unknown) => ops['logs.read']!([req], null as never) as Read;
const iso = (s: number) => new Date(Date.UTC(2026, 10, 22, 6, 0, s)).toISOString();

test('logs.sources lists the seven fixed files, ui.log in a test support dir’s logs', () => {
  writeFileSync(join(logs, 'agentd.log'), '');
  writeFileSync(join(logs, 'ui.log'), `${iso(0)}\tmain\t#/x\tboom\t\n`);
  const got = ops['logs.sources']!([], null as never) as { dirs: { support: string; web: string }; sources: Array<{ id: string; file: string; bytes: number; exists: boolean }> };
  assert.deepEqual(got.sources.map((s) => s.file), ['agentd.log', 'companion.log', 'avatar.log', 'helper.log', 'tunnel.log', 'ui.log', 'motion.jsonl']);
  assert.equal(got.dirs.web, `${dir}/logs`);
  assert.deepEqual(got.sources.filter((s) => s.exists).map((s) => s.id), ['agentd', 'ui']);
  assert.ok(got.sources.find((s) => s.id === 'ui')!.bytes > 0);
});

test('logs.read: the tail of each source merged by time, then only what was written since; an unfinished line waits', () => {
  writeFileSync(join(logs, 'agentd.log'), `${iso(1)} pid=1 agentd: one\n${iso(3)} pid=1 agentd: three\n${iso(5)} pid=1 agentd: half`);
  writeFileSync(join(logs, 'companion.log'), `${iso(2)} pid=2 supervisor: two\n`);
  const first = read({ sources: ['agentd', 'companion', 'helper'] });
  assert.deepEqual(first.lines.map((l) => l.text), ['agentd: one', 'supervisor: two', 'agentd: three']);
  assert.deepEqual(first.cursor, { agentd: Buffer.byteLength(`${iso(1)} pid=1 agentd: one\n${iso(3)} pid=1 agentd: three\n`), companion: Buffer.byteLength(`${iso(2)} pid=2 supervisor: two\n`), helper: 0 });
  appendFileSync(join(logs, 'agentd.log'), ' done\n');
  appendFileSync(join(logs, 'companion.log'), `${iso(6)} pid=2 supervisor: six\n`);
  const next = read({ sources: ['agentd', 'companion', 'helper'], after: first.cursor });
  assert.deepEqual(next.lines.map((l) => l.text), ['agentd: half done', 'supervisor: six']);
  assert.deepEqual(read({ sources: ['agentd', 'companion'], after: next.cursor }).lines, []);
  // Rotated: the new file is shorter than the cursor, so it is read from its start.
  writeFileSync(join(logs, 'companion.log'), `${iso(7)} pid=2 supervisor: fresh\n`);
  assert.deepEqual(read({ sources: ['companion'], after: next.cursor }).lines.map((l) => l.text), ['supervisor: fresh']);
});

test('logs.read caps a big file: the last 2 MiB, partial first line dropped, at most MAX_LINES lines', () => {
  const line = `${iso(9)} pid=1 agentd: ${'x'.repeat(100)}\n`;
  writeFileSync(join(logs, 'agentd.log'), line.repeat(Math.ceil((3 * 1024 * 1024) / line.length)));
  const got = read({ sources: ['agentd'] });
  assert.equal(got.lines.length, MAX_LINES);
  assert.ok(got.lines.every((l) => l.text === `agentd: ${'x'.repeat(100)}`));
  assert.deepEqual(got.truncated, ['agentd']);
});

test('logs.read takes source ids only: a path, an unknown id or a bad cursor is refused', () => {
  for (const req of [{ sources: ['../config.json'] }, { sources: ['/etc/hosts'] }, { sources: [] }, {}, { sources: ['agentd'], after: { agentd: -1 } },
    { sources: ['agentd'], after: { 'config.json': 0 } }]) {
    assert.throws(() => read(req), (e: unknown) => e instanceof BridgeFailure && e.code === 'invalid_args', JSON.stringify(req));
  }
  const none = logsOps({ config: { path: join(dir, 'config.json'), supportDir: null, devResources: null } } as OpsContext);
  assert.throws(() => none['logs.read']!([{ sources: ['agentd'] }], null as never), (e: unknown) => e instanceof BridgeFailure && e.code === 'failed');
});
