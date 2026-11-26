// Desktop surfaces from the platform helper: each link tick reads `windows.list` (and `screens.list` when the displays are
// not known) at the rules' pace, sends `surfaces` / `surface` / `covered` / `pass_through` through the link, and answers
// `track_surface`, `untrack_surface` and `attach`. `workspace.watch` events ask for a fresh read.
import { appKitY, type AttentionSample, type HelperY } from '../../common/attention.ts';
import { type Box, type Capsule, capsulesBox, CURSOR, readCapsules } from '../../common/c3.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';
import {
  COVER, CoverState, DesktopSurfaces, firstInteractive, nearCapsules, PassThroughCache, readHitChain, readScreens, readWindows,
  type SurfaceInput, type SurfaceMessage, type SurfaceScreen, type SurfaceWindow, SurfaceTracking, TRACKING,
} from '../../common/surfaces.ts';
import type { LinkEvent, SurfaceTrackEvent, SurfaceUpdate } from '../renderer/link.ts';

/** The link's tick. */
const TICK_MS = 1000 / 60;

/** What the source uses of HostLink. */
export interface SurfaceLink {
  readonly hello: { pid: number } | null;
  /** The avatar's hello capabilities. */
  readonly capabilities: string[];
  readonly hidden: boolean;
  on(listener: (e: LinkEvent) => void): () => void;
  sendSurfaces(seq: number, windows: SurfaceWindow[]): boolean;
  sendSurface(s: SurfaceUpdate): boolean;
  sendCovered(w: { window_id: number; generation: number; frame: Box } | null): boolean;
  sendPassThrough(rects: Box[]): boolean;
  /** Where `cursor.hit` stays false. */
  setHitExclusions(rects: { above: Box[]; passThrough: Box[] }): boolean;
  /** The next cursor sample goes out even if the pointer stood still. */
  cursorMoved(): void;
}

export interface SurfacePorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  link: SurfaceLink;
  /** The pointer in C3 global points. */
  cursor(): { x: number; y: number };
  /** This shell's processes, whose windows never count. */
  ownPids(): readonly number[];
  /** Seconds since the last key press (infinity when absent). */
  keyIdle?(): number;
  /** Locked or asleep (HostLink setSystemPaused). */
  systemPaused?(): boolean;
  /** The 原地不动 switch (HostLink setStayInPlace). */
  stayInPlace?(): boolean;
  /** The helper's CG y → C3's (AppKit's when absent). */
  helperY?: HelperY;
  /** Monotonic milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

/** HostLink.Connection's surface fields, for one handshaken renderer. */
class Connection {
  readonly avatarPid: number;
  /** Set at hello when she lists `surfaces`. */
  readonly tracking: SurfaceTracking | null;
  readonly tracks = new Set<string>();
  readAt = -Infinity;
  readRequested = true;
  readRevision = 0;
  input: SurfaceInput | null = null;
  inputRevision = 0;
  inputFresh = false;
  readonly cover = new CoverState();
  /** Window ids and generations for `covered`, over every read of this connection. */
  readonly coverSurfaces = new DesktopSurfaces();
  coveredWindow: SurfaceWindow | null = null;
  readonly passThrough = new PassThroughCache();
  passSent: Box[] = [];
  capsules: Capsule[] = [];
  capsulesGlobal = false;
  frame: Box | null = null;
  dragging = false;
  constructor(avatarPid: number, surfaces: boolean) {
    this.avatarPid = avatarPid;
    this.tracking = surfaces ? new SurfaceTracking() : null;
  }
}

export class SurfaceSource {
  private readonly ports: SurfacePorts;
  private conn: Connection | null = null;
  private running = false;
  private reading = false;
  private probing = false;
  /** The displays and the primary's height, read again after a `screens` change. */
  private screens: { screens: SurfaceScreen[]; mainHeight: number } | null = null;
  /** The front app from `workspace.watch` and `workspace.changed`. */
  private frontPid: number | null = null;
  /** The watch gave the front app: the attention sample's front no longer sets `frontPid`. */
  private frontWatched = false;
  /** `workspace.watch` answered; after a restart the supervisor asks for it again. */
  private workspaceWatched = false;
  private failed: string | null = null;
  private readonly stops: (() => void)[] = [];

  constructor(ports: SurfacePorts) {
    this.ports = ports;
    this.stops.push(ports.link.on((e) => this.linkEvent(e)), ports.every(TICK_MS, () => this.tick()));
  }

  stop(): void {
    for (const s of this.stops.splice(0)) s();
  }

  /** The front app's window covers her. */
  get isCovered(): boolean {
    return this.conn?.cover.covered ?? false;
  }

  /** Each attention sample: without `workspace.watch`'s `front_pid` its front app stands in for the one at start
   *  until the watch speaks. */
  sampled(s: AttentionSample): void {
    if (!this.frontWatched) this.frontPid = s.front?.pid ?? null;
  }

  /** The helper said hello (true) or went (false). */
  helper(running: boolean): void {
    this.running = running;
    this.screens = null;
    if (!running) {
      // No reads without the helper: the tracked windows stop and the renderer drops them after 250 ms.
      if (this.conn) this.conn.input = null;
      return;
    }
    if (!this.workspaceWatched) void this.watchWorkspace();
    this.changed();
  }

