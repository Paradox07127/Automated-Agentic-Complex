// TunnelSupervisor: the TTS tunnel's command line, its port checks, backoff,
// restart and stop. The wrapper is a Node script run with process.execPath as `python`; no ssh starts and no host is reached.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChildState } from '../src/common/agentd.ts';
import { menuLines } from '../src/common/components.ts';
import type { Config } from '../src/common/config.ts';
import { initialRuntime, reduced, runtimeJson, runtimePhase, type SlotState } from '../src/common/runtime.ts';
import { loadConfig } from '../src/main/config.ts';
import { lsofListeners, ownSshListeners, tasklistImage, type TunnelOptions, TunnelSupervisor, tunnelArguments, tunnelPort,
  watcherArguments } from '../src/main/tunnel/supervisor.ts';

/** Appends its arguments as one JSON line to ARGS, then stays until SIGTERM, or exits 255 at once with `crash`. */
const WATCHER = String.raw`
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.TUNNEL_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
console.log('watcher up');
if (process.env.TUNNEL_MODE === 'crash') process.exit(255);
setInterval(() => {}, 1000);
`;

// The fake python is node, which takes no `-I -B`: the spawns run as on macOS on every host.
const supervisor = (o: TunnelOptions) => new TunnelSupervisor({ platform: 'mac', ...o });

const text = (s: SlotState) => (s.kind === 'backoff' ? `backoff(${s.seconds})` : s.kind === 'failed' ? `failed(${s.reason})` : s.kind);

async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !ok()) await new Promise((r) => setTimeout(r, 10));
  return ok();
}

function hold(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

async function freePort(): Promise<number> {
  const { server, port } = await hold();
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function setup(o: { config?: Record<string, unknown>; mode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-')), support = join(dir, 's');
  mkdirSync(support);
  const watcher = join(dir, 'parent_watch.cjs'), args = join(dir, 'args.jsonl');
  writeFileSync(watcher, WATCHER);
  process.env.TUNNEL_ARGS = args;
  process.env.TUNNEL_MODE = o.mode ?? 'stay';
  const configPath = join(dir, 'config.json');
  const write = (extra: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath, agentd_port: 48810,
      gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state'), voice_service: 'remote',
      tts_url: 'http://127.0.0.1:9880', tts_tunnel_host: 'gpu-box', ...extra }));
    return loadConfig(configPath);
  };
  const config = write(o.config ?? {});
  const seen: string[] = [];
  // Whole lines only: the watcher may be in the middle of appending one.
  const launches = () => (existsSync(args) ? readFileSync(args, 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l) as string[]) : []);
  const log = () => (existsSync(join(support, 'logs/companion.log')) ? readFileSync(join(support, 'logs/companion.log'), 'utf8') : '');
  return { dir, support, watcher, config, write, seen, launches, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('tunnelArguments forwards each port once from the host to the same port here', () => {
  assert.deepEqual(tunnelArguments('gpu-box', [9880, 9881, 9880], 'mac'), ['/usr/bin/ssh', '-N', '-o', 'BatchMode=yes', '-o',
    'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'GatewayPorts=no', '-L', '127.0.0.1:9880:127.0.0.1:9880',
    '-L', '127.0.0.1:9881:127.0.0.1:9881', '--', 'gpu-box']);
});

test('on Windows the tunnel runs the system\'s OpenSSH ssh.exe with the same options, and python with -I -B', () => {
  const options = tunnelArguments('gpu-box', [9880], 'mac').slice(1);
  assert.deepEqual(tunnelArguments('gpu-box', [9880], 'windows', { SystemRoot: 'D:\\Win' }), ['D:\\Win\\System32\\OpenSSH\\ssh.exe', ...options]);
  assert.deepEqual(tunnelArguments('gpu-box', [9880], 'windows', {}), ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', ...options]);
  const watch = ['--parent-pid', String(process.pid), '--'];
  assert.deepEqual(watcherArguments('w.py', 'gpu-box', 9880, 'windows', {}), ['-I', '-B', 'w.py', ...watch, ...tunnelArguments('gpu-box', [9880], 'windows', {})]);
  // macOS's agentic-complex-python wrapper adds them.
  assert.deepEqual(watcherArguments('w.py', 'gpu-box', 9880, 'mac', {}), ['w.py', ...watch, ...tunnelArguments('gpu-box', [9880], 'mac')]);
});

test('tasklistImage reads the image name from the first CSV field in any display language; the no-match notice is none', () => {
  assert.equal(tasklistImage('"ssh.exe","4312","Console","1","8,124 K"\r\n'), 'ssh.exe');
  assert.equal(tasklistImage('\r\n"ssh.exe","4312","Konsole","1","8.124 K"\r\n'), 'ssh.exe');
  assert.equal(tasklistImage('INFO: No tasks are running which match the specified criteria.\r\n'), undefined);
  assert.equal(tasklistImage('信息: 没有运行的任务匹配指定标准。\r\n'), undefined);
});

test('on Windows a taken port is ours when every listener is ssh.exe, with no uid test; macOS still tests the uid', () => {
  const l = (command: string, uid?: number) => ({ pid: 1, uid, command });
  assert.equal(ownSshListeners([l('ssh.exe')], 'windows', undefined), true);
  assert.equal(ownSshListeners([l('SSH.EXE'), l('ssh.exe', 7)], 'windows', undefined), true);
  for (const listed of [[l('ssh.exe'), l('node.exe')], [l('')], [l('ssh')], []]) assert.equal(ownSshListeners(listed, 'windows', undefined), false);
  assert.equal(ownSshListeners([l('ssh', 501)], 'mac', 501), true);
  for (const listed of [[l('ssh.exe', 501)], [l('ssh', 0)], [l('ssh')]]) assert.equal(ownSshListeners(listed, 'mac', 501), false);
});

test('on Windows a port held by ssh.exe is external and one held by another image fails the tunnel', async () => {
  const { server, port } = await hold();
  try {
    for (const [command, seen] of [['ssh.exe', 'external'], ['node.exe', `failed(端口 ${port} 被占用)`]]) {
      const s = setup({ config: { tts_url: `http://127.0.0.1:${port}` } });
      const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, platform: 'windows',
        listeners: async () => [{ pid: 1, uid: undefined, command }], onStatus: (st) => s.seen.push(text(st)) });
      try {
        tunnel.start();
        assert.ok(await until(5, () => s.seen.length === 1), s.seen.join('\n'));
        assert.deepEqual([s.seen, s.launches()], [[seen], []]);
      } finally {
        await tunnel.stop();
        s.cleanup();
      }
    }
  } finally {
    server.close();
  }
});

