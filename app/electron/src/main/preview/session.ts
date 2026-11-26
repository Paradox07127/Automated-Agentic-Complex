// The character page's live preview from the desktop renderer over its rendezvous, Mach on macOS and a named pipe on Windows:
// one connection while the window lives and the preview was on screen within `releaseAfter`, `pause` while it is not on screen and
// `resume` after, `ack` once the GPU is through with a frame, frames of an older `load_id` dropped (and acked).

/** A frame's `surface` as the transport (native/mac/preview.m, pipe.ts) hands it over. */
export interface PreviewSurface {
  /** Eight bytes, for `sharedTexture.importSharedTexture`: this process's IOSurfaceRef on macOS, its NT handle on Windows. */
  handle: Buffer;
  width: number;
  height: number;
  pixelFormat: number;
  bytesPerRow: number;
  id: number;
}

/** The addon's client end of the service; a connection that fails or ends reports `{"event":"disconnected"}`, with a `reason`
 *  for the page when the service is there but cannot serve this process. */
export interface PreviewTransport<S> {
  start(service: string, onMessage: (json: string, surface: S | null, sequence: number) => void): void;
  send(json: string): boolean;
  stop(): void;
}

/** Where frames are drawn. */
export interface PreviewPresenter<S> {
  /** The preview is placed and on screen. */
  readonly active: boolean;
  /** Drops the drawn frame: a load that builds anew draws nothing for seconds. */
  clear(): void;
  /** Draws `surface`; `done(drawn)` once the GPU is through with it, false when it was not drawn. */
  present(surface: S, done: (drawn: boolean) => void): void;
}

export interface PreviewSelection {
  bundle: string;
  sha256: string;
  character: string;
  clip: string | null;
  facial: string | null;
  rate: number;
  appearance: string | null;
  /** The page's selection revision: the same action again with a new one plays again. */
  request: number;
  modSettings: Record<string, Record<string, number>> | null;
  loop: boolean;
  /** The desktop's lookArguments (renderer/supervisor.ts); absent keeps the service's own. */
  renderArgs?: string[];
  /** Output pixels [w, h] (previewOutput); absent keeps the service's 480×576. */
  output?: [number, number];
  /** Layer ids the desktop hides; absent shows every layer. */
  hiddenLayers?: string[];
  /** Plays `action`'s tracks (its camera and music) as the stage; set only with `action`. */
  stage?: true;
  action?: string;
}

/** The page's transport over a stage load. */
export type StageControl = { op: 'pause' } | { op: 'resume' } | { op: 'seek'; at: number };

/** A stage load's `position`: `t` seconds of `duration` into its clip. */
export interface StagePosition { t: number; duration: number; playing: boolean }

/** Preview `view`: `turn` degrees on her camera yaw, `tilt` degrees on its pitch (±80), `zoom` the share 0.1–2 of the fitted
 *  frame shown, `pan` the shown centre's offset from the fit's in fitted-frame sizes (y down), `frame` where the fit sits in the
 *  output as x, y, w, h shares of it (y down). */
export interface CameraView {
  turn: number;
  tilt: number;
  zoom: number;
  pan: [number, number];
  frame: [number, number, number, number];
}

const DEFAULT_VIEW: CameraView = { turn: 0, tilt: 0, zoom: 1, pan: [0, 0], frame: [0, 0, 1, 1] };

const OUTPUT_HEIGHTS = [576, 864, 1152, 1440, 1728];
const OUTPUT_MAX = 4096;

/** `rect` (CSS px) × `scale` (device px per CSS px), rounded up to a height of OUTPUT_HEIGHTS, the width from the rect's aspect
 *  to a multiple of 16 within 240–4096: a small resize keeps the output, so the service does not reload. Past 4096 wide the height
 *  comes down to keep the aspect. */
export function previewOutput(rect: { w: number; h: number }, scale: number): [number, number] {
  const height = OUTPUT_HEIGHTS.find((h) => h >= rect.h * scale) ?? OUTPUT_HEIGHTS.at(-1)!;
  const width = Math.max(240, Math.ceil((height * rect.w) / rect.h / 16) * 16);
  if (width <= OUTPUT_MAX) return [width, height];
  return [OUTPUT_MAX, Math.max(240, Math.floor((OUTPUT_MAX * rect.h) / rect.w / 16) * 16)];
}

/** The preview could not play; its message is the page's reason. */
export class PreviewFailure extends Error {}