  private async watchWorkspace(): Promise<void> {
    const r = await this.ports.helper.request('workspace.watch', { enabled: true });
    if (!r.ok) {
      this.ports.log(`SURFACES workspace.watch failed code=${r.error.code}`);
      return;
    }
    this.workspaceWatched = true;
    // The front app at start; Windows does not give it.
    if (!this.frontWatched && (Number.isInteger(r.result.front_pid) || r.result.front_pid === null)) {
      this.frontPid = r.result.front_pid as number | null;
      this.frontWatched = true;
      this.changed();
    }
  }

  /** A helper event; only `workspace.changed` is read. */
  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'workspace.changed') return;
    if (Number.isInteger(data.front_pid) || data.front_pid === null) {
      this.frontPid = data.front_pid as number | null;
      this.frontWatched = true;
    }
    if (data.reason === 'screens') this.screens = null;
    this.changed();
  }

  /** LinkOptions.onSurfaceTrack. */
  track(e: SurfaceTrackEvent): void {
    const c = this.conn;
    if (!c?.tracking) return;
    if (e.kind === 'untrack') {
      c.tracking.untrack(e.trackId);
      c.tracks.delete(e.trackId);
      return;
    }
    if (e.kind === 'attach') {
      c.tracking.attach(e.trackId);
      c.readRequested = true;
      return;
    }
    const replies = c.tracking.track(e.trackId, e.windowId, e.generation, this.seconds());
    if (replies.length === 0) c.tracks.add(e.trackId);
    c.readRequested = true;
    c.readRevision += 1;
    for (const m of replies) this.send(m);
  }

  /** HostLink.surfacesChanged. */
  private changed(): void {
    const c = this.conn;
    if (!c) return;
    c.readRequested = true;
    c.readRevision += 1;
    c.tracking?.refreshSoon();
  }

  private seconds(): number {
    return this.ports.now() / 1000;
  }

  private linkEvent(e: LinkEvent): void {
    if (e.kind === 'hello') {
      this.conn = new Connection(e.hello.pid, e.hello.capabilities.includes('surfaces'));
      return;
    }
    if (e.kind === 'lost') {
      this.conn = null;
      return;
    }
    const c = this.conn;
    if (e.kind !== 'message' || !c) return;
    const m = e.message;
    if (m.type === 'hit_capsules') {
      c.capsules = readCapsules(m.capsules);
      c.capsulesGlobal = m.space === 'global';
    } else if (m.type === 'window_frame') {
      const f = m.frame as Record<string, number>;
      c.frame = { x: f.x!, y: f.y!, w: f.w!, h: f.h! };
    } else if (m.type === 'drag') {
      if (m.phase === 'begin') c.dragging = true;
      if (m.phase === 'end') c.dragging = false;
    }
  }

  /** HostLink.body: the capsules' bounds in global points; null without any. */
  private body(c: Connection): Box | null {
    const box = capsulesBox(c.capsules);
    if (box === null || c.capsulesGlobal) return box;
    return c.frame && { x: box.x + c.frame.x, y: box.y + c.frame.y, w: box.w, h: box.h };
  }

  private send(m: SurfaceMessage): void {
    if (m.kind === 'surfaces') this.ports.link.sendSurfaces(m.seq, m.windows);
    else this.ports.link.sendSurface(m.update);
  }

  private tick(): void {
    const c = this.conn;
    if (!c) return;
    const link = this.ports.link;
    const now = this.seconds();
    const fresh = c.inputFresh;
    let latest: SurfaceInput | null = null;
    const body = this.body(c);
    const coverPaused = (this.ports.systemPaused?.() ?? false) || c.dragging || link.hidden || c.tracking?.attached != null;
    let interval = c.tracking === null ? Infinity : TRACKING.snapshotInterval;
    if (c.tracks.size > 0) interval = TRACKING.trackInterval;
    if (!coverPaused && body !== null) interval = Math.min(interval, COVER.readInterval);
    this.read(c, now, interval);
    if (c.input !== null) {
      const snapshot = c.input;
      c.inputFresh = false;
      // The avatar's own windows never count; its pid is the one from its hello.
      const full: SurfaceInput = { ...snapshot, excludedPids: new Set([...snapshot.excludedPids, c.avatarPid]) };
      // judges each read once; tracking reuses the cached read every tick.
      if (fresh) {
        c.coverSurfaces.update(full);
        if (!coverPaused && body !== null) latest = full;
      }
      for (const m of c.tracking?.tick(now, body, () => (c.inputRevision === c.readRevision ? full : null)) ?? []) {
        if (m.kind === 'surface' && m.update.state === 'gone') c.tracks.delete(m.update.track_id);
        this.send(m);
        if (this.conn !== c) return;
      }
    }
    let change: 'entered' | 'left' | null = null;
    if (coverPaused) change = c.cover.pause();
    else if (body !== null && latest !== null) change = c.cover.update(latest, body, now);
    if (change !== null) {
      link.cursorMoved();
      this.ports.log(`SURFACES cover ${change}`);
    }
    // `covered` on entering, again when another window takes over, and null on leaving.
    if (link.capabilities.includes('opacity')) this.covered(c, change, latest);
    this.passThrough(c, now);
    link.setHitExclusions({ above: c.tracking?.attachedAbove ?? [], passThrough: c.passThrough.rects });
  }

  private covered(c: Connection, change: 'entered' | 'left' | null, latest: SurfaceInput | null): void {
    const stay = this.ports.stayInPlace?.() ?? false;
    if ((change === 'left' || stay) && c.coveredWindow !== null) {
      c.coveredWindow = null;
      this.ports.link.sendCovered(null);
      return;
    }
    // Never walk her off while the user types; leaving is never held.
    if (stay || !c.cover.covered || c.cover.fraction < COVER.leaveFraction || (this.ports.keyIdle?.() ?? Infinity) < COVER.typingPause) return;
    const pid = latest?.frontPid ?? null;
    if (latest === null || pid === null || latest.excludedPids.has(pid)) return;
    const id = latest.windows.find((w) => w.pid === pid && w.layer === 0)?.id;
    if (id === undefined) return;
    const at = c.coverSurfaces.presence(id);
    if (at.kind !== 'listed') return;
    const w = at.window;
    if (w.window_id === c.coveredWindow?.window_id && w.generation === c.coveredWindow.generation) return;
    c.coveredWindow = w;
    this.ports.link.sendCovered({ window_id: w.window_id, generation: w.generation, frame: w.frame });
  }

  /** Needs her window's frame; probes the control under the cursor while it is near her. */
  private passThrough(c: Connection, now: number): void {
    const f = c.frame;
    if (f === null) return;
    const g = this.ports.cursor();
    const hp = c.capsulesGlobal ? g : { x: g.x - f.x, y: g.y - f.y };
    const near = nearCapsules(hp, capsulesBox(c.capsules), CURSOR.margin, CURSOR.near);
    c.passThrough.expire(now);
    const mainHeight = this.screens?.mainHeight;
    if (this.running && !this.probing && mainHeight !== undefined && near && !this.ports.link.hidden && !c.dragging
      && c.passThrough.needsProbe(g, now)) {
      this.probing = true;
      const exclude = [...new Set([...(c.input?.excludedPids ?? []), c.avatarPid, ...this.ports.ownPids()])].filter((p) => p > 0);
      // The helper's points are CG's, y down from the primary display's top.
      const y = (this.ports.helperY ?? appKitY)(g.y, 0, mainHeight);
      void this.ports.helper.request('ax.hit_chain', { point: { x: g.x, y }, exclude_pids: exclude }).then((r) => {
        this.probing = false;
        if (this.conn !== c) return;
        c.passThrough.record(g, firstInteractive(r.ok ? readHitChain(r.result, mainHeight, this.ports.helperY) : []), now);
        this.sendPassThrough(c);
      });
    }
    this.sendPassThrough(c);
  }

  private sendPassThrough(c: Connection): void {
    const rects = c.passThrough.rects;
    if (!this.ports.link.capabilities.includes('pass_through') || JSON.stringify(rects) === JSON.stringify(c.passSent)) return;
    c.passSent = rects;
    this.ports.link.sendPassThrough(rects);
  }

  /** One read at a time, when asked or `interval` after the last. */
  private read(c: Connection, now: number, interval: number): void {
    if (this.reading || !this.running || !(c.readRequested || now - c.readAt >= interval)) return;
    this.reading = true;
    c.readRequested = false;
    c.readAt = now;
    // An in-flight read cannot answer a request that arrived after it was dispatched.
    const revision = c.readRevision;
    void this.readInput().then((input) => {
      this.reading = false;
      if (input === null || this.conn !== c || !this.running) return;
      c.input = input;
      c.inputRevision = revision;
      c.inputFresh = true;
      this.tick();
    });
  }

  /** The displays when not known, then the windows; null when the helper did not answer. */
  private async readInput(): Promise<SurfaceInput | null> {
    if (this.screens === null) {
      const r = await this.ports.helper.request('screens.list');
      if (!this.answered('screens.list', r)) return null;
      this.screens = readScreens(r.result, this.ports.helperY);
    }
    const screens = this.screens;
    const r = await this.ports.helper.request('windows.list');
    if (!this.answered('windows.list', r)) return null;
    return { windows: readWindows(r.result), excludedPids: new Set(this.ports.ownPids()), screens: screens.screens,
      mainHeight: screens.mainHeight, frontPid: this.frontPid, ...(this.ports.helperY && { helperY: this.ports.helperY }) };
  }

  private answered(op: string, r: HelperAnswer): r is { ok: true; result: Record<string, unknown> } {
    if (r.ok) {
      this.failed = null;
      return true;
    }
    if (this.failed !== r.error.code) this.ports.log(`SURFACES ${op} failed code=${r.error.code}`);
    this.failed = r.error.code;
    return false;
  }
}

/** The source, reading once `helper(true)` and a renderer's hello. */
export function startSurfaces(ports: SurfacePorts): SurfaceSource {
  return new SurfaceSource(ports);
}
