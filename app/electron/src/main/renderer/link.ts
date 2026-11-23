// The Companion's end of C3: on macOS it listens on <support>/run/avatar.sock and the renderer connects;
// on Windows it connects to the named pipe the renderer creates, again every 0.5 s until it is there and after a drop.
// One connection at a time, the hello handshake, rule 17's watchdog, inbound messages to listeners, and the requests the
// bridge ops make.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  type ActionPlayed, type Actions, attachProblem, type AvatarHello, avatarHello, behaviorReceiptProblem, type Box, boxContains, type C3Message,
  cameraGestureProblem, capturedProblem, type Capsule, capsuleHit, capsulesBox, clickProblem, COMPANION_CAPABILITIES, companionHello, CURSOR,
  CursorKinematics, decodeLine, dropProblem, encodeLine, motionRequestProblem, motionStateProblem, motionStrokeProblem, type MotionOverridesReceipt,
  outboundProblem, playbackProblem, type PointerState, poseStateProblem, presentationInputProblem, presentationStateProblem, readCapsules,
  reactionProblem, type ReactionTrigger, readMotionOverrides, rightDragProblem, movingProblem,
  SPEECH_CANCEL_REASONS, speechCancelledProblem, surfaceTrackProblem, TERMINAL_BEHAVIOR_PHASES, traceEventProblem,
  fpsTier, type FpsTier, fpsTierFor, type Heartbeat, LineFramer, MAX_LINE, type Stats, Watchdog,
} from '../../common/c3.ts';
import {
  type AppearanceOption, LAYER_FAIL_REASONS, type LayerOption, type ModReceipt, type ModValues, readAppearances, readLayers, readModReceipt,
  readSwitchReply, type SwitchReply,
} from '../../common/looks.ts';
import { readPlacement } from '../../common/placement.ts';
import type { CharacterEvent } from '../../common/switch.ts';

/** sockaddr_un's 104 bytes less the NUL (HostLink.maxPathBytes). */
export const MAX_SOCKET_PATH = 103;
const sha16 = (s: string) => createHash('sha256').update(s).digest().subarray(0, 16).toString('hex');

/** `<support>/run/avatar.sock`, or a per-user directory in /tmp when that is too long. */
export function hostSocketPath(supportDir: string, uid: number): string {
  const original = `${supportDir}/run/avatar.sock`;
  if (Buffer.byteLength(original) <= MAX_SOCKET_PATH) return original;
  return `/tmp/agentic-complex-${uid}-${sha16(supportDir.replace(/\/+$/, ''))}/avatar.sock`;
}

/** The pipe the Windows renderer creates for this support dir; passed to it as `--agentic-complex-host-socket`. */
export function hostPipePath(supportDir: string): string {
  return `\\\\.\\pipe\\agentic-complex-${sha16(supportDir.toLowerCase())}-avatar`;
}

export type LinkEvent =
  | { kind: 'hello'; hello: AvatarHello }
  | { kind: 'message'; message: C3Message }
  | { kind: 'lost'; reason: string }
  | { kind: 'watchdog'; pid: number; reason: string }
  | { kind: 'character'; event: CharacterEvent }
  | { kind: 'appearance'; event: AppearanceEvent }
  | { kind: 'layers'; event: LayersEvent }
  | { kind: 'modSettings'; receipt: ModReceipt };

/** HostLink's AppearanceEvent: the list of a hello or `character_changed`, or the reply to an open `set_appearance`. */
export type AppearanceEvent =
  | { kind: 'list'; character: string; current: string | null; options: AppearanceOption[]; atHello: boolean }
  | { kind: 'changed'; id: string }
  | { kind: 'failed'; id: string; reason: string };
/** HostLink's LayersEvent (rule 46). */
export type LayersEvent =
  | { kind: 'list'; character: string; layers: LayerOption[]; hidden: string[]; atHello: boolean }
  | { kind: 'changed'; hidden: string[] }
  | { kind: 'failed'; hidden: string[]; reason: string };

/** What the shell remembers of a character: sent with `set_character`, at hello and on each `actions` (rules 28, 46, 53). */
export interface Remembered {
  hiddenLayers(character: string): string[] | null;
  modSettings(character: string): Record<string, ModValues>;
  switches(character: string): Record<string, boolean> | null;
}

/** `code` is the bridge error code. */
export class ActionFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const REJECTED: Record<string, string> = {
  missing: '这个动作缺资源', unknown_action: '角色没有这个动作', not_playable: '这个动作不能单独播', busy: '她正在做别的动作',
};
const rejected = (reason: string) => new ActionFailure(reason, REJECTED[reason] ?? '正在切换角色');
const unsupported = () => new ActionFailure('not_implemented', '这个版本的角色不支持动作设置');
const disconnected = () => new ActionFailure('failed', '和角色的连接断了');
const timedOut = () => new ActionFailure('failed', '角色没有回应');

/** The mod settings failures' texts. */
const MOD_FAILURES: Record<string, string> = { unsupported: '这个版本的角色不支持 mod 设置', busy: '角色正在切换，过一会儿再试',
  refused: '角色没有接受这组 mod 设置（这个外观可能没有开关表）' };

/** The motion override failures' texts. */
const OVERRIDE_FAILURES = { unsupported: '这个版本的角色不支持动作设置', tooLarge: '改动太多，一次发不下，角色上没有生效',
  busy: '角色正在切换或动作还没加载好，过一会儿再试', refused: '角色没有接受这份动作设置' };

/** Seconds; `character` is rule 14's, `appearance` rules 16 and 46's, `capture` rule 50's, `attention` rule 39's,
 *  `cameraLive` rule 49's, `lineInteractive` how long her line keeps the `interactive` tier. */
export const LINK_TIMING = { tick: 0.1, ack: 2, reply: 2, playStart: 35, relink: 20, reconnect: 0.5, floodLines: 2000, character: 11,
  appearance: 10, capture: 10, attention: 45, cameraLive: 1 / 30, lineInteractive: 8 } as const;

/** Rule 10, as HostLink's onLeftClick, onDoubleClick and onRightClick: `at` in global points. */
export type ClickEvent = { kind: 'left'; at: { x: number; y: number }; region: string | null } | { kind: 'double' }
  | { kind: 'right'; at: { x: number; y: number } };
/** Rule 56: the right button held on her, `at` in global points. */
export interface RightDragEvent { phase: 'down' | 'move' | 'up'; at: { x: number; y: number } }
/** Rules 32, 34: what the renderer asks of the surface source. */
export type SurfaceTrackEvent = { kind: 'track'; trackId: string; windowId: number; generation: number | null }
  | { kind: 'untrack'; trackId: string } | { kind: 'attach'; trackId: string | null };
/** Rule 38: the items as she sent them, `x` and `y` in global points. */
export interface DropEvent { items: Record<string, string>[]; x: number; y: number; truncated: boolean }
export interface PoseState { character: string; id: string | null; locked: boolean }
export interface CameraGesture { phase: 'began' | 'changed' | 'ended'; dx: number; dy: number; zoom: number }
/** Rule 45's four switches. */
export interface TouchSettings { regions: boolean; pat: boolean; pinch: boolean; greet: boolean }
/** The `ack` of a command, or `timeout` / `disconnected`. */
export type CommandResult = { ok: true } | { ok: false; reason: string };
/** A 「桌面表面」 window item, sent as given. */
export interface SurfaceWindow { window_id: number; generation: number; display_id: number; frame: Box; order: number;
  edges: { side: string; segments: [number, number][] }[]; above?: Box[] }
export type SurfaceUpdate = { track_id: string; state: 'tracking'; window: SurfaceWindow } | { track_id: string; state: 'gone'; reason: string };
/** Rule 44's five colours, each linear sRGB `[r, g, b]`. */
export type AmbientColors = Record<'mean' | 'top' | 'bottom' | 'left' | 'right', [number, number, number]>;
/** Rule 51's whole set for a character. */
export interface MotionOverrides { chains: Record<string, boolean>; pools: Record<string, { clip: string; weight: number }[]>;
  blend_in: Record<string, number> }
/** The capabilities this shell lists only when its caller says it sends their messages. */
export type OfferedCapability = 'pass_through' | 'render_live' | 'ambient' | 'camera_free' | 'camera_track' | 'filters' | 'capture'
  | 'motion_overrides' | 'play_chain' | 'photo' | 'camera_bust';
/** Queued output past this closes the connection; `trace` and `behavior_receipt` with `motion_state` lines a second (rules 22, 25, 54). */
export const LINK_LIMITS = { outputBytes: 256 * 1024, traceRate: 20, receiptRate: 20, traceEvents: 50 } as const;

export interface LinkOptions {
  /** A Unix socket path (`unix`) or a named pipe (`pipe`). */
  path: string;
  transport: 'unix' | 'pipe';
  pid: number;
  build: Record<string, string>;
  /** config.json `idle_low_fps`, `render_fps`, `battery_low_fps`, read at each `fps_tier` that has to go out (the hello, a
   *  saved setting, hiding, showing, a pause); the tier changes between them use the values last read. */
  fps(): { idleLowFps: boolean; userFps: number; batteryLow: boolean };
  log(line: string): void;
  remembered?: Remembered;
  /** Scales the reply timeouts; tests shorten them with it. */
  timeScale?: number;
  /** The pointer in C3 global points, read every CURSOR.sample s; with it the link sends `cursor` (rules 1, 2) and lists
   *  `pointer` (rule 36). */
  cursor?(): { x: number; y: number };
  /** HostLink.buttonsDown: a mouse button is held, read at each `cursor` sample; false when absent. */
  buttonsDown?(): boolean;
  /** Rule 22's `trace_epoch` for each hello; it must not go back across restarts. The wall clock in ms when absent. */
  traceEpoch?(): number;
  /** Each lists its capability: the valid events of a `trace`, a valid `behavior_receipt` and a valid `motion_request`,
   *  without `v` and `type`, for agentd. */
  onTrace?(events: Record<string, unknown>[]): void;
  onBehaviorReceipt?(receipt: Record<string, unknown>): void;
  /** Rule 54: each valid `motion_state` without `v` and `type`, when both hellos list `behavior_receipt`. */
  onMotionState?(state: Record<string, unknown>): void;
  onMotionRequest?(request: Record<string, unknown>): void;
  /** Each of these receives its valid messages; the ones that list a capability do so only when given: `presentation`,
   *  `drop`, `poses`, `camera_gesture`, and `surfaces`, `opacity`, `layering` for onSurfaceTrack. */
  onClick?(e: ClickEvent): void;
  onPresentationState?(state: Record<string, unknown>): void;
  /** `reason` is agentd's `/speech/cancel` one. */
  onSpeechCancelled?(speechId: string, reason: string): void;
  /** Rule 23: each `playback` without `v` and `type`; at a drop, `interrupted` `connection_lost` for each speech still open. */
  onPlayback?(body: Record<string, unknown>): void;
  onSurfaceTrack?(e: SurfaceTrackEvent): void;
  onDrop?(d: DropEvent): void;
  /** A drag of hers began (each `drag` `begin`). */
  onDragBegin?(): void;
  /** A drag of hers ended at `at`, in global points; `excludedPids` are her renderer's and this shell's. */
  onDragRelease?(at: { x: number; y: number }, excludedPids: readonly number[]): void;
  /** Rule 55: each valid `reaction`'s trigger; lists `reactions`. */
  onReaction?(trigger: ReactionTrigger): void;
  onMotionStroke?(token: string, clip: string): void;
  onPoseState?(s: PoseState): void;
  onCameraGesture?(g: CameraGesture): void;
  /** Rule 56: lists `right_drag`; each valid one after its `down`. */
  onRightDrag?(e: RightDragEvent): void;
  /** Rule 57: lists `moving`; each change, and false when the link that said true ends. */
  onMoving?(moving: boolean): void;
  /** Lists `touch`; read at each hello that lists it, and by touchSettingsChanged. */
  touchSettings?(): TouchSettings;
  /** Each `set_action_switches` and `set_motion_overrides` written, with the character it is for. */
  onMotionSettings?(character: string): void;
  /** Listed after the others, for a caller that sends their messages. */
  offers?: readonly OfferedCapability[];
}

