// The imports' progress: the tools' progress lines, the state `character.importState` answers, and the
// tool runner that reads the lines as they come (ImportTool.run).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IMPORT_IDLE, type ImportProgress, type ImportState, ImportTracker, moves, parseProgress } from '../src/common/import-state.ts';
import { runAgentdTool } from '../src/main/ops/tools.ts';

const line = (o: Record<string, unknown>) => JSON.stringify(o);

test('parseProgress: a progress line\'s stage and fraction; an unknown stage is null and the fraction is clamped to 0–1', () => {
  assert.deepEqual(parseProgress(line({ event: 'progress', stage: 'retarget', fraction: 0.25 })), { stage: 'retarget', fraction: 0.25 });
  for (const stage of ['read', 'sample', 'retarget', 'compose', 'write', 'validate', 'publish']) {
    assert.equal(parseProgress(line({ event: 'progress', stage, fraction: 0 }))?.stage, stage);
  }
  assert.deepEqual(parseProgress(line({ event: 'progress', stage: 'reload', fraction: 1.5 })), { stage: null, fraction: 1 });
  assert.deepEqual(parseProgress(line({ event: 'progress', fraction: -0.5 })), { stage: null, fraction: 0 });
});

test('parseProgress: without a fraction it is done/total (0 for no total); with neither, or another line, it is null', () => {
  assert.deepEqual(parseProgress(line({ event: 'progress', total: 4, done: 1 })), { stage: null, fraction: 0.25, total: 4, done: 1 });
  assert.deepEqual(parseProgress(line({ event: 'progress', total: 0, done: 0 })), { stage: null, fraction: 0, total: 0, done: 0 });
  assert.deepEqual(parseProgress(line({ event: 'progress', stage: 'write', fraction: 0.5, total: 2, done: 1 })),
    { stage: 'write', fraction: 0.5, total: 2, done: 1 });
  for (const other of [line({ event: 'progress', stage: 'read' }), line({ event: 'progress', total: 2 }), line({ event: 'done', fraction: 1 }),
    line({ ok: true, action: {} }), line({ event: 'progress', stage: 3, fraction: 0 }), line({ event: 'progress', fraction: '0.5' }),
    line({ event: 'progress', total: 2.5, done: 1 }), '[1]', 'Traceback', '']) {
    assert.equal(parseProgress(other), null, other);
  }
});

test('moves: a new stage, or a fraction 0.01 or more away', () => {
  const p = (stage: string | null, fraction: number): ImportProgress => ({ stage, fraction });
  assert.equal(moves(p('read', 0), null, 0), true);
  assert.equal(moves(p('read', 0.005), 'read', 0), false);
  assert.equal(moves(p('read', 0.25), 'read', 0.24), true);
  assert.equal(moves(p('read', 0.2), 'read', 0.25), true);
  assert.equal(moves(p('write', 0.5), 'read', 0.5), true);
});

function tracked(): { tracker: ImportTracker; sent: ImportState[] } {
  const sent: ImportState[] = [];
  return { tracker: new ImportTracker((s) => sent.push(s)), sent };
}

const running = (stage: string | null, fraction: number): ImportState => ({ running: true, kind: 'motion', title: 'dance', stage, fraction });

test('ImportTracker.run: running with no stage, each progress line that moves the bar, reload at 1, then idle', async () => {
  const { tracker, sent } = tracked();
  assert.deepEqual(tracker.state, IMPORT_IDLE);
  const seen: ImportState[] = [];
  const value = await tracker.run('motion', 'dance', async (progress) => {
    seen.push(tracker.state);
    progress({ stage: 'read', fraction: 0 });
    progress({ stage: 'read', fraction: 0.004 });
    progress({ stage: 'retarget', fraction: 0.1 });
    progress({ stage: 'retarget', fraction: 0.105 });
    progress({ stage: 'retarget', fraction: 0.3 });
    return 7;
  }, async () => { seen.push(tracker.state); });
  assert.equal(value, 7);
  assert.deepEqual(seen, [running(null, 0), running('reload', 1)]);
  assert.deepEqual(sent, [running(null, 0), running('read', 0), running('retarget', 0.1), running('retarget', 0.3), running('reload', 1),
    IMPORT_IDLE]);
  assert.deepEqual(tracker.state, IMPORT_IDLE);
});

