// Starts the platform helper (ac-helper on macOS, ac-helper.exe on Windows), says hello and watches it:
// restarts after a crash with the 1, 2, 4 … 30 s backoff and asks the new helper for the watches in effect, gives
// up on a protocol mismatch (exit 3), and on quit sends shutdown, then ends the process.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, fchmodSync, openSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { Backoff, type ChildState, launchFailure, sameState, stateText } from '../../common/agentd.ts';
import { appendLog, prepareLogs, recordError } from '../log.ts';
import { HelperConnection, type HelperEvent, type HelperReply, localError, PROTOCOL } from './client.ts';

/** Seconds. */
export const HELPER_TIMING = {
  /** After the shutdown request, before the helper is ended. */
  shutdownGrace: 1,
  /** Between SIGTERM and SIGKILL; on Windows the first kill already ends the process (TerminateProcess). */
  killGrace: 2,
} as const;

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const ON_OFF_WATCHES = new Set(['workspace.watch', 'presence.watch', 'input.watch', 'input.actions']);

/** The watch a request starts or stops, one per op and `ax.watch` `watch_id`; null for other ops. */
export function watchOf(op: string, params: Record<string, unknown>): { key: string; on: boolean } | null {
  if (ON_OFF_WATCHES.has(op)) return { key: op, on: params.enabled === true };
  if (op === 'ax.watch') return { key: `ax.watch#${typeof params.watch_id === 'string' ? params.watch_id : ''}`, on: params.pid != null };
  return null;
}

/** The system grant (ops/permissions.ts PERMISSION_KINDS) a `permission_denied` of an op lacks; the op's prefix decides. */
export function grantOf(op: string): string {
  const prefix = op.slice(0, op.indexOf('.') + 1);
  return ({ 'ax.': 'accessibility', 'input.': 'accessibility', 'control.': 'accessibility', 'capture.': 'screenRecording',
    'ocr.': 'screenRecording', 'ptt.': 'inputMonitoring', 'mic.': 'microphone' } as Record<string, string>)[prefix] ?? 'unknown';
}

export interface HelperOptions {
  executable: string;
  /** The helper's arguments, none in the product: the tests run a Node script with `process.execPath` as the executable. */
  prefix?: string[];
  supportDir: string;
  /** `hello.params.client_version`. */
  clientVersion: string;
  onStatus?: (state: ChildState) => void;
  onEvent?: (event: HelperEvent) => void;
  /** Multiplies every delay and timeout; tests shorten them. */
  timeScale?: number;
}

export class HelperSupervisor {
  private readonly options: HelperOptions;
  private readonly scale: number;
  private current: ChildState = { kind: 'stopped' };
  private child: ChildProcess | null = null;
  private connection: HelperConnection | null = null;
  private helloResult: Record<string, unknown> | null = null;
  // Bumped whenever the current process is abandoned; stale handlers and timers compare against it.
  private generation = 0;
  private consecutiveCrashes = 0;
  private startedAt = 0;
  private stopping: Promise<void> | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** The watches in effect, replayed after a restart; `seq` drops an answer that a later request to the same watch overtook. */
  private readonly watches = new Map<string, { op: string; params: Record<string, unknown> }>();
  private readonly watchSeq = new Map<string, number>();

  constructor(options: HelperOptions) {
    this.options = options;
    this.scale = options.timeScale ?? 1;
  }

  get state(): ChildState {
    return this.current;
  }

  get pid(): number | undefined {
    return this.current.kind === 'running' ? this.child?.pid : undefined;
  }

  /** The last `hello` answer of the running helper: its platform, `ops` and `events`. */
  get hello(): Record<string, unknown> | null {
    return this.current.kind === 'running' ? this.helloResult : null;
  }

  start(): void {
    prepareLogs(this.options.supportDir);
    this.launch();
  }