export interface SessionOptions<S> {
  transport: PreviewTransport<S>;
  /** `<bundle id>.preview`. */
  service: string;
  presenter: PreviewPresenter<S>;
  log(line: string): void;
  /** ms to wait for a load's first frame. */
  firstFrameTimeout?: number;
  /** ms off screen before the connection ends, so the service process exits and frees its GPU memory. */
  releaseAfter?: number;
  /** A load that builds anew: its share done (the service's `progress`, 0.95 at `loaded`); null once it is drawn, fails or is replaced. */
  progress?(fraction: number | null): void;
  /** The current stage load's position while on screen; null once there is none (another load, hidden, failed, gone). */
  position?(p: StagePosition | null): void;
}

type Phase = { kind: 'idle' | 'loading' | 'live' } | { kind: 'failed'; reason: string };

const sameSelection = (a: PreviewSelection, b: PreviewSelection | null) => b !== null && JSON.stringify(a) === JSON.stringify(b);
/** The same playback asked for again: only her look, render arguments or output differ. */
const samePlayback = (a: PreviewSelection, b: PreviewSelection) =>
  a.character === b.character && a.clip === b.clip && a.loop === b.loop && a.request === b.request;

export class PreviewSession<S> {
  private readonly options: SessionOptions<S>;
  private selection: PreviewSelection | null = null;
  private phase: Phase = { kind: 'idle' };
  /** Callers waiting for the first frame of load `load`. */
  private waiters: { load: number; resolve(): void; reject(e: Error): void }[] = [];
  /** The selection's clip has drawn (or a sequence replaced it): a rebuild of the same playback does not play it again. */
  private played = false;
  private sequenced = false;
  private connected = false;
  private connectionID = 0;
  private servicePaused = false;
  private loadID = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private loadStarted = 0;
  private framesReported = 0;
  /** When the last `stats` line went to the log (performance.now ms). */
  private statsLoggedAt = 0;
  /** The current load's last reported share; null when it reported none. */
  private progressed: number | null = null;
  /** The last `view` asked for; null before one. */
  private lastView: CameraView | null = null;
  /** A stage load stands paused until the page resumes it. */
  private held = false;
  /** The presenter's `active` as of the last syncPlayback. */
  private onScreen = false;
  /** The stage load's last reported `t`. */
  private stageAt = 0;
  /** The last position reported was not null. */
  private positioned = false;

  constructor(options: SessionOptions<S>) {
    this.options = options;
  }

  /** Plays `value`; resolves once a frame of it is drawn, rejects when the service reports an error or goes away. */
  load(value: PreviewSelection): Promise<void> {
    if (!this.connected || !sameSelection(value, this.selection)) {
      // The service keeps a view across loads and connections (a reload can reuse it), so a new connection sets this session's
      // first; a service that starts with it applies it to the actor its load builds.
      if (this.connect()) this.send({ op: 'view', ...(this.lastView ?? DEFAULT_VIEW) });
      // The service cannot keep a playhead across a load: a rebuild of a clip that has played draws her idle, a loop loops on,
      // a stage stands at its start again.
      const idle = !value.stage && this.selection !== null && this.played && samePlayback(value, this.selection) && (this.sequenced || !value.loop);
      this.played = idle;
      this.sequenced = idle && this.sequenced;
      this.selection = value;
      this.phase = { kind: 'loading' };
      const expected = this.nextLoad();
      const message: Record<string, unknown> = { op: 'load', bundle: value.bundle, sha256: value.sha256, character: value.character,
        rate: value.rate, load_id: expected };
      if (value.clip !== null && !idle) message.clip = value.clip;
      if (value.facial !== null) message.facial = value.facial;
      if (value.appearance !== null) message.appearance = value.appearance;
      if (value.modSettings !== null) message.mod_settings = value.modSettings;
      if (value.loop && !idle) message.loop = true;
      if (value.renderArgs !== undefined) message.render_args = value.renderArgs;
      if (value.output !== undefined) message.output = value.output;
      if (value.hiddenLayers !== undefined) message.hidden_layers = value.hiddenLayers;
      if (value.stage) {
        message.stage = true;
        message.action = value.action;
      }
      if (!this.send(message)) {
        this.fail('预览请求发不出去（太大或连接已断）');
        return this.settled();
      }
      // A load starts the service playing; a stage stands at its first frame, silent, until the page resumes it.
      this.held = value.stage === true;
      this.servicePaused = this.held;
      if (this.held) {
        this.stageAt = 0;
        this.onScreen = this.options.presenter.active;
        this.send({ op: 'pause' });
        this.send({ op: 'seek', at: 0 });
      }
      this.syncPlayback();
      this.awaitFirstFrame(expected);
    }
    return this.settled();
  }

