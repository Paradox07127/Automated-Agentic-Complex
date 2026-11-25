// The shared MMD library's bake into the current character: the state machine over fake ports, and the shell's runner
// over a fake motion_tool.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MotionFailureError } from '../src/common/character.ts';
import type { ImportProgress } from '../src/common/import-state.ts';
import { MMD_SYNC_IDLE, MmdSync, type MmdSyncResult, mmdSyncResult, type MmdSyncState } from '../src/common/mmd-sync.ts';
import { shellMmdSync } from '../src/main/ops/character.ts';
import { runAgentdTool } from '../src/main/ops/tools.ts';

const RESULT: MmdSyncResult = { character: 'si', version: '1.2.4', baked: ['mmd_a'], renamed: [], music: [], removed: [], failed: [] };

interface Run { character: string; progress: (p: ImportProgress) => void; signal: AbortSignal; end(r: MmdSyncResult | null | Error): void }

function fixture() {
  const runs: Run[] = [], states: MmdSyncState[] = [], logs: string[] = [];
  let current: string | null = 'si', reloads = 0;
  const sync = new MmdSync({
    run: (character, progress, signal) => new Promise((resolve, reject) => {
      runs.push({ character, progress, signal, end: (r) => (r instanceof Error ? reject(r) : resolve(r)) });
    }),
    reload: async () => { reloads += 1; },
    current: () => current,
    send: (s) => states.push(s),
    log: (line) => logs.push(line),
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { sync, runs, states, logs, tick, reloads: () => reloads, setCurrent: (c: string | null) => { current = c; } };
}

test('a new current character runs mmd-sync once, shows its progress and reloads the renderer after a bake', async () => {
  const f = fixture();
  assert.deepEqual(f.sync.state, MMD_SYNC_IDLE);
  assert.deepEqual(MMD_SYNC_IDLE, { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 });
  f.sync.follow(null);
  const done = f.sync.follow('si');
  f.sync.follow('si');
  await f.tick();
  assert.equal(f.runs.length, 1, 'the same character twice syncs once');
  assert.deepEqual(f.states, [{ running: true, character: 'si', total: 0, done: 0, failed: 0, stage: null, fraction: 0 }]);
  const run = f.runs[0]!;
  run.progress({ stage: 'read', fraction: 0.1, total: 3, done: 0 });
  run.progress({ stage: 'read', fraction: 0.105 });
  run.progress({ stage: 'read', fraction: 0.105, total: 4 });
  run.progress({ stage: 'write', fraction: 0.5, done: 2 });
  assert.deepEqual(f.states.slice(1), [
    { running: true, character: 'si', total: 3, done: 0, failed: 0, stage: 'read', fraction: 0.1 },
    { running: true, character: 'si', total: 4, done: 0, failed: 0, stage: 'read', fraction: 0.105 },
    { running: true, character: 'si', total: 4, done: 2, failed: 0, stage: 'write', fraction: 0.5 },
  ], 'a line within 0.01 of the bar moves it only with a new total');
  assert.throws(() => f.sync.checkIdle(), (e: unknown) => e instanceof MotionFailureError
    && e.failure.reason === 'busy' && e.failure.detail === '正在给角色烘共享库里的 MMD 动作');
  run.end({ ...RESULT, failed: [{ id: 'mmd_b', reason: 'missing_bones', detail: 'x' }] });
  await done;
  assert.equal(f.reloads(), 1);
  assert.deepEqual(f.sync.state, { running: false, character: null, total: 4, done: 2, failed: 1, stage: null, fraction: 0.5 },
    'idle keeps the last counts and fraction');
  f.sync.checkIdle();
});

test('no reload when nothing changed or she is no longer current; a failure is logged and ends idle', async () => {
  const f = fixture();
  let done = f.sync.follow('si');
  await f.tick();
  f.runs[0]!.end({ ...RESULT, baked: [] });
  await done;
  assert.equal(f.reloads(), 0, 'nothing baked, renamed, given music or removed');
  f.setCurrent('cedar');
  done = f.sync.follow('cedar');
  await f.tick();
  f.setCurrent('si');
  f.runs[1]!.end({ ...RESULT, character: 'cedar', removed: ['mmd_c'] });
  await done;
  assert.equal(f.reloads(), 0, 'the renderer shows another character by now');
  done = f.sync.follow('voice_a');
  await f.tick();
  f.runs[2]!.end(new MotionFailureError({ reason: 'internal', detail: 'boom' }));
  await done;
  assert.deepEqual(f.logs, ['mmd-sync voice_a failed: boom']);
  assert.equal(f.sync.state.running, false);
  assert.equal(f.sync.state.failed, 0);
});

test('a sync that only gave a dance other music reloads the renderer', async () => {
  const f = fixture();
  const done = f.sync.follow('si');
  await f.tick();
  f.runs[0]!.end({ ...RESULT, baked: [], music: ['mmd_a'] });
  await done;
  assert.equal(f.reloads(), 1);
});

test('a switch cancels the running sync and starts the next once it has exited; the cancelled one sends nothing more', async () => {
  const f = fixture();
  f.sync.follow('si');
  await f.tick();
  const first = f.runs[0]!;
  const next = f.sync.follow('cedar');
  assert.equal(first.signal.aborted, true);
  await f.tick();
  assert.equal(f.runs.length, 1, 'the library lock is the old tool\'s until it exits');
  const sent = f.states.length;
  first.progress({ stage: 'write', fraction: 0.9 });
  first.end(null);
  await f.tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[1]!.character, 'cedar');
  assert.deepEqual(f.states.slice(sent), [{ running: true, character: 'cedar', total: 0, done: 0, failed: 0, stage: null, fraction: 0 }]);
  f.runs[1]!.end({ ...RESULT, character: 'cedar', baked: [] });
  await next;
  assert.equal(f.states.at(-1)!.running, false);
});

test('mmd-sync\'s result line is checked as MmdSyncResult decodes it', () => {
  assert.deepEqual(mmdSyncResult(JSON.stringify({ ...RESULT, failed: [{ id: 'a', reason: 'r', detail: 'd' }] })),
    { ...RESULT, failed: [{ id: 'a', reason: 'r', detail: 'd' }] });
  assert.deepEqual(mmdSyncResult(JSON.stringify({ ...RESULT, baked: [], music: ['mmd_a'] })).music, ['mmd_a']);
  for (const line of ['', '{}', JSON.stringify({ ...RESULT, baked: [1] }), JSON.stringify({ ...RESULT, failed: [{ id: 'a' }] }),
    JSON.stringify({ ...RESULT, music: undefined }), JSON.stringify({ ...RESULT, music: [1] })]) {
    assert.throws(() => mmdSyncResult(line), (e: unknown) => e instanceof MotionFailureError
      && e.failure.reason === 'internal' && e.failure.detail === `motion_tool printed no result: ${line}`);
  }
});

test('the shell runs motion_tool mmd-sync on the library with its progress and pushes each state as `sync`', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmd-'));
  try {
    // A fake motion_tool.py that Node runs: two progress lines, then the result line.
    writeFileSync(join(dir, 'motion_tool.py'), `
      const args = process.argv.slice(2);
      console.log(JSON.stringify({ event: 'progress', stage: 'read', total: 2, done: 0, fraction: 0 }));
      console.log(JSON.stringify({ event: 'progress', stage: 'write', total: 2, done: 2, fraction: 1 }));
      console.log(JSON.stringify({ character: args[args.indexOf('--character') + 1], version: '1.0.0', baked: ['mmd_a'], renamed: [],
        music: [], removed: [], failed: [], args }));
    `);
    const logs: string[] = [], pushed: unknown[] = [];
    let reloads = 0;
    const shell = shellMmdSync({
      catalog: join(dir, 'library', 'current.json'),
      runTool: (script, args, progress) => runAgentdTool(process.execPath, [], dir, script, args, progress),
      validationHost: () => '/host', reload: async () => { reloads += 1; }, current: () => 'si', log: (line) => logs.push(line),
    });
    shell.events.subscribe(null, (e) => pushed.push([e.event, JSON.parse(e.data)]));
    await shell.sync.follow('si');
    assert.equal(logs.length, 0);
    assert.equal(reloads, 1);
    assert.deepEqual(pushed.map((p) => (p as [string, MmdSyncState])[0]), ['sync', 'sync', 'sync', 'sync']);
    assert.deepEqual(pushed.at(-1), ['sync', { running: false, character: null, total: 2, done: 2, failed: 0, stage: null, fraction: 1 }]);

    writeFileSync(join(dir, 'motion_tool.py'), `
      console.error(JSON.stringify({ reason: 'busy', detail: 'library locked' }));
      process.exit(1);
    `);
    await shell.sync.follow('cedar');
    assert.deepEqual(logs, ['mmd-sync cedar failed: library locked']);
    const failing = shellMmdSync({ catalog: join(dir, 'current.json'), runTool: async () => { throw new Error('unused'); },
      validationHost: () => { throw new Error('未配置 Metal 宿主可执行文件'); }, reload: async () => {}, current: () => 'si',
      log: (line) => logs.push(line) });
    await failing.sync.follow('si');
    assert.equal(logs.at(-1), 'mmd-sync si failed: 未配置 Metal 宿主可执行文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell passes mmd-sync its arguments and the cancel signal; a cancelled tool that exits non-zero is no failure', async () => {
  const calls: { args: string[]; signal: AbortSignal }[] = [];
  const logs: string[] = [];
  let finish: (r: { last: string; status: number; stderr: string }) => void = () => {};
  const shell = shellMmdSync({
    catalog: '/lib/current.json',
    runTool: (script, args, _progress, signal) => {
      calls.push({ args: [script, ...args], signal });
      return new Promise((r) => { finish = r; });
    },
    validationHost: () => '/host', reload: async () => {}, current: () => 'cedar', log: (line) => logs.push(line),
  });
  shell.sync.follow('si');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[0]!.args, ['motion_tool.py', 'mmd-sync', '--library', '/lib', '--character', 'si', '--validate-with', '/host']);
  const next = shell.sync.follow('cedar');
  assert.equal(calls[0]!.signal.aborted, true);
  finish({ last: '', status: -1, stderr: 'Terminated' });
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 0);
  finish({ last: JSON.stringify({ ...RESULT, character: 'cedar', baked: [] }), status: 0, stderr: '' });
  await next;
  assert.equal(calls.length, 2);
  assert.equal(shell.sync.state.running, false);
});