test('a tts_tunnel_host ssh would read as an option, or with a space or control character, starts no ssh', async () => {
  for (const host of ['-oProxyCommand=touch x', 'gpu box', 'gpu\u0000box']) {
    const s = setup();
    const port = await freePort();
    const config = s.write({ tts_url: `http://127.0.0.1:${port}`, tts_tunnel_host: host });
    const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
    try {
      tunnel.start();
      assert.ok(await until(5, () => s.seen.length === 1), s.seen.join('\n'));
      assert.deepEqual([s.seen, s.launches()], [['failed(SSH 转发主机无效)'], []], JSON.stringify(host));
    } finally {
      await tunnel.stop();
      s.cleanup();
    }
  }
});

test('a launch spawn refuses at once (a NUL in python) leaves the tunnel failed, not starting', async () => {
  const s = setup();
  const port = await freePort();
  const config = { ...s.write({ tts_url: `http://127.0.0.1:${port}` }), python: `${process.execPath}\u0000` };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(5, () => s.seen.length === 2), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', `failed(无法运行 ${process.execPath}\u0000)`]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('tunnelPort is the port written in tts_url; none written or no URL is no tunnel', () => {
  assert.equal(tunnelPort('http://127.0.0.1:9880'), 9880);
  assert.equal(tunnelPort('ws://gpu:9001/tts'), 9001);
  assert.equal(tunnelPort('http://127.0.0.1/tts'), null);
  assert.equal(tunnelPort(''), null);
  assert.equal(tunnelPort('not a url'), null);
});

test('lsofListeners reads pid, uid and command from lsof -Fpcu', () => {
  assert.deepEqual(lsofListeners('p100\ncssh\nu501\nf3\np200\ncPython\nu0\nf7\n'),
    [{ pid: 100, uid: 501, command: 'ssh' }, { pid: 200, uid: 0, command: 'Python' }]);
  assert.deepEqual(lsofListeners(''), []);
});

test('no host or no port in tts_url: start launches nothing and the tunnel stays stopped', async () => {
  for (const config of [{ tts_tunnel_host: '' }, { tts_url: 'http://127.0.0.1/tts' }]) {
    const s = setup({ config });
    const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
    try {
      tunnel.start();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual([tunnel.state, s.seen, s.launches()], [{ kind: 'stopped' }, [], []]);
    } finally {
      await tunnel.stop();
      s.cleanup();
    }
  }
});

