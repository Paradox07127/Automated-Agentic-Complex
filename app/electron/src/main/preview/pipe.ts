// The preview's transport on Windows: NDJSON over the named pipe the addon
// (native/win/preview.cpp) creates, each `ring`'s NT handles pulled out of the efw, and the hello's adapter checked against the
// GPU process's before `connected`. To the session it is what the macOS addon is: hello kept from it, sends before a usable
// hello kept and flushed after `connected`, the efw's end or a new hello delivered as one `disconnected`.
import type { PreviewSurface } from './session.ts';
import type { PreviewAddon } from './window.ts';

/** native/win/preview.cpp. Handles are numbers: this process's, or the efw's in `duplicate`. */
export interface PipeAddon {
  /** Creates the pipe `name` (one instance, this user only, no remote clients) and the I/O thread that hands each read of a
   *  connection to `onData`, then null once it ends (EOF or an error) and the pipe waits for the next; false when the pipe
   *  cannot be created. Once. */
  listen(name: string, onData: (connection: number, data: Buffer | null) => void): boolean;
  /** Writes `line` and a newline on `connection`; false when it is not the current one or the write is not through in 100 ms. */
  write(connection: number, line: string): boolean;
  /** `OpenProcess(PROCESS_DUP_HANDLE)` of `connection`'s client (`GetNamedPipeClientProcessId`); null when it fails. */
  openClient(connection: number): number | null;
  /** `handle` of `process` duplicated into this process; null when it fails. */
  duplicate(process: number, handle: number): number | null;
  close(handle: number): void;
  /** The DXGI adapters, `luid` as `<HighPart>:<LowPart>` in 8 lower-case hex digits each. */
  adapters(): Adapter[];
}

export interface Adapter {
  luid: string;
  vendorId: number;
  deviceId: number;
  subSysId: number;
  revision: number;
  software: boolean;
}

/** The GPU process's device. */
export type GpuDevice = Pick<Adapter, 'vendorId' | 'deviceId' | 'subSysId' | 'revision'>;

/** Bytes of a line without its newline. */
export const MAX_LINE = 8192;
/** Sends kept before a usable hello: the efw takes seconds to start, and the page sends `view` and `load` at once. */
const MAX_PENDING = 16;
const SLOTS = 3;
const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
export const ADAPTER_MISMATCH = '预览用的显卡和界面不同';
const CONNECTED = JSON.stringify({ event: 'connected' });
const DISCONNECTED = JSON.stringify({ event: 'disconnected' });
const LUID = /^[0-9a-f]{8}:[0-9a-f]{8}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 240 && (v as number) <= 4096;
const isHandle = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** `app.getGPUInfo('complete')`'s active device (the basic info marks none active); null without one. Chromium reports the ids
 *  as signed 32-bit integers, DXGI as unsigned ones. */
export function activeDevice(info: unknown): GpuDevice | null {
  const devices = isObject(info) && Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const d: unknown = devices.find((x: unknown) => isObject(x) && x.active === true);
  if (!isObject(d)) return null;
  const ids = [d.vendorId, d.deviceId, d.subSysId, d.revision];
  if (!ids.every((n) => Number.isInteger(n))) return null;
  const [vendorId, deviceId, subSysId, revision] = ids.map((n) => (n as number) >>> 0) as [number, number, number, number];
  return { vendorId, deviceId, subSysId, revision };
}

/** True when `active` is exactly one hardware adapter, the one at `luid`. */
export function sameAdapter(active: GpuDevice | null, adapters: Adapter[], luid: string): boolean {
  if (active === null) return false;
  const found = adapters.filter((a) => !a.software && a.vendorId === active.vendorId && a.deviceId === active.deviceId
    && a.subSysId === active.subSysId && a.revision === active.revision);
  return found.length === 1 && found[0]!.luid === luid;
}

/** One connection's bytes as lines of 1–MAX_LINE bytes; a longer one is dropped up to its newline. */
export class LineReader {
  private parts: Buffer[] = [];
  private length = 0;
  private dropping = false;

