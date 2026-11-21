// Starts agentd as C9 describes, probes /health until ready, restarts it after a crash with the backoff, and stops it on
// quit.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { constants } from 'node:os';
import { join } from 'node:path';
import {
  agentdArguments, Backoff, type ChildState, crashState, HealthWatch, launchFailure, preflightFailure, sameState, stateText,
  TIMING,
} from '../../common/agentd.ts';
import { type Config, launchAgentdDir } from '../../common/config.ts';
import { type Plugins, shellPlan } from '../../common/plugins.ts';
import { appendLog, prepareLogs } from '../log.ts';
import { cliScript, hookScript } from '../../common/onboarding.ts';
import { agentdStopRequest, portOwnersCommand, shellPlatform } from '../platform/index.ts';
import { health } from './client.ts';

/** Binds 127.0.0.1:port as agentd's server does (SO_REUSEADDR): a listener fails it, TIME_WAIT sockets do not. */
export function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Pids listening on the TCP port; empty when the command is missing or finds none. */
export function portOwners(port: number): Promise<number[]> {
  const { file, args, pids } = portOwnersCommand(port);
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(error ? [] : pids(stdout)));
  });
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const seconds = () => Date.now() / 1000;

export interface SupervisorOptions {
  config: Config;
  /** The agentd component's launcher, or app/Resources/agentd_launcher.py. */
  launcherScript: string;
  /** Before the launcher: platform/index.ts `pythonFlags`. */
  pythonFlags?: string[];
  /** Empty: agentd runs without a character. A function is asked again at each launch, with the config it launches with. */
  character: string | ((config: Config) => string);
  /** The config.json path, passed as `--privacy-config`. */
  privacyConfigPath?: string;
  /** config.json read again for each restart; throws when it does not load.
   *  Absent restarts with `config`. */
  reload?: () => Config;
  onStatus?: (state: ChildState) => void;
  /** /health's stage and degraded subsystems while starting, each time either changes;
   *  then, just after `running`, a null stage with the ready reply's degraded list. */
  onHealth?: (stage: string | null, degraded: string[]) => void;
}

