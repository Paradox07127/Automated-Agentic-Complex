// The renderer's supervision (src/main/renderer/supervisor.ts) over small Node scripts, and the host link
// (src/main/renderer/link.ts) and avatar ops against an in-test avatar on a temp socket or named pipe.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { type ChildState, stateText } from '../src/common/agentd.ts';
import { handle } from '../src/common/bridge.ts';
import { decodeLine, type C3Message } from '../src/common/c3.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { loadConfig } from '../src/main/config.ts';
import { avatarOps } from '../src/main/ops/avatar.ts';
import type { OpsContext } from '../src/main/ops/index.ts';
import { HostLink, hostPipePath, hostSocketPath, type LinkEvent } from '../src/main/renderer/link.ts';
import { rendererArguments, RendererSupervisor } from '../src/main/renderer/supervisor.ts';
import { FakeAvatar } from './fake-avatar.ts';

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
async function until(seconds: number, ok: () => boolean): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ok()) return true;
    await sleep(0.02);
  }
  return ok();
}

/** The link listens on a Unix socket here, the macOS transport; on Windows it connects to the renderer's named pipe. */
const UNIX_LINK = process.platform === 'win32' ? "the fake avatar connects to the link's Unix socket, macOS's C3 transport" : false;

/** A fake renderer: a Node script that appends its pid and arguments to `launches`, then runs `body` (JavaScript). */
const fakeRenderer = (launches: string, body: string) =>
  `import { appendFileSync, renameSync, writeFileSync } from 'node:fs';\n`
  + `appendFileSync(${JSON.stringify(launches)}, \`\${process.pid} \${process.argv.slice(2).join(' ')}\\n\`);\n${body}\n`;
/** Keeps a fake renderer running until it is killed. */
const STAY = 'setInterval(() => {}, 1000);';

/** A temp support dir and config.json whose avatar_executable is this Node, which the supervisor gives `prefix` (the fake renderer). */
function setup(body: string, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r-')), support = join(dir, 's');
  mkdirSync(support);
  const script = join(dir, 'avatar.mjs'), launches = join(dir, 'launches');
  writeFileSync(script, fakeRenderer(launches, body));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ characters: [{ id: 'aster', name: '示例甲', avatar_app: join(dir, 'Avatar.app') }], avatar_executable: process.execPath, agentd_dir: dir,
    python: '/usr/bin/false', agentd_port: 1, support_dir: support, agentd_state_dir: join(dir, 'state'), gpu_hold_files: [], ...extra }));
  const config = loadConfig(configPath);
  const states: string[] = [];
  const count = () => (existsSync(launches) ? readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0);
  const prefix = [script];
  const supervisor = (timeScale = 0.01) => new RendererSupervisor({ config, settings: () => ({}), state: () => ({}),
    character: () => 'aster', link: null, captureDir: join(dir, 'captures'), timeScale, prefix,
    onStatus: (s: ChildState) => states.push(stateText(s)) });
  const rewrite = (next: string) => writeFileSync(script, fakeRenderer(launches, next));
  return { dir, config, states, count, supervisor, prefix, rewrite, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the socket path falls back to a per-user /tmp directory past 103 bytes; the pipe path is per support dir', () => {
  assert.equal(hostSocketPath('/Users/a/s', 501), '/Users/a/s/run/avatar.sock');
  const long = `/Users/a/${'x'.repeat(100)}`;
  assert.match(hostSocketPath(long, 501), /^\/tmp\/agentic-complex-501-[0-9a-f]{32}\/avatar\.sock$/);
  assert.equal(hostSocketPath(long, 501), hostSocketPath(`${long}/`, 501));
  assert.match(hostPipePath('C:\\Users\\a\\s'), /^\\\\\.\\pipe\\agentic-complex-[0-9a-f]{32}-avatar$/);
});

