// The C12 platform helper's supervision (src/main/helper/) over a fake helper in Node, and one handshake with the real
// macOS ac-helper when app/helpers/mac has been built.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ChildState, stateText } from '../src/common/agentd.ts';
import { HelperSupervisor } from '../src/main/helper/supervisor.ts';
import { processState } from '../src/main/ops/supervisor.ts';
import { helperExecutable } from '../src/main/platform/index.ts';

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.02);
  }
  return ok();
}

/**
 * A helper that speaks C12 enough for the supervisor: screens.list answers, windows.list never does, apps.installed
 * exits 1, cancel and shutdown as the contract says. FAKE_MODE: mismatch (exit 3 on hello), garbage (a non-JSON line
 * after hello), stubborn (ignores shutdown and SIGTERM).
 */
const FAKE = String.raw`
const fs = require('node:fs');
const [launches, received, mode] = process.argv.slice(2);
fs.appendFileSync(launches, process.pid + '\n');
if (mode === 'stubborn') process.on('SIGTERM', () => {});
const send = (m) => process.stdout.write(JSON.stringify({ v: 1, ...m }) + '\n');
const running = new Set();
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let n = buffer.indexOf('\n'); n !== -1; n = buffer.indexOf('\n')) {
    const line = buffer.slice(0, n);
    buffer = buffer.slice(n + 1);
    fs.appendFileSync(received, line + '\n');
    const { id, op, params } = JSON.parse(line);
    if (op === 'hello') {
      if (mode === 'mismatch') { send({ id, ok: false, error: { code: 'protocol_mismatch', message: 'no' } }); process.exit(3); }
      send({ id, ok: true, result: { protocol: 1, platform: 'macos', helper_version: 'fake', os_version: 'x', arch: 'arm64',
        pid: process.pid, ops: ['hello', 'cancel', 'shutdown', 'screens.list', 'windows.list', 'workspace.watch', 'presence.watch', 'ax.watch',
        'ptt.register'], events: [] } });
      if (mode === 'garbage') process.stdout.write('not json\n');
    } else if (op === 'screens.list') send({ id, ok: true, result: { screens: [] } });
    else if (op === 'windows.list') running.add(id);
    else if (op === 'apps.installed') process.exit(1);
    else if (op === 'ax.watch' && params.pid === 999) send({ id, ok: false, error: { code: 'process_gone', message: 'gone' } });
    else if (op === 'ax.focused' || op === 'capture.window') send({ id, ok: false, error: { code: 'permission_denied', message: 'no grant' } });
    else if (op.endsWith('.watch') || op === 'ptt.register') send({ id, ok: true, result: {} });
    else if (op === 'cancel') {
      const was = running.delete(params.target);
      if (was) send({ id: params.target, ok: false, error: { code: 'cancelled', message: 'cancelled' } });
      send({ id, ok: true, result: { cancelled: was } });
    } else if (op === 'shutdown' && mode !== 'stubborn') {
      for (const target of running) send({ id: target, ok: false, error: { code: 'cancelled', message: 'shutting down' } });
      send({ id, ok: true, result: {} });
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => { if (mode !== 'stubborn') process.exit(0); });
`;

