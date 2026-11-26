// ServiceSupervisor: a service's command lines under `ssh` and `local`, its port checks, backoff, restart and stop, and the
// remote start script. The wrapper is a Node script run with process.execPath as `python`; no ssh starts and no host is reached.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Config, servicePort } from '../src/common/config.ts';
import { initialRuntime, reduced, runtimeJson, runtimePhase, type ServiceView, type SlotState } from '../src/common/runtime.ts';
import { loadConfig } from '../src/main/config.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { supervisorOps } from '../src/main/ops/supervisor.ts';
import { lsofListeners, ownSshListeners, remoteArguments, type ServiceOptions, ServiceSupervisor, tasklistImage, tunnelArguments,
  watcherArguments } from '../src/main/services/supervisor.ts';

/** Appends its arguments and working directory as one JSON line to ARGS, then stays until SIGTERM; exits 255 at once with
 *  `crash`; with `listen` and a `--port P` among its arguments, listens on 127.0.0.1:P after LISTEN_DELAY ms. */
const WATCHER = String.raw`
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.TUNNEL_ARGS, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
console.log('watcher up');
console.error('watcher err');
if (process.env.TUNNEL_MODE === 'crash') process.exit(255);
const port = args.indexOf('--port');
if (process.env.TUNNEL_MODE === 'listen' && port >= 0) {
  setTimeout(() => require('node:net').createServer().listen(Number(args[port + 1]), '127.0.0.1'), Number(process.env.LISTEN_DELAY ?? 0));
}
setInterval(() => {}, 1000);
`;

// The fake python is node, which takes no `-I -B`: the spawns run as on macOS on every host.
const supervisor = (o: Omit<ServiceOptions, 'id'> & { id?: ServiceOptions['id'] }) => new ServiceSupervisor({ id: 'tts', platform: 'mac', ...o });

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

type Record_ = Record<string, unknown>;

function setup(o: { tts?: Record_; mode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'services-')), support = join(dir, 's');
  mkdirSync(support);
  const watcher = join(dir, 'parent_watch.cjs'), args = join(dir, 'args.jsonl');
  writeFileSync(watcher, WATCHER);
  process.env.TUNNEL_ARGS = args;
  process.env.TUNNEL_MODE = o.mode ?? 'stay';
  const configPath = join(dir, 'config.json');
  const write = (tts: Record_, services: Record_ = {}) => {
    writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], agentd_dir: dir, python: process.execPath, agentd_port: 48810,
      support_dir: support, agentd_state_dir: join(dir, 'state'),
      services: { tts: { mode: 'ssh', url: 'http://127.0.0.1:9880', ssh_host: 'gpu-box', ...tts }, ...services } }));
    return loadConfig(configPath);
  };
  const config = write(o.tts ?? {});
  const seen: string[] = [];
  const onStatus: ServiceOptions['onStatus'] = (v) => { if (v.state !== null && text(v.state) !== seen.at(-1)) seen.push(text(v.state)); };
  // Whole lines only: the watcher may be in the middle of appending one.
  const launches = () => (existsSync(args) ? readFileSync(args, 'utf8').split('\n').slice(0, -1).map((l) => (JSON.parse(l) as { args: string[] }).args) : []);
  const cwds = () => (existsSync(args) ? readFileSync(args, 'utf8').split('\n').slice(0, -1).map((l) => (JSON.parse(l) as { cwd: string }).cwd) : []);
  const log = () => (existsSync(join(support, 'logs/companion.log')) ? readFileSync(join(support, 'logs/companion.log'), 'utf8') : '');
  const servicesLog = () => (existsSync(join(support, 'logs/services.log')) ? readFileSync(join(support, 'logs/services.log'), 'utf8') : '');
  return { dir, support, watcher, config, write, seen, onStatus, launches, cwds, log, servicesLog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
  const ssh = tunnelArguments('gpu-box', [9880], 'windows', {});
  assert.deepEqual(watcherArguments('w.py', ssh, 'windows'), ['-I', '-B', 'w.py', ...watch, ...ssh]);
  // macOS's agentic-complex-python wrapper adds them.
  assert.deepEqual(watcherArguments('w.py', ['srv', '--port', '1'], 'mac'), ['w.py', ...watch, 'srv', '--port', '1']);
});

