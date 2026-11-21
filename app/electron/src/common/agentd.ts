// agentd's supervision:
// the states, the restart backoff, the health deadlines and the C9 command line. Processes and timers are src/main's.
import { type Config, firstMissingComponent, launchAgentdDir } from './config.ts';

export type ChildState =
  | { kind: 'stopped' } | { kind: 'starting' } | { kind: 'running' } | { kind: 'portInUse' }
  | { kind: 'backoff'; seconds: number }
  | { kind: 'failed'; reason: string };

/** As in companion.log's `STATUS agentd=<state>` lines. */
export function stateText(s: ChildState): string {
  switch (s.kind) {
    case 'backoff': return `backoff(${s.seconds})`;
    case 'failed': return `failed(${s.reason})`;
    default: return s.kind;
  }
}

/** The service detail of the tray's agentd row. */
export function menuDetail(s: ChildState): string {
  switch (s.kind) {
    case 'stopped': return '未启动';
    case 'starting': return '启动中';
    case 'running': return '运行中';
    case 'backoff': return `重连中 ${s.seconds} s`;
    case 'portInUse': return '端口被占用';
    case 'failed': return `失败：${s.reason}`;
  }
}

/** The tray's agentd row, `<service> · <detail>`. */
export function agentdMenuLine(s: ChildState): string {
  return `后台 · ${menuDetail(s)}`;
}

export function sameState(a: ChildState, b: ChildState): boolean {
  return stateText(a) === stateText(b);
}

/** Seconds. */
export const TIMING = {
  /** agentd is killed after this long without any /health answer, starting or ready. */
  healthTimeout: 15,
  /** agentd is killed when it is not ready this long after launch, even while it answers starting. */
  readyTimeout: 90,
  /** Between checks of an agentd port held by another process. */
  portRecheck: 30,
  probeInterval: 0.25,
  /** agentd's SIGTERM cleanup stops its session process groups in up to 5 s; SIGKILL before that orphans them. */
  agentdStop: 6,
} as const;

export type BackoffDecision = { retry: number } | 'tripped';

export class Backoff {
  static readonly window = 300;
  static readonly crashLimit = 5;
  static readonly stableRun = 60;

  /** Delay in seconds before the restart that follows the n-th consecutive crash (n >= 1). */
  static delay(n: number): number {
    return n >= 6 ? 30 : 2 ** (n - 1);
  }

  private consecutive = 0;
  private crashTimes: number[] = [];
  private lastStart: number | undefined;
  private readonly clock: () => number;

  /** `clock` is in seconds. */
  constructor(clock: () => number) {
    this.clock = clock;
  }

  recordStart(): void {
    this.lastStart = this.clock();
  }

  recordCrash(): BackoffDecision {
    const now = this.clock();
    if (this.lastStart !== undefined && now - this.lastStart >= Backoff.stableRun) this.consecutive = 0;
    this.lastStart = undefined;
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < Backoff.window), now];
    if (this.crashTimes.length >= Backoff.crashLimit) return 'tripped';
    this.consecutive += 1;
    return { retry: Backoff.delay(this.consecutive) };
  }

  reset(): void {
    this.consecutive = 0;
    this.crashTimes = [];
    this.lastStart = undefined;
  }
}

/** The state after a crash the backoff decided on. */
export function crashState(decision: BackoffDecision): ChildState {
  return decision === 'tripped'
    ? { kind: 'failed', reason: `${Backoff.window} 秒内崩溃 ${Backoff.crashLimit} 次` }
    : { kind: 'backoff', seconds: decision.retry };
}

export type Health =
  | { kind: 'ready'; degraded: string[] }
  | { kind: 'starting'; stage: string; degraded: string[] }
  | { kind: 'unreachable' };

/** A `GET /health` body: `{"status":"ok"}` is ready, `{"status":"starting","stage":…}` starting, anything else unreachable. */
export function parseHealth(body: unknown): Health {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'unreachable' };
  const b = body as Record<string, unknown>;
  const degraded = Array.isArray(b.degraded) && b.degraded.every((x) => typeof x === 'string') ? b.degraded as string[] : [];
  if (b.status === 'ok') return { kind: 'ready', degraded };
  if (b.status === 'starting') return { kind: 'starting', stage: typeof b.stage === 'string' ? b.stage : '', degraded };
  return { kind: 'unreachable' };
}

export type HealthStep =
  | { action: 'ready' }
  | { action: 'wait'; stage?: string }
  | { action: 'kill'; reason: 'no_health_answer' | 'not_ready' };