  /** Preview `sequence` on top of the drawn load. */
  async sequence(clips: string[], blendSeconds: number[]): Promise<void> {
    if (!this.connected || this.selection === null || this.phase.kind !== 'live') throw new PreviewFailure('预览还没有载入');
    this.phase = { kind: 'loading' };
    this.played = true;
    this.sequenced = true;
    const expected = this.nextLoad();
    if (!this.send({ op: 'sequence', clips, blend_s: blendSeconds, load_id: expected })) {
      this.fail('预览请求发不出去（太大或连接已断）');
      return this.settled();
    }
    // A sequence starts the service playing.
    this.servicePaused = false;
    this.syncPlayback();
    this.awaitFirstFrame(expected);
    return this.settled();
  }

  /** Preview `view`; kept for a new connection. */
  view(v: CameraView): void {
    this.lastView = v;
    if (this.connected) this.send({ op: 'view', ...v });
  }

  /** The presenter's `active` changed: `pause` or `resume` to match it. */
  syncPlayback(): void {
    const active = this.options.presenter.active;
    if (active || !this.connected) {
      if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    } else this.releaseTimer ??= setTimeout(() => this.release(), this.options.releaseAfter ?? 20_000);
    if (!active) this.endPosition();
    const appeared = active && !this.onScreen;
    this.onScreen = active;
    if (!this.connected || this.selection === null) return;
    const paused = !active || this.held;
    if (this.servicePaused === paused) {
      // A hide cleared the canvas: a held stage draws its frame again.
      if (appeared && this.held) this.send({ op: 'seek', at: this.stageAt });
      return;
    }
    this.servicePaused = paused;
    this.send({ op: paused ? 'pause' : 'resume' });
    if (!paused && this.phase.kind === 'loading') this.awaitFirstFrame(this.loadID);
  }

  /** The page's pause, resume or seek of a stage load; nothing without one. */
  control(c: StageControl): void {
    if (!this.connected || this.selection?.stage !== true) return;
    if (c.op === 'seek') {
      this.send({ op: 'seek', at: c.at });
      return;
    }
    // Sent even when it seems to change nothing: a stage played to its end stands, and `resume` plays it again from 0.
    this.held = c.op === 'pause';
    this.servicePaused = this.held;
    this.send({ op: c.op });
    this.syncPlayback();
  }

  /** The window is gone: ends the connection; nothing of it is handled after. */
  disconnect(): void {
    this.endConnection();
    this.fail('预览已关闭', false);
  }

  /** Off screen for `releaseAfter`: ends the connection but keeps the selection, so the next load of it does not replay a drawn one-shot. */
  private release(): void {
    this.endConnection();
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    this.endProgress();
    this.endPosition();
    this.phase = { kind: 'idle' };
    const ended = this.waiters;
    this.waiters = [];
    for (const w of ended) w.reject(new PreviewFailure('预览已关闭'));
  }

  private endConnection(): void {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (this.connected) this.options.transport.stop();
    this.connected = false;
    this.connectionID += 1;
  }

  private settled(): Promise<void> {
    switch (this.phase.kind) {
      case 'live': return Promise.resolve();
      case 'failed': return Promise.reject(new PreviewFailure(this.phase.reason));
      default: return new Promise((resolve, reject) => this.waiters.push({ load: this.loadID, resolve, reject }));
    }
  }

  /** A new load_id; whoever waited for an older one is answered that it was replaced. */
  private nextLoad(): number {
    this.loadID += 1;
    this.loadStarted = performance.now();
    this.framesReported = 0;
    this.endProgress();
    this.endPosition();
    const replaced = this.waiters;
    this.waiters = [];
    for (const w of replaced) w.reject(new PreviewFailure('预览换成了新的请求'));
    return this.loadID;
  }

  /** True when it started a new connection. */
  private connect(): boolean {
    if (this.connected) return false;
    const id = ++this.connectionID;
    this.options.transport.start(this.options.service, (json, surface, sequence) => {
      if (id === this.connectionID) this.receive(json, surface, sequence);
    });
    this.connected = true;
    return true;
  }

