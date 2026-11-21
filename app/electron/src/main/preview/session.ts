// The character page's live preview over the preview XPC service (C3 CONTRACT 「附录：预览 XPC」):
// one connection while the window lives, `pause` while the preview is not on screen and
// `resume` after, `ack` once the GPU is through with a frame, frames of an older `load_id` dropped (and acked).

/** A frame's `surface` as the addon (native/mac/preview.m) hands it over. */
export interface PreviewSurface {
  /** Eight bytes: this process's IOSurfaceRef, for `sharedTexture.importSharedTexture`. */
  handle: Buffer;
  width: number;
  height: number;
  pixelFormat: number;
  bytesPerRow: number;
  id: number;
}

/** The addon's client end of the service; a connection that fails or ends reports `{"event":"disconnected"}`. */
export interface PreviewTransport<S> {
  start(service: string, onMessage: (json: string, surface: S | null, sequence: number) => void): void;
  send(json: string): boolean;
  stop(): void;
}

/** Where frames are drawn. */
export interface PreviewPresenter<S> {
  /** The preview is placed and on screen. */
  readonly active: boolean;
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
}

type Phase = { kind: 'idle' | 'loading' | 'live' } | { kind: 'failed'; reason: string };

const sameSelection = (a: PreviewSelection, b: PreviewSelection | null) => b !== null && JSON.stringify(a) === JSON.stringify(b);

export class PreviewSession<S> {
  private readonly options: SessionOptions<S>;
  private selection: PreviewSelection | null = null;
  private phase: Phase = { kind: 'idle' };
  private waiters: { resolve(): void; reject(e: Error): void }[] = [];
  private connected = false;
  private connectionID = 0;
  private servicePaused = false;
  private loadID = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private loadStarted = 0;
  private framesReported = 0;

  constructor(options: SessionOptions<S>) {
    this.options = options;
  }

  /** Plays `value`; resolves once a frame of it is drawn, rejects when the service reports an error or goes away. */
  load(value: PreviewSelection): Promise<void> {
    if (!sameSelection(value, this.selection)) {
      this.connect();
      this.selection = value;
      this.phase = { kind: 'loading' };
      this.loadID += 1;
      this.loadStarted = performance.now();
      this.framesReported = 0;
      const expected = this.loadID;
      const message: Record<string, unknown> = { op: 'load', bundle: value.bundle, sha256: value.sha256, character: value.character,
        rate: value.rate, load_id: expected };
      if (value.clip !== null) message.clip = value.clip;
      if (value.facial !== null) message.facial = value.facial;
      if (value.appearance !== null) message.appearance = value.appearance;
      if (value.modSettings !== null) message.mod_settings = value.modSettings;
      if (value.loop) message.loop = true;
      this.send(message);
      // A load starts the service playing.
      this.servicePaused = false;
      this.syncPlayback();
      this.awaitFirstFrame(expected);
    }
    return this.settled();
  }

  /** Preview XPC `sequence` on top of the drawn load. */
  async sequence(clips: string[], blendSeconds: number[]): Promise<void> {
    if (!this.connected || this.selection === null || this.phase.kind !== 'live') throw new PreviewFailure('预览还没有载入');
    this.phase = { kind: 'loading' };
    this.loadID += 1;
    this.loadStarted = performance.now();
    this.framesReported = 0;
    const expected = this.loadID;
    this.send({ op: 'sequence', clips, blend_s: blendSeconds, load_id: expected });
    // A sequence starts the service playing.
    this.servicePaused = false;
    this.syncPlayback();
    this.awaitFirstFrame(expected);
    return this.settled();
  }

  /** The presenter's `active` changed: `pause` or `resume` to match it. */
  syncPlayback(): void {
    const active = this.options.presenter.active;
    if (!this.connected || this.selection === null || this.servicePaused !== active) return;
    this.servicePaused = !active;
    this.send({ op: this.servicePaused ? 'pause' : 'resume' });
  }

  /** The window is gone: ends the connection; nothing of it is handled after. */
  disconnect(): void {
    if (this.connected) this.options.transport.stop();
    this.connected = false;
    this.connectionID += 1;
    this.fail('预览已关闭', false);
  }

  private settled(): Promise<void> {
    switch (this.phase.kind) {
      case 'live': return Promise.resolve();
      case 'failed': return Promise.reject(new PreviewFailure(this.phase.reason));
      default: return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
  }

  private connect(): void {
    if (this.connected) return;
    const id = ++this.connectionID;
    this.options.transport.start(this.options.service, (json, surface, sequence) => {
      if (id === this.connectionID) this.receive(json, surface, sequence);
    });
    this.connected = true;
  }

  private awaitFirstFrame(expected: number): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (this.loadID === expected && this.phase.kind === 'loading') this.fail('预览等待首帧超时');
    }, this.options.firstFrameTimeout ?? 15_000);
  }

  private fail(reason: string, report = true): void {
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
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

  private send(value: Record<string, unknown>): void {
    this.options.transport.send(JSON.stringify(value));
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
        this.fail('预览服务断开了');
        return;
      case 'stats': {
        if (this.selection === null || message.load_id !== this.loadID || typeof message.fps !== 'number') return;
        this.framesReported += 1;
        if (this.framesReported === 1 || this.framesReported % 10 === 0) {
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
      if (this.timeout !== null) clearTimeout(this.timeout);
      this.timeout = null;
      this.options.log(`character preview load_id=${load} first_frame_ms=${Math.round(performance.now() - this.loadStarted)}`);
      const ready = this.waiters;
      this.waiters = [];
      for (const w of ready) w.resolve();
    });
  }
}