test('without runtime.python the tunnel fails naming it', async () => {
  const s = setup();
  const config: Config = { ...s.config, missingComponents: { 'runtime.python': 'componentMissing' } };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(5, () => s.seen.length === 1), s.seen.join('\n'));
    assert.deepEqual([s.seen, s.launches()], [['failed(缺 runtime.python 组件)'], []]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('start runs parent_watch.py with this pid around ssh, logs to tunnel.log, and stop ends it', async () => {
  const s = setup();
  const port = await freePort();
  const config = s.write({ tts_url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    assert.deepEqual(s.launches()[0], ['--parent-pid', String(process.pid), '--', ...tunnelArguments('gpu-box', [port], 'mac')]);
    assert.equal(typeof tunnel.pid, 'number');
    assert.ok(await until(5, () => readFileSync(join(s.support, 'logs/tunnel.log'), 'utf8').includes('watcher up')));
    if (process.platform !== 'win32') assert.equal(statSync(join(s.support, 'logs/tunnel.log')).mode & 0o777, 0o600);
    await tunnel.stop();
    assert.deepEqual([tunnel.state, tunnel.pid], [{ kind: 'stopped' }, undefined]);
    assert.deepEqual(s.seen, ['starting', 'running', 'stopped']);
    assert.match(s.log(), /supervisor: STATUS tunnel=starting\n.*supervisor: STATUS tunnel=running\n/);
    assert.match(s.log(), /supervisor: closed\(quit\) child=tunnel reason=companion_exit runtime=\d+\.\d{3}s\n.*STATUS tunnel=stopped/);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('a crashing tunnel restarts after 1, 2, 4, 8 s and fails at the 5th crash in 300 s', async () => {
  const s = setup({ mode: 'crash' });
  const port = await freePort();
  const config = s.write({ tts_url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, timeScale: 0.001, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(20, () => tunnel.state.kind === 'failed'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', 'running', 'backoff(1)', 'starting', 'running', 'backoff(2)', 'starting', 'running',
      'backoff(4)', 'starting', 'running', 'backoff(8)', 'starting', 'running', 'failed(300 秒内崩溃 5 次)']);
    assert.equal(s.launches().length, 5);
    assert.equal(s.log().match(/supervisor: exit child=tunnel status=255 runtime=\d+\.\d{3}s/g)?.length, 5);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('stop during the backoff cancels the restart', async () => {
  const s = setup({ mode: 'crash' });
  const port = await freePort();
  const config = s.write({ tts_url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, timeScale: 0.05, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'backoff'), s.seen.join('\n'));
    await tunnel.stop();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual([s.seen, s.launches().length], [['starting', 'running', 'backoff(1)', 'stopped'], 1]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('a port held by something other than this user\'s ssh fails the tunnel; none listed counts as untrusted', async () => {
  const { server, port } = await hold();
  const uid = process.getuid?.();
  try {
    for (const listed of [[{ pid: 1, uid, command: 'node' }], [{ pid: 1, uid: -1, command: 'ssh' }], []]) {
      const s = setup({ config: { tts_url: `http://127.0.0.1:${port}` } });
      const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, listeners: async () => listed,
        onStatus: (st) => s.seen.push(text(st)) });
      try {
        tunnel.start();
        assert.ok(await until(5, () => s.seen.length === 1), s.seen.join('\n'));
        assert.deepEqual([s.seen, s.launches()], [[`failed(端口 ${port} 被占用)`], []]);
      } finally {
        await tunnel.stop();
        s.cleanup();
      }
    }
  } finally {
    server.close();
  }
});

test('two restarts at once leave one start: an external port is checked again once per period, not twice', async () => {
  const { server, port } = await hold();
  const s = setup({ config: { tts_url: `http://127.0.0.1:${port}` } });
  const uid = process.getuid?.();
  let checks = 0;
  const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, timeScale: 0.005,
    listeners: async () => { checks += 1; return [{ pid: 1, uid, command: 'ssh' }]; }, onStatus: (st) => s.seen.push(text(st)) });
  try {
    await Promise.all([tunnel.restart(s.config), tunnel.restart(s.config)]);
    assert.ok(await until(5, () => tunnel.state.kind === 'external'), s.seen.join('\n'));
    const before = checks;
    // One period is 300 ms.
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(checks - before, 1);
  } finally {
    server.close();
    await tunnel.stop();
    s.cleanup();
  }
});

test('a port held by this user\'s ssh is external, checked again after 60 s, then the tunnel starts', async () => {
  const { server, port } = await hold();
  const s = setup({ config: { tts_url: `http://127.0.0.1:${port}` } });
  const config = s.config;
  const uid = process.getuid?.();
  let checks = 0;
  const tunnel = supervisor({ config, watcherScript: s.watcher, timeScale: 0.002,
    listeners: async () => { checks += 1; return [{ pid: 1, uid, command: 'ssh' }]; }, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(5, () => checks >= 2), `checks ${checks}`);
    assert.deepEqual([s.seen, s.launches()], [['external'], []]);
    assert.match(s.log(), /STATUS tunnel=external/);
    await new Promise<void>((r) => server.close(() => r()));
    assert.ok(await until(5, () => tunnel.state.kind === 'running'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['external', 'starting', 'running']);
  } finally {
    server.close();
    await tunnel.stop();
    s.cleanup();
  }
});

test('a python that cannot be spawned fails the tunnel with the menu\'s text', async () => {
  const s = setup();
  const port = await freePort();
  const missing = join(s.dir, 'no-such-python');
  const config: Config = { ...s.write({ tts_url: `http://127.0.0.1:${port}` }), python: missing };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(5, () => tunnel.state.kind === 'failed'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', `failed(找不到程序 ${missing})`]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('restart takes config.json read again: a cleared host stops the tunnel, a new host starts it there', async () => {
  const s = setup();
  const port = await freePort();
  const tunnel = supervisor({ config: s.write({ tts_url: `http://127.0.0.1:${port}` }), watcherScript: s.watcher,
    onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    await tunnel.restart(s.write({ tts_url: `http://127.0.0.1:${port}`, voice_service: 'local' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([tunnel.state, tunnel.config.ttsTunnelHost, s.launches().length], [{ kind: 'stopped' }, '', 1]);
    assert.match(s.log(), /closed\(quit\) child=tunnel reason=restart/);
    await tunnel.restart(s.write({ tts_url: `http://127.0.0.1:${port}`, tts_tunnel_host: 'other-box' }));
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 2), s.seen.join('\n'));
    assert.equal(s.launches()[1].at(-1), 'other-box');
    assert.deepEqual(s.seen, ['starting', 'running', 'stopped', 'starting', 'running']);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('after stop, the shell\'s quit, neither a restart nor a start launches the tunnel again', async () => {
  const s = setup();
  const port = await freePort();
  const config = s.write({ tts_url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: (st) => s.seen.push(text(st)) });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    await tunnel.stop();
    await tunnel.restart(config);
    tunnel.start();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual([tunnel.state.kind, s.launches().length], ['stopped', 1]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

// An append-only log opens for appending but refuses fchmod.
test('a log whose mode cannot be set fails the tunnel launch without keeping its descriptor open',
  { skip: process.platform !== 'darwin' && 'chflags uappnd is macOS only' }, async () => {
    const s = setup();
    const port = await freePort(), log = join(s.support, 'logs', 'tunnel.log');
    const tunnel = supervisor({ config: s.write({ tts_url: `http://127.0.0.1:${port}` }), watcherScript: s.watcher,
      onStatus: (st) => s.seen.push(text(st)) });
    mkdirSync(join(s.support, 'logs'), { recursive: true });
    writeFileSync(log, '');
    execFileSync('chflags', ['uappnd', log]);
    try {
      const before = readdirSync('/dev/fd').length;
      tunnel.start();
      assert.ok(await until(5, () => tunnel.state.kind === 'failed'), s.seen.join('\n'));
      assert.equal(readdirSync('/dev/fd').length, before);
    } finally {
      await tunnel.stop();
      execFileSync('chflags', ['nouappnd', log]);
      s.cleanup();
    }
  });

test('the tray\'s 语音隧道 row shows the tunnel\'s state; external reads 沿用已有连接', () => {
  const s = setup();
  const stopped: ChildState = { kind: 'stopped' };
  try {
    assert.deepEqual(menuLines(s.config, stopped, stopped, { kind: 'external' }), ['角色 · 未启动', '后台 · 未启动', '语音隧道 · 沿用已有连接']);
    assert.deepEqual(menuLines(s.config, stopped, stopped, { kind: 'backoff', seconds: 2 })[2], '语音隧道 · 重连中 2 s');
    assert.deepEqual(menuLines(s.write({ tts_tunnel_host: '' }), stopped, stopped, { kind: 'running' }), ['角色 · 未启动', '后台 · 未启动']);
  } finally {
    s.cleanup();
  }
});

test('the runtime carries the tunnel\'s external state as `external`, which is not degraded', () => {
  const s = reduced(initialRuntime(0), { kind: 'child', name: 'tunnel', state: { kind: 'external' }, pid: null }, 5);
  assert.equal(s.revision, 1);
  assert.deepEqual(runtimeJson(s).processes.tunnel, { state: 'external', pid: null, backoff: null, reason: null, stage: null });
  assert.equal(reduced(s, { kind: 'child', name: 'tunnel', state: { kind: 'external' }, pid: null }, 9), s);
  const failed = reduced(s, { kind: 'child', name: 'tunnel', state: { kind: 'failed', reason: '端口 9880 被占用' }, pid: null }, 9);
  assert.equal(runtimeJson(failed).processes.tunnel.reason, '端口 9880 被占用');
  assert.notEqual(runtimePhase(s), 'degraded');
});