test("the renderer's command line: fixed head, remembered state, render settings, avatar_args, socket last", () => {
  const s = setup('', { characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app', avatar_args: ['--character-catalog', '/c.json'] }] });
  try {
    const args = rendererArguments({ config: s.config, character: 'aster', parentPid: 42, startupPath: '/r/startup-1.json',
      socketPath: '/r/avatar.sock', captureDir: '/p',
      settings: { viewport: 'window', battery_low_fps: false, render_camera_yaw: 12.3, render_fps: '45', render_filter: 'bogus', stay_mode: 'bust' },
      state: { last_appearance: { aster: 'toppotential' }, hidden_layers: { aster: ['coat', 'hat'] }, window_scale: { aster: 1.25 } } });
    assert.deepEqual(args.slice(0, 10), ['--agentic-complex-window-level', 'status', '--agentic-complex-parent-pid', '42',
      '--agentic-complex-agentd', `${s.config.agentdStateDir}/events-runtime.json`, '--agentic-complex-character', 'aster',
      '--agentic-complex-startup-status', '/r/startup-1.json']);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(value('--agentic-complex-appearance'), 'toppotential');
    assert.equal(value('--agentic-complex-hidden-layers'), 'coat,hat');
    assert.equal(value('--agentic-complex-viewport'), 'window');
    assert.equal(value('--agentic-complex-scale'), '1.250');
    assert.equal(value('--agentic-complex-battery-low-fps'), '0');
    assert.equal(value('--agentic-complex-camera-yaw'), '12.5');
    assert.equal(value('--agentic-complex-render-fps'), '45');
    assert.equal(value('--agentic-complex-filter'), 'none');
    assert.equal(value('--agentic-complex-camera-framing'), 'bust');
    assert.equal(value('--agentic-complex-capture-dir'), '/p');
    assert.deepEqual(args.slice(-4), ['--character-catalog', '/c.json', '--agentic-complex-host-socket', '/r/avatar.sock']);
    const plain = rendererArguments({ config: s.config, character: 'aster', parentPid: 42, startupPath: '/x', socketPath: null,
      captureDir: '/p', settings: {}, state: {} });
    assert.equal(plain[plain.indexOf('--agentic-complex-viewport') + 1], 'fullscreen');
    for (const flag of ['--agentic-complex-appearance', '--agentic-complex-scale', '--agentic-complex-battery-low-fps',
      '--agentic-complex-host-socket', '--agentic-complex-camera-framing']) assert.ok(!plain.includes(flag), flag);
  } finally {
    s.done();
  }
});

test('on Windows the renderer always gets --agentic-complex-hide-on-screen-capture, off unless the setting is on; macOS never', () => {
  const s = setup('', { characters: [{ id: 'aster', name: '示例甲', avatar_app: '/A.app', avatar_args: ['--package', 'C:\\p'] }] });
  try {
    const args = (platform: 'mac' | 'windows', settings: Record<string, unknown>) => rendererArguments({ config: s.config, character: 'aster',
      parentPid: 42, startupPath: '/x', socketPath: '\\\\.\\pipe\\p', captureDir: '/p', settings, state: {}, platform });
    const flag = '--agentic-complex-hide-on-screen-capture';
    const value = (a: string[]) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : null);
    assert.equal(value(args('windows', {})), '0');
    assert.equal(value(args('windows', { hide_on_screen_capture: false })), '0');
    assert.equal(value(args('windows', { hide_on_screen_capture: true })), '1');
    assert.equal(value(args('mac', { hide_on_screen_capture: true })), null);
    assert.deepEqual(args('mac', {}), rendererArguments({ config: s.config, character: 'aster', parentPid: 42, startupPath: '/x',
      socketPath: '\\\\.\\pipe\\p', captureDir: '/p', settings: {}, state: {} }));
    // The frame package comes through avatar_args; the pipe stays last.
    assert.deepEqual(args('windows', {}).slice(-4), ['--package', 'C:\\p', '--agentic-complex-host-socket', '\\\\.\\pipe\\p']);
  } finally {
    s.done();
  }
});

test('the scene arguments: box passes a pack and its SHA-256, stage the stage id, both only fullscreen', () => {
  const s = setup('');
  try {
    const scene = (id: string) => {
      mkdirSync(join(s.config.supportDir, 'scenes', id), { recursive: true });
      writeFileSync(join(s.config.supportDir, 'scenes', id, 'scene.json'), '{}');
      return join(s.config.supportDir, 'scenes', id, 'scene.json');
    };
    const args = (settings: Record<string, unknown>) => rendererArguments({ config: s.config, character: 'aster', parentPid: 42,
      startupPath: '/x', socketPath: '/r/avatar.sock', captureDir: '/p', settings, state: {} });
    const tail = (settings: Record<string, unknown>) => {
      const a = args(settings);
      return a.slice(a.indexOf('--agentic-complex-capture-dir') + 2, -2);
    };
    // sha256 of "{}".
    const sha = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
    assert.deepEqual(tail({ scene_mode: 'box' }), []);
    scene('zone');
    const alpha = scene('alpha');
    scene('Upper');
    assert.deepEqual(tail({ scene_mode: 'box' }), ['--agentic-complex-scene-pack', alpha, '--agentic-complex-scene-pack-sha256', sha]);
    assert.deepEqual(tail({ scene_mode: 'box', scene_id: 'zone', scene_parallax: false }).slice(3),
      [sha, '--agentic-complex-scene-parallax', '0']);
    assert.deepEqual(tail({ scene_mode: 'box', scene_id: 'Upper' }), []);
    assert.deepEqual(tail({ scene_mode: 'box', scene_id: '../scenes/alpha' }), []);
    assert.deepEqual(tail({ scene_mode: 'box', scene_id: 'missing' }), []);
    assert.deepEqual(tail({ scene_mode: 'box', viewport: 'window' }), []);
    assert.deepEqual(tail({ scene_mode: 'stage' }), ['--agentic-complex-scene-stage', 'charinfo']);
    assert.deepEqual(tail({ scene_mode: 'stage', viewport: 'window' }), []);
    assert.deepEqual(tail({ scene_mode: 'weird' }), []);
    assert.deepEqual(tail({}), []);
    // A scene.json that cannot be read passes nothing.
    rmSync(alpha);
    mkdirSync(alpha);
    assert.deepEqual(tail({ scene_mode: 'box', scene_id: 'alpha' }), []);
  } finally {
    s.done();
  }
});

test('on Windows, without an .app bundle, avatar_executable is required', async () => {
  const s = setup('process.exit(0);');
  try {
    const config = { ...s.config, avatarExecutable: null };
    const r = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => 'aster', link: null,
      captureDir: s.dir, platform: 'windows' });
    r.start();
    assert.deepEqual(r.state, { kind: 'failed', reason: 'config.json 没有 avatar_executable（Windows 上是 efw.exe 的路径）' });
    const mac = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => 'aster', link: null, captureDir: s.dir });
    mac.start();
    assert.deepEqual(mac.state, { kind: 'failed', reason: 'Info.plist 缺少 CFBundleExecutable' });
    assert.equal(s.count(), 0);
  } finally {
    s.done();
  }
});