test('the remote start script runs over ssh in batch mode with a connect timeout, the action last', () => {
  assert.deepEqual(remoteArguments('gpu-box', '/opt/tts/ensure.sh', 'ensure', 'mac'),
    ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', 'gpu-box', '/opt/tts/ensure.sh', 'ensure']);
  assert.equal(remoteArguments('gpu-box', '/s', 'stop', 'windows', {})[0], 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
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
      const s = setup({ tts: { url: `http://127.0.0.1:${port}` } });
      const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, platform: 'windows',
        listeners: async () => [{ pid: 1, uid: undefined, command }], onStatus: s.onStatus });
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

test('a launch spawn refuses at once (a NUL in python) leaves the service failed, not starting', async () => {
  const s = setup();
  const port = await freePort();
  const config = { ...s.write({ url: `http://127.0.0.1:${port}` }), python: `${process.execPath}\u0000` };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(5, () => s.seen.length === 2), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', `failed(无法运行 ${process.execPath}\u0000)`]);
    assert.equal(tunnel.view.detail, `无法运行 ${process.execPath}\u0000`);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('servicePort is the port written in the url; none written or no URL is null', () => {
  assert.equal(servicePort('http://127.0.0.1:9880'), 9880);
  assert.equal(servicePort('ws://gpu:9001/tts'), 9001);
  assert.equal(servicePort('http://127.0.0.1/tts'), null);
  assert.equal(servicePort(''), null);
  assert.equal(servicePort('not a url'), null);
});

test('lsofListeners reads pid, uid and command from lsof -Fpcu', () => {
  assert.deepEqual(lsofListeners('p100\ncssh\nu501\nf3\np200\ncPython\nu0\nf7\n'),
    [{ pid: 100, uid: 501, command: 'ssh' }, { pid: 200, uid: 0, command: 'Python' }]);
  assert.deepEqual(lsofListeners(''), []);
});

test('under url and off start launches nothing, the view has no state, and start answers not_supervised', async () => {
  for (const mode of ['url', 'off']) {
    const s = setup({ tts: { mode } });
    const service = supervisor({ config: s.config, watcherScript: s.watcher, onStatus: s.onStatus });
    try {
      service.start();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual([service.view, s.seen, s.launches()], [{ mode, state: null, pid: null, detail: null }, [], []]);
      assert.deepEqual(await service.begin(), { ok: false, error: 'not_supervised', line: null });
      assert.deepEqual(await service.again(), { ok: false, error: 'not_supervised', line: null });
    } finally {
      await service.stop();
      s.cleanup();
    }
  }
});

test('without runtime.python the service fails naming it', async () => {
  const s = setup();
  const config: Config = { ...s.config, missingComponents: { 'runtime.python': 'componentMissing' } };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(5, () => s.seen.length === 1), s.seen.join('\n'));
    assert.deepEqual([s.seen, s.launches()], [['failed(缺 runtime.python 组件)'], []]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('ssh runs parent_watch.py with this pid around ssh, logs to services.log by id, and stop ends it', async () => {
  const s = setup();
  const port = await freePort();
  const config = s.write({ url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    assert.deepEqual(s.launches()[0], ['--parent-pid', String(process.pid), '--', ...tunnelArguments('gpu-box', [port], 'mac')]);
    assert.equal(typeof tunnel.pid, 'number');
    assert.deepEqual(tunnel.view, { mode: 'ssh', state: { kind: 'running' }, pid: tunnel.pid, detail: null });
    assert.ok(await until(5, () => /tts: watcher up\n/.test(s.servicesLog()) && /tts: watcher err\n/.test(s.servicesLog())), s.servicesLog());
    if (process.platform !== 'win32') assert.equal(statSync(join(s.support, 'logs/services.log')).mode & 0o777, 0o600);
    await tunnel.stop();
    assert.deepEqual([tunnel.state, tunnel.pid], [{ kind: 'stopped' }, undefined]);
    assert.deepEqual(s.seen, ['starting', 'running', 'stopped']);
    assert.match(s.log(), /supervisor: STATUS tts=starting\n.*supervisor: STATUS tts=running\n/);
    assert.match(s.log(), /supervisor: closed\(quit\) child=tts reason=companion_exit runtime=\d+\.\d{3}s\n.*STATUS tts=stopped/);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('a crashing service restarts after 1, 2, 4, 8 s and fails at the 5th crash in 300 s', async () => {
  const s = setup({ mode: 'crash' });
  const port = await freePort();
  const config = s.write({ url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, timeScale: 0.001, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(20, () => tunnel.state.kind === 'failed'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', 'running', 'backoff(1)', 'starting', 'running', 'backoff(2)', 'starting', 'running',
      'backoff(4)', 'starting', 'running', 'backoff(8)', 'starting', 'running', 'failed(300 秒内崩溃 5 次)']);
    assert.equal(s.launches().length, 5);
    assert.equal(s.log().match(/supervisor: exit child=tts status=255 runtime=\d+\.\d{3}s/g)?.length, 5);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('stop during the backoff cancels the restart', async () => {
  const s = setup({ mode: 'crash' });
  const port = await freePort();
  const config = s.write({ url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, timeScale: 0.05, onStatus: s.onStatus });
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
      const s = setup({ tts: { url: `http://127.0.0.1:${port}` } });
      const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, listeners: async () => listed, onStatus: s.onStatus });
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
  const s = setup({ tts: { url: `http://127.0.0.1:${port}` } });
  const uid = process.getuid?.();
  let checks = 0;
  const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, timeScale: 0.005,
    listeners: async () => { checks += 1; return [{ pid: 1, uid, command: 'ssh' }]; }, onStatus: s.onStatus });
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
  const s = setup({ tts: { url: `http://127.0.0.1:${port}` } });
  const uid = process.getuid?.();
  let checks = 0;
  const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, timeScale: 0.002,
    listeners: async () => { checks += 1; return [{ pid: 1, uid, command: 'ssh' }]; }, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(5, () => checks >= 2), `checks ${checks}`);
    assert.deepEqual([s.seen, s.launches()], [['external'], []]);
    assert.match(s.log(), /STATUS tts=external/);
    await new Promise<void>((r) => server.close(() => r()));
    assert.ok(await until(5, () => tunnel.state.kind === 'running'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['external', 'starting', 'running']);
  } finally {
    server.close();
    await tunnel.stop();
    s.cleanup();
  }
});

test('a python that cannot be spawned fails the service with the menu\'s text', async () => {
  const s = setup();
  const port = await freePort();
  const missing = join(s.dir, 'no-such-python');
  const config: Config = { ...s.write({ url: `http://127.0.0.1:${port}` }), python: missing };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(5, () => tunnel.state.kind === 'failed'), s.seen.join('\n'));
    assert.deepEqual(s.seen, ['starting', `failed(找不到程序 ${missing})`]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('restart takes config.json read again: off stops the tunnel, a new host starts it there', async () => {
  const s = setup();
  const port = await freePort();
  const tunnel = supervisor({ config: s.write({ url: `http://127.0.0.1:${port}` }), watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    tunnel.start();
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    await tunnel.restart(s.write({ url: `http://127.0.0.1:${port}`, mode: 'off' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([tunnel.state, tunnel.view.state, tunnel.record.mode, s.launches().length], [{ kind: 'stopped' }, null, 'off', 1]);
    assert.match(s.log(), /closed\(quit\) child=tts reason=restart/);
    await tunnel.restart(s.write({ url: `http://127.0.0.1:${port}`, ssh_host: 'other-box' }));
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 2), s.seen.join('\n'));
    assert.equal(s.launches()[1]!.at(-1), 'other-box');
    assert.deepEqual(s.seen, ['starting', 'running', 'stopped', 'starting', 'running']);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('a restart into off or url says so at once: the view has the new mode and not the old failure', async () => {
  const { server, port } = await hold();
  const s = setup({ tts: { url: `http://127.0.0.1:${port}` } });
  const views: ServiceView[] = [];
  const tunnel = supervisor({ config: s.config, watcherScript: s.watcher, listeners: async () => [{ pid: 1, uid: -1, command: 'node' }],
    onStatus: (v) => views.push(v) });
  try {
    tunnel.start();
    assert.ok(await until(5, () => tunnel.state.kind === 'failed'), JSON.stringify(views));
    for (const mode of ['off', 'url'] as const) {
      await tunnel.restart(s.write({ url: `http://127.0.0.1:${port}`, mode }));
      assert.deepEqual(views.at(-1), { mode, state: null, pid: null, detail: null }, mode);
    }
  } finally {
    server.close();
    await tunnel.stop();
    s.cleanup();
  }
});

test('of two restarts in a row only the later one starts: ssh then off launches nothing', async () => {
  const s = setup();
  const port = await freePort();
  const ssh = s.write({ url: `http://127.0.0.1:${port}` }), off = s.write({ url: `http://127.0.0.1:${port}`, mode: 'off' });
  const tunnel = supervisor({ config: off, watcherScript: s.watcher, onStatus: s.onStatus });
  try {
    await Promise.all([tunnel.restart(ssh), tunnel.restart(off)]);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([tunnel.state.kind, tunnel.record.mode, s.launches()], ['stopped', 'off', []]);
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('after stop, the shell\'s quit, neither a restart nor a start launches the service again', async () => {
  const s = setup();
  const port = await freePort();
  const config = s.write({ url: `http://127.0.0.1:${port}` });
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus });
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

test('with a start script, begin starts the tunnel and answers ensure\'s line, end stops it and runs the remote stop', async () => {
  const s = setup();
  const port = await freePort();
  const config = s.write({ url: `http://127.0.0.1:${port}`, start_script: '/opt/tts/ensure.sh' });
  const asked: string[] = [];
  const replies: Record<string, { ok: boolean; line: string }> = { ensure: { ok: true, line: 'ready 12' }, stop: { ok: true, line: 'stopped' } };
  const tunnel = supervisor({ config, watcherScript: s.watcher, onStatus: s.onStatus,
    remote: async (host, script, action) => { asked.push(`${host} ${script} ${action}`); return replies[action]!; } });
  try {
    assert.deepEqual(await tunnel.begin(), { ok: true, line: 'ready 12' });
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 1), s.seen.join('\n'));
    assert.deepEqual(await tunnel.end(), { ok: true, line: 'stopped' });
    assert.equal(tunnel.state.kind, 'stopped');
    replies.ensure = { ok: false, line: 'fail no gpu' };
    assert.deepEqual(await tunnel.again(), { ok: false, error: 'ensure_failed', line: 'fail no gpu' });
    assert.equal(tunnel.view.detail, 'fail no gpu');
    assert.deepEqual(asked, ['gpu-box /opt/tts/ensure.sh ensure', 'gpu-box /opt/tts/ensure.sh stop', 'gpu-box /opt/tts/ensure.sh stop',
      'gpu-box /opt/tts/ensure.sh ensure']);
    assert.ok(await until(10, () => tunnel.state.kind === 'running' && s.launches().length === 2), s.seen.join('\n'));
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('without a start script begin and end only start and stop the tunnel', async () => {
  const s = setup();
  const port = await freePort();
  const tunnel = supervisor({ config: s.write({ url: `http://127.0.0.1:${port}` }), watcherScript: s.watcher, onStatus: s.onStatus,
    remote: async () => assert.fail('no remote call') });
  try {
    assert.deepEqual(await tunnel.begin(), { ok: true, line: null });
    assert.ok(await until(10, () => tunnel.state.kind === 'running'), s.seen.join('\n'));
    assert.deepEqual(await tunnel.end(), { ok: true, line: null });
    assert.equal(tunnel.state.kind, 'stopped');
  } finally {
    await tunnel.stop();
    s.cleanup();
  }
});

test('local runs the command under parent_watch.py in its cwd, starting until its port listens, then running', async () => {
  const s = setup({ mode: 'listen' });
  const port = await freePort();
  process.env.LISTEN_DELAY = '300';
  const cwd = join(s.dir, 'srv');
  mkdirSync(cwd);
  const config = s.write({ mode: 'local', url: `http://127.0.0.1:${port}`, ssh_host: '', command: ['tts-server', '--port', String(port)], cwd });
  const service = supervisor({ config, watcherScript: s.watcher, timeScale: 0.2, onStatus: s.onStatus });
  try {
    service.start();
    assert.ok(await until(5, () => s.launches().length === 1), s.seen.join('\n'));
    assert.equal(service.state.kind, 'starting');
    assert.ok(await until(10, () => service.state.kind === 'running'), s.seen.join('\n'));
    assert.deepEqual(s.launches()[0], ['--parent-pid', String(process.pid), '--', 'tts-server', '--port', String(port)]);
    assert.equal(realpathSync(s.cwds()[0]!), realpathSync(cwd));
    assert.deepEqual(s.seen, ['starting', 'running']);
    assert.deepEqual(service.view, { mode: 'local', state: { kind: 'running' }, pid: service.pid, detail: null });
    await service.stop();
    assert.deepEqual(s.seen, ['starting', 'running', 'stopped']);
  } finally {
    delete process.env.LISTEN_DELAY;
    await service.stop();
    s.cleanup();
  }
});

test('a local command that exits restarts with the backoff; a taken port or a missing cwd starts nothing', async () => {
  const s = setup({ mode: 'crash' });
  const port = await freePort();
  const service = supervisor({ config: s.write({ mode: 'local', url: `http://127.0.0.1:${port}`, command: ['srv'] }),
    watcherScript: s.watcher, timeScale: 0.001, onStatus: s.onStatus });
  try {
    service.start();
    assert.ok(await until(20, () => service.state.kind === 'failed'), s.seen.join('\n'));
    assert.deepEqual(s.seen.filter((x) => x.startsWith('backoff') || x.startsWith('failed')),
      ['backoff(1)', 'backoff(2)', 'backoff(4)', 'backoff(8)', 'failed(300 秒内崩溃 5 次)']);
    assert.equal(s.launches().length, 5);
  } finally {
    await service.stop();
    s.cleanup();
  }
  const { server, port: taken } = await hold();
  try {
    for (const [tts, reason] of [[{ url: `http://127.0.0.1:${taken}` }, `端口 ${taken} 被占用`],
      [{ url: `http://127.0.0.1:${port}`, cwd: '/no/such/dir' }, '工作目录不存在 /no/such/dir']] as const) {
      const t = setup({ mode: 'listen' });
      const local = supervisor({ config: t.write({ mode: 'local', command: ['srv'], ...tts }), watcherScript: t.watcher, onStatus: t.onStatus });
      try {
        local.start();
        assert.ok(await until(5, () => t.seen.length === 1), t.seen.join('\n'));
        assert.deepEqual([t.seen, t.launches()], [[`failed(${reason})`], []]);
      } finally {
        await local.stop();
        t.cleanup();
      }
    }
  } finally {
    server.close();
  }
});

test('supervisor.state carries each ssh or local service\'s state; an adopted forward reads external', () => {
  const views: Record<string, unknown> = {
    tts: { mode: 'ssh', state: { kind: 'external' }, pid: null, detail: null },
    motion: { mode: 'local', state: { kind: 'backoff', seconds: 2 }, pid: null, detail: null },
    llm: { mode: 'url', state: null, pid: null, detail: null },
  };
  const read = supervisorOps({ supervisor: { state: () => ({ kind: 'stopped' }), pid: () => undefined, restart() {}, avatar: () => ({ kind: 'stopped' }) },
    services: { view: (id: string) => views[id] } } as unknown as OpsContext)['supervisor.state']!([], undefined as never) as
    Record<string, Record<string, unknown> | undefined>;
  assert.equal(read.tts!.state, 'external');
  assert.deepEqual([read.motion!.state, read.motion!.backoff], ['backoff(2)', 2]);
  assert.equal(read.llm, undefined);
});

test('the runtime carries a service\'s external state as `external`, which is not degraded; a failed one is', () => {
  const view = (state: SlotState) => ({ mode: 'ssh' as const, state, pid: null, detail: state.kind === 'failed' ? state.reason : null });
  const s = reduced(initialRuntime(0), { kind: 'service', id: 'tts', view: view({ kind: 'external' }) }, 5);
  assert.equal(s.revision, 1);
  assert.deepEqual(runtimeJson(s).services.tts, { mode: 'ssh', state: { kind: 'external' }, pid: null, detail: null });
  assert.equal(reduced(s, { kind: 'service', id: 'tts', view: view({ kind: 'external' }) }, 9), s);
  const failed = reduced(s, { kind: 'service', id: 'tts', view: view({ kind: 'failed', reason: '端口 9880 被占用' }) }, 9);
  assert.deepEqual(runtimeJson(failed).services.tts, { mode: 'ssh', state: { kind: 'failed', reason: '端口 9880 被占用' }, pid: null,
    detail: '端口 9880 被占用' });
  assert.deepEqual(failed.degraded, [{ source: 'service', code: 'service_failed', detail: 'tts' }]);
  assert.notEqual(runtimePhase(s), 'degraded');
  const backoff = reduced(failed, { kind: 'service', id: 'tts', view: view({ kind: 'backoff', seconds: 4 }) }, 9);
  assert.deepEqual([runtimeJson(backoff).services.tts.state, backoff.degraded], [{ kind: 'backoff', seconds: 4 }, []]);
});
