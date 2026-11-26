// Starts the avatar renderer, follows its startup-status file (watchStartup),
// restarts it after a crash with the backoff, fails without a restart on exit 78 or 69, and stops it on quit (C3 quit
// first, SIGTERM only without a handshaken link, SIGKILL after 4 s).
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Backoff, type ChildState, launchFailure, sameState, stateText } from '../../common/agentd.ts';
import { rendererExit, rendererPreflight } from '../../common/components.ts';
import type { Config, ShellPlatform } from '../../common/config.ts';
import { modArgument, storedModSettings } from '../../common/looks.ts';
import { appendLog, recordError } from '../log.ts';

/** Seconds. */
export const RENDERER_TIMING = { startup: 180, poll: 0.2, stop: 4 } as const;

export type LoadingStage = 'starting' | 'loading_character' | 'loading_animations' | 'preparing_graphics' | 'connecting' | 'ready' | 'failed';

/** What the loading panel shows. */
export type Loading =
  | { kind: 'hidden' }
  | { kind: 'loading'; character: string; stage: LoadingStage }
  | { kind: 'recovering'; character: string; seconds: number }
  | { kind: 'failed'; message: string };

/** Null when the file is missing, over 4096 bytes, not the schema or another pid's. */
export function readStartupStatus(path: string, pid: number): { character: string; stage: LoadingStage } | null {
  let text: string;
  try {
    const data = readFileSync(path);
    if (data.length > 4096) return null;
    text = data.toString('utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const stages = ['starting', 'loading_character', 'loading_animations', 'preparing_graphics', 'connecting', 'ready', 'failed'];
    if (v.schema !== 'endfield-startup/v1' || v.pid !== pid || typeof v.character !== 'string' || !stages.includes(v.stage as string)) return null;
    return { character: v.character, stage: v.stage as LoadingStage };
  } catch {
    return null;
  }
}

const settingReaders = (s: Record<string, unknown>) => ({
  flag: (key: string, fallback: boolean) => (typeof s[key] === 'boolean' ? s[key] as boolean : fallback),
  option: (key: string, allowed: string[], fallback: string) => (allowed.includes(s[key] as string) ? s[key] as string : fallback),
});

/** The settings that decide how she is drawn, which the character page's preview takes as its `load.render_args` too
 *  (CONTRACT 「附录：角色页预览」); each value out of its range falls back to its default. */
export function lookArguments(s: Record<string, unknown>): string[] {
  const { flag, option } = settingReaders(s);
  return [
    '--agentic-complex-ssaa', flag('render_ssaa', true) ? '2' : '1',
    '--agentic-complex-shadow-resolution', option('render_shadow', ['1024', '512', '256'], '1024'),
    '--agentic-complex-outline', option('render_outline', ['original', 'subtle', 'contrast'], 'original'),
    '--agentic-complex-light-yaw', option('render_light_yaw', ['-15', '0', '15'], '0'),
    '--agentic-complex-light-pitch', option('render_light_pitch', ['-10', '0', '10'], '0'),
    '--agentic-complex-light-strength', option('render_light_strength', ['0.5', '0.75', '1', '1.25', '1.5'], '1'),
    '--agentic-complex-secondary-motion', flag('render_secondary_motion', true) ? '1' : '0',
    '--agentic-complex-ground-shadow', option('render_ground_shadow', ['off', 'contact', 'cast'], 'cast'),
    '--agentic-complex-dof', option('render_dof', ['off', 'closeup'], 'off'),
  ];
}

/** From config.json's settings: lookArguments, then what only the desktop window takes (its resolution and frame rate, where
 *  her camera looks and she faces, the ambient sampled behind her, speech, captures); each value out of its range falls back to its default. */
export function renderArguments(s: Record<string, unknown>, captureDir: string): string[] {
  const { flag, option } = settingReaders(s);
  // A number in `range` to the nearest 0.5, written without a trailing ".0".
  const degrees = (key: string, low: number, high: number) => {
    const value = typeof s[key] === 'number' ? s[key] as number : NaN;
    const half = Math.round(value * 2) / 2;
    return Number.isFinite(half) && half >= low && half <= high ? String(half) : '0';
  };
  const zoom = typeof s.render_camera_zoom === 'number' && s.render_camera_zoom >= 1 && s.render_camera_zoom <= 4 ? s.render_camera_zoom : 1;
  return [
    ...lookArguments(s),
    '--agentic-complex-display-resolution', String(option('render_resolution', ['authored', 'display'], 'authored') === 'display'),
    '--agentic-complex-render-fps', option('render_fps', ['60', '45', '30'], '60'),
    '--agentic-complex-camera-mode', option('render_camera_mode', ['show', 'overview', 'document'], 'show'),
    '--agentic-complex-camera-yaw', degrees('render_camera_yaw', -180, 180),
    '--agentic-complex-camera-pitch', degrees('render_camera_pitch', -20, 20),
    '--agentic-complex-facing-mode', option('render_facing_mode', ['auto', 'front', 'side', 'back'], 'auto'),
    '--agentic-complex-ambient', option('render_ambient', ['off', 'wallpaper', 'screen'], 'off'),
    '--agentic-complex-light-wrap', flag('render_light_wrap', false) ? '1' : '0',
    '--agentic-complex-speech-expressions', flag('speech_expressions', true) ? 'on' : 'off',
    '--agentic-complex-camera-zoom', String(zoom),
    '--agentic-complex-camera-sway', flag('render_camera_sway', false) ? '1' : '0',
    '--agentic-complex-camera-track', option('render_camera_track', ['off', 'stage'], 'stage'),
    '--agentic-complex-capture-dir', captureDir,
    ...(s.stay_mode === 'bust' ? ['--agentic-complex-camera-framing', 'bust'] : []),
  ];
}

export interface LaunchInput {
  config: Config;
  /** config.json as read. */
  settings: Record<string, unknown>;
  /** `<support>/state.json` as read; `{}` when there is none. */
  state: Record<string, unknown>;
  character: string;
  parentPid: number;
  startupPath: string;
  /** null without a host link. */
  socketPath: string | null;
  captureDir: string;
  /** `--agentic-complex-placement`'s value for a fullscreen launch; null or absent without a remembered placement. */
  placement?: string | null;
  /** Absent is macOS. */
  platform?: ShellPlatform;
  /** The preview addon's `rendezvous()`; absent without the addon or its rendezvous. */
  previewRendezvous?: string;
}

/** Fullscreen only: `scene_mode` box passes `<support>/scenes/<scene_id>/scene.json` (an empty
 *  `scene_id` takes the first id in sorted order) and its SHA-256, stage the 3D stage id; any other mode nothing. */
export function sceneArguments(s: Record<string, unknown>, viewport: string, supportDir: string): string[] {
  if (viewport !== 'fullscreen') return [];
  if (s.scene_mode === 'stage') return ['--agentic-complex-scene-stage', 'charinfo'];
  if (s.scene_mode !== 'box') return [];
  const root = resolve(supportDir, 'scenes'), id = typeof s.scene_id === 'string' ? s.scene_id : '';
  const valid = (v: string) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(v);
  const pack = (v: string) => (existsSync(join(root, v, 'scene.json')) ? join(root, v, 'scene.json') : null);
  let ids: string[] = [id];
  if (id === '') {
    try {
      ids = readdirSync(root).sort();
    } catch {
      return [];
    }
  }
  const file = ids.filter(valid).map(pack).find((f) => f !== null);
  if (!file) return [];
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    return [];
  }
  return ['--agentic-complex-scene-pack', file, '--agentic-complex-scene-pack-sha256', createHash('sha256').update(data).digest('hex'),
    ...(s.scene_parallax === false ? ['--agentic-complex-scene-parallax', '0'] : [])];
}