  /** A request to the running helper; `helper_exited` while none runs. `signal`'s abort cancels it (HelperConnection.request). */
  request(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<HelperReply> {
    const watch = watchOf(op, params);
    const seq = watch === null ? 0 : (this.watchSeq.get(watch.key) ?? 0) + 1;
    if (watch !== null) this.watchSeq.set(watch.key, seq);
    // A stop holds even when no helper runs or its answer never comes; a start counts once the helper confirms it, or
    // when no helper is there to answer it: the next one is asked for it.
    if (watch !== null && !watch.on) this.watches.delete(watch.key);
    if (this.current.kind !== 'running' || !this.connection) {
      if (watch?.on) this.watches.set(watch.key, { op, params });
      return Promise.resolve(localError('helper_exited', 'the helper is not running'));
    }
    const reply = this.connection.request(op, params, signal);
    void reply.then((r) => {
      if (!r.ok && r.error.code === 'permission_denied') {
        recordError(this.options.supportDir, { component: 'helper', code: 'permission_denied', message: `${grantOf(op)} ${op}`, req: op });
      }
    });
    if (watch?.on) {
      void reply.then((r) => {
        if ((r.ok || r.error.code === 'helper_exited') && this.watchSeq.get(watch.key) === seq) this.watches.set(watch.key, { op, params });
      });
    }
    return reply;
  }

  /** shutdown, 1 s for the helper to exit, then SIGTERM and SIGKILL; resolves once it is stopped. */
  stop(): Promise<void> {
    this.stopping ??= this.stopNow().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private log(line: string): void {
    appendLog(this.options.supportDir, 'supervisor', line);
  }

  private setState(state: ChildState): void {
    if (sameState(this.current, state)) return;
    this.current = state;
    this.log(`STATUS helper=${stateText(state)}`);
    this.options.onStatus?.(state);
  }

  private after(secs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, secs * 1000 * this.scale);
    this.timers.add(timer);
  }

  /** Spawns with stderr appended to `<support>/logs/helper.log`, then says hello. */
  private launch(): void {
    this.setState({ kind: 'starting' });
    this.generation += 1;
    const gen = this.generation, executable = this.options.executable;
    const logPath = join(this.options.supportDir, 'logs', 'helper.log');
    let fd = -1;
    try {
      fd = openSync(logPath, 'a', 0o600);
      fchmodSync(fd, 0o600);
    } catch {
      if (fd !== -1) closeSync(fd);
      return this.setState({ kind: 'failed', reason: `无法打开日志 ${logPath}` });
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, this.options.prefix ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', fd] });
    } finally {
      closeSync(fd);
    }
    // Writing to a helper that has just exited fails with EPIPE, which unhandled would end the shell.
    child.stdin?.on('error', () => {});
    this.child = child;
    const connection = this.connection = new HelperConnection({
      write: (line) => { if (running(child)) child.stdin?.write(line); },
      onBroken: (reason) => {
        if (gen !== this.generation) return;
        this.log(`KILL helper reason=${reason}`);
        this.terminate(child);
      },
      onEvent: this.options.onEvent,
      timeScale: this.scale,
    });
    child.stdout?.on('data', (chunk: Buffer) => connection.feed(chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (gen !== this.generation) return;
      this.generation += 1;
      this.child = this.connection = null;
      connection.close(localError('helper_exited', 'the helper could not start'));
      this.setState({ kind: 'failed', reason: launchFailure(error.code, executable) });
    });
    child.once('spawn', () => {
      this.startedAt = performance.now();
      void this.sayHello(gen, connection);
    });
    child.once('exit', (code, signal) => this.exited(gen, connection, code, signal));
  }

  private async sayHello(gen: number, connection: HelperConnection): Promise<void> {
    const reply = await connection.request('hello', { protocol: PROTOCOL, client: 'electron', client_version: this.options.clientVersion });
    if (gen !== this.generation) return;
    if (!reply.ok) {
      // protocol_mismatch: the helper exits 3 next. Otherwise it is broken; the exit handler takes over.
      this.log(`helper hello failed code=${reply.error.code}`);
      if (reply.error.code !== 'protocol_mismatch' && this.child) this.terminate(this.child);
      return;
    }
    this.helloResult = reply.result;
    connection.helloEvents = Array.isArray(reply.result.events) ? reply.result.events.map(String) : [];
    this.log(`helper hello platform=${String(reply.result.platform)} version=${String(reply.result.helper_version)} pid=${String(reply.result.pid)}`);
    this.replayWatches(connection);
    this.setState({ kind: 'running' });
  }

  /** A new helper has no watches; each one in effect is asked for again before anyone else asks. */
  private replayWatches(connection: HelperConnection): void {
    for (const [key, { op, params }] of this.watches) {
      const seq = this.watchSeq.get(key);
      void connection.request(op, params).then((r) => {
        if (r.ok) return;
        this.log(`helper replay ${op} failed code=${r.error.code}`);
        if (r.error.code !== 'helper_exited' && this.watchSeq.get(key) === seq) this.watches.delete(key);
      });
    }
  }

  private exited(gen: number, connection: HelperConnection, code: number | null, signal: NodeJS.Signals | null): void {
    const runtime = (performance.now() - this.startedAt) / 1000;
    this.log(`exit child=helper ${signal !== null ? `signal=${constants.signals[signal] ?? signal}` : `status=${code}`} runtime=${runtime.toFixed(3)}s`);
    connection.close(localError('helper_exited', 'the helper exited'));
    if (gen !== this.generation) return;
    this.generation += 1;
    this.child = this.connection = null;
    this.helloResult = null;
    if (code === 3) return this.setState({ kind: 'failed', reason: `版本不符：本程序用协议 ${PROTOCOL}` });
    if (runtime >= Backoff.stableRun) this.consecutiveCrashes = 0;
    this.consecutiveCrashes += 1;
    const seconds = Backoff.delay(this.consecutiveCrashes);
    this.setState({ kind: 'backoff', seconds });
    const next = this.generation;
    this.after(seconds, () => { if (next === this.generation) this.launch(); });
  }

  /** SIGTERM, then SIGKILL after killGrace. */
  private terminate(child: ChildProcess): void {
    if (!running(child)) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (running(child)) child.kill('SIGKILL'); }, HELPER_TIMING.killGrace * 1000 * this.scale);
    child.once('exit', () => clearTimeout(timer));
  }

  private async stopNow(): Promise<void> {
    const child = this.child, connection = this.connection;
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (child !== null && running(child)) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      // Before hello there is no session to ask; closing stdin is the same shutdown without an answer.
      if (this.current.kind === 'running' && connection) void connection.request('shutdown');
      else child.stdin?.end();
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>((r) => { grace = setTimeout(r, HELPER_TIMING.shutdownGrace * 1000 * this.scale); })]);
      clearTimeout(grace);
      if (running(child)) {
        this.log('KILL helper reason=no exit after shutdown');
        this.terminate(child);
        await exited;
      }
    }
    connection?.close(localError('helper_exited', 'the helper was stopped'));
    this.child = this.connection = null;
    this.helloResult = null;
    this.setState({ kind: 'stopped' });
  }
}