test('without the renderer component it fails at once and never launches', async () => {
  const s = setup('process.exit(0);', { missing_components: { renderer: 'componentMissing' } });
  try {
    const r = s.supervisor();
    assert.equal(stateText(r.state), 'failed(缺 renderer 组件)');
    r.start();
    r.startIfStopped();
    await sleep(0.3);
    assert.equal(s.count(), 0);
    assert.equal(stateText(r.state), 'failed(缺 renderer 组件)');
  } finally {
    s.done();
  }
});

for (const [status, reason] of [[78, '角色包与程序版本不符'], [69, '无法使用 GPU']] as const) {
  test(`exit ${status} fails with ${reason} and is not restarted`, async () => {
    const s = setup(`process.exit(${status});`);
    try {
      const r = s.supervisor();
      r.start();
      assert.ok(await until(5, () => r.state.kind === 'failed'), `${s.states}`);
      assert.deepEqual(s.states, ['starting', 'running', `failed(${reason})`]);
      assert.deepEqual(r.loading, { kind: 'failed', message: reason });
      await sleep(0.5);
      assert.equal(s.count(), 1);
      assert.deepEqual(readFileSync(join(s.config.supportDir, 'logs/companion.log'), 'utf8').match(/exit child=avatar status=\d+/g),
        [`exit child=avatar status=${status}`]);
    } finally {
      s.done();
    }
  });
}

test('crashes back off 1, 2, 4, 8 and fail after the fifth; a restart starts over', async () => {
  const s = setup('process.exit(1);');
  try {
    const r = s.supervisor();
    r.start();
    assert.ok(await until(10, () => r.state.kind === 'failed'), `${s.states}`);
    assert.deepEqual(s.states.filter((x) => x.startsWith('backoff')), ['backoff(1)', 'backoff(2)', 'backoff(4)', 'backoff(8)']);
    assert.equal(s.states.at(-1), 'failed(300 秒内崩溃 5 次)');
    await sleep(0.5);
    assert.equal(s.count(), 5);
    s.rewrite(STAY);
    await r.restart();
    assert.ok(await until(5, () => r.state.kind === 'running'), `${s.states}`);
    await r.stop();
    assert.equal(r.state.kind, 'stopped');
  } finally {
    s.done();
  }
});

test('two restarts at once start one renderer; stop() leaves none running', async () => {
  const s = setup(STAY);
  const pids = () => (existsSync(join(s.dir, 'launches')) ? readFileSync(join(s.dir, 'launches'), 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0]));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const r = s.supervisor(1);
    r.start();
    assert.ok(await until(5, () => s.count() === 1));
    await Promise.all([r.restart(), r.restart()]);
    await sleep(0.5);
    await r.stop();
    assert.deepEqual(pids().filter(alive), [], `alive after stop() ${pids().filter(alive).length}`);
    assert.equal(s.count(), 2);
  } finally {
    for (const pid of pids().filter(alive)) process.kill(pid, 'SIGKILL');
    s.done();
  }
});

test('a renderer that writes no ready status within the startup deadline is killed and fails without a restart', async () => {
  const s = setup(STAY);
  try {
    const r = s.supervisor();
    r.start();
    assert.ok(await until(10, () => r.state.kind === 'failed'), `${s.states}`);
    assert.equal(s.states.at(-1), 'failed(角色准备超时，请重新启动)');
    await sleep(0.5);
    assert.equal(s.count(), 1);
  } finally {
    s.done();
  }
});

test('startup stages are followed and the ready status hides the loading panel', async () => {
  const s = setup(`const path = process.argv[process.argv.indexOf('--agentic-complex-startup-status') + 1];
const w = (stage) => { writeFileSync(path + '.t', JSON.stringify({ character: 'aster', pid: process.pid, schema: 'endfield-startup/v1', stage })); renameSync(path + '.t', path); };
w('loading_character');
setTimeout(() => w('preparing_graphics'), 300);
setTimeout(() => w('ready'), 600);
${STAY}`);
  try {
    const stages: string[] = [];
    const r = new RendererSupervisor({ config: s.config, settings: () => ({}), state: () => ({}), character: () => 'aster', link: null,
      captureDir: s.dir, prefix: s.prefix, onLoading: (l) => stages.push(l.kind === 'loading' ? l.stage : l.kind) });
    r.start();
    assert.ok(await until(5, () => stages.at(-1) === 'hidden'), `${stages}`);
    assert.deepEqual(stages, ['starting', 'loading_character', 'preparing_graphics', 'hidden']);
    assert.equal(r.state.kind, 'running');
    await r.stop();
    assert.equal(r.state.kind, 'stopped');
  } finally {
    s.done();
  }
});