/** The command line of CONTRACT 「启动」. */
export function rendererArguments(o: LaunchInput): string[] {
  const { config, settings, state, character } = o;
  const per = (key: string) => (state[key] as Record<string, unknown> | undefined)?.[character];
  const args = ['--agentic-complex-window-level', 'status', '--agentic-complex-parent-pid', String(o.parentPid),
    '--agentic-complex-agentd', `${config.agentdStateDir}/events-runtime.json`,
    '--agentic-complex-character', character, '--agentic-complex-startup-status', o.startupPath];
  const appearance = per('last_appearance');
  if (typeof appearance === 'string') args.push('--agentic-complex-appearance', appearance);
  const hidden = per('hidden_layers');
  if (Array.isArray(hidden) && hidden.length > 0 && hidden.every((h) => typeof h === 'string')) {
    args.push('--agentic-complex-hidden-layers', hidden.join(','));
  }
  const mods = modArgument(storedModSettings(settings, character));
  if (mods !== null) args.push('--agentic-complex-mod-settings', mods);
  const viewport = settings.viewport === 'window' ? 'window' : 'fullscreen';
  args.push('--agentic-complex-viewport', viewport);
  // Rule 19: the window viewport places by window position; rule 20: fullscreen starts on the character's last screen.
  if (viewport === 'fullscreen' && o.placement) args.push('--agentic-complex-placement', o.placement);
  const scale = per('window_scale');
  if (typeof scale === 'number') args.push('--agentic-complex-scale', scale.toFixed(3));
  if (settings.battery_low_fps === false) args.push('--agentic-complex-battery-low-fps', '0');
  args.push(...renderArguments(settings, o.captureDir));
  args.push(...sceneArguments(settings, viewport, config.supportDir));
  // CONTRACT 附录「Windows」: efw excludes itself from capture only when passed 1; macOS hides her while the screen is recorded.
  if (o.platform === 'windows') args.push('--agentic-complex-hide-on-screen-capture', settings.hide_on_screen_capture === true ? '1' : '0');
  args.push(...(config.characters.find((c) => c.id === character)?.avatarArgs ?? []));
  if (o.socketPath !== null) args.push('--agentic-complex-host-socket', o.socketPath);
  if (o.previewRendezvous !== undefined) args.push('--agentic-complex-preview-rendezvous', o.previewRendezvous);
  return args;
}