function setup(mode = '', timeScale = 0.1) {
  const dir = mkdtempSync(join(tmpdir(), 'h-')), support = join(dir, 's');
  const script = join(dir, 'fake.cjs'), launches = join(dir, 'launches'), received = join(dir, 'received');
  writeFileSync(script, FAKE);
  const states: string[] = [];
  // The helper is this Node running the script, on every platform.
  const helper = new HelperSupervisor({ executable: process.execPath, prefix: [script, launches, received, mode], supportDir: support,
    clientVersion: 'test', timeScale, onStatus: (s: ChildState) => states.push(stateText(s)) });
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
  return {
    dir, support, helper, states, launches: () => lines(launches).length,
    received: () => lines(received).map((l) => JSON.parse(l) as { id: number; op: string; params: Record<string, unknown> }),
    log: () => lines(join(support, 'logs', 'companion.log')),
    done: async () => {
      await helper.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the helper is found where its build puts it: .build/release on macOS, .local/build on Windows', () => {
  assert.equal(helperExecutable('/r/app', 'darwin'), '/r/app/helpers/mac/.build/release/ac-helper');
  assert.equal(helperExecutable('C:\\r\\app', 'win32'), 'C:\\r\\.local\\build\\helper-windows\\ac-helper.exe');
});

test('desktop.onState\'s helper pip is worded like the agentd and renderer states', () => {
  assert.deepEqual([{ kind: 'stopped' }, { kind: 'running' }, { kind: 'backoff', seconds: 4 }, { kind: 'failed', reason: '找不到程序 /x' }]
    .map((s) => processState(s as ChildState, undefined).state), ['stopped', 'running', 'backoff(4)', 'failed(找不到程序 /x)']);
});

test('hello first, then requests; stop sends shutdown and the helper exits 0', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'), s.states.join(' '));
    assert.equal(s.helper.hello?.helper_version, 'fake');
    assert.deepEqual(await s.helper.request('screens.list'), { ok: true, result: { screens: [] } });
    await s.helper.stop();
    assert.deepEqual(s.received().map((r) => r.op), ['hello', 'screens.list', 'shutdown']);
    assert.deepEqual(s.received()[0]!.params, { protocol: 1, client: 'electron', client_version: 'test' });
    assert.deepEqual(s.received().map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(s.states, ['starting', 'running', 'stopped']);
    assert.ok(s.log().some((l) => l.includes('exit child=helper status=0')), s.log().join('\n'));
    assert.deepEqual(await s.helper.request('screens.list'), { ok: false, error: { code: 'helper_exited', message: 'the helper is not running' } });
  } finally {
    await s.done();
  }
});

test('a permission_denied answer is recorded in error.jsonl with the grant it lacks and the op', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'), s.states.join(' '));
    assert.equal((await s.helper.request('ax.focused', {})).ok, false);
    assert.equal((await s.helper.request('capture.window', { window_id: 4 })).ok, false);
    assert.equal((await s.helper.request('screens.list')).ok, true);
    const records = readFileSync(join(s.support, 'logs', 'error.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(records.map((r) => [r.component, r.code, r.message, r.req]),
      [['helper', 'permission_denied', 'accessibility ax.focused', 'ax.focused'], ['helper', 'permission_denied', 'screenRecording capture.window', 'capture.window']]);
  } finally {
    await s.done();
  }
});

test('a request without an answer in time is helper_timeout and cancelled; three in a row end the helper as stuck', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    for (let n = 0; n < 2; n++) {
      const reply = await s.helper.request('windows.list');
      assert.equal(reply.ok ? '' : reply.error.code, 'helper_timeout');
    }
    assert.ok(await until(5, () => s.received().filter((r) => r.op === 'cancel').length === 2));
    assert.deepEqual(s.received().filter((r) => r.op === 'cancel').map((r) => r.params.target), [2, 4]);
    assert.equal(s.helper.state.kind, 'running');
    await s.helper.request('windows.list');
    assert.ok(await until(10, () => s.launches() === 2 && s.helper.state.kind === 'running'), s.states.join(' '));
    assert.ok(s.states.includes('backoff(1)'), s.states.join(' '));
    assert.ok(s.log().some((l) => l.includes('KILL helper reason=windows.list timed out 3 times in a row')), s.log().join('\n'));
  } finally {
    await s.done();
  }
});

test('an aborted request is cancelled at the helper at once and settles with its own answer', async () => {
  const s = setup('', 1);
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    const abort = new AbortController();
    const reply = s.helper.request('windows.list', {}, abort.signal);
    assert.ok(await until(5, () => s.received().some((r) => r.op === 'windows.list')));
    abort.abort();
    const r = await reply;
    assert.equal(r.ok ? '' : r.error.code, 'cancelled');
    assert.deepEqual(s.received().filter((m) => m.op === 'cancel').map((m) => m.params.target), [2]);
  } finally {
    await s.done();
  }
});

test('a crash fails the requests in flight with helper_exited and restarts after 1, then 2 s', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    const pending = s.helper.request('windows.list');
    const crash = await s.helper.request('apps.installed');
    assert.equal(crash.ok ? '' : crash.error.code, 'helper_exited');
    const reply = await pending;
    assert.equal(reply.ok ? '' : reply.error.code, 'helper_exited');
    assert.ok(await until(10, () => s.launches() === 2 && s.helper.state.kind === 'running'));
    await s.helper.request('apps.installed');
    assert.ok(await until(10, () => s.launches() === 3 && s.helper.state.kind === 'running'));
    assert.deepEqual(s.states.filter((x) => x.startsWith('backoff')), ['backoff(1)', 'backoff(2)']);
  } finally {
    await s.done();
  }
});

