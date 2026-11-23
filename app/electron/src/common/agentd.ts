// agentd's supervision:
// the states, the restart backoff, the health deadlines and the C9 command line. Processes and timers are src/main's.
import { type Config, firstMissingComponent, launchAgentdDir, SERVICE_IDS, type ShellPlatform } from './config.ts';
import { PLUGIN_IDS } from './plugins.ts';

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
  /** Absent is macOS. */
  platform?: ShellPlatform;
}

/** The basename of the TTS credential reference shared with agentd (C10). */
export const ttsTokenFile = (supportDir: string) => `${supportDir}/tts-token`;

/**
 * `control.listen`'s endpoint and token file (CONTRACT §7.8), the same for the helper and agentd: a Unix socket in
 * `<supportDir>/run/` on macOS; on Windows a named pipe, unique per support dir by an FNV-1a hash of it, and the token
 * in `<supportDir>\run\`.
 */
export function controlEndpoint(supportDir: string, platform: ShellPlatform): { path: string; tokenFile: string } {
  if (platform !== 'windows') return { path: `${supportDir}/run/computer-control.sock`, tokenFile: `${supportDir}/run/computer-control.token` };
  let hash = 0x811c9dc5;
  for (let i = 0; i < supportDir.length; i += 1) hash = Math.imul(hash ^ supportDir.charCodeAt(i), 0x01000193) >>> 0;
  return { path: `\\\\.\\pipe\\agentic-complex-${hash.toString(16).padStart(8, '0')}-control`,
    tokenFile: `${supportDir}\\run\\computer-control.token` };
}

/** `[<python flags>] <launcher> --agentd-dir … --parent-pid … -- <agentd arguments>` (C9 「启动」). */
export function agentdArguments(config: Config, ctx: LaunchContext): string[] {
  const args = [...ctx.pythonFlags ?? [], ctx.launcherScript, '--agentd-dir', launchAgentdDir(config), '--parent-pid', String(ctx.parentPid), '--',
    '--port', String(config.agentdPort), '--state-dir', config.agentdStateDir, '--interaction-preset', config.interactionPreset];
  if (ctx.character !== '') args.push('--character', ctx.character);
  if (config.characterCatalog !== null) args.push('--character-catalog', config.characterCatalog);
  for (const id of Object.keys(config.harnessSites).sort()) args.push('--harness-site', `${id}=${config.harnessSites[id]}`);
  if (ctx.privacyConfigPath !== undefined) args.push('--privacy-config', ctx.privacyConfigPath);
  for (const id of PLUGIN_IDS) args.push(config.plugins[id] ? '--plugin-on' : '--plugin-off', id);
  if (config.plugins.computer_use) {
    const endpoint = controlEndpoint(config.supportDir, ctx.platform ?? 'mac');
    args.push('--computer-control-socket', endpoint.path, '--computer-control-token-file', endpoint.tokenFile);
  }
  if (config.sharePageText) args.push('--share-page-text');
  if (config.shareWindowText) args.push('--share-window-text');
  if (config.shareTypedText) args.push('--share-typed-text');
  if (config.shareAgentSessions) args.push('--share-agent-sessions');
  if (config.shareScreenshots) args.push('--share-screenshots');
  if (!config.redactSensitive) args.push('--no-redact');
  if (!config.proactiveSpeech) args.push('--no-proactive');
  if (config.mute) args.push('--mute');
  for (const id of SERVICE_IDS) {
    const s = config.services[id];
    if (s.mode === 'off') continue;
    args.push(`--${id}-url`, s.url);
    if (s.mode === 'ssh') args.push(`--${id}-ssh-host`, s.ssh_host);
    if (s.mode === 'ssh' && s.start_script !== '') args.push(`--${id}-ensure-host`, s.ssh_host, `--${id}-ensure-script`, s.start_script);
  }
  // Pass the reference basename even before a credential is configured (C10).
  args.push('--tts-token-file', ttsTokenFile(config.supportDir));
  return args;
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** agentd's environment: `base`, or with config `proxy_url` that as HTTP_PROXY and HTTPS_PROXY in place of the inherited
 *  proxy variables of any case. NO_PROXY keeps its hosts and adds loopback and the hosts of the services that are on, which
 *  agentd reaches directly. */
export function agentdEnv(config: Config, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const proxy = config.proxyUrl;
  if (proxy === '') return base;
  const kept = Object.entries(base).filter(([k]) => k.toUpperCase() === 'NO_PROXY').flatMap(([, v]) => (v ?? '').split(','));
  const services = SERVICE_IDS.map((id) => config.services[id]).filter((s) => s.mode !== 'off').map((s) => URL.parse(s.url)?.hostname.replace(/^\[|\]$/g, '') ?? '');
  const direct = [...kept.map((h) => h.trim()), 'localhost', '127.0.0.1', '::1', ...services].filter((h) => h !== '');
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !PROXY_VARS.includes(k.toUpperCase())));
  return { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: [...new Set(direct)].join(',') };
}

/** The failure text the menu shows when the executable cannot be spawned; `code` is the errno name. */
export function launchFailure(code: string | undefined, executable: string): string {
  if (code === 'ENOENT') return `找不到程序 ${executable}`;
  if (code === 'EACCES') return `没有权限运行 ${executable}`;
  return `无法运行 ${executable}`;
}