/** `<avatar_app>/Contents/MacOS/<CFBundleExecutable>` from an XML Info.plist; null when it names none. */
export function bundleExecutable(avatarApp: string): string | null {
  let plist: string;
  try {
    plist = readFileSync(join(avatarApp, 'Contents/Info.plist'), 'utf8');
  } catch {
    return null;
  }
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  return name === undefined ? null : join(avatarApp, 'Contents/MacOS', name);
}

/** The last line of `path` from byte `from` on that starts with `error:`, cut to 300 characters; null without one. A log
 *  emptied by rotation since is read from its start. */
export function lastErrorLine(path: string, from: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size, chunk = Buffer.alloc(1 << 20), decoder = new StringDecoder('utf8');
    let pos = from <= size ? from : 0, carry = '', found: string | null = null;
    while (pos < size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n === 0) break;
      pos += n;
      const lines = (carry + decoder.write(chunk.subarray(0, n))).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('error:')) found = line;
    }
    if (carry.startsWith('error:')) found = carry;
    return found === null ? null : [...found.replace(/\r$/, '')].slice(0, 300).join('');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What the supervisor needs of the host link. */
export interface RendererLink {
  readonly listening: boolean;
  readonly startError: string | null;
  readonly path: string;
  readonly connected: boolean;
  readonly currentCharacter: string | null;
  sendQuit(reason: string): boolean;
}

