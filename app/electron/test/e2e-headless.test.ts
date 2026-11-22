// The headless e2e gate: the main process's
// supervision without a window over app/Tests/Fixtures/HeadlessE2E — agentd from this checkout through
// agentd_e2e_launcher.py, the fake TTS, and mock_host.py as the import's validating host and, in the renderer scenarios, as the
// renderer the main process supervises over C3. Skipped unless AAC_ELECTRON_E2E=1.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { type ChildState, stateText } from '../src/common/agentd.ts';
import { handle } from '../src/common/bridge.ts';
import { menuLines, rendererPreflight } from '../src/common/components.ts';
import { type Config, launchCharacter } from '../src/common/config.ts';
import { PageSession } from '../src/common/page.ts';
import type { ScreenInfo } from '../src/common/placement.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { AgentdClient, health } from '../src/main/agentd/client.ts';
import { AgentdSupervisor } from '../src/main/agentd/supervisor.ts';
import { lastCharacter, loadConfig } from '../src/main/config.ts';
import { readPlacements, readState } from '../src/main/placement/store.ts';
import { agentdOps } from '../src/main/ops/agentd.ts';
import { avatarOps } from '../src/main/ops/avatar.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { characterOps } from '../src/main/ops/character.ts';
import { CharacterSwitch } from '../src/common/switch.ts';
import { AvatarLooks, linkSwitchPorts, rememberedLooks } from '../src/main/renderer/looks.ts';
import { supervisorOps } from '../src/main/ops/supervisor.ts';
import { AvatarPlacer } from '../src/main/placement/controller.ts';
import { HelperSupervisor } from '../src/main/helper/supervisor.ts';
import { helperExecutable } from '../src/main/platform/index.ts';
import { HostLink, hostPipePath, hostSocketPath } from '../src/main/renderer/link.ts';
import { RendererSupervisor } from '../src/main/renderer/supervisor.ts';
import { e2ePort } from './port.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURES = join(REPO, 'app/Tests/Fixtures/HeadlessE2E');
const SKIP = process.env.AAC_ELECTRON_E2E === '1' ? false : 'AAC_ELECTRON_E2E is not set';
const E2E_PORT = await e2ePort();
/** Why a renderer scenario does not run on Windows. */
const MOCK_RENDERER = 'mock_host.py runs as the renderer through a #!/bin/sh wrapper and connects to the Unix socket, both macOS only';
/** The Windows renderer and a frame package for it, from the gate (electron-e2e-win); the scenario that uses them says why it skips. */
const EFW = process.env.AAC_EFW ? resolve(process.env.AAC_EFW) : '';
const EFW_PACKAGE = process.env.AAC_EFW_PACKAGE ? resolve(process.env.AAC_EFW_PACKAGE) : '';
const REAL_EFW = !existsSync(EFW) ? `no efw.exe at AAC_EFW (${EFW || 'unset'}); private\\renderer\\windows\\run.bat builds it`
  : !existsSync(join(EFW_PACKAGE, 'vulkan', 'frame.bin')) ? `no vulkan/frame.bin in the character directory at AAC_EFW_PACKAGE (${EFW_PACKAGE || 'unset'})` : false;
/** A character library whose default character's bundle entry has `vulkan_frame`, from the gate (electron-e2e-win). */
const EFW_LIBRARY = process.env.AAC_EFW_LIBRARY ? resolve(process.env.AAC_EFW_LIBRARY) : '';
const REAL_EFW_LIBRARY = !existsSync(EFW) ? `no efw.exe at AAC_EFW (${EFW || 'unset'}); private\\renderer\\windows\\run.bat builds it`
  : !existsSync(EFW_LIBRARY) ? `no library current.json at AAC_EFW_LIBRARY (${EFW_LIBRARY || 'unset'})` : false;
/** A library of two characters whose bundle entries have `vulkan_frame`, from the gate (electron-e2e-win); the first is its default. */
const EFW_LIBRARY_TWO = process.env.AAC_EFW_LIBRARY_TWO ? resolve(process.env.AAC_EFW_LIBRARY_TWO) : '';
/** The complete library (every file its inventories list), put on the host once (`winhost.py put --shared`), from the gate (electron-e2e-win). */
const EFW_LIBRARY_FULL = process.env.AAC_EFW_LIBRARY_FULL ? resolve(process.env.AAC_EFW_LIBRARY_FULL) : '';
const FULL_LIBRARY = existsSync(EFW_LIBRARY_FULL);
/** The switch scenario's library: the complete one when the host has it, else the two-character one. */
const SWITCH_LIBRARY = FULL_LIBRARY ? EFW_LIBRARY_FULL : EFW_LIBRARY_TWO;
const REAL_SWITCH_LIBRARY = !existsSync(EFW) ? `no efw.exe at AAC_EFW (${EFW || 'unset'}); private\\renderer\\windows\\run.bat builds it`
  : !existsSync(SWITCH_LIBRARY) ? `no library current.json at AAC_EFW_LIBRARY_FULL (${EFW_LIBRARY_FULL || 'unset'}) or AAC_EFW_LIBRARY_TWO (${EFW_LIBRARY_TWO || 'unset'})`
  : !existsSync(process.env.AGENTD_PYTHON ?? '') ? `no agentd Python at AGENTD_PYTHON (${process.env.AGENTD_PYTHON || 'unset'})` : false;
/** Where the shell looks for the platform helper; helper-win builds it there before this suite. */
const HELPER = helperExecutable(resolve(REPO, 'app'));
const REAL_HELPER = existsSync(HELPER) ? false : `no ac-helper.exe at ${HELPER}; app\\helpers\\windows\\build.bat builds it`;
/** agentd launches, imports and starts its stores before it answers ready. */
const START_TIMEOUT = 30;

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Polls `ok` every 0.1 s until it holds or `seconds` pass; returns its last answer. */
async function until(seconds: number, ok: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await ok()) return true;
    await sleep(0.1);
  }
  return ok();
}

/** The one display of the placement scenario, its id the one mock_host.py reports. */
const SCREEN: ScreenInfo = { id: 7, frame: { x: 0, y: 0, w: 1440, h: 900 }, visibleFrame: { x: 0, y: 70, w: 1440, h: 805 } };

const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;

/** The pieces index.ts wires, over one temp directory: config.json, the agentd supervisor, the renderer's state, the ops. */
class Stack {
  readonly port = E2E_PORT;
  readonly dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  readonly support = join(this.dir, 'support');
  readonly stateDir = join(this.dir, 'state');
  readonly configPath = join(this.dir, 'config.json');
  // Windows has no bash; the gate gives the host's Python as AGENTD_PYTHON.
  readonly python = process.platform === 'win32' ? process.env.AGENTD_PYTHON!
    : execFileSync('bash', [join(REPO, 'tools/platform/agentd-python.sh')], { encoding: 'utf8' }).trim();
  readonly mockHost = join(this.dir, 'mock_host');
  readonly states: string[] = [];
  config!: Config;
  supervisor!: AgentdSupervisor;
  renderer!: ChildState;
  /** Set by `superviseRenderer`: the host link and the renderer's supervisor as index.ts wires them. */
  link: HostLink | undefined;
  avatar: RendererSupervisor | undefined;
  placer: AvatarPlacer | undefined;
  looks: AvatarLooks | undefined;
  switcher: CharacterSwitch | undefined;
  readonly avatarStates: string[] = [];
  /** index.ts's agentd status hook beside the states. */
  private onAgentd: ((s: ChildState) => void) | undefined;
  private tts: ChildProcess | undefined;