  push(data: Buffer, line: (text: string) => void): void {
    for (let start = 0; ;) {
      const newline = data.indexOf(0x0a, start);
      const end = newline < 0 ? data.length : newline;
      if (!this.dropping && this.length + end - start > MAX_LINE) {
        this.dropping = true;
        this.parts = [];
        this.length = 0;
      }
      if (!this.dropping && end > start) {
        this.parts.push(data.subarray(start, end));
        this.length += end - start;
      }
      if (newline < 0) return;
      if (!this.dropping && this.length > 0) line(Buffer.concat(this.parts, this.length).toString('utf8'));
      this.parts = [];
      this.length = 0;
      this.dropping = false;
      start = newline + 1;
    }
  }
}

interface Ring {
  id: number;
  width: number;
  height: number;
  handles: number[];
}

/** The efw whose hello came last, until its connection ends. */
interface Peer {
  connection: number;
  process: number | null;
  ring: Ring | null;
  adapter: 'checking' | 'same' | 'other';
}

export interface PipeTransportOptions {
  addon: PipeAddon;
  /** previewPipePath's name. */
  name: string;
  /** The GPU process's device once it has reported one (`gpu-info-update`); null without one. */
  gpu(): Promise<GpuDevice | null>;
  log(line: string): void;
}

export class PipeTransport implements PreviewAddon {
  private readonly options: PipeTransportOptions;
  private listening: boolean | null = null;
  private reader = new LineReader();
  private readerConnection = 0;
  private peer: Peer | null = null;
  private receiver: ((json: string, surface: PreviewSurface | null, sequence: number) => void) | null = null;
  private started = false;
  private pending: string[] = [];
  /** Bumped by start and stop; a disconnect of an older connection is not delivered. */
  private generation = 0;

  constructor(options: PipeTransportOptions) {
    this.options = options;
  }

  /** The pipe's name, made on the first call; null when it cannot be made, and no preview then. */
  rendezvous(): string | null {
    this.listening ??= this.options.addon.listen(this.options.name, (connection, data) => this.data(connection, data));
    return this.listening ? this.options.name : null;
  }

  start(_service: string, onMessage: (json: string, surface: PreviewSurface | null, sequence: number) => void): void {
    this.rendezvous();
    this.generation += 1;
    this.receiver = onMessage;
    this.started = true;
    this.pending = [];
    if (this.peer?.adapter === 'same') this.options.addon.write(this.peer.connection, CONNECTED);
    else if (this.peer?.adapter === 'other') this.endStarted(ADAPTER_MISMATCH);
  }

  send(json: string): boolean {
    const bytes = Buffer.byteLength(json);
    if (!this.started || bytes < 1 || bytes > MAX_LINE) return false;
    if (this.peer?.adapter === 'same') return this.options.addon.write(this.peer.connection, json);
    if (this.pending.length === MAX_PENDING) return false;
    this.pending.push(json);
    return true;
  }

  stop(): void {
    this.generation += 1;
    if (this.started && this.peer?.adapter === 'same') this.options.addon.write(this.peer.connection, DISCONNECTED);
    this.started = false;
    this.pending = [];
    // The efw frees the ring on `disconnected`; the handles here would keep its textures.
    if (this.peer) this.closeRing(this.peer);
  }

  private data(connection: number, data: Buffer | null): void {
    if (data === null) {
      if (this.peer?.connection !== connection) return;
      this.forget();
      this.endStarted();
      return;
    }
    if (connection !== this.readerConnection) {
      this.reader = new LineReader();
      this.readerConnection = connection;
    }
    this.reader.push(data, (text) => this.line(connection, text));
  }

  private line(connection: number, text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    if (message.event === 'hello') return this.hello(connection, message);
    const peer = this.peer;
    if (!this.started || peer?.connection !== connection || peer.adapter !== 'same') return;
    if (message.event === 'ring') return this.ring(peer, message);
    if (message.event === 'frame') return this.frame(peer, text, message);
    this.receiver!(text, null, 0);
  }