class Connection {
  readonly socket: Socket;
  readonly framer = new LineFramer();
  hello: AvatarHello | null = null;
  watchdog: Watchdog | null = null;
  watchdogFired = false;
  readonly lineTimes: number[] = [];
  /** Bytes of the line being handled, without its newline. */
  lineBytes = 0;
  /** Rule 18's `req`, numbered per connection. */
  nextReq = 1;
  /** This renderer's last valid `placement` and `stats`. */
  placement: C3Message | null = null;
  stats: Stats | null = null;
  frame: Box | null = null;
  capsules: Capsule[] = [];
  /** `capsules` are in global points rather than window points. */
  capsulesGlobal = false;
  capsulesAt = -Infinity;
  dragging = false;
  /** Rule 56: a `right_drag` `down` came and its `up` has not; rule 57: her last `moving`. */
  rightHeld = false;
  moving = false;
  /** The tier she runs at when neither hidden nor paused, as last worked out. */
  tier: FpsTier = 'working';
  /** Rules 34, 41: where `cursor.hit` stays false, in global points (setHitExclusions). */
  above: Box[] = [];
  passThrough: Box[] = [];
  /** Rule 49: when the last `camera.live` sample went out, and the newest one waiting for its turn. */
  cameraLiveAt = -Infinity;
  cameraLivePending: C3Message | null = null;
  traceEpoch = 0;
  /** Receive times of the last LINK_LIMITS.traceRate `trace` and receiptRate forwarded receipts and `motion_state`. */
  traceTimes: number[] = [];
  receiptTimes: number[] = [];
  /** `turn_generation` of each behavior whose last receipt was not terminal (rule 25). */
  readonly openBehaviors = new Map<string, number>();
  /** The last `playback` of each speech `started` and not yet ended (rule 23). */
  readonly openSpeech = new Map<string, { clause_id: unknown; sample: number; rate: number }>();
  lastCursor: { x: number; y: number; inside: boolean; hit: boolean } | null = null;
  lastCursorAt = -Infinity;
  lastPoint: { x: number; y: number } | null = null;
  readonly kinematics = new CursorKinematics();
  pointerSent: PointerState = { speed: 0, hoverMs: 0, near: false, shake: false };
  pointerAt = -Infinity;
  /** Lines not yet handed to the socket; a `cursor`, `pointer` or `surfaces` replaces the queued one of its type. */
  out: { line: string; key: string | null; bytes: number }[] = [];
  outBytes = 0;
  constructor(socket: Socket) {
    this.socket = socket;
  }
  get capabilities(): string[] {
    return this.hello?.capabilities ?? [];
  }
}