  /**
   * `missing` goes into config.json as `missing_components`, as a packaged launch writes it; `catalog` as `character_catalog`;
   * `config` over the rest.
   */
  async init(options: { missing?: Record<string, string>; catalog?: string; config?: Record<string, unknown> } = {}): Promise<this> {
    mkdirSync(join(this.support, 'run'), { recursive: true });
    // The supervisor passes it to agentd as --tts-token-file.
    writeFileSync(join(this.support, 'tts-token'), 'e2e\n', { mode: 0o600 });
    process.env.E2E_AGENTD_FAULTS = join(this.dir, 'agentd-faults.json');
    // Without a catalog agentd reads the agentd test library, whose ids the tests use.
    process.env.AGENTD_DEV_CATALOG = join(REPO, 'agent/agentd/tests/fixtures/characters/current.json');
    this.tts = spawn(this.python, ['-I', join(FIXTURES, 'fake_tts.py'), '--port-file', join(this.dir, 'tts.port'),
      '--log', join(this.dir, 'tts.jsonl')], { stdio: 'ignore' });
    const portFile = join(this.dir, 'tts.port');
    assert.ok(await until(5, () => existsSync(portFile) && readFileSync(portFile, 'utf8').trim() !== ''), 'fake_tts.py wrote no port');
    // mock_host.py is not executable in the checkout.
    writeFileSync(this.mockHost, `#!/bin/sh\nexec '${this.python}' -I '${FIXTURES}/mock_host.py' "$@"\n`);
    chmodSync(this.mockHost, 0o700);
    writeFileSync(this.configPath, JSON.stringify({
      avatar_app: join(this.dir, 'Avatar.app'), characters: [{ id: 'aster', name: '示例甲', avatar_app: join(this.dir, 'Avatar.app') }],
      avatar_executable: this.mockHost, agentd_dir: join(REPO, 'agent/agentd'),
      python: this.python, agentd_port: this.port, gpu_hold_files: [], support_dir: this.support, agentd_state_dir: this.stateDir,
      voice_service: 'remote', tts_url: `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`, tts_tunnel_host: '',
      share_page_text: false, share_window_text: false, share_screenshots: false, voice_hotkey: '', hotkey_quick_input: '',
      onboarding_done: true, viewport: 'window', plugins: { screen_awareness: false },
      ...(options.missing ? { missing_components: options.missing } : {}),
      ...(options.catalog ? { character_catalog: options.catalog } : {}),
      ...options.config,
    }));
    this.config = loadConfig(this.configPath);
    this.supervisor = new AgentdSupervisor({
      config: this.config, launcherScript: join(FIXTURES, 'agentd_e2e_launcher.py'),
      character: launchCharacter(this.config, undefined), privacyConfigPath: this.configPath,
      onStatus: (s) => {
        this.states.push(stateText(s));
        this.onAgentd?.(s);
      },
    });
    // The renderer is not launched here: it stays stopped unless a component or the library is missing.
    this.renderer = rendererPreflight(this.config) ?? { kind: 'stopped' };
    return this;
  }

  /** Faults for agentd_e2e_launcher.py, keyed by launch number or "*"; written before `start()`. */
  faults(faults: Record<string, Record<string, unknown>>): void {
    writeFileSync(process.env.E2E_AGENTD_FAULTS!, JSON.stringify(faults));
  }

  start(): void {
    this.supervisor.start();
  }

