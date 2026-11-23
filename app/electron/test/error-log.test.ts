// error.jsonl (src/common/error-record.ts, src/main/log.ts recordError), the per-key line limit, the logs' rotation while
// running, and what 复制诊断信息 adds from avatar.log, ui.log and error.jsonl.
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diagnosticsText, errorRecords, logTail } from '../src/common/diagnostics.ts';
import { ERROR_CODES, ErrorLog, type ErrorRecord, LineLimiter } from '../src/common/error-record.ts';
import { appendLog, flushErrors, LOG_ROTATE_BYTES, prepareLogs, recordError, rotateLogs } from '../src/main/log.ts';

const busy = { component: 'bridge', code: 'op_failed', message: 'avatar.playAction busy', req: 'avatar.playAction' } as const;

test('ErrorLog: the first record at once, the same (component, code, message) within 60 s one count line when its minute is over', () => {
  let t = Date.parse('2026-11-23T10:00:00Z');
  const lines: string[] = [];
  const log = new ErrorLog((l) => lines.push(l), () => t);
  const got = () => lines.map((l) => JSON.parse(l) as ErrorRecord).map((r) => [r.message, r.count]);
  log.record(busy);
  for (let i = 0; i < 5; i++) {
    t += 1000;
    log.record(busy);
  }
  log.record({ ...busy, message: 'avatar.playAction timeout' });
  log.record({ ...busy, code: 'host_exit' });
  assert.deepEqual(got(), [['avatar.playAction busy', 1], ['avatar.playAction timeout', 1], ['avatar.playAction busy', 1]]);
  assert.ok(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
  const first = JSON.parse(lines[0]!) as ErrorRecord;
  assert.deepEqual(first, { t: '2026-11-23T10:00:00.000Z', component: 'bridge', code: 'op_failed', message: 'avatar.playAction busy',
    req: 'avatar.playAction', count: 1 });
  // flush writes nothing while the minute runs; a record of another key after it writes the held count first.
  log.flush();
  assert.equal(lines.length, 3);
  t += 60_000;
  log.record({ ...busy, message: 'avatar.stopAction failed' });
  assert.deepEqual(got().slice(3), [['avatar.playAction busy', 5], ['avatar.stopAction failed', 1]]);
  assert.equal((JSON.parse(lines[3]!) as ErrorRecord).t, '2026-11-23T10:00:05.000Z');
  // Still repeating: one count line a minute; after a quiet minute the next one is written at once again.
  t += 1000;
  log.record(busy);
  log.record(busy);
  t += 60_000;
  log.flush();
  assert.deepEqual(got().slice(5), [['avatar.playAction busy', 2]]);
  t += 61_000;
  log.flush();
  log.record(busy);
  assert.deepEqual(got().slice(6), [['avatar.playAction busy', 1]]);
});

test('ErrorLog: message and detail are cut, absent fields left out; flush(true) writes every held count', () => {
  const lines: string[] = [];
  const log = new ErrorLog((l) => lines.push(l), () => 0);
  log.record({ component: 'page', code: 'page_exception', message: '错'.repeat(400), detail: 'x'.repeat(900) });
  log.record({ component: 'page', code: 'page_exception', message: '错'.repeat(400), detail: 'y' });
  log.flush(true);
  const [a, b] = lines.map((l) => JSON.parse(l) as ErrorRecord);
  assert.equal([...a!.message].length, 300);
  assert.equal(a!.detail!.length, 500);
  assert.deepEqual(Object.keys(a!), ['t', 'component', 'code', 'message', 'detail', 'count']);
  assert.deepEqual([b!.detail, b!.count], ['y', 1]);
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), ['host_exit', 'host_message_rejected', 'op_failed', 'page_exception', 'permission_denied']);
});

test('LineLimiter: the first line of a key at once, the repeats within its minute counted onto the next line that goes out', () => {
  const l = new LineLimiter();
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 0), 'heartbeat stale 300 ms');
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 1000), null);
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 59_000), null);
  assert.equal(l.pass('other', 'rejected type=x why=y', 2000), 'rejected type=x why=y');
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 60_000), 'heartbeat stale 300 ms (+2 more)');
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 61_000), null);
  assert.equal(l.pass('stale', 'heartbeat stale 300 ms', 200_000), 'heartbeat stale 300 ms (+1 more)');
});

