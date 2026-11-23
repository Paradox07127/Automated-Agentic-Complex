import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  agentdArguments, Backoff, type ChildState, controlEndpoint, crashState, HealthWatch, launchFailure, parseHealth,
  preflightFailure, stateText,
} from '../src/common/agentd.ts';
import { parseConfig } from '../src/common/config.ts';
import { PLUGIN_IDS } from '../src/common/plugins.ts';
import { portOwners } from '../src/main/agentd/supervisor.ts';
import { processState } from '../src/main/ops/supervisor.ts';
import { lsofPids, netstatListeners, portOwnersCommand, pythonFlags } from '../src/main/platform/index.ts';

const config = (o: Record<string, unknown> = {}) => parseConfig(JSON.stringify({
  agentd_dir: '/a/agentd', python: '/a/python', agentd_port: 48810, gpu_hold_files: [], characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app' }], support_dir: '/s',
  agentd_state_dir: '/st', ...o,
}), { supportDir: '/support', agentdStateDir: '/state', catalog: () => null });

test('backoff waits 1, 2, 4, 8 s and fails at the fifth crash within 300 s', () => {
  let now = 1000;
  const b = new Backoff(() => now);
  const states: ChildState[] = [];
  for (let i = 0; i < 5; i++) {
    b.recordStart();
    now += 2;
    states.push(crashState(b.recordCrash()));
  }
  assert.deepEqual(states.map(stateText), ['backoff(1)', 'backoff(2)', 'backoff(4)', 'backoff(8)', 'failed(300 秒内崩溃 5 次)']);
  assert.equal(processState(states[4]!, undefined).state, 'failed(300 秒内崩溃 5 次)');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(Backoff.delay), [1, 2, 4, 8, 16, 30, 30]);
});

test('a run of 60 s restarts the delays at 1 s, and crashes older than 300 s no longer count', () => {
  let now = 0;
  const b = new Backoff(() => now);
  b.recordStart(); now += 1;
  assert.deepEqual(b.recordCrash(), { retry: 1 });
  b.recordStart(); now += 1;
  assert.deepEqual(b.recordCrash(), { retry: 2 });
  b.recordStart(); now += 60;
  assert.deepEqual(b.recordCrash(), { retry: 1 });
  now += 300;
  for (const delay of [2, 4, 8, 16]) {
    b.recordStart(); now += 1;
    assert.deepEqual(b.recordCrash(), { retry: delay });
  }
  assert.equal(b.recordCrash(), 'tripped');
  b.reset();
  assert.deepEqual(b.recordCrash(), { retry: 1 });
});

test('/health replies: ok is ready, starting carries the stage, anything else is unreachable', () => {
  assert.deepEqual(parseHealth({ status: 'ok', degraded: ['observations'], c6_contract: 'v1' }), { kind: 'ready', degraded: ['observations'] });
  assert.deepEqual(parseHealth({ status: 'starting', stage: 'storage', degraded: [] }), { kind: 'starting', stage: 'storage', degraded: [] });
  for (const body of [null, [], 'ok', { status: 'down' }]) assert.deepEqual(parseHealth(body), { kind: 'unreachable' });
});

test('the health watch: ready ends it, a new stage is reported once, 15 s silent or 90 s not ready kills', () => {
  const starting = (stage: string) => ({ kind: 'starting' as const, stage, degraded: [] });
  const w = new HealthWatch(0);
  assert.deepEqual(w.observe({ kind: 'unreachable' }, 1), { action: 'wait' });
  assert.deepEqual(w.observe(starting('init'), 2), { action: 'wait', stage: 'init' });
  assert.deepEqual(w.observe(starting('init'), 3), { action: 'wait' });
  assert.deepEqual(w.observe(starting('storage'), 4), { action: 'wait', stage: 'storage' });
  assert.deepEqual(w.observe({ kind: 'unreachable' }, 18.9), { action: 'wait' });
  assert.deepEqual(w.observe({ kind: 'unreachable' }, 19), { action: 'kill', reason: 'no_health_answer' });
  const slow = new HealthWatch(0);
  for (let t = 10; t < 90; t += 10) assert.equal(slow.observe(starting('memory'), t).action, 'wait');
  assert.deepEqual(slow.observe(starting('memory'), 90), { action: 'kill', reason: 'not_ready' });
  assert.deepEqual(new HealthWatch(0).observe({ kind: 'ready', degraded: [] }, 100), { action: 'ready' });
});