  /** index.ts's renderer wiring over mock_host.py: started beside agentd, and again when agentd comes up and it is stopped. */
  async superviseRenderer(viewport = 'window'): Promise<void> {
    const support = this.config.supportDir;
    const log = (line: string) => writeFileSync(join(this.dir, 'hostlink.log'), `${line}\n`, { flag: 'a' });
    this.link = new HostLink({ path: hostSocketPath(support, process.getuid!()), transport: 'unix', pid: process.pid, build: { version: 'e2e' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log, remembered: rememberedLooks(support, this.configPath) });
    const link = this.link;
    // One display whose C3 coordinates are the placement space, as on a Mac.
    const placer = this.placer = new AvatarPlacer({ link: this.link, supportDir: support, stayInPlace: () => false, keyIdle: () => 60,
      mainWindow: () => null, log, space: { screens: () => [SCREEN], fromDip: () => SCREEN.frame, rectFromC3: (r) => r, rectToC3: (r) => r,
        pointFromC3: (p) => p, pointToC3: (p) => p } });
    placer.start();
    this.avatar = new RendererSupervisor({ config: this.config,
      settings: () => ({ ...JSON.parse(readFileSync(this.configPath, 'utf8')) as Record<string, unknown>, viewport }), state: () => readState(support),
      character: () => launchCharacter(this.config, lastCharacter(support)), placement: (c) => placer.launchPlacement(c), link: this.link,
      captureDir: join(this.dir, 'captures'),
      onStatus: (s) => {
        this.avatarStates.push(stateText(s));
        this.renderer = s;
      } });
    const avatar = this.avatar;
    this.link.on((e) => { if (e.kind === 'watchdog' && e.pid === avatar.pid) avatar.kill(e.reason); });
    // index.ts's switch and looks over the link and this agentd.
    this.looks = new AvatarLooks({ link, supportDir: support, configPath: this.configPath, log });
    this.looks.start();
    const client = new AgentdClient(this.runtimePath);
    const switcher = this.switcher = new CharacterSwitch(linkSwitchPorts({ link, supportDir: support,
      agentd: (method, path, json) => client.request(method, path, json), agentdRunning: () => this.supervisor.state.kind === 'running',
      restartAvatar: () => { void avatar.restart(); }, renderable: (id) => this.config.characters.find((c) => c.id === id)?.renderEnabled !== false,
      log }));
    this.link.on((e) => { if (e.kind === 'character') switcher.avatar(e.event); });
    await this.link.start();
    avatar.start();
    this.onAgentd = (s) => {
      if (s.kind !== 'running') return;
      avatar.startIfStopped();
      void switcher.agentdReady();
    };
  }

  /** Each launch's C3 traffic as mock_host.py recorded it, heartbeats left out. */
  transcripts(): { dir: string; msg: Record<string, unknown> }[][] {
    const run = join(this.support, 'run');
    return readdirSync(run).filter((f) => /^e2e-host-\d+\.jsonl$/.test(f)).sort()
      .map((f) => readFileSync(join(run, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }

  /** What `supervisor.state` answers the main window. */
  processes(): Record<string, Record<string, unknown>> {
    const ctx = { supervisor: { state: () => this.supervisor.state, pid: () => this.supervisor.pid,
      restart: () => { void this.supervisor.restart(); }, avatar: () => this.renderer } } as unknown as OpsContext;
    return supervisorOps(ctx)['supervisor.state']!([], undefined as never) as Record<string, Record<string, unknown>>;
  }

  tray(): string[] {
    return menuLines(this.config, this.renderer, this.supervisor.state);
  }

  /** Each mock_host.py launch's arguments. */
  launchArgs(): string[][] {
    const path = join(this.support, 'run/e2e-host-launches.jsonl');
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  }

  /** An `avatar.*` op from the main window. */
  avatarOp(op: string, ...args: unknown[]) {
    const ctx = { surface: 'main', routes, avatar: this.link, placement: this.placer, supervisor: { avatar: () => this.renderer },
      library: { launched: 'aster' } } as unknown as OpsContext;
    return handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, new Map(Object.entries(avatarOps(ctx))), new PageSession(() => {}));
  }

  /** Any op from the main window, over the pieces index.ts wires. */
  op(op: string, ...args: unknown[]) {
    const ctx = { surface: 'main', routes, config: { path: this.configPath, supportDir: this.support, devResources: null }, agentd: null,
      avatar: this.link, placement: this.placer, looks: this.looks, switcher: this.switcher, supervisor: { avatar: () => this.renderer },
      library: { launched: 'aster', catalog: null }, log: () => {} } as unknown as OpsContext;
    const ops = new Map([...Object.entries(avatarOps(ctx)), ...Object.entries(characterOps(ctx))]);
    return handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, new PageSession(() => {}));
  }

  get agentdLaunches(): number { return lines(join(this.stateDir, 'e2e-agentd-launches.jsonl')); }
  get hostLaunches(): number { return lines(join(this.support, 'run/e2e-host-launches.jsonl')); }
  get companionLog(): string {
    const path = join(this.support, 'logs/companion.log');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }
  get runtimePath(): string { return join(this.stateDir, 'ui-runtime.json'); }

  async character(): Promise<string | null | undefined> {
    try {
      return (await new AgentdClient(this.runtimePath).state()).character;
    } catch {
      return undefined;
    }
  }

  waitRunning(seconds = START_TIMEOUT): Promise<boolean> {
    return until(seconds, () => this.supervisor.state.kind === 'running' && existsSync(this.runtimePath));
  }

  async stop(): Promise<void> {
    await this.avatar?.stop();
    this.placer?.stop();
    this.looks?.stop();
    this.link?.stop();
    await this.supervisor?.stop();
    this.tts?.kill('SIGKILL');
    for (const script of ['agentd_e2e_launcher.py', 'mock_host.py', 'fake_tts.py']) {
      try { execFileSync('/usr/bin/pkill', ['-9', '-f', `${script}.*${this.dir}`]); } catch { /* none left */ }
    }
    delete process.env.E2E_AGENTD_FAULTS;
    delete process.env.AGENTD_DEV_CATALOG;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Runs `body` on a new stack and stops it after; `windows` is why it is skipped on Windows. */
function e2e(name: string, seconds: number, body: (stack: Stack) => Promise<void>,
  options: { missing?: Record<string, string>; library?: string; windows?: string; config?: Record<string, unknown> } = {}): void {
  test(name, { skip: SKIP || (process.platform === 'win32' && options.windows) || false, timeout: seconds * 1000 }, async () => {
    const stack = new Stack();
    try {
      let catalog: string | undefined;
      if (options.library) {
        cpSync(join(REPO, options.library), join(stack.dir, 'library'), { recursive: true });
        catalog = join(stack.dir, 'library/current.json');
      }
      await stack.init({ missing: options.missing, catalog, config: options.config });
      await body(stack);
    } finally {
      await stack.stop();
    }
  });
}

/** Every agentd launch exits 1 after 0.3 s until the backoff trips. */
async function crashLoop(stack: Stack): Promise<void> {
  stack.faults(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), { exit_status: 1, after_s: 0.3 }])));
  stack.start();
  assert.ok(await until(40, () => stack.supervisor.state.kind === 'failed'), `agentd never failed: ${stack.states}`);
}

e2e('agentd starts as the configured character and answers ready; the renderer stays stopped', 120, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.equal((await health(stack.port)).kind, 'ready');
  assert.equal(await stack.character(), 'aster');
  assert.deepEqual(stack.states, ['starting', 'running']);
  assert.equal(stack.processes().avatar!.state, 'stopped');
  assert.deepEqual(stack.tray(), ['角色 · 未启动', '后台 · 运行中']);
  assert.equal(stack.hostLaunches, 0);
});

e2e('a slow start that keeps answering starting is kept past the health timeout', 120, async (stack) => {
  const release = join(stack.dir, 'release');
  // Held in the task recovery, which agentd runs only with the personal agent.
  stack.faults({ 1: { recovery_wait_file: release } });
  const launched = Date.now();
  stack.start();
  assert.ok(await until(START_TIMEOUT, async () => {
    const h = await health(stack.port);
    return h.kind === 'starting' && h.stage === 'recovery';
  }), '/health never answered starting(recovery)');
  await sleep(Math.max(0, 20 - (Date.now() - launched) / 1000));
  assert.equal(stack.supervisor.state.kind, 'starting');
  assert.equal(stack.agentdLaunches, 1);
  assert.doesNotMatch(stack.companionLog, /KILL agentd/);
  assert.equal(existsSync(stack.runtimePath), false, 'ui-runtime.json written before ready');

  const released = Date.now();
  writeFileSync(release, '');
  assert.ok(await stack.waitRunning(10), `agentd not running within 10 s of the release: ${stack.states}`);
  assert.ok(Date.now() > released);
  assert.equal(stack.agentdLaunches, 1);
}, { config: { plugins: { personal_agent: true } } });

e2e('backoff 1, 2, 4, 8, then failed after the fifth crash, and no sixth launch', 120, async (stack) => {
  await crashLoop(stack);
  assert.deepEqual(stack.states.filter((s) => s.startsWith('backoff')), ['backoff(1)', 'backoff(2)', 'backoff(4)', 'backoff(8)']);
  assert.equal(stack.states.at(-1), 'failed(300 秒内崩溃 5 次)');
  assert.equal(stack.agentdLaunches, 5);
  await sleep(10);
  assert.equal(stack.agentdLaunches, 5, 'a launch after the trip');
});

e2e('with the faults gone, restarting brings the tripped agentd back', 120, async (stack) => {
  await crashLoop(stack);
  rmSync(process.env.E2E_AGENTD_FAULTS!);
  await stack.supervisor.restart();
  assert.ok(await stack.waitRunning(), `agentd not running after the restart: ${stack.states}`);
  assert.equal(stack.agentdLaunches, 6);
});

e2e('after kill -9 the replacement binds the same port; the dead pid is not taken for a foreign holder', 120, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  const old = stack.supervisor.pid!;
  process.kill(old, 'SIGKILL');
  assert.ok(await until(15, () => (stack.supervisor.pid ?? old) !== old), `agentd not running again within 15 s: ${stack.states}`);
  assert.ok(!stack.states.includes('portInUse'), `${stack.states}`);
  assert.equal(stack.agentdLaunches, 2);
  assert.equal((await health(stack.port)).kind, 'ready');
});