  private awaitFirstFrame(expected: number): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (this.loadID !== expected || this.phase.kind !== 'loading') return;
      // Paused off screen, the service draws nothing to wait for; the wait starts again on `resume`.
      if (!this.options.presenter.active) return;
      this.fail('预览等待首帧超时');
    }, this.options.firstFrameTimeout ?? 15_000);
  }

  private fail(reason: string, report = true): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    this.endProgress();
    this.endPosition();
    if (report) this.options.log(`character preview load_id=${this.loadID} failed: ${reason}`);
    if (this.connected && !this.servicePaused) {
      this.servicePaused = true;
      this.send({ op: 'pause' });
    }
    this.selection = null;
    this.phase = { kind: 'failed', reason };
    const ended = this.waiters;
    this.waiters = [];
    for (const w of ended) w.reject(new PreviewFailure(reason));
  }

  private reportProgress(fraction: number): void {
    if (this.progressed === null) this.options.presenter.clear();
    this.progressed = fraction;
    this.options.progress?.(fraction);
  }

  private endProgress(): void {
    if (this.progressed === null) return;
    this.progressed = null;
    this.options.progress?.(null);
  }

  private endPosition(): void {
    if (!this.positioned) return;
    this.positioned = false;
    this.options.position?.(null);
  }

  private send(value: Record<string, unknown>): boolean {
    return this.options.transport.send(JSON.stringify(value));
  }

  private ack(sequence: number): void {
    this.send({ op: 'ack', sequence });
  }

  private receive(json: string, surface: S | null, sequence: number): void {
    let message: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(json);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
      message = v as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.event) {
      case 'error':
        if (message.load_id !== this.loadID) return;
        this.fail(typeof message.reason === 'string' ? message.reason : '预览出错');
        return;
      case 'disconnected':
        if (!this.connected) return;
        this.connected = false;
        this.fail(typeof message.reason === 'string' ? message.reason : '预览服务断开了');
        return;
      case 'progress':
        if (this.selection === null || message.load_id !== this.loadID || this.phase.kind !== 'loading' || typeof message.fraction !== 'number') return;
        this.reportProgress(message.fraction);
        return;
      case 'loaded':
        if (message.load_id === this.loadID && this.progressed !== null) this.reportProgress(0.95);
        return;
      case 'position': {
        const { t, duration, playing } = message;
        if (this.selection?.stage !== true || message.load_id !== this.loadID || typeof t !== 'number' || typeof duration !== 'number'
          || typeof playing !== 'boolean') return;
        this.stageAt = t;
        // The `pause` a hide sends brings one more.
        if (!this.options.presenter.active) return;
        this.positioned = true;
        this.options.position?.({ t, duration, playing });
        return;
      }
      case 'stats': {
        if (this.selection === null || message.load_id !== this.loadID || typeof message.fps !== 'number') return;
        this.framesReported += 1;
        // The load's first, then at most one a minute.
        if (this.framesReported === 1 || performance.now() - this.statsLoggedAt >= 60_000) {
          this.statsLoggedAt = performance.now();
          const prepare = typeof message.prepare_ms === 'number' ? message.prepare_ms : 0;
          const gpu = typeof message.gpu_ms === 'number' ? message.gpu_ms.toFixed(1) : 'unreported';
          this.options.log(`character preview load_id=${this.loadID} fps=${message.fps.toFixed(1)} prepare_ms=${prepare.toFixed(1)} gpu_ms=${gpu}`);
        }
        return;
      }
      case 'frame':
        if (surface === null || this.selection === null || message.load_id !== this.loadID) return this.ack(sequence);
        this.render(surface, sequence, this.loadID);
        return;
      default:
    }
  }

  /** Draws the frame; the service reuses its surface once the GPU is done with it (`ack`). */
  private render(surface: S, sequence: number, load: number): void {
    if (!this.options.presenter.active) return this.ack(sequence);
    const connection = this.connectionID;
    this.options.presenter.present(surface, (drawn) => {
      if (!this.connected || this.connectionID !== connection) return;
      this.ack(sequence);
      if (!drawn || this.loadID !== load || this.phase.kind !== 'loading') return;
      this.phase = { kind: 'live' };
      this.played = true;
      if (this.timeout !== null) clearTimeout(this.timeout);
      this.timeout = null;
      this.endProgress();
      this.options.log(`character preview load_id=${load} first_frame_ms=${Math.round(performance.now() - this.loadStarted)}`);
      const ready = this.waiters;
      this.waiters = [];
      for (const w of ready) w.resolve();
    });
  }
}