test('ImportTracker.run: a failed tool goes idle without reloading and passes the failure on', async () => {
  const { tracker, sent } = tracked();
  let reloaded = false;
  await assert.rejects(tracker.run('outfit', 'Red Coat', async (progress) => {
    progress({ stage: 'read', fraction: 0 });
    throw new Error('bad mod');
  }, async () => { reloaded = true; }), /bad mod/);
  assert.equal(reloaded, false);
  assert.deepEqual(sent, [{ running: true, kind: 'outfit', title: 'Red Coat', stage: null, fraction: 0 },
    { running: true, kind: 'outfit', title: 'Red Coat', stage: 'read', fraction: 0 }, IMPORT_IDLE]);
});

test('ImportTracker.run: a progress line after the run ended changes nothing', async () => {
  const { tracker, sent } = tracked();
  let late: ((p: ImportProgress) => void) | undefined;
  await tracker.run('mmd', 'dance', async (progress) => { late = progress; }, async () => {});
  const count = sent.length;
  late!({ stage: 'write', fraction: 0.5 });
  assert.equal(sent.length, count);
  assert.deepEqual(tracker.state, IMPORT_IDLE);
});

test('runAgentdTool hands each progress line on as it comes and keeps the last other line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-'));
  try {
    // Halves of one line in two writes, a CRLF line, and a line after the result that is progress again.
    writeFileSync(join(dir, 'tool.mjs'), [
      'const out = (s) => new Promise((r) => process.stdout.write(s, r));',
      `await out(${JSON.stringify(line({ event: 'progress', stage: 'read', fraction: 0 }) + '\n')});`,
      `await out(${JSON.stringify(line({ event: 'progress', stage: 'write' }).slice(0, -1))});`,
      `await out(${JSON.stringify(', "fraction": 0.5}\r\nlog line\n')});`,
      "await out(JSON.stringify({ ok: true, args: process.argv.slice(2) }) + '\\n');",
      `await out(${JSON.stringify(line({ event: 'progress', stage: 'publish', fraction: 1 }))});`,
    ].join('\n'));
    const seen: ImportProgress[] = [];
    const result = await runAgentdTool(process.execPath, [], dir, 'tool.mjs', ['import', '--x'], (p) => seen.push(p));
    assert.deepEqual(seen, [{ stage: 'read', fraction: 0 }, { stage: 'write', fraction: 0.5 }, { stage: 'publish', fraction: 1 }]);
    assert.deepEqual(result, { last: line({ ok: true, args: ['import', '--x'] }), status: 0, stderr: '' });
    assert.deepEqual(await runAgentdTool(process.execPath, [], dir, 'tool.mjs', []),
      { last: line({ ok: true, args: [] }), status: 0, stderr: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgentdTool puts the Python flags before the script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-'));
  try {
    writeFileSync(join(dir, 'flags.mjs'), 'process.stdout.write(JSON.stringify([process.execArgv, process.argv.slice(2)]));');
    assert.deepEqual(await runAgentdTool(process.execPath, ['--no-warnings'], dir, 'flags.mjs', ['x']),
      { last: JSON.stringify([['--no-warnings'], ['x']]), status: 0, stderr: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgentdTool stops the tool when its signal aborts and settles once it has exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-'));
  try {
    writeFileSync(join(dir, 'bake.mjs'), [
      `process.stdout.write(${JSON.stringify(line({ event: 'progress', stage: 'write', fraction: 0.1 }) + '\n')});`,
      'setTimeout(() => {}, 20_000);',
    ].join('\n'));
    const abort = new AbortController();
    let started!: () => void;
    const progressed = new Promise<void>((r) => { started = r; });
    const run = runAgentdTool(process.execPath, [], dir, 'bake.mjs', ['mmd-sync'], () => started(), abort.signal);
    await progressed;
    abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([run, new Promise<string>((r) => { timer = setTimeout(() => r('still running 5 s after the abort'), 5000); })]);
    clearTimeout(timer);
    assert.notEqual(result, 'still running 5 s after the abort');
    assert.notEqual((result as { status: number }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