e2e('a port held by another process is checked again and agentd starts once it is free', 150, async (stack) => {
  const holder: Server = createServer();
  await new Promise<void>((ok, bad) => holder.once('error', bad).listen({ host: '127.0.0.1', port: stack.port, exclusive: true }, ok));
  try {
    stack.start();
    assert.ok(await until(5, () => stack.supervisor.state.kind === 'portInUse'), `agentd state ${stack.states}`);
    await sleep(3);
    assert.equal(stack.supervisor.state.kind, 'portInUse');
    assert.equal(stack.agentdLaunches, 0);
    assert.deepEqual(stack.tray(), ['角色 · 未启动', '后台 · 端口被占用']);
  } finally {
    await new Promise((r) => holder.close(r));
  }
  // The supervisor checks the port again every 30 s.
  assert.ok(await stack.waitRunning(30 + START_TIMEOUT), `agentd not running after the port's release: ${stack.states}`);
  assert.equal(stack.agentdLaunches, 1);
});

e2e('without the agentd component agentd fails at once and is never launched, not even after a restart', 60, async (stack) => {
  stack.start();
  assert.ok(await until(2, () => stack.supervisor.state.kind === 'failed'), `agentd: ${stack.states}`);
  await sleep(5);
  assert.equal(stack.agentdLaunches, 0);
  assert.deepEqual(stack.states, ['failed(缺 agentd 组件)']);
  assert.deepEqual(stack.tray(), ['角色 · 未启动', '后台 · 失败：缺 agentd 组件']);
  assert.equal(stack.processes().agentd!.state, 'failed(缺 agentd 组件)');

  await stack.supervisor.restart();
  assert.ok(await until(10, () => stack.states.length >= 3), `agentd: ${stack.states}`);
  assert.deepEqual(stack.states, ['failed(缺 agentd 组件)', 'stopped', 'failed(缺 agentd 组件)']);
  assert.equal(stack.agentdLaunches, 0);
}, { missing: { agentd: 'componentMissing' } });

e2e('without the renderer component the renderer fails and is never launched; agentd comes up', 120, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.equal(stack.processes().avatar!.state, 'failed(缺 renderer 组件)');
  assert.deepEqual(stack.tray(), ['角色 · 失败：缺 renderer 组件', '后台 · 运行中']);
  assert.equal(stack.hostLaunches, 0);
}, { missing: { renderer: 'componentMissing' } });

e2e('with a library of only the text-only sample character agentd comes up as it and no renderer is needed', 120, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.equal((await health(stack.port)).kind, 'ready');
  assert.equal(await stack.character(), 'aide');
  assert.equal(stack.processes().avatar!.state, 'stopped');
  assert.equal(stack.hostLaunches, 0);
}, { library: 'characters/sample-library' });

e2e('with an empty library agentd comes up without a character; after an import a restart brings it up as it', 180, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.equal((await health(stack.port)).kind, 'ready');
  assert.equal(await stack.character(), null);
  const client = new AgentdClient(stack.runtimePath);
  assert.equal((await client.request('GET', '/character/state')).status, 409);
  assert.equal(stack.processes().avatar!.state, 'stopped');

  const packages = join(REPO, 'characters/sample-library/packages/aide');
  const library = join(stack.dir, 'library');
  execFileSync(stack.python, ['-I', join(REPO, 'agent/agentd/character_tool.py'), 'install', join(packages, readdirSync(packages)[0]!),
    '--library', library, '--validate-with', stack.mockHost], { stdio: 'ignore' });
  await stack.supervisor.restart();
  let character: string | null | undefined;
  assert.ok(await until(START_TIMEOUT, async () => (character = await stack.character()) === 'aide'),
    `agentd says ${character}: ${stack.states}`);
  assert.equal(stack.hostLaunches, 0);
}, { library: 'protocol/character-library/fixtures/empty-library',
  windows: 'the import validates with mock_host.py through a #!/bin/sh wrapper, which Windows cannot start' });

e2e('the renderer starts beside agentd and says hello over C3; the loading panel closes and the tray shows it', 120, async (stack) => {
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.ok(await until(5, () => stack.avatar!.loading.kind === 'hidden'), JSON.stringify(stack.avatar!.loading));
  assert.deepEqual(stack.avatarStates, ['starting', 'running']);
  assert.equal(stack.link!.currentCharacter, 'aster');
  assert.deepEqual(stack.tray(), ['角色 · 运行中', '后台 · 运行中']);
  assert.equal(stack.processes().avatar!.state, 'running');
  assert.equal(stack.hostLaunches, 1);
  const [sent] = stack.transcripts().map((t) => t.filter((m) => m.dir === 'c2a').map((m) => m.msg.type));
  assert.deepEqual(sent!.slice(0, 2), ['hello', 'fps_tier']);
  assert.equal(readdirSync(join(stack.support, 'run')).filter((f) => f.startsWith('startup-')).length, 0, 'startup status left behind');
}, { windows: MOCK_RENDERER });

e2e('a killed renderer is relaunched after the 1 s backoff and says hello again', 120, async (stack) => {
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  const first = stack.link!.hello!.pid;
  process.kill(first, 'SIGKILL');
  assert.ok(await until(15, () => stack.link!.connected && stack.link!.hello!.pid !== first), `no second hello: ${stack.avatarStates}`);
  assert.deepEqual(stack.avatarStates, ['starting', 'running', 'backoff(1)', 'starting', 'running']);
  assert.equal(stack.hostLaunches, 2);
  assert.match(stack.companionLog, /exit child=avatar signal=9/);
}, { windows: MOCK_RENDERER });

e2e('a renderer whose heartbeats stop is killed by the watchdog after 10 s clicked through and relaunched', 120, async (stack) => {
  writeFileSync(join(stack.support, 'run/e2e-host-faults.json'), JSON.stringify({ 1: { silent_after_s: 1 } }));
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  const first = stack.link!.hello!.pid;
  assert.ok(await until(30, () => stack.link!.connected && stack.link!.hello!.pid !== first), `not relaunched: ${stack.avatarStates}`);
  assert.match(stack.companionLog, /KILL avatar reason=heartbeat_timeout/);
  assert.ok(stack.avatarStates.includes('backoff(1)'), `${stack.avatarStates}`);
  assert.equal(stack.hostLaunches, 2);
}, { windows: MOCK_RENDERER });

e2e('a renderer that exits 78 at startup fails without a restart; agentd runs', 120, async (stack) => {
  writeFileSync(join(stack.support, 'run/e2e-host-faults.json'), JSON.stringify({ '*': { exit_after_s: 0.5, exit_status: 78 } }));
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.renderer.kind === 'failed'), `${stack.avatarStates}`);
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  await sleep(3);
  assert.deepEqual(stack.avatarStates, ['starting', 'running', 'failed(角色包与程序版本不符)']);
  assert.deepEqual(stack.tray(), ['角色 · 失败：角色包与程序版本不符', '后台 · 运行中']);
  assert.equal(stack.hostLaunches, 1);
}, { windows: MOCK_RENDERER });

e2e('quit: stopping sends C3 quit first and the renderer exits on it, before agentd stops', 120, async (stack) => {
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  const began = Date.now();
  await stack.avatar!.stop();
  assert.ok(Date.now() - began < 3000, 'waited for the SIGKILL');
  assert.deepEqual(stack.avatarStates.slice(-1), ['stopped']);
  assert.equal(stack.supervisor.state.kind, 'running');
  const [sent] = stack.transcripts().map((t) => t.filter((m) => m.dir === 'c2a').map((m) => m.msg));
  assert.deepEqual(sent!.at(-1), { v: 1, type: 'quit', reason: 'companion_exit' });
  assert.match(stack.companionLog, /closed\(quit\) child=avatar reason=companion_exit/);
}, { windows: MOCK_RENDERER });