test('after a restart the watches in effect are asked for again, one per watch_id, before the helper counts as running (CONTRACT §6.4)', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    const watches = [
      ['workspace.watch', { enabled: true }], ['presence.watch', { enabled: true }], ['presence.watch', { enabled: false }],
      ['ax.watch', { pid: 702, notifications: ['focus'], watch_id: 'activity' }],
      ['ax.watch', { pid: 702, notifications: ['value'], watch_id: 'context' }],
      ['ax.watch', { pid: 703, notifications: ['focus', 'value'], watch_id: 'activity' }],
      ['ax.watch', { pid: 999, notifications: ['focus'], watch_id: 'activity' }],
      ['ax.watch', { pid: 702, notifications: ['focus'] }], ['ax.watch', { pid: null, notifications: [] }],
      ['ptt.register', { combo: 'right_option' }],
    ] as const;
    for (const [op, params] of watches) await s.helper.request(op, params);
    const before = s.received().length;
    await s.helper.request('apps.installed');
    assert.ok(await until(10, () => s.launches() === 2 && s.helper.state.kind === 'running'), s.states.join(' '));
    // The fake helper logs what it reads a little after the supervisor has written it.
    await until(2, () => s.received().length >= before + 5);
    assert.deepEqual(s.received().slice(before + 1).map((r) => [r.op, r.params]), [
      ['hello', { protocol: 1, client: 'electron', client_version: 'test' }],
      ['workspace.watch', { enabled: true }],
      ['ax.watch', { pid: 703, notifications: ['focus', 'value'], watch_id: 'activity' }],
      ['ax.watch', { pid: 702, notifications: ['value'], watch_id: 'context' }],
    ]);
  } finally {
    await s.done();
  }
});

test('without a watch in effect a restart asks for nothing but hello, also when it was stopped while no helper ran', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    await s.helper.request('workspace.watch', { enabled: true });
    await s.helper.request('workspace.watch', { enabled: false });
    await s.helper.request('apps.installed');
    assert.ok(await until(10, () => s.launches() === 2 && s.helper.state.kind === 'running'), s.states.join(' '));
    assert.deepEqual(s.received().map((r) => r.op), ['hello', 'workspace.watch', 'workspace.watch', 'apps.installed', 'hello']);
    await s.helper.request('presence.watch', { enabled: true });
    await s.helper.request('apps.installed');
    assert.equal(s.helper.state.kind, 'backoff');
    // Stopped while no helper runs: the next one is not asked for it.
    await s.helper.request('presence.watch', { enabled: false });
    assert.ok(await until(10, () => s.launches() === 3 && s.helper.state.kind === 'running'), s.states.join(' '));
    assert.deepEqual(s.received().slice(5).map((r) => r.op), ['presence.watch', 'apps.installed', 'hello']);
  } finally {
    await s.done();
  }
});

test('a watch changed while no helper runs is asked for as changed after the restart', async () => {
  const s = setup();
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    await s.helper.request('ax.watch', { pid: 702, read_selected_text: true, watch_id: 'activity' });
    await s.helper.request('apps.installed');
    assert.equal(s.helper.state.kind, 'backoff');
    const reply = await s.helper.request('ax.watch', { pid: 702, read_selected_text: false, watch_id: 'activity' });
    assert.equal(reply.ok ? '' : reply.error.code, 'helper_exited');
    assert.ok(await until(10, () => s.launches() === 2 && s.helper.state.kind === 'running'), s.states.join(' '));
    await until(2, () => s.received().length >= 5);
    assert.deepEqual(s.received().slice(3).map((r) => [r.op, r.params]), [
      ['hello', { protocol: 1, client: 'electron', client_version: 'test' }],
      ['ax.watch', { pid: 702, read_selected_text: false, watch_id: 'activity' }],
    ]);
  } finally {
    await s.done();
  }
});