test('desktop.onState\'s agentd pip carries each state and the backoff seconds', () => {
  const pips = ([{ kind: 'stopped' }, { kind: 'starting' }, { kind: 'running' }, { kind: 'backoff', seconds: 4 }, { kind: 'portInUse' },
    { kind: 'failed', reason: '缺 agentd 组件' }] as ChildState[]).map((s) => processState(s, undefined));
  assert.deepEqual(pips.map((p) => p.state), ['stopped', 'starting', 'running', 'backoff(4)', 'portInUse', 'failed(缺 agentd 组件)']);
  assert.deepEqual(pips.map((p) => p.backoff), [null, null, null, 4, null, null]);
});

test('missing components and a missing library fail before launch', () => {
  assert.equal(preflightFailure(config()), null);
  assert.deepEqual(preflightFailure(config({ missing_components: { 'runtime.python': 'componentMissing' } })),
    { kind: 'failed', reason: '缺 runtime.python 组件' });
  assert.deepEqual(preflightFailure(config({ missing_components: { 'runtime.python': 'x', agentd: 'requirementUnmet' } })),
    { kind: 'failed', reason: '缺 agentd 组件' });
  assert.deepEqual(preflightFailure(config({ character_library_missing: ['agentd', 'characters.aster'] })),
    { kind: 'failed', reason: '没有角色库：缺 agentd characters.aster 组件' });
  assert.equal(launchFailure('ENOENT', '/p'), '找不到程序 /p');
  assert.equal(launchFailure('EACCES', '/p'), '没有权限运行 /p');
  assert.equal(launchFailure('EIO', '/p'), '无法运行 /p');
});

test('the agentd command line follows C9 in a fixed order', () => {
  const ctx = { launcherScript: '/r/agentd_launcher.py', parentPid: 42, character: 'aster', privacyConfigPath: '/s/config.json' };
  assert.deepEqual(agentdArguments(config(), ctx), [
    '/r/agentd_launcher.py', '--agentd-dir', '/a/agentd', '--parent-pid', '42', '--',
    '--port', '48810', '--state-dir', '/st', '--interaction-preset', 'balanced', '--character', 'aster',
    '--privacy-config', '/s/config.json', ...PLUGIN_IDS.flatMap((id) => [id === 'light_ai' ? '--plugin-on' : '--plugin-off', id]),
    '--share-agent-sessions', '--break-reminder-minutes', '0',
    '--water-reminder-minutes', '90',
    '--tts-token-file', '/s/tts-token',
  ]);
  const all = agentdArguments(config({
    character_catalog: null, harness_sites: { 'harness.pi': '/pi' }, plugins: { computer_use: true }, share_page_text: true,
    share_window_text: true, share_typed_text: true, share_agent_sessions: false, share_screenshots: true,
    redact_sensitive: false, proactive_speech: false, break_reminder_minutes: -3, water_reminder_minutes: 0, mute: true,
    services: { tts: { mode: 'ssh', url: 'http://127.0.0.1:9888', ssh_host: 'gpu', start_script: '/e.sh' },
      motion: { mode: 'url', url: 'http://gpu:48830', ssh_host: 'gpu', start_script: '/m.sh' },
      llm: { mode: 'local', url: 'http://127.0.0.1:11434/v1', command: ['ollama', 'serve'], start_script: '/l.sh' } },
    interaction_preset: 'quiet', dev_resources: '/dev',
  }), { ...ctx, character: '', privacyConfigPath: undefined });
  assert.deepEqual(all, [
    '/r/agentd_launcher.py', '--agentd-dir', '/dev/runtime/agentd', '--parent-pid', '42', '--',
    '--port', '48810', '--state-dir', '/st', '--interaction-preset', 'quiet', '--harness-site', 'harness.pi=/pi',
    ...PLUGIN_IDS.flatMap((id) => [['light_ai', 'computer_use'].includes(id) ? '--plugin-on' : '--plugin-off', id]),
    '--computer-control-socket', '/s/run/computer-control.sock', '--computer-control-token-file', '/s/run/computer-control.token',
    '--share-page-text', '--share-window-text', '--share-typed-text', '--share-screenshots', '--no-redact',
    '--no-proactive', '--break-reminder-minutes', '0', '--water-reminder-minutes', '0', '--mute',
    '--tts-url', 'http://127.0.0.1:9888', '--tts-ssh-host', 'gpu', '--tts-ensure-host', 'gpu', '--tts-ensure-script', '/e.sh',
    '--motion-url', 'http://gpu:48830', '--llm-url', 'http://127.0.0.1:11434/v1', '--tts-token-file', '/s/tts-token',
  ]);
  const ssh = { mode: 'ssh', url: 'http://127.0.0.1:48830', ssh_host: 'gpu' };
  assert.deepEqual(agentdArguments(config({ services: { motion: ssh } }), ctx).slice(-6),
    ['--motion-url', 'http://127.0.0.1:48830', '--motion-ssh-host', 'gpu', '--tts-token-file', '/s/tts-token']);
});