e2e('the fullscreen placement the renderer reports comes back as --agentic-complex-placement after a restart; avatar.setScale sends set_placement', 60, async (stack) => {
  writeFileSync(join(stack.support, 'run/e2e-host-faults.json'), JSON.stringify({ '*': { placement: { x: 321.5, y: 40, scale: 1.25, display_id: 7 } } }));
  await stack.superviseRenderer('fullscreen');
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  assert.ok(await until(5, () => readPlacements(stack.support).aster?.['7'] !== undefined), 'the start placement was not remembered');
  assert.deepEqual(readPlacements(stack.support), { aster: { 7: { x: 321.5, y: 40, scale: 1.25 } } });
  assert.deepEqual(readState(stack.support), { last_display: { aster: 7 } });
  assert.ok(!stack.launchArgs()[0]!.includes('--agentic-complex-placement'), 'nothing remembered at the first launch');

  assert.deepEqual(await stack.avatarOp('avatar.setScale', 1.25), { ok: true, value: null });
  assert.deepEqual(await stack.avatarOp('avatar.setScale', 1.5), { ok: true, value: null });
  assert.ok(await until(5, () => readPlacements(stack.support).aster?.['7']?.scale === 1.5), JSON.stringify(readPlacements(stack.support)));
  assert.equal(stack.transcripts().length, 1);
  const [first] = stack.transcripts();
  assert.deepEqual(first!.filter((m) => m.dir === 'c2a' && m.msg.type === 'set_placement').map(({ msg: { req: _req, ...msg } }) => msg),
    [{ v: 1, type: 'set_placement', scale: 1.5 }], 'the scale the renderer already has sends nothing');
  assert.deepEqual(first!.filter((m) => m.dir === 'a2c' && m.msg.type === 'placement').map((m) => [m.msg.reason, m.msg.scale]),
    [['start', 1.25], ['set_placement', 1.5]]);

  const pid = stack.link!.hello!.pid;
  await stack.avatar!.restart();
  assert.ok(await until(15, () => stack.link!.connected && stack.link!.hello!.pid !== pid), `no second hello: ${stack.avatarStates}`);
  const args = stack.launchArgs()[1]!;
  const at = args.indexOf('--agentic-complex-viewport');
  assert.deepEqual(args.slice(at, at + 4), ['--agentic-complex-viewport', 'fullscreen', '--agentic-complex-placement', '321.5,40.0,1.500']);
  // Transcripts sort by pid as text: the second launch's is the one without the set_placement.
  const second = () => stack.transcripts().find((t) => !t.some((m) => m.msg.type === 'set_placement'));
  assert.ok(await until(5, () => stack.transcripts().length === 2 && second()?.some((m) => m.msg.type === 'placement') === true));
  assert.deepEqual(second()!.find((m) => m.msg.type === 'placement')!.msg,
    { v: 1, type: 'placement', x: 321.5, y: 40, scale: 1.5, display_id: 7, reason: 'start' }, 'the second launch starts where the first ended');
}, { windows: MOCK_RENDERER });

e2e('character.switchTo aster → birch goes through prepare, one set_character with her remembered look and commit, without relaunching the renderer; her look ops reach it and come back at the next launch', 120, async (stack) => {
  writeFileSync(join(stack.support, 'run/e2e-host-faults.json'), JSON.stringify({ '*': { looks: {
    appearances: [{ id: 'default', name: '默认' }, { id: 'summer', name: '夏装' }], layers: [{ id: 'coat', name: '外套' }] } } }));
  writeFileSync(join(stack.support, 'state.json'), JSON.stringify({ last_appearance: { birch: 'summer' }, hidden_layers: { birch: ['coat'] } }));
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  assert.ok(await until(5, () => stack.switcher!.current === 'aster'), 'the switch never saw the hello');

  assert.deepEqual(await stack.op('character.switchTo', 'birch'), { ok: true, value: { ok: true } });
  let agentd: string | null | undefined;
  assert.ok(await until(15, async () => (agentd = await stack.character()) === 'birch'), `agentd says ${agentd}`);
  assert.equal(stack.link!.currentCharacter, 'birch');
  assert.equal(stack.link!.currentAppearance, 'summer');
  assert.equal(stack.hostLaunches, 1);
  const sent = () => stack.transcripts()[0]!.filter((m) => m.dir === 'c2a').map((m) => m.msg);
  assert.deepEqual(sent().filter((m) => m.type === 'set_character'), [{ v: 1, type: 'set_character', id: 'birch', appearance: 'summer',
    hidden_layers: ['coat'] }]);
  assert.equal(readState(stack.support).last_character, 'birch');

  assert.deepEqual(await stack.op('avatar.setAppearance', 'default'), { ok: true, value: null });
  assert.deepEqual(await stack.op('avatar.setLayers', []), { ok: true, value: null });
  assert.deepEqual(await stack.op('avatar.modSettings.set', { character: 'birch', appearance: 'default', values: { coat: 1 } }),
    { ok: true, value: { values: { coat: 1 }, adjusted: [] } });
  assert.deepEqual(readState(stack.support), { last_character: 'birch', last_appearance: { birch: 'default', aster: 'default' },
    hidden_layers: { birch: [], aster: [] } });

  // Back to aster in her summer look; this config.json lists only aster, so the next launch is hers.
  assert.deepEqual(await stack.op('character.switchTo', 'aster', 'summer'), { ok: true, value: { ok: true } });
  assert.ok(await until(15, async () => (agentd = await stack.character()) === 'aster'), `agentd says ${agentd}`);
  assert.deepEqual(await stack.op('avatar.setLayers', ['coat']), { ok: true, value: null });
  assert.deepEqual(await stack.op('avatar.modSettings.set', { character: 'aster', appearance: 'summer', values: { coat: 2 } }),
    { ok: true, value: { values: { coat: 2 }, adjusted: [] } });
  const pid = stack.link!.hello!.pid;
  await stack.avatar!.restart();
  assert.ok(await until(15, () => stack.link!.connected && stack.link!.hello!.pid !== pid), `no second hello: ${stack.avatarStates}`);
  const args = stack.launchArgs()[1]!;
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  assert.equal(value('--agentic-complex-character'), 'aster');
  assert.equal(value('--agentic-complex-appearance'), 'summer');
  assert.equal(value('--agentic-complex-hidden-layers'), 'coat');
  assert.equal(value('--agentic-complex-mod-settings'), '{"summer":{"coat":2}}');
  assert.equal(stack.link!.currentAppearance, 'summer');
  assert.deepEqual(stack.link!.hiddenLayers, ['coat']);
}, { windows: MOCK_RENDERER });