// An append-only log opens for appending but refuses fchmod.
test('a log whose mode cannot be set fails the helper launch without keeping its descriptor open',
  { skip: process.platform !== 'darwin' && 'chflags uappnd is macOS only' }, async () => {
    const s = setup(), log = join(s.support, 'logs', 'helper.log');
    mkdirSync(join(s.support, 'logs'), { recursive: true });
    writeFileSync(log, '');
    execFileSync('chflags', ['uappnd', log]);
    try {
      const before = readdirSync('/dev/fd').length;
      s.helper.start();
      assert.equal(s.helper.state.kind, 'failed');
      assert.equal(readdirSync('/dev/fd').length, before);
    } finally {
      execFileSync('chflags', ['nouappnd', log]);
      await s.done();
    }
  });

test('a stop the helper answers in time leaves no shutdown grace timer behind', async () => {
  const s = setup();
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  try {
    const before = timeouts();
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    await s.helper.stop();
    assert.equal(timeouts(), before);
  } finally {
    await s.done();
  }
});

test('a protocol mismatch (exit 3) is a failure without a restart', async () => {
  const s = setup('mismatch');
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'failed'), s.states.join(' '));
    await sleep(0.5);
    assert.equal(s.launches(), 1);
    assert.equal(processState(s.helper.state, undefined).state, 'failed(版本不符：本程序用协议 1)');
  } finally {
    await s.done();
  }
});

test('an illegal line from the helper ends it and counts as a crash', async () => {
  const s = setup('garbage');
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.launches() >= 2), s.states.join(' '));
    assert.ok(s.log().some((l) => l.includes('KILL helper reason=a line is not JSON')), s.log().join('\n'));
    assert.ok(s.states.includes('backoff(1)'), s.states.join(' '));
  } finally {
    await s.done();
  }
});

test('a helper that ignores shutdown and SIGTERM is killed after the two graces', async () => {
  const s = setup('stubborn');
  try {
    s.helper.start();
    assert.ok(await until(10, () => s.helper.state.kind === 'running'));
    const began = performance.now();
    await s.helper.stop();
    const took = (performance.now() - began) / 1000;
    // Windows has no SIGTERM to ignore: the first kill (TerminateProcess) ends it after the shutdown grace alone.
    const [least, signal] = process.platform === 'win32' ? [0.1, 15] : [0.25, 9];
    assert.ok(took >= least && took < 5, `${took}`);
    assert.ok(s.log().some((l) => l.includes(`exit child=helper signal=${signal}`)), s.log().join('\n'));
    assert.equal(s.helper.state.kind, 'stopped');
  } finally {
    await s.done();
  }
});

test('a missing helper is a failure that names its path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-'));
  const helper = new HelperSupervisor({ executable: join(dir, 'none'), supportDir: join(dir, 's'), clientVersion: 'test' });
  try {
    helper.start();
    assert.ok(await until(5, () => helper.state.kind === 'failed'));
    assert.equal(processState(helper.state, undefined).state, `failed(找不到程序 ${join(dir, 'none')})`);
  } finally {
    await helper.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const REAL = resolve(import.meta.dirname, '../..', 'helpers/mac/.build/release/ac-helper');
test('the real macOS helper: hello, screens.list, shutdown', { skip: process.platform !== 'darwin' || !existsSync(REAL) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-')), support = join(dir, 's');
  const helper = new HelperSupervisor({ executable: helperExecutable(resolve(import.meta.dirname, '../..'), 'darwin'), supportDir: support,
    clientVersion: 'test' });
  try {
    helper.start();
    assert.ok(await until(10, () => helper.state.kind === 'running'), stateText(helper.state));
    const hello = helper.hello!;
    console.log(`# real helper hello: ${JSON.stringify(hello)}`);
    assert.equal(hello.platform, 'macos');
    assert.equal(hello.pid, helper.pid);
    assert.ok((hello.ops as string[]).includes('screens.list'));
    const screens = await helper.request('screens.list');
    assert.ok(screens.ok && Array.isArray(screens.result.screens) && screens.result.screens.length > 0);
    await helper.stop();
    const log = readFileSync(join(support, 'logs', 'companion.log'), 'utf8').trim().split('\n');
    console.log(log.map((l) => `# ${l}`).join('\n'));
    assert.ok(log.some((l) => l.includes('exit child=helper status=0')));
  } finally {
    await helper.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
