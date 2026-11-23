// One external service of config.json's `services` (tts, motion, llm). Under `ssh`, parent_watch.py runs `ssh -N -L` and
// ends it when this process is gone; a port already served by this user's ssh is used as it is. Under `local`,
// parent_watch.py runs the record's command, which counts as running once its port listens. A crash restarts either with
// the backoff; quit or restart stops it. `url` and `off` run nothing here.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { constants } from 'node:os';
import { win32 } from 'node:path';
import { Backoff, crashState, launchFailure, stateText } from '../../common/agentd.ts';
import { type Config, firstMissingComponent, type ServiceId, type ServiceRecord, servicePort, type ShellPlatform } from '../../common/config.ts';
import type { ServiceView, SlotState } from '../../common/runtime.ts';
import { portAvailable } from '../agentd/supervisor.ts';
import { appendLog, prepareLogs } from '../log.ts';
import { portOwnersCommand, shellPlatform } from '../platform/index.ts';

/** Seconds. */
export const SERVICE_TIMING = {
  /** Between checks of a tunnel port served by an existing ssh listener. */
  externalRecheck: 60,
  /** Between SIGTERM and SIGKILL. */
  stop: 4,
  /** Between checks whether a local command's port listens. */
  listenPoll: 0.5,
  /** A remote `ensure`, which may cold-start the service; agentd's own ensure waits as long. */
  ensure: 200,
  /** A remote `stop` or `status`. */
  remote: 30,
} as const;

/** The services' shared log under `<support>/logs`; each line names its service. */
export const SERVICES_LOG = 'services.log';

const systemRoot = (env: NodeJS.ProcessEnv) => env.SystemRoot ?? 'C:\\Windows';