e2e('a switch made while agentd starts only changes the picture; agentd follows once it is ready', 120, async (stack) => {
  const release = join(stack.dir, 'release');
  // Held in the task recovery, which agentd runs only with the personal agent.
  stack.faults({ 1: { recovery_wait_file: release } });
  stack.start();
  await stack.superviseRenderer();
  assert.ok(await until(15, () => stack.link!.connected), `no hello: ${stack.avatarStates}`);
  assert.ok(await until(5, () => stack.switcher!.current === 'aster'), 'the switch never saw the hello');
  assert.ok(await until(START_TIMEOUT, async () => {
    const h = await health(stack.port);
    return h.kind === 'starting' && h.stage === 'recovery';
  }), '/health never answered starting(recovery)');

  stack.switcher!.select('birch');
  assert.ok(await until(5, () => stack.switcher!.current === 'birch' && !stack.switcher!.busy), 'the switch did not finish while agentd started');
  assert.equal(stack.supervisor.state.kind, 'starting');
  assert.equal(stack.link!.currentCharacter, 'birch');

  writeFileSync(release, '');
  assert.ok(await stack.waitRunning(10), `agentd not running after the release: ${stack.states}`);
  let agentd: string | null | undefined;
  assert.ok(await until(10, async () => (agentd = await stack.character()) === 'birch'), `agentd says ${agentd}`);
  assert.equal(stack.link!.currentCharacter, 'birch');
  assert.equal(stack.hostLaunches, 1);
  assert.equal(stack.transcripts()[0]!.filter((m) => m.dir === 'c2a' && m.msg.type === 'set_character').length, 1);
}, { windows: MOCK_RENDERER, config: { plugins: { personal_agent: true } } });

// Windows only: the macOS gate (electron-e2e) takes no skipped scenario.
if (process.platform === 'win32') test('Windows: the real efw.exe (offscreen) starts under the supervisor, says hello and pipeline over its named pipe, and exits on quit',
  { skip: SKIP || REAL_EFW, timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'efw-')), support = join(dir, 'support');
    mkdirSync(support);
    // The package's directory is named after its character, as renderer-win-host passes it.
    const character = basename(EFW_PACKAGE);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      characters: [{ id: character, name: character, avatar_app: dirname(EFW), avatar_args: ['--package', EFW_PACKAGE, '--offscreen'] }],
      avatar_executable: EFW, agentd_dir: dir, python: process.execPath, agentd_port: 1, gpu_hold_files: [], support_dir: support,
      agentd_state_dir: join(dir, 'state') }));
    const config = loadConfig(configPath);
    const log = (line: string) => writeFileSync(join(dir, 'hostlink.log'), `${line}\n`, { flag: 'a' });
    const link = new HostLink({ path: hostPipePath(support), transport: 'pipe', pid: process.pid, build: { version: 'e2e' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log });
    const states: string[] = [];
    const renderer = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => character, link,
      captureDir: join(dir, 'captures'), platform: 'windows', onStatus: (s) => states.push(stateText(s)) });
    link.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer.pid) renderer.kill(e.reason); });
    const avatarLog = () => (existsSync(join(support, 'logs/avatar.log')) ? readFileSync(join(support, 'logs/avatar.log'), 'utf8') : '');
    try {
      await link.start();
      renderer.start();
      assert.ok(await until(60, () => link.connected && link.lastPipeline !== null), `${states}\n${avatarLog()}`);
      assert.equal(renderer.state.kind, 'running');
      const pid = renderer.pid!;
      assert.equal(link.hello?.pid, pid);
      assert.equal(link.hello?.character, character);
      assert.equal((link.hello?.build as Record<string, unknown> | undefined)?.renderer, 'vulkan');
      assert.equal(link.lastPipeline?.renderer, 'vulkan');
      assert.ok(await until(10, () => renderer.loading.kind === 'hidden'), JSON.stringify(renderer.loading));
      await renderer.stop();
      assert.equal(renderer.state.kind, 'stopped');
      const companion = readFileSync(join(support, 'logs/companion.log'), 'utf8');
      assert.match(companion, /closed\(quit\) child=avatar reason=companion_exit/);
      assert.doesNotMatch(companion, /KILL avatar/);
      assert.ok(await until(2, () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }), `efw ${pid} is still running`);
    } finally {
      await renderer.stop();
      link.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

// Windows only, as above: config.json names only the library; the shell finds the character directory itself.
if (process.platform === 'win32') test('Windows: from character_catalog alone the supervisor starts the real efw.exe with --package <the library character\'s directory>, which says hello and pipeline',
  { skip: SKIP || REAL_EFW_LIBRARY, timeout: 60_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'efw-')), support = join(dir, 'support');
    mkdirSync(support);
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ character_catalog: EFW_LIBRARY, avatar_app: dirname(EFW), avatar_executable: EFW, agentd_dir: dir,
      python: process.execPath, agentd_port: 1, gpu_hold_files: [], support_dir: support, agentd_state_dir: join(dir, 'state') }));
    const config = loadConfig(configPath);
    const character = config.character;
    // CONTRACT (character library): packages/<id>/<sha>/character.json, its character directory runtime/characters/<id>.
    const entry = (JSON.parse(readFileSync(EFW_LIBRARY, 'utf8')) as { characters: { id: string; definition: { file: string } }[] })
      .characters.find((c) => c.id === character)!;
    const expected = join(dirname(EFW_LIBRARY), dirname(entry.definition.file), 'runtime', 'characters', character);
    const link = new HostLink({ path: hostPipePath(support), transport: 'pipe', pid: process.pid, build: { version: 'e2e' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (line) => writeFileSync(join(dir, 'hostlink.log'), `${line}\n`, { flag: 'a' }) });
    const states: string[] = [];
    // Session 0 has no desktop to show her on.
    const renderer = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => character, link,
      captureDir: join(dir, 'captures'), platform: 'windows', prefix: ['--offscreen'], onStatus: (s) => states.push(stateText(s)) });
    link.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer.pid) renderer.kill(e.reason); });
    const avatarLog = () => (existsSync(join(support, 'logs/avatar.log')) ? readFileSync(join(support, 'logs/avatar.log'), 'utf8') : '');
    try {
      await link.start();
      renderer.start();
      assert.ok(await until(40, () => link.connected && link.lastPipeline !== null), `${states}\n${avatarLog()}`);
      const command = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${renderer.pid}").CommandLine`], { encoding: 'utf8' }).trim();
      t.diagnostic(`efw command line: ${command}`);
      assert.ok(command.includes(`--package ${expected}`), command);
      assert.ok(!command.includes('--character-catalog'), command);
      assert.equal(link.hello?.pid, renderer.pid);
      assert.equal(link.hello?.character, character);
      assert.equal(link.lastPipeline?.renderer, 'vulkan');
      await renderer.stop();
      assert.equal(renderer.state.kind, 'stopped');
    } finally {
      await renderer.stop();
      link.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const SRC = (path: string) => JSON.stringify(pathToFileURL(join(REPO, 'app/electron/src', path)).href);

/** A shell for the cascade scenario: agentd and the renderer as index.ts wires them, and parent_watch.py as the tunnel runs it
 *  with a sleeper that writes its pid to argv[3] for ssh; writes the pids it has to argv[4]. */
const SHELL = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const { AgentdSupervisor } = await import(${SRC('main/agentd/supervisor.ts')});
const { launchCharacter } = await import(${SRC('common/config.ts')});
const { loadConfig } = await import(${SRC('main/config.ts')});
const { HostLink, hostSocketPath } = await import(${SRC('main/renderer/link.ts')});
const { RendererSupervisor } = await import(${SRC('main/renderer/supervisor.ts')});
const [configPath, launcherScript, watcherScript, sleeperPid, pidsPath] = process.argv.slice(2);
const config = loadConfig(configPath);
const agentd = new AgentdSupervisor({ config, launcherScript, character: launchCharacter(config, undefined), privacyConfigPath: configPath });
const link = new HostLink({ path: hostSocketPath(config.supportDir, process.getuid()), transport: 'unix', pid: process.pid, build: { version: 'e2e' },
  fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {} });
await link.start();
const renderer = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => launchCharacter(config, undefined), link,
  captureDir: config.supportDir });