export interface RendererOptions {
  config: Config;
  /** config.json read again for each restart; throws when it does not load.
   *  Absent restarts with `config`. */
  reload?: () => Config;
  /** config.json and state.json, read at each launch. */
  settings(): Record<string, unknown>;
  state(): Record<string, unknown>;
  /** The character to launch; empty for none. */
  character(): string;
  /** The character's `--agentic-complex-placement` value at launch (AvatarPlacer.launchPlacement); absent for none. */
  placement?(character: string): string | null;
  /** null runs the renderer without C3. */
  link: RendererLink | null;
  captureDir: string;
  /** Absent is macOS. Windows has no .app bundle to find the executable in. */
  platform?: ShellPlatform;
  /** `LaunchInput.previewRendezvous`, read at each launch. */
  previewRendezvous?(): string | undefined;
  /** Arguments before the renderer's own: the tests run a Node script with `process.execPath` as the executable. */
  prefix?: string[];
  onStatus?: (state: ChildState) => void;
  onLoading?: (loading: Loading) => void;
  /** Scales every delay; tests shorten the backoff and the startup deadline with it. */
  timeScale?: number;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const seconds = () => Date.now() / 1000;

export class RendererSupervisor {
  private readonly options: RendererOptions;
  private config: Config;
  private readonly backoff = new Backoff(seconds);
  private readonly scale: number;
  private current: ChildState;
  private child: ChildProcess | null = null;
  private generation = 0;
  private readonly quitReasons = new Map<number, { reason: string; logged: boolean }>();
  private startedAt = 0;
  private startupPath: string | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopping: Promise<void> | undefined;
  /** Counts stop and restart calls; a restart starts the renderer only when no later one came while it was stopping. */
  private requests = 0;
  /** Set by stop: the shell is quitting, and nothing starts the renderer again. */
  private ended = false;
  private _loading: Loading = { kind: 'hidden' };

  constructor(options: RendererOptions) {
    this.options = options;
    this.config = options.config;
    this.scale = options.timeScale ?? 1;
    this.current = rendererPreflight(options.config) ?? { kind: 'stopped' };
  }

  get state(): ChildState { return this.current; }
  get loading(): Loading { return this._loading; }
  get pid(): number | undefined { return this.current.kind === 'running' ? this.child?.pid : undefined; }

  /** At launch, beside agentd: the renderer reconnects to agentd by itself. */
  start(): void {
    this.startAvatar();
  }

  /** agentd came up: launches a renderer that is stopped. */
  startIfStopped(): void {
    if (this.current.kind === 'stopped') this.startAvatar();
  }