  private hello(connection: number, message: Json): void {
    // A hello over a live efw is a new one: that one's connection is over.
    if (this.peer !== null) {
      this.forget();
      this.endStarted();
    }
    const peer: Peer = { connection, process: this.options.addon.openClient(connection), ring: null, adapter: 'checking' };
    this.peer = peer;
    const luid = typeof message.luid === 'string' && LUID.test(message.luid) ? message.luid : null;
    void this.options.gpu().then((gpu) => {
      if (this.peer !== peer) return;
      const adapters = this.options.addon.adapters();
      if (luid === null || !sameAdapter(gpu, adapters, luid)) {
        peer.adapter = 'other';
        const listed = adapters.map((a) => `${a.luid}=${[a.vendorId, a.deviceId, a.subSysId, a.revision].join('/')}${a.software ? '(software)' : ''}`);
        this.options.log(`AAC_PREVIEW_ADAPTER_MISMATCH hello_luid=${String(message.luid)} gpu=${gpu ? [gpu.vendorId, gpu.deviceId, gpu.subSysId, gpu.revision].join('/') : 'none'} adapters=${listed.join(',')}`);
        this.endStarted(ADAPTER_MISMATCH);
        return;
      }
      peer.adapter = 'same';
      if (!this.started) return;
      this.options.addon.write(connection, CONNECTED);
      for (const json of this.pending) this.options.addon.write(connection, json);
      this.pending = [];
    });
  }

  private ring(peer: Peer, message: Json): void {
    this.closeRing(peer);
    const { ring, width, height, slots } = message;
    if (!isHandle(ring) || !isSize(width) || !isSize(height) || !Array.isArray(slots) || slots.length !== SLOTS || !slots.every(isHandle)
      || peer.process === null) return;
    const handles: number[] = [];
    for (const slot of slots) {
      const handle = this.options.addon.duplicate(peer.process, slot);
      if (handle === null) {
        for (const h of handles) this.options.addon.close(h);
        this.options.log(`character preview ring=${ring} handles not duplicated`);
        return;
      }
      handles.push(handle);
    }
    peer.ring = { id: ring, width, height, handles };
  }

  /** Delivers the frame with its slot's surface; a frame of no current ring goes without one, so the session acks and drops it. */
  private frame(peer: Peer, text: string, message: Json): void {
    const { sequence, slot } = message;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return;
    const ring = peer.ring;
    const current = ring !== null && message.ring === ring.id && Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < SLOTS;
    this.receiver!(text, current ? surfaceOf(ring, slot as number) : null, sequence as number);
  }

  private closeRing(peer: Peer): void {
    for (const h of peer.ring?.handles ?? []) this.options.addon.close(h);
    peer.ring = null;
  }

  private forget(): void {
    const peer = this.peer!;
    this.closeRing(peer);
    if (peer.process !== null) this.options.addon.close(peer.process);
    this.peer = null;
  }

  /** The started connection ends with one `disconnected`, `reason` the page's when it is not the service's going away. */
  private endStarted(reason?: string): void {
    if (!this.started) return;
    this.started = false;
    this.pending = [];
    const receiver = this.receiver!, generation = this.generation;
    const json = reason === undefined ? DISCONNECTED : JSON.stringify({ event: 'disconnected', reason });
    // As the macOS addon delivers it: after the call that caused it, so a start's caller has seen start return.
    queueMicrotask(() => { if (generation === this.generation) receiver(json, null, 0); });
  }
}

function surfaceOf(ring: Ring, slot: number): PreviewSurface {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(BigInt(ring.handles[slot]!));
  return { handle, width: ring.width, height: ring.height, pixelFormat: DXGI_FORMAT_B8G8R8A8_UNORM, bytesPerRow: ring.width * 4,
    id: ring.id * SLOTS + slot };
}