renderer.start();
agentd.start();
const sleeper = 'import os, sys, time; open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(600)';
const watcher = spawn(config.python, [watcherScript, '--parent-pid', String(process.pid), '--', config.python, '-I', '-c', sleeper, sleeperPid],
  { stdio: 'ignore' });
setInterval(() => writeFileSync(pidsPath, JSON.stringify({ agentd: agentd.pid, renderer: renderer.pid, watcher: watcher.pid })), 100);
`;

e2e('cascade: after the shell is killed with SIGKILL its agentd, renderer and parent_watch.py (with its command) all exit', 120, async (stack) => {
  const script = join(stack.dir, 'shell.mjs'), pidsPath = join(stack.dir, 'shell-pids.json'), sleeperPath = join(stack.dir, 'sleeper.pid');
  writeFileSync(script, SHELL);
  const shell = spawn(process.execPath, [script, stack.configPath, join(FIXTURES, 'agentd_e2e_launcher.py'),
    join(REPO, 'app/Resources/parent_watch.py'), sleeperPath, pidsPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  shell.stderr!.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  let pids: Record<string, number | undefined> = {};
  try {
    assert.ok(await until(START_TIMEOUT, () => {
      if (!existsSync(pidsPath) || !existsSync(sleeperPath) || readFileSync(sleeperPath, 'utf8') === '') return false;
      pids = { ...JSON.parse(readFileSync(pidsPath, 'utf8')) as Record<string, number | undefined>, sleeper: Number(readFileSync(sleeperPath, 'utf8')) };
      return ['agentd', 'renderer', 'watcher', 'sleeper'].every((k) => pids[k] !== undefined);
    }), `the shell's children did not all run: ${JSON.stringify(pids)}\n${stderr}`);
    const children = Object.values(pids) as number[];
    assert.ok(children.every((pid) => !gone(pid)), JSON.stringify(pids));
    process.kill(shell.pid!, 'SIGKILL');
    assert.ok(await until(15, () => children.every(gone)),
      `left after the shell's SIGKILL: ${JSON.stringify(Object.fromEntries(Object.entries(pids).filter(([, pid]) => !gone(pid!))))}`);
  } finally {
    shell.kill('SIGKILL');
    for (const pid of Object.values(pids)) if (pid !== undefined && !gone(pid)) process.kill(pid, 'SIGKILL');
  }
}, { windows: MOCK_RENDERER });

/** POSTs `json` to agentd as a hook does, with the hook token; resolves with agentd's reply once it answers. */
function hookPost(port: number, token: string, path: string, json: unknown): Promise<{ status: number; body: unknown }> {
  const data = Buffer.from(JSON.stringify(json));
  return new Promise((ok, bad) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', bad);
    req.end(data);
  });
}

e2e('approval: a Claude PermissionRequest is pending in GET /approvals through the bridge, decided through it, answered to the hook as allow and no longer pending', 120, async (stack) => {
  stack.start();
  assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}`);
  const ctx = { surface: 'main', routes, agentd: new AgentdClient(stack.runtimePath) } as unknown as OpsContext;
  const ops = new Map(Object.entries(agentdOps(ctx)));
  const bridge = async (...args: unknown[]) => await handle('main', { mainFrame: true, origin: ORIGIN }, { op: 'agentd.request', args }, ops,
    new PageSession(() => {}));
  const pending = async () => {
    const reply = await bridge('GET', '/approvals');
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return ((reply as { value: { body: { approvals: Record<string, unknown>[] } } }).value.body.approvals);
  };
  assert.deepEqual(await pending(), []);

  const token = readFileSync(join(stack.stateDir, 'hook.token'), 'utf8').trim();
  const hook = hookPost(stack.port, token, '/hook/claude', { hook_event_name: 'PermissionRequest', session_id: 'e2e-approval', cwd: stack.dir,
    tool_name: 'Write', tool_input: { file_path: join(stack.dir, 'a.txt'), content: 'x' } });
  let approvals: Record<string, unknown>[] = [];
  assert.ok(await until(10, async () => (approvals = await pending()).length === 1), `approvals: ${JSON.stringify(approvals)}`);
  const card = approvals[0]!;
  assert.equal(card.status, 'pending');
  assert.equal(card.tool_summary, join(stack.dir, 'a.txt'));

  assert.deepEqual(await bridge('POST', `/approvals/${card.request_id as string}/decision`, { decision: 'allow', generation: card.generation }),
    { ok: true, value: { status: 200, body: { ok: true } } });
  assert.deepEqual(await hook, { status: 200, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  assert.deepEqual(await pending(), []);
  const again = await bridge('POST', `/approvals/${card.request_id as string}/decision`, { decision: 'deny', generation: card.generation });
  assert.equal((again as { value: { status: number } }).value.status, 409, JSON.stringify(again));
}, { config: { plugins: { coding_sessions: true } } });

// Windows only, as above: the four processes of a Windows run (this one as the shell) in one go.
if (process.platform === 'win32') test('Windows: agentd, the real efw.exe and the real ac-helper.exe run and connect together, and none is left after the stop',
  { skip: SKIP || REAL_EFW || REAL_HELPER, timeout: 180_000 }, async () => {
    const stack = new Stack();
    // agentd's library (AGENTD_DEV_CATALOG, the agentd test library) has the character the package is named after.
    const character = basename(EFW_PACKAGE);
    await stack.init({ config: { avatar_executable: EFW,
      characters: [{ id: character, name: character, avatar_app: dirname(EFW), avatar_args: ['--package', EFW_PACKAGE, '--offscreen'] }] } });
    const support = stack.support, states: string[] = [], helperStates: string[] = [];
    const link = new HostLink({ path: hostPipePath(support), transport: 'pipe', pid: process.pid, build: { version: 'e2e' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: (line) => writeFileSync(join(stack.dir, 'hostlink.log'), `${line}\n`, { flag: 'a' }) });
    const renderer = new RendererSupervisor({ config: stack.config, settings: () => ({}), state: () => ({}), character: () => character, link,
      captureDir: join(stack.dir, 'captures'), platform: 'windows', onStatus: (s) => states.push(stateText(s)) });
    link.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer.pid) renderer.kill(e.reason); });
    const helper = new HelperSupervisor({ executable: HELPER, supportDir: support, clientVersion: 'e2e',
      onStatus: (s) => helperStates.push(stateText(s)) });
    try {
      await link.start();
      renderer.start();
      helper.start();
      stack.start();
      assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}\n${stack.companionLog}`);
      let agentd: string | null | undefined;
      assert.ok(await until(10, async () => (agentd = await stack.character()) === character), `agentd says ${agentd}`);
      assert.ok(await until(60, () => link.connected && link.lastPipeline !== null), `${states}\n${stack.companionLog}`);
      assert.equal(renderer.state.kind, 'running');
      assert.equal(link.hello?.pid, renderer.pid);
      assert.ok(await until(10, () => helper.state.kind === 'running'), `${helperStates}\n${stack.companionLog}`);
      assert.equal(helper.hello?.platform, 'windows');
      assert.equal(helper.hello?.pid, helper.pid);
      const pids = { agentd: stack.supervisor.pid!, efw: renderer.pid!, helper: helper.pid! };
      await renderer.stop();
      link.stop();
      await helper.stop();
      await stack.supervisor.stop();
      assert.deepEqual([renderer.state.kind, helper.state.kind, stack.supervisor.state.kind], ['stopped', 'stopped', 'stopped']);
      assert.ok(await until(5, () => Object.values(pids).every(gone)), `left: ${JSON.stringify(pids)}`);
      assert.match(stack.companionLog, /exit child=helper status=0/);
      assert.match(stack.companionLog, /closed\(quit\) child=avatar reason=companion_exit/);
    } finally {
      await renderer.stop();
      link.stop();
      await helper.stop();
      await stack.stop();
    }
  });

