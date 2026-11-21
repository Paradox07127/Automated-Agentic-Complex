// The TTS tunnel: with
// `tts_tunnel_host` and a port in `tts_url`, parent_watch.py runs `ssh -N -L` and ends it when this process is gone; a crash
// restarts it with the backoff, a port already served by this user's ssh is used as it is, and quit or restart stops it.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { closeSync, fchmodSync, openSync } from 'node:fs';
import { constants } from 'node:os';
import { join, win32 } from 'node:path';
import { Backoff, crashState, launchFailure, stateText } from '../../common/agentd.ts';
import { type Config, firstMissingComponent, type ShellPlatform } from '../../common/config.ts';
import type { SlotState } from '../../common/runtime.ts';
import { unsafeSshHost } from '../../common/settings.ts';
import { portAvailable } from '../agentd/supervisor.ts';
import { appendLog, prepareLogs } from '../log.ts';
import { portOwnersCommand, shellPlatform } from '../platform/index.ts';

/** Seconds. */
export const TUNNEL_TIMING = {
  /** Between checks of a tunnel port served by an existing ssh listener. */
  externalRecheck: 60,
  /** Between SIGTERM and SIGKILL. */
  stop: 4,
} as const;

const systemRoot = (env: NodeJS.ProcessEnv) => env.SystemRoot ?? 'C:\\Windows';

/** ssh arguments forwarding each of `ports` (duplicates dropped) from `host` to the same port on this machine; on Windows
 *  the system's OpenSSH client. */
export function tunnelArguments(host: string, ports: number[], platform: ShellPlatform = shellPlatform(), env: NodeJS.ProcessEnv = process.env): string[] {
  const forwards = [...new Set(ports)].flatMap((p) => ['-L', `127.0.0.1:${p}:127.0.0.1:${p}`]);
  const ssh = platform === 'windows' ? win32.join(systemRoot(env), 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
  return [ssh, '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'GatewayPorts=no', ...forwards, '--', host];
}

/** `python`'s arguments running `script` around ssh to `host`; Windows has no wrapper adding `-I -B`, so they are given here. */
export function watcherArguments(script: string, host: string, port: number, platform: ShellPlatform = shellPlatform(),
  env: NodeJS.ProcessEnv = process.env): string[] {
  return [...(platform === 'windows' ? ['-I', '-B'] : []), script, '--parent-pid', String(process.pid), '--', ...tunnelArguments(host, [port], platform, env)];
}

/** The port written in `url`; null when there is none. */
export function tunnelPort(url: string): number | null {
  const port = URL.parse(url)?.port ?? '';
  return port === '' ? null : Number(port);
}

export interface Listener { pid: number; uid: number | undefined; command: string }

/** `lsof -Fpcu` output as listeners; a process missing its uid or command is left out. */
export function lsofListeners(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | undefined, uid: number | undefined, command: string | undefined;
  const flush = () => { if (pid !== undefined && uid !== undefined && command !== undefined) listeners.push({ pid, uid, command }); };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      flush();
      pid = Number(line.slice(1));
      uid = command = undefined;
    } else if (line.startsWith('u')) uid = Number(line.slice(1));
    else if (line.startsWith('c')) command = line.slice(1);
  }
  flush();
  return listeners;
}

/** The image name in the first CSV field of `tasklist /FO CSV /NH`; undefined for its no-match notice. */
export function tasklistImage(stdout: string): string | undefined {
  return /^"([^"]*)"/.exec(stdout.trim())?.[1];
}

const output = (file: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
});

/** The TCP listeners on `port`: lsof's on macOS; on Windows netstat's pids, each named by tasklist and with no uid.
 *  Empty when the command is missing or finds none. */