test("the helper's control.listen and agentd get one endpoint: a socket in <support>/run on macOS, a pipe per support dir on Windows", () => {
  assert.deepEqual(controlEndpoint('/s', 'mac'), { path: '/s/run/computer-control.sock', tokenFile: '/s/run/computer-control.token' });
  const support = 'C:\\Users\\me\\AppData\\Roaming\\Agentic Complex';
  const win = controlEndpoint(support, 'windows');
  assert.match(win.path, /^\\\\\.\\pipe\\agentic-complex-[0-9a-f]{8}-control$/);
  assert.equal(win.tokenFile, `${support}\\run\\computer-control.token`);
  assert.deepEqual(controlEndpoint(support, 'windows'), win);
  assert.notEqual(controlEndpoint('C:\\Users\\you\\AppData\\Roaming\\Agentic Complex', 'windows').path, win.path);
  const ctx = { launcherScript: 'C:\\r\\agentd_launcher.py', parentPid: 42, character: '', platform: 'windows' as const };
  const args = agentdArguments(config({ support_dir: support, plugins: { computer_use: true } }), ctx);
  const at = args.indexOf('--computer-control-socket');
  assert.deepEqual(args.slice(at, at + 4), ['--computer-control-socket', win.path, '--computer-control-token-file', win.tokenFile]);
});

test('a packaged Windows app runs its plain python.exe with -I -B before the launcher; the macOS wrapper adds them itself', () => {
  assert.deepEqual([pythonFlags(true, 'windows'), pythonFlags(false, 'windows'), pythonFlags(true, 'mac')], [['-I', '-B'], [], []]);
  const ctx = { launcherScript: '/r/agentd_launcher.py', parentPid: 42, character: '' };
  assert.deepEqual(agentdArguments(config(), { ...ctx, pythonFlags: ['-I', '-B'] }).slice(0, 4), ['-I', '-B', '/r/agentd_launcher.py', '--agentd-dir']);
  assert.equal(agentdArguments(config(), ctx)[0], '/r/agentd_launcher.py');
});

test("the port's owners: lsof's p lines on macOS; on Windows netstat's TCP rows on that local port without a remote one", () => {
  assert.deepEqual(lsofPids('p812\nf9\np913\nf4\n'), [812, 913]);
  assert.deepEqual(lsofPids(''), []);
  const netstat = [
    '', 'Active Connections', '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1060',
    '  TCP    127.0.0.1:49133        0.0.0.0:0              LISTENING       4120',
    '  TCP    127.0.0.1:49133        127.0.0.1:50212        ESTABLISHED     4120',
    '  TCP    127.0.0.1:50212        127.0.0.1:49133        ESTABLISHED     7788',
    '  TCP    127.0.0.1:491330       0.0.0.0:0              LISTENING       9001',
    '  TCP    127.0.0.1:49133        127.0.0.1:50300        TIME_WAIT       0',
    '  TCP    [::1]:49133            [::]:0                 侦听            5230',
    '  UDP    127.0.0.1:49133        *:*                                    6000',
  ].join('\r\n');
  assert.deepEqual(netstatListeners(netstat, 49133), [4120, 5230]);
  assert.deepEqual(netstatListeners(netstat, 49134), []);
  assert.deepEqual(portOwnersCommand(49133, 'darwin').args, ['-nP', '-iTCP:49133', '-sTCP:LISTEN', '-Fp']);
  const windows = portOwnersCommand(49133, 'win32', { SystemRoot: 'C:\\Windows' });
  assert.deepEqual([windows.file, windows.args], ['C:\\Windows\\System32\\netstat.exe', ['-a', '-n', '-o']]);
  assert.deepEqual(windows.pids(netstat), [4120, 5230]);
});

test('portOwners finds this process listening on a port', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.ok((await portOwners(port)).includes(process.pid), `port ${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