/** One launch's /health probes: ready ends them; 15 s without an answer or 90 s without ready kills agentd. */
export class HealthWatch {
  private readonly launched: number;
  private answered: number;
  private stage: string | undefined;

  /** `launched` in seconds, on the clock `observe` gets. */
  constructor(launched: number) {
    this.launched = launched;
    this.answered = launched;
  }

  /** `stage` is set when a starting reply names a stage other than the last one. */
  observe(health: Health, now: number): HealthStep {
    if (health.kind === 'ready') return { action: 'ready' };
    let stage: string | undefined;
    if (health.kind === 'starting') {
      this.answered = now;
      if (health.stage !== this.stage) stage = this.stage = health.stage;
    }
    const silent = now - this.answered >= TIMING.healthTimeout;
    if (silent || now - this.launched >= TIMING.readyTimeout) return { action: 'kill', reason: silent ? 'no_health_answer' : 'not_ready' };
    return stage === undefined ? { action: 'wait' } : { action: 'wait', stage };
  }
}

/** Why agentd does not start at all with this config, before the port check; null when it may. */
export function preflightFailure(config: Config): ChildState | null {
  const id = firstMissingComponent(config);
  if (id !== undefined) return { kind: 'failed', reason: `缺 ${id} 组件` };
  // Without --character-catalog agentd reads the development sources, which a packaged app lacks.
  if (config.characterLibraryMissing.length > 0) {
    return { kind: 'failed', reason: `没有角色库：缺 ${config.characterLibraryMissing.join(' ')} 组件` };
  }
  return null;
}

export interface LaunchContext {
  /** Before the launcher: platform/index.ts `pythonFlags`. */
  pythonFlags?: string[];
  launcherScript: string;
  parentPid: number;
  /** Empty: agentd runs without a character (an empty library). */
  character: string;
  privacyConfigPath?: string;
}

/** `[<python flags>] <launcher> --agentd-dir … --parent-pid … -- <agentd arguments>` (C9 「启动」). */
export function agentdArguments(config: Config, ctx: LaunchContext): string[] {
  const args = [...ctx.pythonFlags ?? [], ctx.launcherScript, '--agentd-dir', launchAgentdDir(config), '--parent-pid', String(ctx.parentPid), '--',
    '--port', String(config.agentdPort), '--state-dir', config.agentdStateDir, '--interaction-preset', config.interactionPreset];
  if (ctx.character !== '') args.push('--character', ctx.character);
  if (config.characterCatalog !== null) args.push('--character-catalog', config.characterCatalog);
  for (const id of Object.keys(config.harnessSites).sort()) args.push('--harness-site', `${id}=${config.harnessSites[id]}`);
  if (ctx.privacyConfigPath !== undefined) args.push('--privacy-config', ctx.privacyConfigPath);
  if (config.computerUseEnabled) {
    args.push('--computer-control-socket', `${config.supportDir}/run/computer-control.sock`,
      '--computer-control-token-file', `${config.supportDir}/run/computer-control.token`);
  }
  if (config.sharePageText) args.push('--share-page-text');
  if (config.shareWindowText) args.push('--share-window-text');
  if (config.shareTypedText) args.push('--share-typed-text');
  if (config.shareAgentSessions) args.push('--share-agent-sessions');
  if (config.shareScreenshots) args.push('--share-screenshots');
  if (!config.observeActivity) args.push('--observation-off');
  if (!config.redactSensitive) args.push('--no-redact');
  if (!config.proactiveSpeech) args.push('--no-proactive');
  // Always passed: agentd's own default is 50, so leaving 0 out would turn 关 into every 50 minutes.
  args.push('--break-reminder-minutes', String(Math.max(0, config.breakReminderMinutes)));
  args.push('--water-reminder-minutes', String(Math.max(0, config.waterReminderMinutes)));
  if (config.mute) args.push('--mute');
  if (config.ttsURL !== '') args.push('--tts-url', config.ttsURL);
  // Passed even when the file is missing: agentd then sends TTS requests without a token (C10).
  args.push('--tts-token-file', `${config.supportDir}/tts-token`);
  if (config.ttsTunnelHost !== '' && config.ttsURL !== '' && config.ttsEnsureScript !== '') {
    args.push('--tts-ensure-host', config.ttsTunnelHost, '--tts-ensure-script', config.ttsEnsureScript);
  }
  return args;
}

/** The failure text the menu shows when the executable cannot be spawned; `code` is the errno name. */
export function launchFailure(code: string | undefined, executable: string): string {
  if (code === 'ENOENT') return `找不到程序 ${executable}`;
  if (code === 'EACCES') return `没有权限运行 ${executable}`;
  return `无法运行 ${executable}`;
}