test('recordError writes <support>/logs/error.jsonl; flushErrors writes the counts held back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'err-'));
  try {
    const exit = { component: 'host', code: 'host_exit', message: 'status=1', detail: 'error: Unprepared x' } as const;
    recordError(dir, exit);
    recordError(dir, exit);
    const path = join(dir, 'logs', 'error.jsonl');
    const records = () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ErrorRecord);
    assert.deepEqual(records().map((r) => [r.component, r.code, r.message, r.detail, r.count]), [['host', 'host_exit', 'status=1', 'error: Unprepared x', 1]]);
    flushErrors();
    assert.deepEqual(records().map((r) => r.count), [1, 1]);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a log passing 20 MiB while the shell runs moves to .1: companion.log at its next line, a child-held log in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rot-'));
  try {
    prepareLogs(dir);
    const logs = join(dir, 'logs');
    appendLog(dir, 'companion', 'first');
    truncateSync(join(logs, 'companion.log'), LOG_ROTATE_BYTES + 1);
    appendLog(dir, 'companion', 'over the limit');
    assert.ok(statSync(join(logs, 'companion.log.1')).size > LOG_ROTATE_BYTES);
    appendLog(dir, 'companion', 'after');
    assert.match(readFileSync(join(logs, 'companion.log'), 'utf8'), /^\S+ pid=\d+ companion: after\n$/);
    // The renderer holds avatar.log open in append mode: emptied in place, its next write lands at the start.
    const fd = openSync(join(logs, 'avatar.log'), 'a');
    try {
      writeSync(fd, 'old\n');
      truncateSync(join(logs, 'avatar.log'), LOG_ROTATE_BYTES + 1);
      writeFileSync(join(logs, 'helper.log'), 'small\n');
      writeFileSync(join(logs, 'agentd-error.jsonl'), '');
      truncateSync(join(logs, 'agentd-error.jsonl'), LOG_ROTATE_BYTES + 1);
      rotateLogs(dir);
      writeSync(fd, 'new\n');
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(join(logs, 'avatar.log'), 'utf8'), 'new\n');
    assert.ok(readFileSync(join(logs, 'avatar.log.1')).subarray(0, 4).equals(Buffer.from('old\n')));
    assert.equal(readFileSync(join(logs, 'helper.log'), 'utf8'), 'small\n');
    assert.equal(existsSync(join(logs, 'helper.log.1')), false);
    // agentd writes its own agentd-error.jsonl in the same envelope.
    assert.equal(statSync(join(logs, 'agentd-error.jsonl')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('复制诊断信息: avatar.log\'s last lines without its JSON report, ui.log\'s, and the last error records', () => {
  const avatar = ['2026-11-23 05:00:00.000 Host[1:2] AAC_HOSTLINK fps=60', 'error: Unprepared jsspsi/default/A', '{', '  "frames" : 3,',
    '  "clips" : [', '  ]', '}', 'host: bye'].join('\n');
  assert.deepEqual(logTail(avatar, 3), ['2026-11-23 05:00:00.000 Host[1:2] AAC_HOSTLINK fps=60', 'error: Unprepared jsspsi/default/A', 'host: bye']);
  assert.deepEqual(logTail('a\nb\r\nc\n', 2), ['b', 'c']);
  const records = Array.from({ length: 60 }, (_, i) => JSON.stringify({ t: 't', component: 'bridge', code: 'op_failed', message: `op${i} busy`, count: 1 }));
  const got = errorRecords(`${records.join('\n')}\nnot json\n`);
  assert.equal(got.length, 50);
  assert.equal(got[0], 't bridge op_failed op10 busy');
  assert.equal(errorRecords(JSON.stringify({ t: 't', component: 'host', code: 'host_exit', message: 'status=1', detail: 'error: x', count: 3 }))[0],
    't host host_exit status=1 · error: x ×3');
  const text = diagnosticsText('1.0', '7', [['agentd', 'running']], ['e1'], { records: ['r1'], avatar: ['a1'], ui: ['u1'] });
  assert.deepEqual(text.split('\n'), ['Agentic Complex 1.0 (7)', '', '子进程', 'agentd: running', '', '最近 1 行错误（companion.log、agentd.log）', 'e1',
    '', '最近 1 条错误记录（error.jsonl）', 'r1', '', 'avatar.log 最后 1 行', 'a1', '', 'ui.log 最后 1 行', 'u1']);
});