  /** Stops it and starts it again with a fresh backoff and `reload`'s config; keeps it running when that throws. */
  restart(): Promise<void> {
    let config: Config;
    try {
      config = this.options.reload?.() ?? this.config;
    } catch (e) {
      appendLog(this.config.supportDir, 'companion', `restart avatar: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return Promise.resolve();
    }
    const stopped = this.halt('restart'), request = this.requests;
    return stopped.then(() => {
      if (request !== this.requests) return;
      this.config = config;
      this.backoff.reset();
      this.startAvatar();
    });
  }

  /** The shell's quit: C3 quit (SIGTERM without a handshaken link), then SIGKILL after 4 s; resolves once it is stopped.
   *  No start or restart launches it again. */
  stop(): Promise<void> {
    this.ended = true;
    return this.halt('companion_exit');
  }

  private halt(reason: string): Promise<void> {
    this.requests += 1;
    this.stopping ??= this.stopNow(reason).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  /** Rule 17: SIGKILLs the renderer; its exit then goes through the backoff like any crash. */
  kill(reason: string): void {
    if (!this.child || !running(this.child)) return;
    this.log(`KILL avatar reason=${reason}`);
    this.child.kill('SIGKILL');
  }

  private log(line: string): void {
    appendLog(this.config.supportDir, 'supervisor', line);
  }

  private setLoading(loading: Loading): void {
    this._loading = loading;
    this.options.onLoading?.(loading);
  }

  private setState(state: ChildState): void {
    if (sameState(this.current, state)) return;
    this.current = state;
    this.log(`STATUS avatar=${stateText(state)}`);
    if (state.kind === 'stopped') this.setLoading({ kind: 'hidden' });
    // Only handleCrash puts it in backoff; requested stops go through stopped.
    else if (state.kind === 'backoff') this.setLoading({ kind: 'recovering', character: this.options.character(), seconds: state.seconds });
    else if (state.kind === 'failed') this.setLoading({ kind: 'failed', message: state.reason });
    this.options.onStatus?.(state);
  }

  private after(secs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, secs * 1000 * this.scale);
    this.timers.add(timer);
  }

  private clearStartupStatus(): void {
    if (this.startupPath !== null) rmSync(this.startupPath, { force: true });
    this.startupPath = null;
  }

  private startAvatar(): void {
    if (this.ended) return;
    const failure = rendererPreflight(this.config);
    if (failure !== null) return this.setState(failure);
    const character = this.options.character();
    // A text-only character, or none, has nothing to show; stopped hides the loading panel without an error.
    if (character === '' || this.config.characters.find((c) => c.id === character)?.renderEnabled === false) {
      return this.setState({ kind: 'stopped' });
    }
    const link = this.options.link;
    if (link !== null && !link.listening) return this.setState({ kind: 'failed', reason: `角色连接没有建立：${link.startError ?? '未监听'}` });
    const windows = this.options.platform === 'windows';
    const executable = this.config.avatarExecutable ?? (windows ? null : bundleExecutable(this.config.avatarApp));
    if (executable === null) {
      return this.setState({ kind: 'failed', reason: windows ? 'config.json 没有 avatar_executable（Windows 上是 efw.exe 的路径）' : 'Info.plist 缺少 CFBundleExecutable' });
    }
    this.clearStartupStatus();
    const run = join(this.config.supportDir, 'run');
    try {
      mkdirSync(run, { recursive: true });
    } catch {
      return this.setState({ kind: 'failed', reason: '无法创建角色启动目录' });
    }
    const startupPath = join(run, `startup-${randomUUID().toUpperCase()}.json`);
    this.startupPath = startupPath;
    this.setLoading({ kind: 'loading', character, stage: 'starting' });
    const args = rendererArguments({ config: this.config, settings: this.options.settings(), state: this.options.state(), character,
      parentPid: process.pid, startupPath, socketPath: link?.path ?? null, captureDir: this.options.captureDir,
      placement: this.options.placement?.(character) ?? null, platform: this.options.platform,
      previewRendezvous: this.options.previewRendezvous?.() });
    if (this.launch(executable, [...this.options.prefix ?? [], ...args])) {
      this.setState({ kind: 'running' });
      this.watchStartup(this.generation, startupPath, character, seconds(), 'starting');
    }
  }

  private watchStartup(gen: number, path: string, character: string, began: number, lastStage: LoadingStage): void {
    const child = this.child;
    if (gen !== this.generation || child === null || !running(child)) return;
    const link = this.options.link;
    let stage = lastStage;
    const status = readStartupStatus(path, child.pid!);
    if (status !== null) {
      if (status.stage === 'failed') {
        this.clearStartupStatus();
        return this.setLoading({ kind: 'failed', message: '角色加载失败' });
      }
      if (status.stage === 'ready') {
        if (link === null || (link.connected && link.currentCharacter === status.character)) {
          this.clearStartupStatus();
          return this.setLoading({ kind: 'hidden' });
        }
        stage = 'connecting';
      } else stage = status.stage;
    }
    if ((seconds() - began) / this.scale >= RENDERER_TIMING.startup) {
      this.generation += 1;
      child.kill('SIGKILL');
      this.child = null;
      this.clearStartupStatus();
      return this.setState({ kind: 'failed', reason: '角色准备超时，请重新启动' });
    }
    if (stage !== lastStage) {
      this.log(`AVATAR_LOADING character=${character} stage=${stage}`);
      this.setLoading({ kind: 'loading', character, stage });
    }
    this.after(RENDERER_TIMING.poll / this.scale, () => this.watchStartup(gen, path, character, began, stage));
  }

  /** Spawns with stdout and stderr appended to `<support>/logs/avatar.log`; false (and failed) when it cannot. An exit on its
   *  own logs the last `error:` line this run wrote there as its cause. */
  private launch(executable: string, args: string[]): boolean {
    this.setState({ kind: 'starting' });
    this.generation += 1;
    const gen = this.generation;
    const logPath = join(this.config.supportDir, 'logs', 'avatar.log');
    let fd = -1, logStart = 0;
    try {
      mkdirSync(join(this.config.supportDir, 'logs'), { recursive: true, mode: 0o700 });
      fd = openSync(logPath, 'a', 0o600);
      fchmodSync(fd, 0o600);
      logStart = fstatSync(fd).size;
    } catch {
      if (fd !== -1) closeSync(fd);
      this.setState({ kind: 'failed', reason: `无法打开日志 ${logPath}` });
      return false;
    }
    const began = performance.now();
    this.startedAt = began;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    if (child.pid === undefined) {
      // spawn reports ENOENT and EACCES asynchronously with no pid.
      child.once('error', (e: NodeJS.ErrnoException) => {
        if (gen === this.generation) this.setState({ kind: 'failed', reason: launchFailure(e.code, executable) });
      });
      this.clearStartupStatus();
      return false;
    }
    this.child = child;
    child.once('exit', (code, signal) => {
      const quit = this.quitReasons.get(gen);
      this.quitReasons.delete(gen);
      const how = signal !== null ? `signal=${constants.signals[signal] ?? signal}` : `status=${code}`;
      const cause = quit === undefined && how !== 'status=0' ? lastErrorLine(logPath, logStart) : null;
      const outcome = quit !== undefined ? `closed(quit) child=avatar reason=${quit.reason}` : `exit child=avatar ${how}`;
      if (quit?.logged !== true) this.log(`${outcome} runtime=${((performance.now() - began) / 1000).toFixed(3)}s${cause === null ? '' : ` cause=${cause}`}`);
      if (quit === undefined && how !== 'status=0') {
        recordError(this.config.supportDir, { component: 'host', code: 'host_exit', message: how, ...(cause !== null && { detail: cause }) });
      }
      if (gen !== this.generation) return;
      this.generation += 1;
      this.child = null;
      this.clearStartupStatus();
      const next = rendererExit(code, signal, this.backoff);
      this.setState(next);
      if (next.kind !== 'backoff') return;
      const retry = this.generation;
      this.after(next.seconds, () => {
        if (retry === this.generation) this.startAvatar();
      });
    });
    this.backoff.recordStart();
    return true;
  }

  private async stopNow(reason: string): Promise<void> {
    const child = this.child;
    const live = child !== null && running(child);
    if (live) this.quitReasons.set(this.generation, { reason, logged: false });
    const gen = this.generation;
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearStartupStatus();
    if (child !== null && live) {
      // Rule 5: after quit it gets the whole timeout; SIGTERM would cut its quit path.
      if (this.options.link?.sendQuit(reason) !== true) child.kill('SIGTERM');
      const deadline = performance.now() + RENDERER_TIMING.stop * 1000;
      while (running(child) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(50, deadline - performance.now())));
      }
      if (running(child)) child.kill('SIGKILL');
    }
    const quit = this.quitReasons.get(gen);
    if (quit !== undefined && !quit.logged) {
      this.log(`closed(quit) child=avatar reason=${quit.reason} runtime=${((performance.now() - this.startedAt) / 1000).toFixed(3)}s`);
      quit.logged = true;
    }
    this.child = null;
    this.setState({ kind: 'stopped' });
  }
}