export class AgentdSupervisor {
  private readonly options: SupervisorOptions;
  private config: Config;
  private readonly backoff = new Backoff(seconds);
  private current: ChildState = { kind: 'stopped' };
  private child: ChildProcess | null = null;
  // Bumped whenever the current process is abandoned; stale exit handlers, probes and timers compare against it.
  private generation = 0;
  private readonly quitReasons = new Map<number, { reason: string; logged: boolean }>();
  private startedAt = 0;
  /** The pid of the last process launched; it may still hold the port after its exit is reported. */
  private lastPid: number | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopping: Promise<void> | undefined;
  /** Counts stop and restart calls; a restart starts agentd only when no later one came while it was stopping. */
  private requests = 0;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.config = options.config;
  }

  get state(): ChildState {
    return this.current;
  }

  /** The plug-ins of the config agentd last started with (or starts with next). */
  get plugins(): Plugins {
    return this.config.plugins;
  }

  /** agentd's pid while it is running. */
  get pid(): number | undefined {
    return this.current.kind === 'running' ? this.child?.pid : undefined;
  }

  start(): void {
    prepareLogs(this.config.supportDir);
    void this.startAgentd();
  }

  /** Stops agentd and starts it again with a fresh backoff and `reload`'s config; keeps it running when that throws. */
  restart(): Promise<void> {
    let config: Config;
    try {
      config = this.options.reload?.() ?? this.config;
    } catch (e) {
      appendLog(this.config.supportDir, 'companion', `restart backend: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return Promise.resolve();
    }
    const stopped = this.stop('restart'), request = this.requests;
    return stopped.then(() => {
      if (request !== this.requests) return;
      this.config = config;
      this.backoff.reset();
      void this.startAgentd();
    });
  }

  /** SIGTERM (on Windows: closing agentd's stdin), then SIGKILL after 6 s; resolves once agentd is stopped. */
  stop(reason = 'companion_exit'): Promise<void> {
    this.requests += 1;
    this.stopping ??= this.stopNow(reason).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private log(line: string): void {
    appendLog(this.config.supportDir, 'supervisor', line);
  }

  private setState(state: ChildState): void {
    if (sameState(this.current, state)) return;
    this.current = state;
    this.log(`STATUS agentd=${stateText(state)}`);
    this.options.onStatus?.(state);
  }

  private after(secs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, secs * 1000);
    this.timers.add(timer);
  }

  private async startAgentd(): Promise<void> {
    const failure = preflightFailure(this.config);
    if (failure !== null) return this.setState(failure);
    const gen = this.generation, port = this.config.agentdPort;
    if (!(await portAvailable(port))) {
      if (gen !== this.generation) return;
      // The agentd launched last can still hold the port just after its exit is reported.
      const last = this.lastPid;
      if (last !== undefined && (await portOwners(port)).includes(last)) {
        if (gen === this.generation) this.handleCrash();
        return;
      }
      if (gen !== this.generation) return;
      this.setState({ kind: 'portInUse' });
      this.after(TIMING.portRecheck, () => {
        if (gen === this.generation && this.current.kind === 'portInUse') void this.startAgentd();
      });
      return;
    }
    if (gen !== this.generation) return;
    const character = typeof this.options.character === 'string' ? this.options.character : this.options.character(this.config);
    const args = agentdArguments(this.config, { pythonFlags: this.options.pythonFlags, launcherScript: this.options.launcherScript,
      parentPid: process.pid, character, privacyConfigPath: this.options.privacyConfigPath });
    this.writeBinScripts();
    if (!(await this.launch(this.config.python, args, 'agentd.log'))) return;
    const launchGen = this.generation, watch = new HealthWatch(seconds());
    let stage: string | null = null, degraded: string[] = [];
    const probe = async () => {
      const reply = await health(port);
      if (launchGen !== this.generation) return;
      const step = watch.observe(reply, seconds());
      if (step.action === 'ready') {
        this.setState({ kind: 'running' });
        // After `running`: a state change clears the stage and degraded already reported for this run.
        if (reply.kind === 'ready') this.options.onHealth?.(null, reply.degraded);
        return;
      }
      if (reply.kind === 'starting' && (reply.stage !== stage || reply.degraded.join('\n') !== degraded.join('\n'))) {
        stage = reply.stage;
        degraded = reply.degraded;
        this.options.onHealth?.(stage, degraded);
      }
      if (step.action === 'kill') {
        this.log(`KILL agentd reason=${step.reason}`);
        // The exit handler then goes through handleCrash, so the restart waits until the port is released.
        this.child?.kill('SIGKILL');
        return;
      }
      if (step.stage !== undefined) this.log(`agentd stage=${step.stage}`);
      this.after(TIMING.probeInterval, () => void probe());
    };
    void probe();
  }

  /** onboarding.ts `hookScript` (only with `hooks` in the plan) and `cliScript` in `<support>/bin`, the fixed paths users'
   *  hook and MCP settings run, for this launch's agentd. */
  private writeBinScripts(): void {
    const dir = join(this.config.supportDir, 'bin'), flags = this.options.pythonFlags ?? [], agentd = launchAgentdDir(this.config);
    const hooks = shellPlan(this.config.plugins).has('hooks') ? [hookScript(this.config.python, flags, agentd, shellPlatform())] : [];
    for (const { name, text: script } of [...hooks,
      cliScript(this.config.python, flags, agentd, this.config.agentdStateDir, dir, shellPlatform())]) {
      const path = join(dir, name), temp = `${path}.tmp`;
      try {
        if (existsSync(path) && readFileSync(path, 'utf8') === script) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, script, { mode: 0o755 });
        renameSync(temp, path);
      } catch (e) {
        this.log(`${name} not written: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Spawns with stdout and stderr appended to `<support>/logs/<log>`; false (and failed) when it cannot. */
  private async launch(executable: string, args: string[], log: string): Promise<boolean> {
    this.setState({ kind: 'starting' });
    this.generation += 1;
    const gen = this.generation;
    const logPath = join(this.config.supportDir, 'logs', log);
    let fd = -1;
    try {
      fd = openSync(logPath, 'a', 0o600);
      fchmodSync(fd, 0o600);
    } catch {
      if (fd !== -1) closeSync(fd);
      this.setState({ kind: 'failed', reason: `无法打开日志 ${logPath}` });
      return false;
    }
    const began = performance.now();
    this.startedAt = began;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: [agentdStopRequest() === 'stdin' ? 'pipe' : 'ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    // Ending the pipe of an agentd that has just exited fails with EPIPE, which unhandled would end the shell.
    child.stdin?.on('error', () => {});
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
        ? `closed(quit) child=agentd reason=${quit.reason}`
        : `exit child=agentd ${signal !== null ? `signal=${constants.signals[signal] ?? signal}` : `status=${code}`}`;
      if (quit?.logged !== true) this.log(`${outcome} runtime=${((performance.now() - began) / 1000).toFixed(3)}s`);
      if (gen !== this.generation) return;
      // Ends the health probe, which would otherwise count this crash again at its deadline.
      this.generation += 1;
      this.child = null;
      this.handleCrash();
    });
    this.lastPid = child.pid;
    this.backoff.recordStart();
    return gen === this.generation;
  }

  private handleCrash(): void {
    const next = crashState(this.backoff.recordCrash());
    this.setState(next);
    if (next.kind !== 'backoff') return;
    const gen = this.generation;
    this.after(next.seconds, () => {
      if (gen === this.generation) void this.startAgentd();
    });
  }

  private async stopNow(reason: string): Promise<void> {
    const child = this.child;
    const live = child !== null && running(child);
    // Cancels probes and retries before waiting for the process.
    if (live) this.quitReasons.set(this.generation, { reason, logged: false });
    const gen = this.generation;
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (child !== null && live) {
      if (agentdStopRequest() === 'stdin') child.stdin?.end();
      else child.kill('SIGTERM');
      const deadline = performance.now() + TIMING.agentdStop * 1000;
      while (running(child) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(50, deadline - performance.now())));
      }
      if (running(child)) child.kill('SIGKILL');
    }
    const quit = this.quitReasons.get(gen);
    if (quit !== undefined && !quit.logged) {
      this.log(`closed(quit) child=agentd reason=${quit.reason} runtime=${((performance.now() - this.startedAt) / 1000).toFixed(3)}s`);
      quit.logged = true;
    }
    this.child = null;
    this.setState({ kind: 'stopped' });
  }
}