test('a text-only character or none leaves the renderer stopped', async () => {
  const s = setup('process.exit(0);');
  try {
    const r = new RendererSupervisor({ config: s.config, settings: () => ({}), state: () => ({}), character: () => '', link: null, captureDir: s.dir });
    r.start();
    await sleep(0.2);
    assert.equal(r.state.kind, 'stopped');
    assert.equal(s.count(), 0);
  } finally {
    s.done();
  }
});

test('host link: hello handshake, fps_tier, avatar ops over C3, rule 17 kill, the next connection and a too-long line', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l-'));
  const lines: string[] = [], events: LinkEvent[] = [];
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => lines.push(l) });
  link.on((e) => events.push(e));
  await link.start();
  let avatar: FakeAvatar | undefined, second: FakeAvatar | undefined;
  try {
    assert.ok(link.listening, link.startError ?? '');
    avatar = new FakeAvatar(link.path, true);
    avatar.send({ type: 'heartbeat', seq: 0, click_through: true });
    avatar.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', appearance: 'default', appearances: [{ id: 'default', name: '默认' }],
      capabilities: ['heartbeat', 'ack', 'actions', 'action_loop'], build: { git: 'abc', renderer: 'metal' } });
    assert.ok(await until(2, () => avatar!.got.length >= 2), `${avatar.types()}`);
    assert.deepEqual(avatar.got[0], { v: 1, type: 'hello', role: 'companion', pid: 4242, protocol: 1,
      capabilities: ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings'], build: { version: 't' } });
    assert.deepEqual({ ...avatar.got[1], req: 0 }, { v: 1, type: 'fps_tier', tier: 'working', fps: 30, user_fps: 60, battery_low: true, req: 0 });
    assert.ok(link.connected);
    assert.ok(!events.some((e) => e.kind === 'message' && e.message.type === 'heartbeat'), 'the heartbeat before hello is dropped');
    avatar.send({ type: 'stats', fps: 60, frame_ms_p95: 17.5, gpu_ms: 3 });
    avatar.send({ type: 'placement', x: 10, y: 20, scale: 1.5, display_id: 1, reason: 'start' });

    const ctx = { surface: 'main', routes, config: { path: '', supportDir: null, devResources: null }, supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {},
      avatar: () => ({ kind: 'running' }) }, avatar: link, library: { launched: 'aster' } } as unknown as OpsContext;
    const ops = new Map(Object.entries(avatarOps(ctx))), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
    const heartbeats = setInterval(() => avatar!.send({ type: 'heartbeat', seq: 1, click_through: false }), 100);
    try {
      assert.ok(await until(2, () => link.lastPlacement !== null));
      assert.deepEqual(await call('avatar.state'), { ok: true, value: { running: true, visible: true, scale: 1.5, clickThroughAll: false,
        speaking: false, characterId: 'aster', appearanceId: 'default' } });
      assert.deepEqual(await call('avatar.details'), { ok: true, value: { renderer: 'metal', build: 'abc', pipeline: null,
        placement: { x: 10, y: 20, scale: 1.5 }, photo: false, capture: false, filters: false } });
      const actions = await call('avatar.actions') as { ok: true; value: Record<string, unknown>[] };
      assert.deepEqual(actions.value.map((a) => [a.id, a.enabled, a.playable, a.defaultEnabled, a.requiredReason ?? null]),
        [['wave', true, true, true, null], ['walk', true, false, false, '移动']]);
      assert.deepEqual(actions.value[1]!.media, { bgm: false, face: true, camera: false });
      assert.deepEqual(await call('avatar.playAction', 'wave', 1, { loop: true }), { ok: true, value: null });
      const play = avatar.got.find((m) => m.type === 'play_action')!;
      assert.deepEqual({ ...play, play_id: '' }, { v: 1, type: 'play_action', play_id: '', character: 'aster', id: 'wave', speed: 1, loop: true });
      assert.deepEqual(await call('avatar.stopAction'), { ok: true, value: null });
      assert.ok(await until(1, () => avatar!.types().includes('stop_action')));
      assert.deepEqual(avatar.got.find((m) => m.type === 'stop_action'), { v: 1, type: 'stop_action', play_id: play.play_id });
      assert.deepEqual(await call('avatar.playAction', 'walk', 2), { ok: false, error: { code: 'not_playable', detail: '这个动作不能单独播' } });
      assert.deepEqual(await call('avatar.playAction', 'wave', 3), { ok: false, error: { code: 'invalid_args',
        detail: 'action id, speed 0.5, 1 or 2, and {loop?}' } });
      assert.deepEqual(await call('avatar.setVisible', false), { ok: true, value: null });
      assert.ok(await until(1, () => avatar!.got.some((m) => m.type === 'fps_tier' && m.tier === 'paused')));
      assert.equal(avatar.got.find((m) => m.type === 'set_visible')?.visible, false);
      assert.equal(((await call('avatar.state')) as { value: { visible: boolean } }).value.visible, false);
      assert.deepEqual(await call('avatar.stopSpeech'), { ok: true, value: null });
      assert.ok(await until(1, () => avatar!.types().includes('stop_speech')));
      assert.deepEqual(avatar.got.find((m) => m.type === 'stop_speech'), { v: 1, type: 'stop_speech', reason: 'barge_in' });
      assert.ok(link.sendQuit('restart'));
      assert.ok(await until(1, () => avatar!.types().includes('quit')));
      assert.deepEqual(avatar.got.at(-1), { v: 1, type: 'quit', reason: 'restart' });
      await call('avatar.setVisible', true);
    } finally {
      clearInterval(heartbeats);
    }
    // Clicked through now, then hidden: shown again, the last heartbeat takes the mouse, so 0.8 s of silence kills.
    avatar.send({ type: 'heartbeat', seq: 2, click_through: false });
    assert.ok(await until(3, () => events.some((e) => e.kind === 'watchdog')), lines.join('\n'));
    assert.deepEqual(events.find((e) => e.kind === 'watchdog'), { kind: 'watchdog', pid: 99, reason: 'heartbeat_timeout' });

    // The killed renderer's connection closes before the restarted one says hello.
    avatar.socket.destroy();
    assert.ok(await until(2, () => events.some((e) => e.kind === 'lost')), lines.join('\n'));
    second = new FakeAvatar(link.path, true);
    second.send({ type: 'hello', role: 'avatar', pid: 100, protocol: 1, character: 'cedar', capabilities: [] });
    assert.ok(await until(2, () => link.hello?.pid === 100), lines.join('\n'));
    assert.equal(link.currentCharacter, 'cedar');
    assert.deepEqual(await call2(link, 'avatar.actions'), { ok: false, error: { code: 'not_implemented', detail: '这个版本的角色不支持动作设置' } });
    second.socket.write(`${'x'.repeat(70000)}\n`);
    assert.ok(await until(2, () => !link.connected), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('行超过 65536 字节')), lines.join('\n'));
  } finally {
    avatar?.socket.destroy();
    second?.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host link: a new connection numbers its req from 1 again and does not inherit the last connection\'s placement', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {} });
  await link.start();
  const avatars: FakeAvatar[] = [];
  const attach = async () => {
    avatars.at(-1)?.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    const a = new FakeAvatar(link.path, true);
    avatars.push(a);
    a.send({ type: 'hello', role: 'avatar', pid: 99 + avatars.length, protocol: 1, capabilities: ['ack', 'placement'] });
    assert.ok(await until(2, () => a.types().includes('fps_tier')), `${a.types()}`);
    return a;
  };
  try {
    const first = await attach();
    assert.ok(link.sendMoveWindow(1, 2));
    first.send({ type: 'placement', x: 10, y: 20, scale: 1.5, display_id: 1, reason: 'start' });
    assert.ok(await until(1, () => link.lastPlacement !== null && first.types().includes('move_window')));
    assert.deepEqual(first.got.map((m) => m.req ?? null), [null, 1, 2]);

    const second = await attach();
    assert.equal(link.hello?.pid, 101);
    assert.equal(link.lastPlacement, null, 'the closed renderer\'s placement is not this one\'s');
    assert.equal(((await call2(link, 'avatar.state')) as { value: { scale: number } }).value.scale, 1);
    assert.ok(link.sendSetPlacement({ scale: 1.25 }));
    assert.ok(await until(1, () => second.types().includes('set_placement')));
    assert.deepEqual(second.got.map((m) => [m.type, m.req ?? null]), [['hello', null], ['fps_tier', 1], ['set_placement', 2]]);
    second.send({ type: 'placement', x: 5, y: 6, scale: 1.25, display_id: 1, reason: 'set_placement' });
    assert.ok(await until(1, () => link.lastPlacement?.scale === 1.25));

    second.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    assert.equal(link.lastPlacement, null, 'no placement without a renderer');
  } finally {
    for (const a of avatars) a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host link: stats belong to their connection; the next renderer and a dropped one leave none', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 's-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {} });
  await link.start();
  const avatars: FakeAvatar[] = [];
  const attach = async () => {
    avatars.at(-1)?.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    const a = new FakeAvatar(link.path, true);
    avatars.push(a);
    a.send({ type: 'hello', role: 'avatar', pid: 99 + avatars.length, protocol: 1, capabilities: [] });
    assert.ok(await until(2, () => link.hello?.pid === 99 + avatars.length));
    return a;
  };
  try {
    const first = await attach();
    first.send({ type: 'stats', fps: 60, frame_ms_p95: 17.5, gpu_ms: 3 });
    assert.ok(await until(1, () => link.lastStats?.fps === 60));
    const second = await attach();
    assert.equal(link.lastStats, null, 'the closed renderer\'s stats are not this one\'s');
    second.send({ type: 'stats', fps: 30, frame_ms_p95: null, gpu_ms: null });
    assert.ok(await until(1, () => link.lastStats?.fps === 30));
    second.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    assert.equal(link.lastStats, null, 'no stats without a renderer');
  } finally {
    for (const a of avatars) a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host link: cursor, pointer and point_at, the paused tier, and trace, receipts and motion requests forwarded', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c-'));
  let at = { x: 1150, y: 1200 };
  const traces: unknown[] = [], receipts: Record<string, unknown>[] = [], motions: unknown[] = [], lines: string[] = [];
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => lines.push(l), cursor: () => at, traceEpoch: () => 77,
    onTrace: (e) => traces.push(e), onBehaviorReceipt: (r) => receipts.push(r), onMotionRequest: (m) => motions.push(m) });
  await link.start();
  const avatar = new FakeAvatar(link.path, true);
  try {
    avatar.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, capabilities: ['pointer', 'motion_requests', 'turn_generation'] });
    assert.ok(await until(2, () => avatar.types().includes('fps_tier')));
    assert.deepEqual(avatar.got[0]!.capabilities, ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings',
      'trace', 'behavior_receipt', 'pointer', 'motion_requests']);
    assert.equal(avatar.got[0]!.trace_epoch, 77);
    // No cursor before a window_frame; then window points, `hit` on her global capsule.
    await sleep(0.2);
    assert.ok(!avatar.types().includes('cursor'));
    avatar.send({ type: 'window_frame', frame: { x: 1000, y: 1000, w: 300, h: 400 }, viewport: 'window' });
    avatar.send({ type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] });
    const cursors = () => avatar.got.filter((m) => m.type === 'cursor');
    assert.ok(await until(1, () => cursors().some((m) => m.hit === true)), JSON.stringify(cursors()));
    assert.deepEqual(cursors().find((m) => m.hit === true), { v: 1, type: 'cursor', x: 150, y: 200, inside: true, hit: true });
    assert.ok(await until(1, () => avatar.got.some((m) => m.type === 'pointer' && m.hover_ms as number > 0)));
    // Rule 14: switching pins `hit` false; still, `cursor` goes out at least every 100 ms.
    link.sendSetCharacter('cedar', null);
    const before = cursors().length;
    await sleep(0.35);
    assert.ok(cursors().length - before >= 2, `${cursors().length - before} cursors in 0.35 s`);
    assert.equal(cursors().at(-1)!.hit, false);
    at = { x: 0, y: 0 };
    assert.ok(await until(1, () => cursors().at(-1)!.inside === false));

    assert.ok(link.sendPointAt('n1', { x: -40, y: 100, w: 200, h: 60 }));
    assert.ok(link.stopSpeech(7));
    assert.ok(link.setSystemPaused(true));
    assert.ok(await until(1, () => avatar.got.some((m) => m.type === 'fps_tier' && m.tier === 'paused')));
    assert.ok(link.setSystemPaused(false));
    assert.ok(await until(1, () => avatar.got.filter((m) => m.type === 'fps_tier').at(-1)!.tier === 'working'));
    assert.deepEqual(avatar.got.find((m) => m.type === 'point_at'), { v: 1, type: 'point_at', nudge_id: 'n1', kind: 'alert',
      rect: { x: -40, y: 100, w: 200, h: 60 } });
    assert.deepEqual(avatar.got.find((m) => m.type === 'stop_speech'), { v: 1, type: 'stop_speech', reason: 'barge_in', turn_generation: 7 });

    const event = { v: 1, producer: 'avatar', producer_epoch: 77, seq: 1, kind: 'k', event_id: 'e', trace_id: 't', t_wall: 'w', status: 'ok',
      t_mono_ms: 5, attrs: {} };
    avatar.send({ type: 'trace', events: [event, { ...event, producer_epoch: 1 }] });
    avatar.send({ type: 'behavior_receipt', behavior_id: 'b-1', phase: 'running', reason: null, at_ms: 1, turn_generation: 3 });
    avatar.send({ type: 'behavior_receipt', behavior_id: 'b-2', phase: 'blocked', reason: '', at_ms: 1, turn_generation: 3 });
    avatar.send({ type: 'motion_request', request_id: 'mr-0123456789abcdef', behavior_id: 'b-1', kind: 'walk', seconds: 3,
      geometry: { to: [-1.2, 0], end_yaw: 0 } });
    assert.ok(await until(1, () => motions.length === 1));
    assert.deepEqual(traces, [[event]]);
    assert.deepEqual(receipts, [{ behavior_id: 'b-1', phase: 'running', reason: null, at_ms: 1, turn_generation: 3 }]);
    assert.ok(lines.includes('rejected trace event index=1 seq=1 why=producer_epoch') && lines.includes('rejected type=behavior_receipt why=reason'),
      lines.join('\n'));
    // Rule 25: the open behavior ends as connection_lost with the link.
    avatar.socket.destroy();
    assert.ok(await until(2, () => receipts.length === 2));
    assert.deepEqual({ ...receipts[1], at_ms: 0 }, { behavior_id: 'b-1', phase: 'cancelled', reason: 'connection_lost', at_ms: 0, turn_generation: 3 });
  } finally {
    avatar.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host link: characterSwitching while a set_character waits for its reply; lastCursorHit is the last cursor sent\'s hit', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-'));
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, cursor: () => ({ x: 1150, y: 1200 }) });
  await link.start();
  const avatar = new FakeAvatar(link.path, true);
  try {
    assert.equal(link.characterSwitching, false);
    assert.equal(link.lastCursorHit, false);
    avatar.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, character: 'aster', capabilities: [] });
    assert.ok(await until(2, () => avatar.types().includes('fps_tier')));
    avatar.send({ type: 'window_frame', frame: { x: 1000, y: 1000, w: 300, h: 400 }, viewport: 'window' });
    avatar.send({ type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] });
    const cursors = () => avatar.got.filter((m) => m.type === 'cursor');
    assert.ok(await until(1, () => link.lastCursorHit));
    assert.equal(cursors().at(-1)!.hit, true);
    link.sendSetCharacter('cedar', null);
    assert.equal(link.characterSwitching, true);
    // Rule 14: switching sends `hit` false.
    assert.ok(await until(1, () => !link.lastCursorHit));
    assert.equal(cursors().at(-1)!.hit, false);
    avatar.send({ type: 'character_changed', id: 'cedar', ms: 100 });
    assert.ok(await until(1, () => !link.characterSwitching));
    avatar.send({ type: 'hit_capsules', space: 'global', capsules: [{ a: [1150, 1100], b: [1150, 1300], r: 40 }] });
    assert.ok(await until(1, () => link.lastCursorHit));
    avatar.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    assert.equal(link.lastCursorHit, false);
  } finally {
    avatar.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The Windows renderer's end of C3: it owns the pipe (a Unix socket off Windows, which the link dials the same way). */
class PipeRenderer {
  readonly server: Server;
  readonly got: C3Message[][] = [];
  socket: Socket | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private frames = 0;
  readonly path: string;
  private readonly pid: () => number;
  constructor(path: string, pid: () => number) {
    this.path = path;
    this.pid = pid;
    this.server = createServer((socket) => {
      this.socket = socket;
      const got: C3Message[] = [];
      this.got.push(got);
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', (d) => {
        buffer += d.toString();
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const m = decodeLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (m) got.push(m);
        }
      });
      // efw's order: the hello as soon as the link connects, then a heartbeat every 100 ms.
      this.send({ type: 'hello', role: 'avatar', pid: this.pid(), protocol: 1, character: 'aster',
        capabilities: ['heartbeat', 'render_progress', 'ack', 'actions', 'action_loop', 'pipeline'], build: { git: 'unknown', renderer: 'd3d11' } });
      this.send({ type: 'pipeline', renderer: 'd3d11', clip: 'idle' });
      this.heartbeats(true);
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }
  send(m: Record<string, unknown>): void {
    this.socket?.write(`${JSON.stringify({ v: 1, ...m })}\n`);
  }
  /** Heartbeats every 100 ms, clicked through as efw's always are; false stops them. */
  heartbeats(on: boolean, clickThrough = true): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = on ? setInterval(() => this.send({ type: 'heartbeat', seq: 1, click_through: clickThrough, render: 'active', frames: ++this.frames }), 100) : null;
  }
  close(): void {
    this.heartbeats(false);
    this.socket?.destroy();
    this.server.close();
  }
}