/** The ssh client: on Windows the system's OpenSSH. */
export function sshExecutable(platform: ShellPlatform = shellPlatform(), env: NodeJS.ProcessEnv = process.env): string {
  return platform === 'windows' ? win32.join(systemRoot(env), 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh';
}

/** ssh arguments forwarding each of `ports` (duplicates dropped) from `host` to the same port on this machine. */
export function tunnelArguments(host: string, ports: number[], platform: ShellPlatform = shellPlatform(), env: NodeJS.ProcessEnv = process.env): string[] {
  const forwards = [...new Set(ports)].flatMap((p) => ['-L', `127.0.0.1:${p}:127.0.0.1:${p}`]);
  return [sshExecutable(platform, env), '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'GatewayPorts=no', ...forwards, '--', host];
}

/** ssh's argv running `script action` on `host`. */
export function remoteArguments(host: string, script: string, action: RemoteAction, platform: ShellPlatform = shellPlatform(),
  env: NodeJS.ProcessEnv = process.env): string[] {
  return [sshExecutable(platform, env), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, script, action];
}

/** `python`'s arguments running `script` around `command`; Windows has no wrapper adding `-I -B`, so they are given here. */
export function watcherArguments(script: string, command: string[], platform: ShellPlatform = shellPlatform()): string[] {
  return [...(platform === 'windows' ? ['-I', '-B'] : []), script, '--parent-pid', String(process.pid), '--', ...command];
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

/** Whether something accepts a TCP connection at `url`'s host and port. */
export function urlListens(url: string, port: number): Promise<boolean> {
  const host = (URL.parse(url)?.hostname ?? '127.0.0.1').replace(/^\[(.*)\]$/, '$1');
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export type RemoteAction = 'ensure' | 'stop' | 'status';
/** The first stdout line of a remote action; `ok` when ssh exited 0 and the line starts with the action's success word. */
export interface RemoteReply { ok: boolean; line: string }
const SUCCESS: Record<RemoteAction, string[]> = { ensure: ['ready'], stop: ['stopped'], status: ['running', 'stopped'] };

/** Runs `script action` on `host` over ssh; a timeout or a missing ssh reads as a failed line. */
export function runRemote(host: string, script: string, action: RemoteAction, platform: ShellPlatform = shellPlatform()): Promise<RemoteReply> {
  const [file, ...args] = remoteArguments(host, script, action, platform);
  const timeout = (action === 'ensure' ? SERVICE_TIMING.ensure : SERVICE_TIMING.remote) * 1000;
  return new Promise((resolve) => {
    execFile(file!, args, { windowsHide: true, timeout }, (error, stdout) => {
      const first = String(stdout).split(/\r?\n/)[0]!.trim();
      const status = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      const line = first !== '' ? first : error?.killed ? 'fail timeout' : `fail exit ${status ?? error?.code ?? '?'}`;
      resolve({ ok: status === 0 && SUCCESS[action].includes(first.split(' ')[0]!), line });
    });
  });
}

/** What `services.start`, `services.stop` and `services.restart` answer. */
export type ServiceActionResult = { ok: true; line: string | null } | { ok: false; error: string; line: string | null };

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const seconds = () => Date.now() / 1000;
const text = (s: SlotState) => (s.kind === 'external' ? 'external' : stateText(s));

export interface ServiceOptions {
  id: ServiceId;
  config: Config;
  /** app/Resources/parent_watch.py, run with `config.python`. */
  watcherScript: string;
  onStatus?: (view: ServiceView) => void;
  /** The listeners on a port that is not free; tests give a fake. */
  listeners?: (port: number) => Promise<Listener[]>;
  /** The record's remote `start_script`; tests give a fake. */
  remote?: (host: string, script: string, action: RemoteAction) => Promise<RemoteReply>;
  /** Default the shell's own; tests give the other. */
  platform?: ShellPlatform;
  /** Multiplies every delay; tests shorten them. */
  timeScale?: number;
}

export class ServiceSupervisor {
  readonly id: ServiceId;
  private readonly options: ServiceOptions;
  private readonly scale: number;
  private readonly platform: ShellPlatform;
  private current: Config;
  private readonly backoff = new Backoff(seconds);
  private slot: SlotState = { kind: 'stopped' };
  private lastFailure: string | null = null;
  private child: ChildProcess | null = null;
  // Bumped whenever the current process is abandoned; stale exit handlers, checks and timers compare against it.
  private generation = 0;
  private readonly quitReasons = new Map<number, { reason: string; logged: boolean }>();
  private startedAt = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopping: Promise<void> | undefined;
  private restarts = 0;
  /** Set by stop: the shell is quitting, and nothing starts the service again. */
  private ended = false;

  constructor(options: ServiceOptions) {
    this.id = options.id;
    this.options = options;
    this.scale = options.timeScale ?? 1;
    this.platform = options.platform ?? shellPlatform();
    this.current = options.config;
  }

  get record(): ServiceRecord {
    return this.current.services[this.id];
  }

  /** Whether this shell runs a process for the record: `ssh` and `local`. */
  get supervised(): boolean {
    return this.record.mode === 'ssh' || this.record.mode === 'local';
  }

  get state(): SlotState {
    return this.slot;
  }

  /** The config the service runs with: the launch's, then the last `restart`'s. */
  get config(): Config {
    return this.current;
  }

  /** parent_watch.py's pid while the service is running. */
  get pid(): number | undefined {
    return this.slot.kind === 'running' ? this.child?.pid : undefined;
  }

  get view(): ServiceView {
    return { mode: this.record.mode, state: this.supervised ? this.slot : null, pid: this.pid ?? null, detail: this.lastFailure };
  }

  start(): void {
    prepareLogs(this.current.supportDir);
    void this.startService();
  }

  /** Stops the service, then starts it with `config` (config.json read again) and a fresh backoff. */
  restart(config: Config): Promise<void> {
    // Restarts share one halt; only the latest one's config starts.
    const request = ++this.restarts;
    return this.halt('restart').then(() => {
      if (request !== this.restarts) return;
      if (JSON.stringify(config.services[this.id]) !== JSON.stringify(this.record)) this.lastFailure = null;
      this.current = config;
      this.backoff.reset();
      this.changed();
      void this.startService();
    });
  }

  /** The shell's quit: SIGTERM, then SIGKILL after 4 s; resolves once the service is stopped. No start or restart launches
   *  it again. */
  stop(): Promise<void> {
    this.ended = true;
    return this.halt('companion_exit');
  }

  /** `services.start`: starts the process unless it runs, then under `ssh` runs the remote `ensure` when there is a script. */
  async begin(): Promise<ServiceActionResult> {
    if (!this.supervised) return { ok: false, error: 'not_supervised', line: null };
    if (this.child === null && this.slot.kind !== 'external') {
      this.backoff.reset();
      void this.startService();
    }
    return this.remote('ensure');
  }

  /** `services.stop`: stops the process, then under `ssh` runs the remote `stop` when there is a script. */
  async end(): Promise<ServiceActionResult> {
    if (!this.supervised) return { ok: false, error: 'not_supervised', line: null };
    await this.halt('user_stop');
    return this.remote('stop');
  }

  /** `services.restart`: `end`, then `begin`. */
  async again(): Promise<ServiceActionResult> {
    if (!this.supervised) return { ok: false, error: 'not_supervised', line: null };
    await this.end();
    return this.begin();
  }

  private async remote(action: 'ensure' | 'stop'): Promise<ServiceActionResult> {
    const r = this.record;
    if (r.mode !== 'ssh' || r.start_script === '') return { ok: true, line: null };
    const reply = await (this.options.remote ?? ((h, s, a) => runRemote(h, s, a, this.platform)))(r.ssh_host, r.start_script, action);
    this.log(`remote ${this.id} ${action}: ${reply.line}`);
    if (reply.ok) return { ok: true, line: reply.line };
    this.lastFailure = reply.line;
    this.changed();
    return { ok: false, error: `${action}_failed`, line: reply.line };
  }

  private halt(reason: string): Promise<void> {
    this.stopping ??= this.stopNow(reason).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private log(line: string): void {
    appendLog(this.current.supportDir, 'supervisor', line);
  }

  private changed(): void {
    this.options.onStatus?.(this.view);
  }

  private setState(state: SlotState): void {
    if (text(this.slot) === text(state)) return;
    this.slot = state;
    if (state.kind === 'failed') this.lastFailure = state.reason;
    this.log(`STATUS ${this.id}=${text(state)}`);
    this.changed();
  }

  private after(secs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, secs * 1000 * this.scale);
    this.timers.add(timer);
  }

  private async startService(): Promise<void> {
    if (this.ended) return;
    if (!this.supervised) {
      // A start still waiting on a port check is abandoned.
      this.generation += 1;
      return;
    }
    const r = this.record, port = servicePort(r.url)!;
    const python = firstMissingComponent(this.current, ['runtime.python']);
    if (python !== undefined) return this.setState({ kind: 'failed', reason: `缺 ${python} 组件` });
    if (this.child !== null) return;
    // A later start abandons this one's checks and rechecks.
    this.generation += 1;
    const gen = this.generation;
    if (r.mode === 'ssh') {
      if (!(await portAvailable(port))) {
        const listeners = await (this.options.listeners ?? ((p: number) => portListeners(p, this.platform)))(port);
        if (gen !== this.generation) return;
        if (!ownSshListeners(listeners, this.platform)) return this.setState({ kind: 'failed', reason: `端口 ${port} 被占用` });
        this.setState({ kind: 'external' });
        this.after(SERVICE_TIMING.externalRecheck, () => {
          if (gen === this.generation && this.slot.kind === 'external') void this.startService();
        });
        return;
      }
      if (gen !== this.generation) return;
      const command = tunnelArguments(r.ssh_host, [port], this.platform);
      if (await this.launch(watcherArguments(this.options.watcherScript, command, this.platform), undefined)) this.setState({ kind: 'running' });
      return;
    }
    if (!(await portAvailable(port))) {
      if (gen === this.generation) this.setState({ kind: 'failed', reason: `端口 ${port} 被占用` });
      return;
    }
    if (r.cwd !== '' && !existsSync(r.cwd)) return this.setState({ kind: 'failed', reason: `工作目录不存在 ${r.cwd}` });
    if (gen !== this.generation) return;
    // argv as it is, no shell, on either platform.
    if (!(await this.launch(watcherArguments(this.options.watcherScript, r.command, this.platform), r.cwd === '' ? undefined : r.cwd))) return;
    const launched = this.generation;
    const poll = async () => {
      if (launched !== this.generation) return;
      if (!(await urlListens(r.url, port))) return this.after(SERVICE_TIMING.listenPoll, () => void poll());
      if (launched === this.generation) this.setState({ kind: 'running' });
    };
    void poll();
  }

  /** Spawns `config.python` with `args`, each output line appended to `<support>/logs/services.log`; false (and failed)
   *  when it cannot. */
  private async launch(args: string[], cwd: string | undefined): Promise<boolean> {
    this.setState({ kind: 'starting' });
    this.generation += 1;
    const gen = this.generation;
    const executable = this.current.python;
    const began = performance.now();
    this.startedAt = began;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd !== undefined && { cwd }) });
    } catch (e) {
      this.setState({ kind: 'failed', reason: launchFailure((e as NodeJS.ErrnoException).code, executable) });
      return false;
    }
    this.child = child;
    for (const stream of [child.stdout!, child.stderr!]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop()!;
        if (lines.length > 0) appendLog(this.current.supportDir, this.id, lines.join('\n'), SERVICES_LOG);
      });
      stream.on('end', () => { if (rest !== '') appendLog(this.current.supportDir, this.id, rest, SERVICES_LOG); });
    }
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
        ? `closed(quit) child=${this.id} reason=${quit.reason}`
        : `exit child=${this.id} ${signal !== null ? `signal=${constants.signals[signal] ?? signal}` : `status=${code}`}`;
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
      if (gen === this.generation) void this.startService();
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
      const deadline = performance.now() + SERVICE_TIMING.stop * 1000 * this.scale;
      while (running(child) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(50, deadline - performance.now())));
      }
      if (running(child)) child.kill('SIGKILL');
    }
    const quit = this.quitReasons.get(gen);
    if (quit !== undefined && !quit.logged) {
      this.log(`closed(quit) child=${this.id} reason=${quit.reason} runtime=${((performance.now() - this.startedAt) / 1000).toFixed(3)}s`);
      quit.logged = true;
    }
    this.child = null;
    this.setState({ kind: 'stopped' });
  }
}