// Windows only, as above: efw answers set_character for the characters its --package-of names (C3 附录「Windows」), so the switch keeps
// the process; with restartOnly (what a switch to or from a text-only character does) it restarts efw as the other character.
if (process.platform === 'win32') for (const restartOnly of [false, true]) test(restartOnly
  ? 'Windows: with restartOnly the switch restarts the real efw.exe with the other library character\'s --package between agentd\'s prepare and commit, and back'
  : 'Windows: the switch sends the real efw.exe set_character between agentd\'s prepare and commit, and back, in one efw process',
  { skip: SKIP || REAL_SWITCH_LIBRARY, timeout: 240_000 }, async (t) => {
    const stack = new Stack();
    // agentd checks every file a character.json inventory lists: it reads the complete library too (--character-catalog); the
    // two-character library leaves them out, so without the complete one agentd reads its test library (AGENTD_DEV_CATALOG), which
    // has the same ids, and only the renderer reads the two-character library.
    await stack.init({ ...(FULL_LIBRARY ? { catalog: SWITCH_LIBRARY } : {}), config: { avatar_executable: EFW } });
    t.diagnostic(FULL_LIBRARY ? `agentd library: ${SWITCH_LIBRARY} (--character-catalog), the renderer's too`
      : `agentd library: the agentd test library (AGENTD_DEV_CATALOG), no complete library at AAC_EFW_LIBRARY_FULL (${EFW_LIBRARY_FULL || 'unset'}); `
        + `the renderer's: ${SWITCH_LIBRARY}`);
    const support = stack.support;
    const shellConfig = join(stack.dir, 'shell-config.json');
    writeFileSync(shellConfig, JSON.stringify({ ...JSON.parse(readFileSync(stack.configPath, 'utf8')) as Record<string, unknown>,
      character_catalog: SWITCH_LIBRARY, avatar_app: dirname(EFW) }));
    const config = loadConfig(shellConfig);
    // CONTRACT (character library): packages/<id>/<sha>/character.json, its character directory runtime/characters/<id>.
    const entries = (JSON.parse(readFileSync(SWITCH_LIBRARY, 'utf8')) as { characters: { id: string; definition: { file: string } }[] }).characters;
    const [first, second] = entries.map((c) => c.id) as [string, string];
    const directory = (id: string) => join(dirname(SWITCH_LIBRARY), dirname(entries.find((c) => c.id === id)!.definition.file), 'runtime', 'characters', id);
    const log = (line: string) => writeFileSync(join(stack.dir, 'hostlink.log'), `${line}\n`, { flag: 'a' });
    const link = new HostLink({ path: hostPipePath(support), transport: 'pipe', pid: process.pid, build: { version: 'e2e' },
      fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log });
    const states: string[] = [];
    const renderer = new RendererSupervisor({ config, settings: () => ({}), state: () => ({}), character: () => launchCharacter(config, lastCharacter(support)),
      link, captureDir: join(stack.dir, 'captures'), platform: 'windows', prefix: ['--offscreen'], onStatus: (s) => states.push(stateText(s)) });
    link.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer.pid) renderer.kill(e.reason); });
    const client = new AgentdClient(stack.runtimePath);
    const sw = new CharacterSwitch(linkSwitchPorts({ link, supportDir: support, agentd: (method, path, json) => client.request(method, path, json),
      agentdRunning: () => stack.supervisor.state.kind === 'running', restartAvatar: () => { void renderer.restart(); },
      renderable: (id) => config.characters.find((c) => c.id === id)?.renderEnabled !== false, log }));
    sw.restartOnly = restartOnly;
    link.on((e) => { if (e.kind === 'character') sw.avatar(e.event); });
    const commandLine = (pid: number) => execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).trim();
    const avatarLog = () => (existsSync(join(support, 'logs/avatar.log')) ? readFileSync(join(support, 'logs/avatar.log'), 'utf8') : '');
    try {
      await link.start();
      renderer.start();
      stack.start();
      assert.ok(await stack.waitRunning(), `agentd not running: ${stack.states}\n${stack.companionLog}`);
      if (FULL_LIBRARY) {
        const agentdCommand = commandLine(stack.supervisor.pid!);
        t.diagnostic(`agentd command line: ${agentdCommand}`);
        assert.ok(agentdCommand.includes(`--character-catalog ${SWITCH_LIBRARY}`), agentdCommand);
      }
      await sw.agentdReady();
      assert.ok(await until(60, () => link.connected && link.lastPipeline !== null && sw.current === first), `${states}\n${avatarLog()}`);
      let agentd: string | null | undefined;
      assert.ok(await until(10, async () => (agentd = await stack.character()) === first), `agentd says ${agentd}`);
      for (const [from, to] of [[first, second], [second, first]] as const) {
        const before = renderer.pid;
        assert.deepEqual(await sw.switchOutcome(to), { kind: 'switched' }, `${JSON.stringify(sw.failure)}\n${states}\n${avatarLog()}`);
        const command = commandLine(renderer.pid!);
        t.diagnostic(`efw command line after ${from} -> ${to}: ${command}`);
        if (restartOnly) {
          assert.notEqual(renderer.pid, before);
          assert.ok(command.includes(`--package ${directory(to)}`), command);
          assert.equal(link.hello?.character, to);
        } else {
          assert.equal(renderer.pid, before, `${states}\n${avatarLog()}`);
          assert.ok(command.includes(`--package-of ${to}=${directory(to)}`), command);
          assert.equal(link.currentCharacter, to);
        }
        assert.equal(link.hello?.pid, renderer.pid);
        // The commit: agentd speaks as the new character.
        assert.equal(await stack.character(), to);
      }
    } finally {
      await renderer.stop();
      link.stop();
      await stack.stop();
    }
  });