export async function portListeners(port: number, platform: ShellPlatform = shellPlatform(), env: NodeJS.ProcessEnv = process.env): Promise<Listener[]> {
  if (platform !== 'windows') {
    const stdout = await output('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcu']);
    return stdout === null ? [] : lsofListeners(stdout);
  }
  const owners = portOwnersCommand(port, 'win32', env);
  const stdout = await output(owners.file, owners.args);
  if (stdout === null) return [];
  const tasklist = win32.join(systemRoot(env), 'System32', 'tasklist.exe');
  // A pid tasklist cannot name stays in with no command, so the port is not taken as ours.
  return Promise.all(owners.pids(stdout).map(async (pid) => {
    const row = await output(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return { pid, uid: undefined, command: (row === null ? undefined : tasklistImage(row)) ?? '' };
  }));
}

/** Whether a taken port is served only by this user's ssh: by uid and `ssh` on macOS, by the image `ssh.exe` on Windows. */
export function ownSshListeners(listeners: Listener[], platform: ShellPlatform = shellPlatform(), uid = process.getuid?.()): boolean {
  const ours = (l: Listener) => (platform === 'windows' ? l.command.toLowerCase() === 'ssh.exe' : l.uid === uid && l.command === 'ssh');
  return listeners.length > 0 && listeners.every(ours);
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const seconds = () => Date.now() / 1000;
const text = (s: SlotState) => (s.kind === 'external' ? 'external' : stateText(s));

export interface TunnelOptions {
  config: Config;
  /** app/Resources/parent_watch.py, run with `config.python`. */
  watcherScript: string;
  onStatus?: (state: SlotState) => void;
  /** The listeners on a port that is not free; tests give a fake. */
  listeners?: (port: number) => Promise<Listener[]>;
  /** Default the shell's own; tests give the other. */
  platform?: ShellPlatform;
  /** Multiplies every delay; tests shorten them. */
  timeScale?: number;
}

export class TunnelSupervisor {
  private readonly options: TunnelOptions;
  private readonly scale: number;
  private readonly platform: ShellPlatform;
  private current: Config;
  private readonly backoff = new Backoff(seconds);
  private slot: SlotState = { kind: 'stopped' };
  private child: ChildProcess | null = null;
  // Bumped whenever the current process is abandoned; stale exit handlers, checks and timers compare against it.
  private generation = 0;
  private readonly quitReasons = new Map<number, { reason: string; logged: boolean }>();
  private startedAt = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopping: Promise<void> | undefined;

  constructor(options: TunnelOptions) {
    this.options = options;
    this.scale = options.timeScale ?? 1;
    this.platform = options.platform ?? shellPlatform();
    this.current = options.config;
  }

  get state(): SlotState {
    return this.slot;
  }

  /** The config the tunnel runs with: the launch's, then the last `restart`'s. */
  get config(): Config {
    return this.current;
  }

  /** parent_watch.py's pid while the tunnel is running. */
  get pid(): number | undefined {
    return this.slot.kind === 'running' ? this.child?.pid : undefined;
  }

  start(): void {
    prepareLogs(this.current.supportDir);
    void this.startTunnel();
  }

  /** Stops the tunnel, then starts it with `config` (config.json
   *  read again) and a fresh backoff. */
  restart(config: Config): Promise<void> {
    return this.stop('restart').then(() => {
      this.current = config;
      this.backoff.reset();
      void this.startTunnel();
    });
  }

  /** SIGTERM, then SIGKILL after 4 s; resolves once the tunnel is stopped. */
  stop(reason = 'companion_exit'): Promise<void> {
    this.stopping ??= this.stopNow(reason).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private log(line: string): void {
    appendLog(this.current.supportDir, 'supervisor', line);
  }

  private setState(state: SlotState): void {
    if (text(this.slot) === text(state)) return;
    this.slot = state;
    this.log(`STATUS tunnel=${text(state)}`);
    this.options.onStatus?.(state);
  }

  private after(secs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, secs * 1000 * this.scale);
    this.timers.add(timer);
  }

  /** No host or no port in `tts_url` means no tunnel. */
  private async startTunnel(): Promise<void> {
    const host = this.current.ttsTunnelHost, port = tunnelPort(this.current.ttsURL);
    if (host === '' || port === null) return;
    // A hand-edited config.json does not pass settings.save's check.
    if (unsafeSshHost(host)) return this.setState({ kind: 'failed', reason: 'SSH 转发主机无效' });
    const python = firstMissingComponent(this.current, ['runtime.python']);
    if (python !== undefined) return this.setState({ kind: 'failed', reason: `缺 ${python} 组件` });
    if (this.child !== null) return;
    // A later start abandons this one's checks and rechecks.
    this.generation += 1;
    const gen = this.generation;
    if (!(await portAvailable(port))) {
      const listeners = await (this.options.listeners ?? ((p: number) => portListeners(p, this.platform)))(port);
      if (gen !== this.generation) return;
      if (!ownSshListeners(listeners, this.platform)) return this.setState({ kind: 'failed', reason: `端口 ${port} 被占用` });
      this.setState({ kind: 'external' });
      this.after(TUNNEL_TIMING.externalRecheck, () => {
        if (gen === this.generation && this.slot.kind === 'external') void this.startTunnel();
      });
      return;
    }
    if (gen !== this.generation) return;
    if (await this.launch(this.current.python, watcherArguments(this.options.watcherScript, host, port, this.platform))) this.setState({ kind: 'running' });
  }

  /** Spawns with stdout and stderr appended to `<support>/logs/tunnel.log`; false (and failed) when it cannot. */
  private async launch(executable: string, args: string[]): Promise<boolean> {
    this.setState({ kind: 'starting' });
    this.generation += 1;
    const gen = this.generation;
    const logPath = join(this.current.supportDir, 'logs', 'tunnel.log');
    let fd: number;
    try {
      fd = openSync(logPath, 'a', 0o600);
      fchmodSync(fd, 0o600);
    } catch {
      this.setState({ kind: 'failed', reason: `无法打开日志 ${logPath}` });
      return false;
    }
    const began = performance.now();
    this.startedAt = began;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
    } catch (e) {
      this.setState({ kind: 'failed', reason: launchFailure((e as NodeJS.ErrnoException).code, executable) });
      return false;
    } finally {
      closeSync(fd);
    }
    this.child = child;
    const spawned = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
    if (spawned !== null) {
      if (this.child === child) this.child = null;
      if (gen === this.generation) this.setState({ kind: 'failed', reason: launchFailure(spawned.code, executable) });
      return false;
    }
    child.once('exit', (code, signal) => {
      const quit = this.quitReasons.get(gen);
      this.quitReasons.delete(gen);
      const outcome = quit !== undefined
        ? `closed(quit) child=tunnel reason=${quit.reason}`
        : `exit child=tunnel ${signal !== null ? `signal=${constants.signals[signal] ?? signal}` : `status=${code}`}`;
      if (quit?.logged !== true) this.log(`${outcome} runtime=${((performance.now() - began) / 1000).toFixed(3)}s`);
      if (gen !== this.generation) return;
      this.generation += 1;
      this.child = null;
      this.handleCrash();
    });
    this.backoff.recordStart();
    return gen === this.generation;
  }

  private handleCrash(): void {
    const next = crashState(this.backoff.recordCrash());
    this.setState(next);
    if (next.kind !== 'backoff') return;
    const gen = this.generation;
    this.after(next.seconds, () => {
      if (gen === this.generation) void this.startTunnel();
    });
  }

  private async stopNow(reason: string): Promise<void> {
    const child = this.child;
    const live = child !== null && running(child);
    // Cancels checks and retries before waiting for the process.
    if (live) this.quitReasons.set(this.generation, { reason, logged: false });
    const gen = this.generation;
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (child !== null && live) {
      child.kill('SIGTERM');
      const deadline = performance.now() + TUNNEL_TIMING.stop * 1000 * this.scale;
      while (running(child) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(50, deadline - performance.now())));
      }
      if (running(child)) child.kill('SIGKILL');
    }
    const quit = this.quitReasons.get(gen);
    if (quit !== undefined && !quit.logged) {
      this.log(`closed(quit) child=tunnel reason=${quit.reason} runtime=${((performance.now() - this.startedAt) / 1000).toFixed(3)}s`);
      quit.logged = true;
    }
    this.child = null;
    this.setState({ kind: 'stopped' });
  }
}