test('pipe link: dials until the renderer\'s pipe is there, handshakes, keeps the watchdog fed, and after a drop dials again for a new hello', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\e6b-test-${process.pid}-${Date.now()}` : join(dir, 'avatar.pipe');
  const lines: string[] = [], events: LinkEvent[] = [];
  const link = new HostLink({ path, transport: 'pipe', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => lines.push(l) });
  link.on((e) => events.push(e));
  let pid = 700;
  const renderer = new PipeRenderer(path, () => pid);
  try {
    await link.start();
    assert.ok(link.listening);
    // Nothing to dial yet: the link keeps trying every 0.5 s.
    await sleep(0.7);
    assert.ok(!link.connected);
    await renderer.listen();
    assert.ok(await until(2, () => link.connected), lines.join('\n'));
    assert.equal(link.hello?.pid, 700);
    assert.equal(link.lastPipeline?.renderer, 'd3d11');
    assert.ok(await until(1, () => (renderer.got[0]?.length ?? 0) >= 2));
    assert.deepEqual(renderer.got[0]![0], { v: 1, type: 'hello', role: 'companion', pid: 4242, protocol: 1,
      capabilities: ['capsules_global', 'watchdog', 'actions', 'keep_clear', 'action_loop', 'layers', 'mod_settings'], build: { version: 't' } });
    assert.equal(renderer.got[0]![1]!.type, 'fps_tier');
    // Heartbeats keep the watchdog quiet.
    await sleep(1.2);
    assert.ok(!events.some((e) => e.kind === 'watchdog'), lines.join('\n'));
    assert.ok(link.sendQuit('test'));
    assert.ok(await until(1, () => renderer.got[0]!.some((m) => m.type === 'quit')));

    // The renderer drops the connection and keeps the pipe; the link dials again and the next hello is a new handshake.
    pid = 701;
    renderer.socket!.destroy();
    assert.ok(await until(1, () => events.some((e) => e.kind === 'lost')), lines.join('\n'));
    assert.ok(await until(2, () => link.connected && link.hello?.pid === 701), lines.join('\n'));
    assert.equal(renderer.got.length, 2);
    assert.ok(await until(1, () => renderer.got[1]!.some((m) => m.type === 'hello')));

    // Rule 17: a renderer that takes the mouse and then goes silent is reported to the supervisor.
    renderer.heartbeats(false);
    renderer.send({ type: 'heartbeat', seq: 2, click_through: false, render: 'idle', frames: 0 });
    assert.ok(await until(3, () => events.some((e) => e.kind === 'watchdog')), lines.join('\n'));
    assert.deepEqual(events.find((e) => e.kind === 'watchdog'), { kind: 'watchdog', pid: 701, reason: 'heartbeat_timeout' });
  } finally {
    link.stop();
    renderer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipe link: after stop it dials no more', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\e6b-test-${process.pid}-${Date.now()}` : join(dir, 'avatar.pipe');
  const link = new HostLink({ path, transport: 'pipe', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {} });
  const renderer = new PipeRenderer(path, () => 1);
  try {
    await link.start();
    await sleep(0.2);
    link.stop();
    await renderer.listen();
    await sleep(1.2);
    assert.equal(renderer.got.length, 0);
    assert.ok(!link.connected);
  } finally {
    link.stop();
    renderer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function call2(link: HostLink, op: string, ...args: unknown[]) {
  const ctx = { surface: 'main', routes, config: { path: '', supportDir: null, devResources: null }, supervisor: null, avatar: link, library: null } as unknown as OpsContext;
  return handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, new Map(Object.entries(avatarOps(ctx))), new PageSession(() => {}));
}

test('HostLinkTests+PlacementAndHit: set_placement and move_window carry a req; set_placement needs `placement`', { skip: UNIX_LINK }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'l-'));
  const lines: string[] = [];
  const link = new HostLink({ path: join(dir, 'run/avatar.sock'), transport: 'unix', pid: 4242, build: { version: 't' },
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (l) => lines.push(l) });
  await link.start();
  const avatars: FakeAvatar[] = [];
  const connectV9 = async (capabilities: string[]) => {
    avatars.at(-1)?.socket.destroy();
    assert.ok(await until(2, () => !link.connected));
    const a = new FakeAvatar(link.path, true);
    avatars.push(a);
    a.send({ type: 'hello', role: 'avatar', pid: 99, protocol: 1, capabilities });
    assert.ok(await until(2, () => a.types().includes('fps_tier')), `${a.types()}`);
    return a;
  };
  try {
    assert.equal(link.sendSetPlacement({ x: 1200, y: 70 }), false, 'no avatar yet');
    const plain = await connectV9(['ack']);
    assert.equal(link.sendSetPlacement({ x: 1200, y: 70, scale: 1 }), false, 'the avatar does not list placement');
    assert.ok(link.sendMoveWindow(100, 24));
    assert.ok(await until(1, () => plain.types().includes('move_window')));
    assert.equal(plain.got.find((m) => m.type === 'fps_tier')?.req, 1);
    assert.deepEqual(plain.got.find((m) => m.type === 'move_window'), { v: 1, type: 'move_window', x: 100, y: 24, req: 2 });

    const v9 = await connectV9(['ack', 'placement']);
    v9.replies = false;
    assert.equal(link.sendSetPlacement({ x: 1200 }), false, 'x and y go together');
    assert.equal(link.sendSetPlacement({}), false, 'at least one field');
    assert.ok(link.sendSetPlacement({ x: 1200, y: 70 }));
    assert.ok(link.sendSetPlacement({ scale: 1.5 }));
    assert.ok(await until(1, () => v9.got.filter((m) => m.type === 'set_placement').length === 2));
    const [move, resize] = v9.got.filter((m) => m.type === 'set_placement');
    assert.deepEqual([move, resize], [{ v: 1, type: 'set_placement', x: 1200, y: 70, req: 2 }, { v: 1, type: 'set_placement', scale: 1.5, req: 3 }]);
    v9.send({ type: 'ack', req: 2, ok: true });
    v9.send({ type: 'ack', req: 3, ok: false, error: 'busy' });
    assert.ok(await until(1, () => lines.some((l) => l.includes('ack type=set_placement req=3 error=busy'))), lines.join('\n'));

    const bare = await connectV9(['placement']);
    assert.ok(link.sendSetPlacement({ scale: 0.75 }));
    assert.ok(link.sendMoveWindow(5, 6));
    assert.ok(await until(1, () => bare.types().includes('move_window')));
    assert.deepEqual(bare.got.filter((m) => ['set_placement', 'move_window'].includes(m.type)).map((m) => m.type), ['set_placement', 'move_window']);

    // Rule 19's limits: a rejected placement is logged and not kept.
    for (const bad of [{ scale: 3 }, { display_id: 0 }, { reason: 'teleport' }, { x: 1e9 }]) {
      bare.send({ type: 'placement', x: 1200, y: 70, scale: 1, display_id: 1, reason: 'drag', ...bad });
    }
    bare.send({ type: 'placement', x: 1200.5, y: 70, scale: 1.25, display_id: 69733248, reason: 'drag' });
    assert.ok(await until(1, () => link.lastPlacement !== null));
    assert.deepEqual(link.lastPlacement, { v: 1, type: 'placement', x: 1200.5, y: 70, scale: 1.25, display_id: 69733248, reason: 'drag' });
    assert.deepEqual(lines.filter((l) => l.startsWith('rejected type=placement')),
      ['rejected type=placement why=scale', 'rejected type=placement why=display_id', 'rejected type=placement why=reason',
        'rejected type=placement why=coordinate']);
  } finally {
    for (const a of avatars) a.socket.destroy();
    link.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