const now = () => performance.now() / 1000;
const sameTable = (a: Record<string, boolean>, b: Record<string, boolean>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export class HostLink {
  private readonly options: LinkOptions;
  private server: Server | null = null;
  private conn: Connection | null = null;
  private candidate: Connection | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private cursorTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private listeners = new Set<(e: LinkEvent) => void>();
  private _listening = false;
  private _startError: string | null = null;
  private readonly acks = new Map<number, { type: string; timer: ReturnType<typeof setTimeout>; done?: (r: CommandResult) => void }>();
  /** Rules 50, 51: open until the reply that follows their `ack`. */
  private readonly captures = new Map<number, { acked: boolean; resolve(r: { file: string; width: number; height: number }): void;
    reject(e: Error): void }>();
  private readonly overrideRequests = new Map<number, { acked: boolean; resolve(r: MotionOverridesReceipt): void; reject(e: Error): void }>();
  /** Rule 39: across connections, as HostLink's attentionAt and attentionGeneration. */
  private attentionAt = -Infinity;
  private attentionGeneration = 0;
  /** Kept across reconnects; rule 13. */
  private _hidden = false;
  /** 临时全部点穿; kept across reconnects, off at launch. */
  private _clickThroughAll = false;
  /** HostLink.cursorMovedPending: the next cursor sample goes past the gate of a still pointer once. */
  private cursorMovedPending = false;
  /** Lock or sleep, as setSystemPaused last said; kept across reconnects. */
  private systemPaused = false;
  /** For the fps tier, as setInteractionVisible and noteLine last said. */
  private conversationVisible = false;
  private bubbleVisible = false;
  private lineAt = -Infinity;
  private fpsValues: ReturnType<LinkOptions['fps']> | null = null;
  private lastTraceEpoch = 0;
  private character: string | null = null;
  private appearance: string | null = null;
  private pipeline: C3Message | null = null;
  /** The last list without an error per character; dropped with the link. */
  private latestActions = new Map<string, Actions>();
  private listWaiters = new Set<{ character: string; notReady: boolean; resolve(a: Actions): void; reject(e: Error): void }>();
  private playWaiters = new Map<string, { resolve(): void; reject(e: Error): void }>();
  /** The `play_id` playAction sent last, until a final `action_played` of it. */
  private playing: string | null = null;
  private playCounter = 0;
  private appearanceOptions: AppearanceOption[] = [];
  private layerOptions: LayerOption[] = [];
  private hiddenList: string[] = [];
  private characterRequest: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private timedOutCharacter: string | null = null;
  private appearanceRequest: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private layersRequest: { hidden: string[]; timer: ReturnType<typeof setTimeout> } | null = null;
  /** One entry per `set_action_switches` sent, oldest first; null for one sent on a list (rule 28). */
  private switchQueue: ({ resolve(r: SwitchReply): void; reject(e: Error): void } | null)[] = [];
  private readonly modRequests = new Map<number, { acked: boolean; resolve(r: ModReceipt): void; reject(e: Error): void }>();

  constructor(options: LinkOptions) {
    this.options = options;
  }

  get listening(): boolean { return this._listening; }
  get startError(): string | null { return this._startError; }
  get path(): string { return this.options.path; }
  /** An avatar's hello has arrived on the current connection. */
  get connected(): boolean { return this.conn?.hello != null; }
  get hello(): AvatarHello | null { return this.conn?.hello ?? null; }
  get capabilities(): string[] { return this.conn?.capabilities ?? []; }
  get currentCharacter(): string | null { return this.character; }
  get currentAppearance(): string | null { return this.appearance; }
  get hidden(): boolean { return this._hidden; }
  /** Rule 57: she walks, as her last `moving` on the current connection says. */
  get moving(): boolean { return this.conn?.moving ?? false; }
  /** HostLink.clickThroughAll: every `cursor` goes out with `hit` false while on, except during a drag. */
  get clickThroughAll(): boolean { return this._clickThroughAll; }
  set clickThroughAll(on: boolean) {
    if (this._clickThroughAll !== on) this.cursorMovedPending = true;
    this._clickThroughAll = on;
  }
  get lastStats(): Stats | null { return this.conn?.hello != null ? this.conn.stats : null; }
  get lastPipeline(): C3Message | null { return this.pipeline; }
  get lastPlacement(): C3Message | null { return this.conn?.hello != null ? this.conn.placement : null; }
  /** Her window's last `window_frame` in global points; null without one. */
  get avatarFrame(): Box | null { return this.conn?.hello != null ? this.conn.frame : null; }
  /** What this link lists in its hello: COMPANION_CAPABILITIES, then each of these only with what it needs, a receiver of
   *  the lines for `trace`, `behavior_receipt` and `motion_requests` and a cursor for `pointer`; then, in this
   *  order, the ones of the other receivers, `touchSettings` and `offers`. */
  get companionCapabilities(): string[] {
    const o = this.options, offers: readonly string[] = o.offers ?? [];
    const given: Record<string, unknown> = { presentation: o.onPresentationState, drop: o.onDrop, reactions: o.onReaction, touch: o.touchSettings,
      poses: o.onPoseState, camera_gesture: o.onCameraGesture, surfaces: o.onSurfaceTrack, opacity: o.onSurfaceTrack, layering: o.onSurfaceTrack,
      right_drag: o.onRightDrag, moving: o.onMoving };
    const later = ['presentation', 'drop', 'reactions', 'pass_through', 'render_live', 'ambient', 'touch', 'poses', 'camera_free', 'camera_track',
      'camera_gesture', 'filters', 'capture', 'motion_overrides', 'play_chain', 'photo', 'camera_bust', 'surfaces', 'opacity', 'layering',
      'right_drag', 'moving'];
    return [...COMPANION_CAPABILITIES, ...(o.onTrace ? ['trace'] : []), ...(o.onBehaviorReceipt ? ['behavior_receipt'] : []),
      ...(o.cursor ? ['pointer'] : []), ...(o.onMotionRequest ? ['motion_requests'] : []),
      ...later.filter((x) => given[x] !== undefined || offers.includes(x))];
  }
  /** Both this link and the handshaken avatar list `capability`. */
  private both(c: Connection, capability: string): boolean {
    return c.capabilities.includes(capability) && this.companionCapabilities.includes(capability);
  }
  /** Her appearances and outfit layers as she last reported them; empty when she has none. */
  get appearances(): AppearanceOption[] { return this.appearanceOptions; }
  get layers(): LayerOption[] { return this.layerOptions; }
  get hiddenLayers(): string[] { return this.hiddenList; }
  /** A `set_appearance` or `set_layers` waits for its reply. */
  get appearanceSwitching(): boolean { return this.appearanceRequest !== null; }
  get layersSwitching(): boolean { return this.layersRequest !== null; }
  /** A `set_character` waits for its reply (rule 14). */
  get characterSwitching(): boolean { return this.characterRequest !== null; }
  /** `hit` of the last C3 `cursor` sent on the current connection; false before one. */
  get lastCursorHit(): boolean { return this.conn?.lastCursor?.hit === true; }

  on(listener: (e: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listens (unix) or begins connecting (pipe); a unix start that fails leaves `startError` set. */
  async start(): Promise<void> {
    this.stopped = false;
    this.tickTimer = setInterval(() => this.tick(), LINK_TIMING.tick * 1000);
    if (this.options.cursor) this.cursorTimer = setInterval(() => this.sampleCursor(), CURSOR.sample * 1000);
    if (this.options.transport === 'pipe') {
      this._listening = true;
      this.dial();
      return;
    }
    try {
      await this.listen();
      this._listening = true;
      this._startError = null;
    } catch (e) {
      this._startError = e instanceof Error ? e.message : String(e);
      this.options.log(`host link not listening: ${this._startError}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.conn) this.close(this.conn, 'stop');
    if (this.candidate) this.close(this.candidate, 'stop');
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.tickTimer = this.cursorTimer = this.reconnectTimer = null;
    if (this.server) {
      this.server.close();
      this.server = null;
      try { unlinkSync(this.options.path); } catch { /* already gone */ }
    }
    this._listening = false;
  }

  private async listen(): Promise<void> {
    const path = this.options.path;
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH) throw new Error(`socket 路径超过 ${MAX_SOCKET_PATH} 字节：${path}`);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A symlinked or foreign socket directory would let another user reach or replace the socket.
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error(`socket 目录不是本用户的普通目录：${dir}`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    try { unlinkSync(path); } catch { /* no stale socket */ }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => this.options.log(`host link server error: ${e.message}`));
    this.server = server;
  }

  /** Windows: the renderer owns the pipe; tries again every 0.5 s until it connects. */
  private dial(): void {
    if (this.stopped || this.conn || this.candidate) return;
    const socket = connect(this.options.path);
    socket.once('connect', () => this.accept(socket));
    socket.once('error', () => {
      socket.destroy();
      if (this.candidate?.socket !== socket && this.conn?.socket !== socket) this.redial();
    });
  }

  private redial(): void {
    if (this.stopped || this.options.transport !== 'pipe' || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, LINK_TIMING.reconnect * 1000);
  }

  private accept(socket: Socket): void {
    if (this.candidate) this.close(this.candidate, 'replaced before hello');
    const c = new Connection(socket);
    this.candidate = c;
    this.options.log('avatar connected');
    socket.on('data', (chunk: Buffer) => this.readable(c, chunk));
    socket.on('drain', () => this.flush(c));
    socket.on('error', (e) => this.close(c, `read: ${e.message}`));
    socket.on('close', () => this.close(c, 'EOF'));
  }

  private readable(c: Connection, chunk: Buffer): void {
    if (this.conn !== c && this.candidate !== c) return;
    let lines: string[];
    try {
      lines = c.framer.append(chunk);
    } catch (e) {
      return this.close(c, e instanceof Error ? e.message : String(e));
    }
    for (const line of lines) {
      if (this.conn !== c && this.candidate !== c) return;
      const t = now();
      c.lineTimes.push(t);
      if (c.lineTimes.length > LINK_TIMING.floodLines) {
        if (t - c.lineTimes.shift()! < 1) return this.close(c, 'flood');
      }
      const m = decodeLine(line);
      c.lineBytes = Buffer.byteLength(line);
      if (m !== null) this.handle(m, c);
    }
  }

  private emit(e: LinkEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  private handle(m: C3Message, c: Connection): void {
    if (c.hello === null) {
      const hello = avatarHello(m);
      if (hello !== null) this.handshake(hello, c);
      return;
    }
    switch (m.type) {
      case 'heartbeat': {
        if (typeof m.click_through !== 'boolean') return;
        const verdict = c.watchdog?.heartbeat(m as Heartbeat, now());
        if (verdict && 'log' in verdict) this.options.log('heartbeat resumed');
        break;
      }
      case 'stats': c.stats = m as Stats; break;
      case 'pipeline': this.pipeline = m; break;
      case 'window_frame': {
        const f = m.frame as Record<string, unknown> | null;
        const [x, y, w, h] = [f?.x, f?.y, f?.w, f?.h];
        if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return;
        c.frame = { x, y, w, h };
        break;
      }
      case 'hit_capsules':
        c.capsules = readCapsules(m.capsules);
        c.capsulesGlobal = m.space === 'global';
        c.capsulesAt = now();
        break;
      case 'drag':
        if (m.phase === 'begin') {
          c.dragging = true;
          this.options.onDragBegin?.();
        }
        if (m.phase === 'end') {
          c.dragging = false;
          if (typeof m.x === 'number' && typeof m.y === 'number') {
            this.options.onDragRelease?.({ x: m.x, y: m.y }, [...new Set([c.hello.pid, this.options.pid])]);
          }
        }
        break;
      case 'trace': if (!this.handleTrace(m, c)) return; break;
      case 'behavior_receipt': if (!this.handleReceipt(m, c)) return; break;
      case 'motion_state': if (!this.handleMotionState(m, c)) return; break;
      case 'motion_request': if (!this.handleMotionRequest(m, c)) return; break;
      case 'placement': {
        const p = readPlacement(m);
        if ('rejected' in p) return this.options.log(`rejected type=placement why=${p.rejected}`);
        c.placement = m;
        break;
      }
      case 'ack': this.handleAck(m); break;
      case 'character_changed': case 'character_change_failed': if (!this.handleCharacterReply(m)) return; break;
      case 'appearance_changed': case 'appearance_change_failed': if (!this.handleAppearanceReply(m)) return; break;
      case 'layers_changed': case 'layers_change_failed': if (!this.handleLayersReply(m)) return; break;
      case 'mod_settings': this.handleModSettings(m, c); return;
      case 'action_switches': this.handleSwitchReply(m); break;
      case 'actions': this.handleActions(m as Actions); break;
      case 'action_played': if (!this.handlePlayed(m as ActionPlayed, c)) return; break;
      case 'click': if (!this.handleClick(m, c)) return; break;
      case 'presentation_state': if (!this.handlePresentationState(m, c)) return; break;
      case 'speech_cancelled': if (!this.handleSpeechCancelled(m)) return; break;
      case 'playback': if (!this.handlePlayback(m, c)) return; break;
      case 'motion_overrides': if (!this.handleMotionOverrides(m, c)) return; break;
      case 'track_surface': case 'untrack_surface': case 'attach': if (!this.handleSurfaceTrack(m, c)) return; break;
      case 'drop': if (!this.handleDrop(m, c)) return; break;
      case 'reaction': if (!this.handleReaction(m)) return; break;
      case 'motion.stroke': if (!this.handleMotionStroke(m)) return; break;
      case 'pose_state': if (!this.handlePoseState(m, c)) return; break;
      case 'captured': if (!this.handleCaptured(m, c)) return; break;
      case 'camera_gesture': if (!this.handleCameraGesture(m, c)) return; break;
      case 'right_drag': if (!this.handleRightDrag(m, c)) return; break;
      case 'moving': if (!this.handleMoving(m, c)) return; break;
    }
    this.emit({ kind: 'message', message: m });
  }

  /** Logs `rejected type=… why=…` for a problem; true when there is none. */
  private accepted(m: C3Message, why: string | null): boolean {
    if (why !== null) this.options.log(`rejected type=${m.type} why=${why}`);
    return why === null;
  }

  /** Rule 10: a single click or the right button needs her window's frame. */
  private handleClick(m: C3Message, c: Connection): boolean {
    if (!this.options.onClick) return true;
    if (!this.accepted(m, clickProblem(m, this.both(c, 'touch')))) return false;
    if (m.button === 'left' && m.count === 2) {
      this.options.onClick({ kind: 'double' });
      return true;
    }
    if (!c.frame) return this.accepted(m, 'window_frame');
    const at = { x: c.frame.x + (m.x as number), y: c.frame.y + (m.y as number) };
    this.options.onClick(m.button === 'right' ? { kind: 'right', at } : { kind: 'left', at, region: (m.region as string | undefined) ?? null });
    return true;
  }

  /** CONTRACT「Optional presentation capability」: a state of the character she shows. */
  private handlePresentationState(m: C3Message, c: Connection): boolean {
    if (!this.options.onPresentationState) return true;
    const why = this.both(c, 'presentation') ? presentationStateProblem(m, this.character) : 'capability';
    if (!this.accepted(m, why)) return false;
    const { v: _v, type: _type, ...body } = m;
    this.options.onPresentationState!(body);
    return true;
  }

  private handleSpeechCancelled(m: C3Message): boolean {
    if (!this.options.onSpeechCancelled) return true;
    if (!this.accepted(m, speechCancelledProblem(m))) return false;
    this.options.onSpeechCancelled(m.speech_id as string, SPEECH_CANCEL_REASONS[m.reason as string]!);
    return true;
  }

  /** Rule 23: forwarded without `v` and `type`; the speeches it opens are kept for a drop. */
  private handlePlayback(m: C3Message, c: Connection): boolean {
    if (!this.options.onPlayback) return true;
    if (!this.accepted(m, playbackProblem(m))) return false;
    const id = m.speech_id as string, last = { clause_id: m.clause_id, sample: m.sample as number, rate: m.rate as number };
    if (['ended', 'interrupted', 'failed'].includes(m.state as string)) c.openSpeech.delete(id);
    else if (m.state === 'started' || c.openSpeech.has(id)) c.openSpeech.set(id, last);
    const { v: _v, type: _type, ...body } = m;
    this.options.onPlayback(body);
    return true;
  }

  /** Rule 51 (g): ends the open `set_motion_overrides` of the same `req` once its `ack` came. */
  private handleMotionOverrides(m: C3Message, c: Connection): boolean {
    const receipt = c.capabilities.includes('motion_overrides') ? readMotionOverrides(m) : 'capability';
    if (typeof receipt === 'string') return this.accepted(m, receipt);
    const open = this.overrideRequests.get(receipt.req);
    if (!open?.acked) {
      this.options.log(`motion_overrides req=${receipt.req} ignored: no acked request for it`);
      return false;
    }
    this.overrideRequests.delete(receipt.req);
    const a = receipt.applied;
    this.options.log(`motion_overrides req=${receipt.req} character=${receipt.character} applied=${a.chains},${a.pools},${a.blend_in} `
      + `adjusted=${receipt.adjusted.length}`);
    open.resolve(receipt);
    return true;
  }

  /** Rules 32–34: for the surface source when this link has one and she lists `surfaces` (`layering` for `attach`). */
  private handleSurfaceTrack(m: C3Message, c: Connection): boolean {
    if (!this.options.onSurfaceTrack) return true;
    const listed = this.both(c, 'surfaces') && (m.type !== 'attach' || this.both(c, 'layering'));
    const why = !listed ? 'capability' : m.type === 'attach' ? attachProblem(m) : surfaceTrackProblem(m);
    if (!this.accepted(m, why)) return false;
    const trackId = m.track_id as string;
    this.options.log(`${m.type} track_id=${String(trackId)}`);
    // The rects above the attached window change with it.
    if (m.type === 'attach') this.cursorMovedPending = true;
    this.options.onSurfaceTrack!(m.type === 'attach' ? { kind: 'attach', trackId }
      : m.type === 'untrack_surface' ? { kind: 'untrack', trackId }
        : { kind: 'track', trackId, windowId: m.window_id as number, generation: (m.generation as number | undefined) ?? null });
    return true;
  }

  /** Rule 38: both sides list `drop`. */
  private handleDrop(m: C3Message, c: Connection): boolean {
    if (!this.options.onDrop) return true;
    if (!this.accepted(m, this.both(c, 'drop') ? dropProblem(m) : 'capability')) return false;
    this.options.onDrop!({ items: m.items as Record<string, string>[], x: m.x as number, y: m.y as number, truncated: m.truncated === true });
    return true;
  }

  /** Rule 55: only this link lists `reactions`. */
  private handleReaction(m: C3Message): boolean {
    if (!this.accepted(m, this.companionCapabilities.includes('reactions') ? reactionProblem(m) : 'capability')) return false;
    this.options.onReaction!(m.trigger as ReactionTrigger);
    return true;
  }

  /** Rule 39. */
  private handleMotionStroke(m: C3Message): boolean {
    if (!this.options.onMotionStroke) return true;
    if (!this.accepted(m, motionStrokeProblem(m))) return false;
    this.options.onMotionStroke(m.token as string, m.clip as string);
    return true;
  }

  /** Rule 47. */
  private handlePoseState(m: C3Message, c: Connection): boolean {
    if (!this.options.onPoseState) return true;
    if (!this.accepted(m, this.both(c, 'poses') ? poseStateProblem(m) : 'capability')) return false;
    this.options.log(`pose_state character=${String(m.character)} id=${String(m.id)} locked=${String(m.locked)}`);
    this.options.onPoseState!({ character: m.character as string, id: m.id as string | null, locked: m.locked as boolean });
    return true;
  }

  /** Rule 50 (b): ends the open `capture` of the same `req` once its `ack` came. */
  private handleCaptured(m: C3Message, c: Connection): boolean {
    if (!this.accepted(m, c.capabilities.includes('capture') ? capturedProblem(m) : 'capability')) return false;
    const req = m.req as number, file = m.file as string, open = this.captures.get(req);
    if (!open?.acked) {
      this.options.log(`captured req=${req} file=${file} ignored: no acked capture for it`);
      return false;
    }
    this.captures.delete(req);
    this.options.log(`captured req=${req} file=${file} width=${String(m.width)} height=${String(m.height)}`);
    open.resolve({ file, width: m.width as number, height: m.height as number });
    return true;
  }

  /** Rule 49 (h); `changed` comes per pointer event, so only `began` and `ended` are logged. */
  private handleCameraGesture(m: C3Message, c: Connection): boolean {
    if (!this.options.onCameraGesture) return true;
    if (!this.accepted(m, this.both(c, 'camera_gesture') ? cameraGestureProblem(m) : 'capability')) return false;
    if (m.phase !== 'changed') this.options.log(`camera_gesture phase=${String(m.phase)}`);
    this.options.onCameraGesture!({ phase: m.phase as CameraGesture['phase'], dx: m.dx as number, dy: m.dy as number, zoom: m.zoom as number });
    return true;
  }

  /** Rule 56: a move or up only after its down; the held press keeps the hit. */
  private handleRightDrag(m: C3Message, c: Connection): boolean {
    if (!this.options.onRightDrag) return true;
    if (!this.accepted(m, this.both(c, 'right_drag') ? rightDragProblem(m) : 'capability')) return false;
    if (m.phase !== 'down' && !c.rightHeld) return this.accepted(m, 'no_down');
    if (m.phase !== 'move') this.options.log(`right_drag phase=${String(m.phase)}`);
    c.rightHeld = m.phase !== 'up';
    this.cursorMovedPending = true;
    this.options.onRightDrag({ phase: m.phase as RightDragEvent['phase'], at: { x: m.x as number, y: m.y as number } });
    return true;
  }

  private handleMoving(m: C3Message, c: Connection): boolean {
    if (!this.options.onMoving) return true;
    if (!this.accepted(m, this.both(c, 'moving') ? movingProblem(m) : 'capability')) return false;
    c.moving = m.moving as boolean;
    this.options.log(`moving ${c.moving}`);
    this.options.onMoving(c.moving);
    return true;
  }

  private handshake(hello: AvatarHello, c: Connection): void {
    if (this.candidate === c) {
      // The connected renderer keeps the link until its connection closes.
      if (this.conn) return this.close(c, 'refused: a renderer is connected');
      this.candidate = null;
      this.conn = c;
    }
    c.hello = hello;
    c.watchdog = new Watchdog(now());
    this.character = typeof hello.character === 'string' && hello.character !== '' ? hello.character : 'aster';
    const character = this.character;
    const capabilities = this.companionCapabilities;
    if (capabilities.includes('trace')) {
      c.traceEpoch = this.options.traceEpoch?.() ?? Math.max(this.lastTraceEpoch + 1, Date.now());
      this.lastTraceEpoch = c.traceEpoch;
    }
    this.write(c, companionHello(this.options.pid, this.options.build, capabilities, c.traceEpoch));
    if (this._hidden) this.command(c, { v: 1, type: 'set_visible', visible: false });
    this.updateFpsTier(c, true);
    // The touch switches after the tier.
    this.sendTouchSettings(c);
    this.options.log(`hello character=${character} capabilities=${c.capabilities.join(',')}`);
    this.emit({ kind: 'hello', hello });
    this.emit({ kind: 'character', event: { kind: 'current', id: character } });
    this.reportLooks(hello, character, true);
    // Rule 53 (g): one `set_mod_settings` per remembered appearance she lists.
    if (!c.capabilities.includes('mod_settings')) return;
    const listed = this.appearanceOptions.map((a) => a.id);
    const stored = this.options.remembered?.modSettings(character) ?? {};
    for (const appearance of Object.keys(stored).sort()) {
      if (listed.length > 0 && !listed.includes(appearance)) continue;
      this.sendModSettings(c, character, appearance, stored[appearance]!).then((receipt) => this.emit({ kind: 'modSettings', receipt }),
        (e: Error) => this.options.log(`set_mod_settings appearance=${appearance} at hello failed: ${e.message}`));
    }
  }

  /** Rule 22: at most LINK_LIMITS.traceRate lines a second of 1–traceEvents events; the valid events go to onTrace. */
  private handleTrace(m: C3Message, c: Connection): boolean {
    const t = now();
    if (c.traceTimes.length >= LINK_LIMITS.traceRate && t - c.traceTimes[0]! < 1) {
      this.options.log('rejected type=trace why=rate');
      return false;
    }
    c.traceTimes = [...c.traceTimes, t].slice(-LINK_LIMITS.traceRate);
    if (!Array.isArray(m.events) || m.events.length < 1 || m.events.length > LINK_LIMITS.traceEvents) {
      this.options.log('rejected type=trace why=events');
      return false;
    }
    const valid = m.events.filter((e: unknown, index) => {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        this.options.log(`rejected trace event index=${index} why=not_object`);
        return false;
      }
      const why = traceEventProblem(e as Record<string, unknown>, c.traceEpoch);
      if (why !== null) this.options.log(`rejected trace event index=${index} seq=${String((e as Record<string, unknown>).seq ?? '')} why=${why}`);
      return why === null;
    }) as Record<string, unknown>[];
    if (valid.length > 0) this.options.onTrace?.(valid);
    return true;
  }

  /** Rule 25: a terminal receipt always goes on; others at most LINK_LIMITS.receiptRate a second. */
  private handleReceipt(m: C3Message, c: Connection): boolean {
    const why = behaviorReceiptProblem(m);
    if (why !== null) {
      this.options.log(`rejected type=behavior_receipt why=${why}`);
      return false;
    }
    const id = m.behavior_id as string, terminal = TERMINAL_BEHAVIOR_PHASES.includes(m.phase as string);
    if (terminal) c.openBehaviors.delete(id);
    else c.openBehaviors.set(id, m.turn_generation as number);
    const t = now();
    if (!terminal && c.receiptTimes.length >= LINK_LIMITS.receiptRate && t - c.receiptTimes[0]! < 1) {
      this.options.log('rejected type=behavior_receipt why=rate');
      return false;
    }
    c.receiptTimes = [...c.receiptTimes, t].slice(-LINK_LIMITS.receiptRate);
    const { v: _v, type: _type, ...body } = m;
    this.options.onBehaviorReceipt?.(body);
    return true;
  }

  /** Rule 54: counted in rule 25's receipts a second; past them it is dropped. */
  private handleMotionState(m: C3Message, c: Connection): boolean {
    if (!this.accepted(m, this.both(c, 'behavior_receipt') ? motionStateProblem(m) : 'capability')) return false;
    const t = now();
    if (c.receiptTimes.length >= LINK_LIMITS.receiptRate && t - c.receiptTimes[0]! < 1) return this.accepted(m, 'rate');
    c.receiptTimes = [...c.receiptTimes, t].slice(-LINK_LIMITS.receiptRate);
    const { v: _v, type: _type, ...body } = m;
    this.options.onMotionState?.(body);
    return true;
  }

  /** Rule 40: forwarded when this link listed `motion_requests`; no reply line. */
  private handleMotionRequest(m: C3Message, c: Connection): boolean {
    const listed = this.options.onMotionRequest && c.capabilities.includes('motion_requests');
    const why = listed ? motionRequestProblem(m, c.lineBytes) : 'capability';
    if (why !== null) {
      this.options.log(`rejected type=motion_request why=${why}`);
      return false;
    }
    const { v: _v, type: _type, ...body } = m;
    this.options.onMotionRequest!(body);
    return true;
  }

  /** reportAppearances: her appearance and layer lists, as a hello or `character_changed` reports them. */
  private reportLooks(m: C3Message, character: string, atHello: boolean): void {
    const looks = readAppearances(m);
    if (looks.problem !== null) this.options.log(`appearance fields of ${character} ignored: ${looks.problem}`);
    this.appearance = looks.current;
    this.appearanceOptions = looks.options;
    this.emit({ kind: 'appearance', event: { kind: 'list', character, current: looks.current, options: looks.options, atHello } });
    const layers = readLayers(m);
    if (layers !== null && 'problem' in layers) this.options.log(`layers fields dropped: ${layers.problem}`);
    const ok = layers !== null && !('problem' in layers) ? layers : { layers: [], hidden: [] };
    this.layerOptions = ok.layers;
    this.hiddenList = ok.hidden;
    this.emit({ kind: 'layers', event: { kind: 'list', character, layers: ok.layers, hidden: ok.hidden, atHello } });
  }

  /** Rule 14: the reply to the open `set_character`, or a `character_changed` after its timeout; false when it is dropped. */
  private handleCharacterReply(m: C3Message): boolean {
    const id = typeof m.id === 'string' ? m.id : '', reason = typeof m.reason === 'string' ? m.reason : '';
    const request = this.characterRequest;
    if (request === null || request.id !== id) {
      if (id !== '' && id === this.timedOutCharacter) {
        this.timedOutCharacter = null;
        this.options.log(`${m.type} id=${id} reason=${reason} came after the timeout`);
        if (m.type === 'character_changed') {
          this.character = id;
          this.emit({ kind: 'character', event: { kind: 'lateChanged', id } });
          this.reportLooks(m, id, false);
          return true;
        }
        return false;
      }
      this.options.log(`${m.type} id=${id} reason=${reason} ignored: no open request for it`);
      return false;
    }
    clearTimeout(request.timer);
    this.characterRequest = null;
    this.timedOutCharacter = null;
    this.options.log(`${m.type} id=${id} ms=${String(m.ms ?? '')} reason=${reason}`);
    if (m.type === 'character_changed') {
      this.character = id;
      this.emit({ kind: 'character', event: { kind: 'changed', id } });
      this.reportLooks(m, id, false);
    } else {
      this.emit({ kind: 'character', event: { kind: 'failed', id, reason } });
    }
    return true;
  }

  /** Rule 16: the reply to the open `set_appearance`; false when it is dropped. */
  private handleAppearanceReply(m: C3Message): boolean {
    const id = typeof m.id === 'string' ? m.id : '', reason = typeof m.reason === 'string' ? m.reason : '';
    const request = this.appearanceRequest;
    if (request === null || request.id !== id) {
      this.options.log(`${m.type} id=${id} reason=${reason} ignored: no open request for it`);
      return false;
    }
    clearTimeout(request.timer);
    this.appearanceRequest = null;
    this.options.log(`${m.type} id=${id} reason=${reason}`);
    if (m.type === 'appearance_changed') {
      this.appearance = id;
      this.emit({ kind: 'appearance', event: { kind: 'changed', id } });
    } else {
      this.emit({ kind: 'appearance', event: { kind: 'failed', id, reason } });
    }
    return true;
  }

  /** Rule 46 (b): a valid reply is reported whether or not a `set_layers` is open, and ends the open one. */
  private handleLayersReply(m: C3Message): boolean {
    const failed = m.type === 'layers_change_failed', hidden = m.hidden;
    if (!Array.isArray(hidden) || !hidden.every((h) => typeof h === 'string')
      || (failed && !LAYER_FAIL_REASONS.includes(m.reason as string))) {
      this.options.log(`rejected ${m.type} hidden=${JSON.stringify(m.hidden ?? '')} reason=${String(m.reason ?? '')}`);
      return false;
    }
    if (this.layersRequest) clearTimeout(this.layersRequest.timer);
    this.layersRequest = null;
    this.options.log(`${m.type} hidden=${hidden.join(',')}${failed ? ` reason=${String(m.reason)}` : ''}`);
    if (!failed) this.hiddenList = hidden;
    this.emit({ kind: 'layers', event: failed ? { kind: 'failed', hidden, reason: m.reason as string } : { kind: 'changed', hidden } });
    return true;
  }

  /** Rule 53 (b), (e): ends the open `set_mod_settings` of the same `req` once its `ack` came; `req` null is her own report. */
  private handleModSettings(m: C3Message, c: Connection): void {
    if (!c.capabilities.includes('mod_settings')) return this.options.log('rejected type=mod_settings why=capability');
    const receipt = readModReceipt(m);
    if (typeof receipt === 'string') return this.options.log(`rejected type=mod_settings why=${receipt}`);
    const summary = `character=${receipt.character} appearance=${receipt.appearance} values=${Object.keys(receipt.values).length} `
      + `adjusted=${receipt.adjusted.length}`;
    if (receipt.req === null) return this.options.log(`mod_settings req=null ${summary}`);
    const open = this.modRequests.get(receipt.req);
    if (!open?.acked) return this.options.log(`mod_settings req=${receipt.req} ignored: no acked request for it`);
    this.modRequests.delete(receipt.req);
    this.options.log(`mod_settings req=${receipt.req} ${summary}`);
    open.resolve(receipt);
  }

  /** Rule 28: one `action_switches` per `set_action_switches`, in order. */
  private handleSwitchReply(m: C3Message): void {
    const reply = readSwitchReply(m);
    if (typeof reply === 'string') return this.options.log(`rejected type=action_switches why=${reply}`);
    if (this.switchQueue.length === 0) return this.options.log('action_switches without a request');
    const waiter = this.switchQueue.shift()!;
    const latest = this.latestActions.get(reply.character);
    if (reply.error === undefined && latest) this.latestActions.set(reply.character, { ...latest, switches: reply.switches });
    waiter?.resolve(reply);
  }

  private close(c: Connection, reason: string): void {
    const wasActive = this.conn === c;
    if (this.candidate === c) this.candidate = null;
    else if (wasActive) this.conn = null;
    else return;
    c.socket.destroy();
    c.out = [];
    c.outBytes = 0;
    this.options.log(`avatar disconnected: ${reason}`);
    // Rule 25: behaviors not yet terminal end as connection_lost.
    const atMs = Date.now();
    for (const [id, generation] of [...c.openBehaviors].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.options.onBehaviorReceipt?.({ behavior_id: id, phase: 'cancelled', reason: 'connection_lost', at_ms: atMs, turn_generation: generation });
    }
    c.openBehaviors.clear();
    // Rule 23: speeches still playing end as connection_lost.
    for (const [id, open] of [...c.openSpeech].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      this.options.onPlayback?.({ speech_id: id, clause_id: open.clause_id, state: 'interrupted', reason: 'connection_lost', sample: open.sample,
        rate: open.rate });
    }
    c.openSpeech.clear();
    // Rule 57: the link's end is moving false.
    if (wasActive && c.moving) {
      c.moving = false;
      this.options.onMoving?.(false);
    }
    if (wasActive) {
      this.latestActions.clear();
      this.playing = null;
      for (const w of this.listWaiters) w.reject(disconnected());
      for (const w of this.playWaiters.values()) w.reject(disconnected());
      this.listWaiters.clear();
      this.playWaiters.clear();
      const acks = [...this.acks.values()];
      this.acks.clear();
      for (const a of acks) clearTimeout(a.timer);
      // stop() closes on quit, where a failure would make the caller restart her.
      if (reason !== 'stop') for (const a of acks) a.done?.({ ok: false, reason: 'disconnected' });
      for (const w of this.captures.values()) w.reject(new ActionFailure('failed', 'disconnected'));
      this.captures.clear();
      for (const w of this.overrideRequests.values()) w.reject(disconnected());
      this.overrideRequests.clear();
      for (const w of this.switchQueue.splice(0)) w?.reject(disconnected());
      for (const w of this.modRequests.values()) w.reject(disconnected());
      this.modRequests.clear();
      this.appearanceOptions = this.layerOptions = [];
      this.hiddenList = [];
      const character = this.characterRequest, appearance = this.appearanceRequest, layers = this.layersRequest;
      for (const r of [character, appearance, layers]) if (r) clearTimeout(r.timer);
      this.characterRequest = this.appearanceRequest = this.layersRequest = null;
      this.timedOutCharacter = null;
      if (character) this.emit({ kind: 'character', event: { kind: 'failed', id: character.id, reason: 'connection_lost' } });
      if (appearance) this.emit({ kind: 'appearance', event: { kind: 'failed', id: appearance.id, reason: 'connection_lost' } });
      if (layers) this.emit({ kind: 'layers', event: { kind: 'failed', hidden: layers.hidden, reason: 'connection_lost' } });
      this.emit({ kind: 'lost', reason });
    }
    this.redial();
  }

  private tick(): void {
    const c = this.conn;
    if (c) this.updateFpsTier(c, false);
    if (!c?.watchdog || c.watchdogFired) return;
    const verdict = c.watchdog.check(now(), this._hidden);
    if (verdict === null) return;
    if ('log' in verdict) return this.options.log('heartbeat stale 300 ms');
    c.watchdogFired = true;
    this.options.log(`watchdog kill pid=${c.hello?.pid} reason=${verdict.kill}`);
    this.emit({ kind: 'watchdog', pid: Number(c.hello?.pid), reason: verdict.kill });
  }

  /** Lines wait while the socket is backed up; a newer `cursor`, `pointer`, `surfaces` or
   *  `surface` of one track replaces the waiting one, and over LINK_LIMITS.outputBytes waiting closes the connection. */
  private write(c: Connection, m: C3Message): boolean {
    let line: string;
    try {
      line = encodeLine(m);
    } catch (e) {
      this.options.log(e instanceof Error ? e.message : String(e));
      return false;
    }
    const key = ['cursor', 'pointer', 'surfaces'].includes(m.type) ? m.type
      : m.type === 'surface' && typeof m.track_id === 'string' ? `surface:${m.track_id}` : null;
    if (key !== null) {
      for (const queued of c.out.filter((q) => q.key === key)) c.outBytes -= queued.bytes;
      c.out = c.out.filter((q) => q.key !== key);
    }
    const bytes = Buffer.byteLength(line);
    if (c.outBytes + c.socket.writableLength + bytes > LINK_LIMITS.outputBytes) {
      this.close(c, 'outgoing buffer full');
      return false;
    }
    c.out.push({ line, key, bytes });
    c.outBytes += bytes;
    this.flush(c);
    if (m.type === 'set_action_switches' || m.type === 'set_motion_overrides') {
      this.options.onMotionSettings?.(m.character as string);
    }
    return true;
  }

  private flush(c: Connection): void {
    while (c.out.length > 0 && !c.socket.writableNeedDrain && !c.socket.destroyed) {
      const next = c.out.shift()!;
      c.outBytes -= next.bytes;
      c.socket.write(next.line);
    }
  }

  /** Rule 18: a missing ack after 2 s is logged and `done` gets `timeout`. `done` gets the `ack`, or `disconnected` when
   *  the link drops. */
  private command(c: Connection, m: C3Message, done?: (r: CommandResult) => void): boolean {
    const req = c.nextReq++;
    const timer = this.after(LINK_TIMING.ack, () => {
      this.acks.delete(req);
      this.options.log(`ack timeout type=${m.type} req=${req}`);
      done?.({ ok: false, reason: 'timeout' });
    });
    this.acks.set(req, { type: m.type, timer, done });
    return this.write(c, { ...m, req });
  }

  private handleAck(m: C3Message): void {
    const req = m.req as number, error = String(m.error ?? '');
    const overrides = this.overrideRequests.get(req);
    if (overrides && !overrides.acked) {
      if (m.ok !== false) {
        overrides.acked = true;
        return this.options.log(`ack req=${req} set_motion_overrides ok`);
      }
      this.overrideRequests.delete(req);
      this.options.log(`ack failed type=set_motion_overrides req=${req} error=${error}`);
      return overrides.reject(new ActionFailure('failed', error === 'busy' ? OVERRIDE_FAILURES.busy : OVERRIDE_FAILURES.refused));
    }
    const capture = this.captures.get(req);
    if (capture && !capture.acked) {
      if (m.ok !== false) {
        capture.acked = true;
        return this.options.log(`ack req=${req} capture ok`);
      }
      this.captures.delete(req);
      this.options.log(`ack failed type=capture req=${req} error=${error}`);
      return capture.reject(new ActionFailure(error === 'busy' || error === 'unsupported' ? error : 'failed', error));
    }
    const mod = typeof m.req === 'number' ? this.modRequests.get(m.req) : undefined;
    if (mod && !mod.acked) {
      if (m.ok !== false) {
        mod.acked = true;
        return this.options.log(`ack req=${m.req} set_mod_settings ok`);
      }
      this.modRequests.delete(m.req as number);
      const error = String(m.error ?? '');
      this.options.log(`ack failed type=set_mod_settings req=${m.req} error=${error}`);
      return mod.reject(new ActionFailure('failed', MOD_FAILURES[error === 'busy' ? 'busy' : 'refused']!));
    }
    const pending = typeof m.req === 'number' ? this.acks.get(m.req) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.acks.delete(m.req as number);
    if (m.ok !== true) this.options.log(`ack type=${pending.type} req=${m.req} error=${String(m.error)}`);
    pending.done?.(m.ok === false ? { ok: false, reason: error } : { ok: true });
  }

  /** `force` sends the tier, `paused` while hidden or paused; otherwise it goes out
   *  only when it changed and she is neither. */
  private updateFpsTier(c: Connection, force: boolean): void {
    if (force || this.fpsValues === null) this.fpsValues = this.options.fps();
    const t = now(), { idleLowFps, userFps, batteryLow } = this.fpsValues;
    const origin = c.capsulesGlobal ? { x: 0, y: 0 } : c.frame;
    const g = t - c.capsulesAt <= CURSOR.fresh && origin !== null ? this.options.cursor?.() : undefined;
    const hovering = g !== undefined && capsuleHit({ x: g.x - origin!.x, y: g.y - origin!.y }, c.capsules);
    const speaking = c.openSpeech.size > 0 || t - this.lineAt < LINK_TIMING.lineInteractive * (this.options.timeScale ?? 1);
    const tier = fpsTierFor({ idleLowFps, active: c.dragging || hovering || speaking || this.conversationVisible || this.bubbleVisible });
    const changed = c.tier !== tier;
    c.tier = tier;
    const paused = this.systemPaused || this._hidden;
    if (force || (changed && !paused)) this.command(c, fpsTier({ paused, tier, userFps, batteryLow }));
  }

  /** HostLink.updateFpsSettings: `fps()` changed (a saved setting); the tier and caps go out again. False without an avatar. */
  fpsSettingsChanged(): boolean {
    const c = this.conn;
    if (c?.hello == null) return false;
    this.updateFpsTier(c, true);
    return true;
  }

  /** HostLink.setInteractionVisible: `conversation`, the user has a quick input, comm or console open to type in; `bubble`,
   *  her bubble shows a line. Either keeps the `interactive` tier; a window merely on screen passes neither. */
  setInteractionVisible(conversation: boolean, bubble: boolean): void {
    this.conversationVisible = conversation;
    this.bubbleVisible = bubble;
    if (this.conn) this.updateFpsTier(this.conn, false);
  }

  /** HostLink.noteLine: a part of her line streamed or showed; the `interactive` tier for LINK_TIMING.lineInteractive. */
  noteLine(): void {
    this.lineAt = now();
    if (this.conn) this.updateFpsTier(this.conn, false);
  }

  /** HostLink.setSystemPaused: lock or sleep sends the `paused` tier, and the tier again after it unless hidden; kept for
   *  the next connection. False without an avatar. */
  setSystemPaused(paused: boolean): boolean {
    this.systemPaused = paused;
    const c = this.conn;
    if (c?.hello == null) return false;
    this.updateFpsTier(c, true);
    return true;
  }

  /** Rule 9: `rect` in window points, null without a target window; false without an avatar. */
  sendPointAt(nudgeId: string, rect: Box | null): boolean {
    return this.send({ v: 1, type: 'point_at', nudge_id: nudgeId, kind: 'alert', rect });
  }

  /** Rules 1, 2, 36: every CURSOR.sample s; `cursor` when it moved, near her or CURSOR.keepalive
   *  since the last, `pointer` at most every CURSOR.pointerInterval when it changed. */
  private sampleCursor(): void {
    const c = this.conn, f = c?.frame;
    if (!c?.hello || !f) return;
    const t = now(), g = this.options.cursor!();
    const fresh = t - c.capsulesAt <= CURSOR.fresh;
    const origin = c.capsulesGlobal ? { x: 0, y: 0 } : f;
    const box = capsulesBox(c.capsules);
    const globalBox = box && { ...box, x: box.x + origin.x, y: box.y + origin.y };
    const onBody = capsuleHit({ x: g.x - origin.x, y: g.y - origin.y }, c.capsules);
    c.kinematics.sample(t, g, globalBox, onBody);
    if (c.capabilities.includes('pointer') && t - c.pointerAt >= CURSOR.pointerInterval) {
      const s = c.kinematics.state(t), last = c.pointerSent;
      if (s.hoverMs !== last.hoverMs || s.near !== last.near || s.shake !== last.shake || Math.abs(s.speed - last.speed) >= CURSOR.pointerSpeedStep) {
        c.pointerSent = s;
        c.pointerAt = t;
        this.write(c, { v: 1, type: 'pointer', speed: s.speed, hover_ms: s.hoverMs, near: s.near, shake: s.shake });
      }
    }
    const p = { x: g.x - f.x, y: g.y - f.y }, hp = c.capsulesGlobal ? g : p;
    const grow = CURSOR.margin + CURSOR.near;
    const near = box !== null && hp.x >= box.x - grow && hp.x <= box.x + box.w + grow && hp.y >= box.y - grow && hp.y <= box.y + box.h + grow;
    const moved = this.cursorMovedPending || c.lastPoint === null || c.lastPoint.x !== g.x || c.lastPoint.y !== g.y;
    c.lastPoint = g;
    if (!moved && !near && t - c.lastCursorAt < CURSOR.keepalive) return;
    this.cursorMovedPending = false;
    // Rules 13, 14: hidden or switching, `hit` stays false; rule 2: a drag holds it true; rules 34, 41: not over a window
    // above the attached one or a control she lets through, nor while click-through all is on.
    // While a button is held the hit only stays on, and a press held since a hit goes past the pass-through rects.
    const pinnedOff = this._hidden || this.characterRequest !== null;
    const held = this.options.buttonsDown?.() ?? false, heldOnHer = held && c.lastCursor?.hit === true;
    const onCapsules = fresh && capsuleHit(hp, c.capsules) && !c.above.some((b) => boxContains(b, g)) && (!held || heldOnHer)
      && !(c.passThrough.some((b) => boxContains(b, g)) && !heldOnHer);
    const sample = { x: p.x, y: p.y, inside: p.x >= 0 && p.x < f.w && p.y >= 0 && p.y < f.h,
      hit: !pinnedOff && (c.dragging || c.rightHeld || (!this._clickThroughAll && onCapsules)) };
    const last = c.lastCursor;
    const same = last !== null && last.x === sample.x && last.y === sample.y && last.inside === sample.inside && last.hit === sample.hit;
    if (same && t - c.lastCursorAt < CURSOR.keepalive) return;
    c.lastCursor = sample;
    c.lastCursorAt = t;
    this.write(c, { v: 1, type: 'cursor', ...sample });
  }

  /** A mouse move or drag event; the next sample sends a `cursor` when it
   *  differs from the last, without waiting for the keepalive. */
  cursorMoved(): void {
    this.cursorMovedPending = true;
  }

  /** Rules 34, 41: `above` of the attached track's latest `surface` and the current pass-through rects, in global points
   *  as `cursor()` gives; `cursor.hit` is false over either from the next sample. For this connection; false without one. */
  setHitExclusions(rects: { above: Box[]; passThrough: Box[] }): boolean {
    const c = this.conn;
    if (c?.hello == null) return false;
    c.above = rects.above;
    c.passThrough = rects.passThrough;
    return true;
  }

  /** Sends to the handshaken avatar; false without one. */
  send(m: C3Message): boolean {
    const c = this.conn;
    return c?.hello != null && this.write(c, m);
  }

  /** Rule 5; false when no avatar has completed the handshake, so the caller stops it by signal. */
  sendQuit(reason: string): boolean {
    return this.send({ v: 1, type: 'quit', reason });
  }

  /** Rule 24: `turnGeneration` goes on the line only when she lists `turn_generation`. */
  stopSpeech(turnGeneration?: number): boolean {
    const m: C3Message = { v: 1, type: 'stop_speech', reason: 'barge_in' };
    if (turnGeneration !== undefined && this.capabilities.includes('turn_generation')) m.turn_generation = turnGeneration;
    return this.send(m);
  }

  /** Rule 13: kept for the next connection; hidden also sends the `paused` tier. False without an avatar. */
  setVisible(visible: boolean): boolean {
    this._hidden = !visible;
    const c = this.conn;
    if (c?.hello == null) return false;
    this.command(c, { v: 1, type: 'set_visible', visible });
    this.updateFpsTier(c, true);
    return true;
  }

  /** Rule 12: the window's bottom-left to (`x`, `y`) in C3's global coordinates; false without an avatar. */
  sendMoveWindow(x: number, y: number): boolean {
    const c = this.conn;
    return c?.hello != null && this.command(c, { v: 1, type: 'move_window', x, y });
  }

  /** Rule 19: the anchor (`x` and `y` together) and/or the scale; false without either, or an avatar that lists `placement`. */
  sendSetPlacement(p: { x?: number; y?: number; scale?: number }): boolean {
    const c = this.conn;
    if ((p.x === undefined) !== (p.y === undefined) || (p.x === undefined && p.scale === undefined)) return false;
    if (c?.hello == null || !c.capabilities.includes('placement')) return false;
    const m: C3Message = { v: 1, type: 'set_placement' };
    if (p.x !== undefined) Object.assign(m, { x: p.x, y: p.y });
    if (p.scale !== undefined) m.scale = p.scale;
    return this.command(c, m);
  }

  /** Waits while the avatar restarts, at most LINK_TIMING.relink seconds. */
  private async linked(): Promise<void> {
    const deadline = now() + LINK_TIMING.relink;
    while (!this.connected) {
      if (now() >= deadline) throw disconnected();
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private handleActions(m: Actions): void {
    if (typeof m.character !== 'string' || !Array.isArray(m.actions)) return;
    if (m.error !== undefined) {
      for (const w of this.listWaiters) {
        if (w.character !== m.character) continue;
        if (m.error === 'not_ready') {
          w.notReady = true;
        } else {
          this.listWaiters.delete(w);
          w.reject(new ActionFailure('failed', m.error === 'too_large' ? '这个角色的动作清单太长，读不出来' : '正在切换角色，没有保存到角色上'));
        }
      }
      return;
    }
    this.latestActions.set(m.character, m);
    for (const w of this.listWaiters) {
      if (w.character !== m.character) continue;
      this.listWaiters.delete(w);
      w.resolve(m);
    }
    // Rule 28: the user's stored table goes out once when her list differs from it.
    const stored = this.options.remembered?.switches(m.character);
    if (stored && !sameTable(stored, m.switches) && this.send({ v: 1, type: 'set_action_switches', character: m.character, switches: stored })) {
      this.switchQueue.push(null);
    }
  }

  private handlePlayed(m: ActionPlayed, c: Connection): boolean {
    // `chain` only from a renderer that lists `play_chain`.
    if (m.chain !== undefined && !c.capabilities.includes('play_chain')) return this.accepted(m, 'capability');
    if (m.play_id === this.playing && m.phase !== 'started') this.playing = null;
    const waiter = this.playWaiters.get(m.play_id);
    if (!waiter) return true;
    this.playWaiters.delete(m.play_id);
    if (m.phase === 'rejected') waiter.reject(rejected(m.reason ?? ''));
    else waiter.resolve();
    return true;
  }

  /** Rule 27: the character's list; asks the avatar only when none arrived since the link came up. */
  async actions(character: string): Promise<Actions> {
    await this.linked();
    if (!this.capabilities.includes('actions')) throw unsupported();
    const latest = this.latestActions.get(character);
    if (latest) return latest;
    if (!this.send({ v: 1, type: 'get_actions' })) throw unsupported();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.listWaiters.delete(w)) return;
        reject(w.notReady ? new ActionFailure('not_ready', '角色的动作还没加载好，过一会儿再试') : timedOut());
      }, LINK_TIMING.reply * 1000);
      const w = { character, notReady: false, resolve: (a: Actions) => { clearTimeout(timer); resolve(a); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); } };
      this.listWaiters.add(w);
    });
  }

  /** Rule 29: resolves once the avatar reports `started`; `loop` goes on the line only when it lists `action_loop`. */
  async playAction(character: string, id: string, speed: number, loop: boolean): Promise<void> {
    await this.linked();
    if (!this.capabilities.includes('actions')) throw unsupported();
    if (loop && !this.capabilities.includes('action_loop')) throw unsupported();
    const playId = `e-${process.pid}-${Date.now().toString(36)}-${++this.playCounter}`;
    const m: C3Message = { v: 1, type: 'play_action', play_id: playId, character, id, speed };
    if (loop) m.loop = true;
    if (!this.send(m)) throw unsupported();
    this.playing = playId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.playWaiters.delete(playId)) reject(timedOut());
      }, LINK_TIMING.playStart * 1000);
      this.playWaiters.set(playId, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }

  private after(seconds: number, fn: () => void): ReturnType<typeof setTimeout> {
    return setTimeout(fn, seconds * 1000 * (this.options.timeScale ?? 1));
  }

  /** Rule 14: asks her to switch, with the character's remembered look; the reply or the 11 s timeout comes as a `character` event. */
  sendSetCharacter(id: string, appearance: string | null): boolean {
    const c = this.conn;
    if (c?.hello == null) return false;
    const m: C3Message = { v: 1, type: 'set_character', id };
    if (appearance !== null) m.appearance = appearance;
    const hidden = c.capabilities.includes('layers') ? this.options.remembered?.hiddenLayers(id) : null;
    if (hidden) m.hidden_layers = hidden;
    // Rule 53 (f): every remembered appearance of the new character, left out when the line would not fit.
    const mods = c.capabilities.includes('mod_settings') ? this.options.remembered?.modSettings(id) ?? {} : {};
    if (Object.keys(mods).length > 0) {
      m.mod_settings = mods;
      if (new TextEncoder().encode(`${JSON.stringify(m)}\n`).length > MAX_LINE) {
        this.options.log(`set_character id=${id} mod_settings left out: over ${MAX_LINE} bytes`);
        delete m.mod_settings;
      }
    }
    if (this.characterRequest) clearTimeout(this.characterRequest.timer);
    const timer = this.after(LINK_TIMING.character, () => {
      if (this.characterRequest?.timer !== timer) return;
      this.characterRequest = null;
      this.timedOutCharacter = id;
      this.options.log(`set_character id=${id} timed out`);
      this.emit({ kind: 'character', event: { kind: 'failed', id, reason: 'timeout' } });
    });
    this.characterRequest = { id, timer };
    return this.write(c, m);
  }

  /** Rule 16: the reply or the 10 s timeout comes as an `appearance` event. */
  sendSetAppearance(id: string): boolean {
    const c = this.conn;
    if (c?.hello == null) return false;
    if (this.appearanceRequest) clearTimeout(this.appearanceRequest.timer);
    const timer = this.after(LINK_TIMING.appearance, () => {
      if (this.appearanceRequest?.timer !== timer) return;
      this.appearanceRequest = null;
      this.options.log(`set_appearance id=${id} timed out`);
      this.emit({ kind: 'appearance', event: { kind: 'failed', id, reason: 'timeout' } });
    });
    this.appearanceRequest = { id, timer };
    return this.write(c, { v: 1, type: 'set_appearance', id });
  }

  /** Rule 46: the whole hidden set, when she lists `layers`; the reply or the 10 s timeout comes as a `layers` event. */
  sendSetLayers(hidden: string[]): boolean {
    const c = this.conn;
    if (c?.hello == null || !c.capabilities.includes('layers')) return false;
    if (this.layersRequest) clearTimeout(this.layersRequest.timer);
    const timer = this.after(LINK_TIMING.appearance, () => {
      if (this.layersRequest?.timer !== timer) return;
      this.layersRequest = null;
      this.options.log(`set_layers hidden=${hidden.join(',')} timed out`);
      this.emit({ kind: 'layers', event: { kind: 'failed', hidden, reason: 'timeout' } });
    });
    this.layersRequest = { hidden, timer };
    return this.write(c, { v: 1, type: 'set_layers', hidden });
  }

  /** Rule 28: sends the character's whole table and returns her `action_switches`, at most 2 s later. */
  async saveSwitches(character: string, switches: Record<string, boolean>): Promise<SwitchReply> {
    if (!this.capabilities.includes('actions') || !this.send({ v: 1, type: 'set_action_switches', character, switches })) throw unsupported();
    return new Promise((resolve, reject) => {
      const w = { resolve: (r: SwitchReply) => { clearTimeout(timer); resolve(r); }, reject: (e: Error) => { clearTimeout(timer); reject(e); } };
      const timer = this.after(LINK_TIMING.reply, () => {
        const at = this.switchQueue.indexOf(w);
        // A reply that comes late still takes this place in the queue.
        if (at >= 0) this.switchQueue[at] = null;
        reject(timedOut());
      });
      this.switchQueue.push(w);
    });
  }

  /** Rule 53: one appearance's whole set; resolves with her `mod_settings` of the same `req`, which follows its `ack`. */
  setModSettings(character: string, appearance: string, values: ModValues): Promise<ModReceipt> {
    const c = this.conn;
    if (c?.hello == null || !c.capabilities.includes('mod_settings')) {
      return Promise.reject(new ActionFailure('failed', MOD_FAILURES.unsupported!));
    }
    return this.sendModSettings(c, character, appearance, values);
  }

  private sendModSettings(c: Connection, character: string, appearance: string, values: ModValues): Promise<ModReceipt> {
    const req = c.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = this.after(LINK_TIMING.ack, () => {
        const open = this.modRequests.get(req);
        if (!open) return;
        this.modRequests.delete(req);
        this.options.log(`set_mod_settings timeout req=${req} acked=${open.acked}`);
        reject(timedOut());
      });
      this.modRequests.set(req, { acked: false, resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write(c, { v: 1, type: 'set_mod_settings', req, character, appearance, values });
    });
  }

  /** Rule 29 `stop_action` for the play playAction sent last; does nothing when none is playing. */
  stopAction(): void {
    if (this.playing === null) return;
    if (!this.capabilities.includes('action_loop') || !this.send({ v: 1, type: 'stop_action', play_id: this.playing })) throw unsupported();
  }

  /** The handshaken connection when both sides list each of `capabilities`; null otherwise. */
  private listing(...capabilities: string[]): Connection | null {
    const c = this.conn;
    return c?.hello != null && capabilities.every((x) => this.both(c, x)) ? c : null;
  }

  /** Writes `m` when its fields hold (CONTRACT, outboundProblem); `done` as command's when `command` is set. */
  private checked(c: Connection, m: C3Message, how: 'write' | 'command', done?: (r: CommandResult) => void): boolean {
    const why = outboundProblem({ ...m, ...(how === 'command' ? { req: c.nextReq } : {}) },
      (x) => this.both(c, x));
    if (why !== null) {
      this.options.log(`not sent type=${m.type} why=${why}`);
      return false;
    }
    return how === 'write' ? this.write(c, m) : this.command(c, m, done);
  }

  /** Rule 31: the whole window list; only the newest queued one goes out. */
  sendSurfaces(seq: number, windows: SurfaceWindow[]): boolean {
    const c = this.listing('surfaces');
    return c !== null && this.checked(c, { v: 1, type: 'surfaces', seq, windows }, 'write');
  }

  /** Rules 32, 34: one tracked window; only the newest queued one of a `track_id` goes out. `above` needs `layering`. */
  sendSurface(s: SurfaceUpdate): boolean {
    const c = this.listing('surfaces');
    return c !== null && this.checked(c, { v: 1, type: 'surface', ...s }, 'write');
  }

  /** Rule 35: the covering window, or null when she is no longer covered; in order. */
  sendCovered(w: { window_id: number; generation: number; frame: Box } | null): boolean {
    const c = this.listing('opacity');
    return c !== null && this.checked(c, { v: 1, type: 'covered', ...(w ?? { window_id: null }) }, 'write');
  }

  /** Rule 41: all current rects in global points, `[]` to clear; in order. */
  sendPassThrough(rects: Box[]): boolean {
    const c = this.listing('pass_through');
    return c !== null && this.checked(c, { v: 1, type: 'pass_through', rects }, 'write');
  }

  /** Rule 39: false while hidden or paused, within LINK_TIMING.attention of
   *  the last one sent, or for a side other than `left` / `right`. */
  sendAttentionSide(source: string, kind: string, side: string): boolean {
    const c = this.conn, scale = this.options.timeScale ?? 1;
    if (c?.hello == null || this._hidden || this.systemPaused || (side !== 'left' && side !== 'right')) return false;
    if (now() - this.attentionAt < LINK_TIMING.attention * scale) return false;
    if (!this.checked(c, { v: 1, type: 'attention_side', source, kind, side, generation: this.attentionGeneration }, 'write')) return false;
    this.attentionAt = now();
    this.attentionGeneration += 1;
    return true;
  }

  /** Rule 39: `open` before a panel shows beside her, `close` with the same token as it goes. */
  sendPresent(token: string, side: string, phase: string): boolean {
    const c = this.conn;
    return c?.hello != null && this.checked(c, { v: 1, type: 'present', token, side, phase }, 'write');
  }

  /** Rule 44: without `req`; the caller keeps it at 2 Hz or less. */
  sendAmbientSample(source: string, colors: AmbientColors): boolean {
    const c = this.listing('ambient');
    return c !== null && this.checked(c, { v: 1, type: 'ambient_sample', source, colors }, 'write');
  }

  private sendTouchSettings(c: Connection): boolean {
    const s = this.options.touchSettings;
    if (!s || !this.both(c, 'touch')) return false;
    const { regions, pat, pinch, greet } = s();
    return this.checked(c, { v: 1, type: 'touch_settings', regions, pat, pinch, greet }, 'write');
  }

  /** Rule 45: `touchSettings()` changed; sent again when both sides list `touch`, as at each hello. */
  touchSettingsChanged(): boolean {
    const c = this.conn;
    return c?.hello != null && this.sendTouchSettings(c);
  }

  /** Rules 43, 49: the groups in `payload`; camera fields of a capability she does
   *  not list are left out and a `yaw` below −90 is raised to it without `camera_free`; `filter`, `dof`, `photo` are left
   *  out without theirs. `onResult` as command's. */
  sendSetRender(payload: Record<string, unknown>, onResult?: (r: CommandResult) => void): boolean {
    const c = this.listing('render_live');
    if (c === null) return false;
    const m: C3Message = { ...payload, v: 1, type: 'set_render' };
    if (typeof m.camera === 'object' && m.camera !== null) {
      const camera = { ...(m.camera as Record<string, unknown>) };
      if (!this.both(c, 'camera_free')) {
        for (const key of ['zoom', 'sway', 'closeup', 'live']) delete camera[key];
        if (typeof camera.yaw === 'number') camera.yaw = Math.min(Math.max(camera.yaw, -90), 180);
      }
      if (!this.both(c, 'camera_track')) delete camera.track;
      if (!this.both(c, 'camera_bust')) delete camera.framing;
      m.camera = camera;
      // A live sample still waiting would land after this camera; its timer finds nothing and sends nothing.
      c.cameraLivePending = null;
    }
    if (!this.both(c, 'filters')) delete m.filter;
    if (!this.both(c, 'photo')) {
      delete m.dof;
      delete m.photo;
    }
    return this.checked(c, m, 'command', onResult);
  }

  /** Rule 49: a sample of a gesture in progress, without `req`; samples within
   *  LINK_TIMING.cameraLive of the last one sent merge into the newest, which goes out then. */
  sendCameraLive(yaw: number, pitch: number, zoom: number): boolean {
    const c = this.listing('render_live', 'camera_free');
    if (c === null) return false;
    const m: C3Message = { v: 1, type: 'set_render', camera: { yaw, pitch, zoom, live: true } };
    const why = outboundProblem(m, (x) => this.both(c, x));
    if (why !== null) {
      this.options.log(`not sent type=set_render why=${why}`);
      return false;
    }
    const wait = LINK_TIMING.cameraLive - (now() - c.cameraLiveAt);
    if (c.cameraLivePending === null && wait <= 0) {
      c.cameraLiveAt = now();
      return this.write(c, m);
    }
    if (c.cameraLivePending === null) {
      setTimeout(() => {
        const pending = c.cameraLivePending;
        if (pending === null || this.conn !== c) return;
        c.cameraLivePending = null;
        c.cameraLiveAt = now();
        this.write(c, pending);
      }, wait * 1000);
    }
    c.cameraLivePending = m;
    return true;
  }

  /** Rule 49: asks for, or ends, the conversation close-up. */
  sendCloseup(on: boolean): boolean {
    const c = this.listing('render_live', 'camera_free');
    return c !== null && this.checked(c, { v: 1, type: 'set_render', camera: { closeup: on } }, 'command');
  }

  /** Rule 43: the photo panel's `photo` group; `focus` null is `auto`. */
  sendPhoto(active: boolean, aperture: number, focus: number | null): boolean {
    const c = this.listing('render_live', 'photo');
    return c !== null && this.checked(c, { v: 1, type: 'set_render', photo: { active, aperture, focus: focus ?? 'auto' } }, 'command');
  }

  /** Rule 47: `id` null goes back to automatic. `onResult` as command's. */
  sendSetPose(id: string | null, lock: boolean, onResult?: (r: CommandResult) => void): boolean {
    const c = this.listing('poses');
    if (c === null || this.character === null) return false;
    return this.checked(c, { v: 1, type: 'set_pose', character: this.character, id, lock }, 'command', onResult);
  }

  /** CONTRACT「Optional presentation capability」: `input` holds `weather`, `expression`, `face_effect`, `facial_animation`,
   *  `valid_for_seconds`, sent only when they hold (presentationInputProblem); the answer comes as onPresentationState. */
  sendSetPresentation(req: number, character: string, input: Record<string, unknown>): boolean {
    const c = this.listing('presentation');
    if (c === null || !Number.isInteger(req) || req < 0 || character === '') return false;
    const why = presentationInputProblem(input);
    if (why !== null) {
      this.options.log(`not sent type=set_presentation why=${why}`);
      return false;
    }
    return this.write(c, { ...input, v: 1, type: 'set_presentation', req, character });
  }

  /** Rule 51: `character`'s whole set; resolves with her `motion_overrides` of the same `req`, which follows its `ack`,
   *  within LINK_TIMING.ack. A line over MAX_LINE is not sent. */
  setMotionOverrides(character: string, overrides: MotionOverrides): Promise<MotionOverridesReceipt> {
    const c = this.listing('motion_overrides');
    if (c === null || !c.capabilities.includes('actions')) {
      return Promise.reject(new ActionFailure('failed', OVERRIDE_FAILURES.unsupported));
    }
    const req = c.nextReq;
    const m: C3Message = { v: 1, type: 'set_motion_overrides', req, character, chains: overrides.chains, pools: overrides.pools,
      blend_in: overrides.blend_in };
    const why = outboundProblem(m, (x) => this.both(c, x));
    if (why !== null) {
      this.options.log(`not sent type=set_motion_overrides why=${why}`);
      return Promise.reject(new ActionFailure('failed', OVERRIDE_FAILURES.refused));
    }
    if (Buffer.byteLength(JSON.stringify(m)) + 1 > MAX_LINE) {
      this.options.log(`set_motion_overrides character=${character} not sent: over ${MAX_LINE} bytes`);
      return Promise.reject(new ActionFailure('failed', OVERRIDE_FAILURES.tooLarge));
    }
    c.nextReq += 1;
    return new Promise((resolve, reject) => {
      const timer = this.after(LINK_TIMING.ack, () => {
        const open = this.overrideRequests.get(req);
        if (!open) return;
        this.overrideRequests.delete(req);
        this.options.log(`set_motion_overrides timeout req=${req} acked=${open.acked}`);
        reject(timedOut());
      });
      this.overrideRequests.set(req, { acked: false, resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write(c, m);
    });
  }

  /** Rule 52: the chain from `start` once; `speed` goes on the line when given. `onResult` gets its `ack` as command's;
   *  `action_played` with `chain` follows an ok one. */
  playChain(playId: string, character: string, start: string, speed?: number, onResult?: (r: CommandResult) => void): boolean {
    const c = this.listing('play_chain');
    if (c === null || !c.capabilities.includes('actions')) return false;
    const m: C3Message = { v: 1, type: 'play_chain', play_id: playId, character, start };
    if (speed !== undefined) m.speed = speed;
    return this.checked(c, m, 'command', onResult);
  }

  /** Rule 50: resolves with the file name and pixel size of her `captured`, which follows the `ack` of the same `req`,
   *  within LINK_TIMING.capture. Fails with code `unsupported`, `busy`, `failed` or `timeout`. */
  capture(background = 'transparent'): Promise<{ file: string; width: number; height: number }> {
    const c = this.listing('capture');
    if (c === null) return Promise.reject(new ActionFailure('unsupported', 'unsupported'));
    const req = c.nextReq;
    const m: C3Message = { v: 1, type: 'capture', req, background };
    const why = outboundProblem(m, (x) => this.both(c, x));
    if (why !== null) {
      this.options.log(`not sent type=capture why=${why}`);
      return Promise.reject(new ActionFailure('unsupported', 'unsupported'));
    }
    c.nextReq += 1;
    return new Promise((resolve, reject) => {
      const timer = this.after(LINK_TIMING.capture, () => {
        const open = this.captures.get(req);
        if (!open) return;
        this.captures.delete(req);
        this.options.log(`capture timeout req=${req} acked=${open.acked}`);
        reject(new ActionFailure('timeout', 'timeout'));
      });
      this.captures.set(req, { acked: false, resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write(c, m);
    });
  }
}
