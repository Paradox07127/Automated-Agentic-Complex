// Desktop surfaces and pass-through: the platform helper's `screens.list`, `windows.list` and `ax.hit_chain` replies in,
// the `surfaces`, `surface`, `covered` and `pass_through` contents out. Rects are C3 global points (AppKit's, y up, unless a
// `HelperY` says otherwise) unless a field says CG (the helper's: main display's top-left origin, y down).
import { appKitY, type HelperY } from './attention.ts';
import type { Box } from './c3.ts';

/** A 「桌面表面」 window item; `above` only on the attached track. */
export interface SurfaceWindow { window_id: number; generation: number; display_id: number; frame: Box; order: number;
  edges: { side: string; segments: [number, number][] }[]; above?: Box[] }
export type SurfaceUpdate = { track_id: string; state: 'tracking'; window: SurfaceWindow } | { track_id: string; state: 'gone'; reason: string };

type Range = [number, number];
type Point = { x: number; y: number };

/** One helper `window`; `bounds` in CG global points. */
export interface RawWindow { id: number; pid: number; layer: number; alpha: number; bounds: Box }

/** `frame` and `visible` (without the menu bar and the Dock) in global points. */
export interface SurfaceScreen { displayId: number; frame: Box; visible: Box }

/** One read, windows front to back. */
export interface SurfaceInput {
  windows: RawWindow[];
  excludedPids: ReadonlySet<number>;
  screens: SurfaceScreen[];
  /** Height of the primary display, for the CG → global flip. */
  mainHeight: number;
  /** The front app's pid; null when unknown. */
  frontPid: number | null;
  /** The CG → global y (AppKit's when absent). */
  helperY?: HelperY;
}

/** `frame` in global points. */
export interface UnderlayElement { role: string | null; subrole: string | null; frame: Box | null }

// CGRect's semantics: `contains` is half-open, `intersects` needs overlap, a null rect is `null`.
const maxX = (r: Box) => r.x + r.w;
const maxY = (r: Box) => r.y + r.h;
const contains = (r: Box, p: Point) => p.x >= r.x && p.x < maxX(r) && p.y >= r.y && p.y < maxY(r);
const intersects = (a: Box, b: Box) => a.x < maxX(b) && b.x < maxX(a) && a.y < maxY(b) && b.y < maxY(a);
function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), x1 = Math.min(maxX(a), maxX(b)), y1 = Math.min(maxY(a), maxY(b));
  return x1 < x || y1 < y ? null : { x, y, w: x1 - x, h: y1 - y };
}
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(maxX(a), maxX(b)) - x, h: Math.max(maxY(a), maxY(b)) - y };
}
const grow = (r: Box, d: number): Box => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
const sameRects = (a: readonly Box[] | null, b: readonly Box[] | null) => JSON.stringify(a) === JSON.stringify(b);
/** CG global bounds → global points. */
const flip = (b: Box, mainHeight: number, y: HelperY = appKitY): Box => ({ x: b.x, y: y(b.y, b.h, mainHeight), w: b.w, h: b.h });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A C12 `rect` as a Box; null when it is not one. */
function helperRect(v: unknown): Box | null {
  if (!object(v) || ![v.x, v.y, v.width, v.height].every(finite)) return null;
  return { x: v.x as number, y: v.y as number, w: v.width as number, h: v.height as number };
}

/** Over `screens.list`: frames in global points, the primary display's height (0 without). */
export function readScreens(result: Record<string, unknown>, y?: HelperY): { screens: SurfaceScreen[]; mainHeight: number } {
  const list = Array.isArray(result.screens) ? result.screens.filter(object) : [];
  const mainHeight = helperRect(list.find((s) => s.primary === true)?.frame)?.h ?? 0;
  const screens = list.flatMap((s) => {
    const frame = helperRect(s.frame), visible = helperRect(s.visible);
    if (!finite(s.display_id) || frame === null || visible === null) return [];
    return [{ displayId: s.display_id, frame: flip(frame, mainHeight, y), visible: flip(visible, mainHeight, y) }];
  });
  return { screens, mainHeight };
}

/** Over `windows.list`: only id, pid, layer (0 when absent), alpha (1 when absent) and bounds. */
export function readWindows(result: Record<string, unknown>): RawWindow[] {
  const list = Array.isArray(result.windows) ? result.windows.filter(object) : [];
  return list.flatMap((w) => {
    const bounds = helperRect(w.bounds);
    if (!Number.isInteger(w.window_id) || !Number.isInteger(w.pid) || bounds === null) return [];
    return [{ id: w.window_id as number, pid: w.pid as number, layer: finite(w.layer) ? w.layer : 0, alpha: finite(w.alpha) ? w.alpha : 1, bounds }];
  });
}

/** Over `ax.hit_chain`: the hit element and its ancestors, frames in global points. */
export function readHitChain(result: Record<string, unknown>, mainHeight: number, y?: HelperY): UnderlayElement[] {
  const list = Array.isArray(result.chain) ? result.chain.filter(object) : [];
  return list.map((e) => {
    const frame = helperRect(e.frame);
    return { role: typeof e.role === 'string' ? e.role : null, subrole: typeof e.subrole === 'string' ? e.subrole : null,
      frame: frame && flip(frame, mainHeight, y) };
  });
}

/** Window size limits in points. */
export const SURFACE_LIMITS = { minSize: 80, minSegment: 40, maxWindows: 32, maxSegments: 8 } as const;

export type Presence = { kind: 'listed'; window: SurfaceWindow } | { kind: 'notListed' } | { kind: 'closed' };

const clamp = (a: Range, b: Range): Range | null => {
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  return lo < hi ? [lo, hi] : null;
};
function subtract(a: Range, cut: Range): Range[] {
  if (!(cut[0] < a[1] && cut[1] > a[0])) return [a];
  const out: Range[] = [];
  if (cut[0] > a[0]) out.push([a[0], cut[0]]);
  if (cut[1] < a[1]) out.push([cut[1], a[1]]);
  return out;
}
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) out[out.length - 1] = [last[0], Math.max(last[1], r[1])];
    else out.push(r);
  }
  return out;
}

/** The uncovered parts of the top, left and right edges of `f`. */
export function surfaceEdges(f: Box, covers: Box[], screens: Box[]): SurfaceWindow['edges'] {
  const lines: [string, number, Range, boolean][] = [
    ['top', maxY(f), [f.x, maxX(f)], true], ['left', f.x, [f.y, maxY(f)], false], ['right', maxX(f), [f.y, maxY(f)], false]];
  return lines.flatMap(([side, at, span, horizontal]) => {
    // The parts of the line on some display, minus every rect in front that reaches the line.
    const across = (r: Box): Range | null => (horizontal ? (r.y <= at && at <= maxY(r) ? [r.x, maxX(r)] : null)
      : (r.x <= at && at <= maxX(r) ? [r.y, maxY(r)] : null));
    let free = screens.map(across).flatMap((r) => (r ? [clamp(r, span)] : [])).filter((r): r is Range => r !== null);
    for (const r of covers) {
      const cut = across(r);
      if (cut) free = free.flatMap((a) => subtract(a, cut));
    }
    const segments = merge(free).filter((s) => s[1] - s[0] >= SURFACE_LIMITS.minSegment)
      .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, SURFACE_LIMITS.maxSegments).sort((a, b) => a[0] - b[0]);
    return segments.length === 0 ? [] : [{ side, segments }];
  });
}

/** The strips of `frame` outside `visible` (menu bar and Dock). */
export function outsideVisible(frame: Box, visible: Box): Box[] {
  return [{ x: frame.x, y: maxY(visible), w: frame.w, h: maxY(frame) - maxY(visible) },
    { x: frame.x, y: frame.y, w: frame.w, h: visible.y - frame.y },
    { x: frame.x, y: frame.y, w: visible.x - frame.x, h: frame.h },
    { x: maxX(visible), y: frame.y, w: maxX(frame) - maxX(visible), h: frame.h }].filter((r) => r.w > 0 && r.h > 0);
}

/** Which windows are listed, their generations and uncovered edges. */
export class DesktopSurfaces {
  private readonly generations = new Map<number, number>();
  private listed = new Set<number>();
  private onScreen = new Set<number>();
  /** Every listed window, front to back; `windows` is the part a `surfaces` snapshot carries. */
  all: SurfaceWindow[] = [];

  get windows(): SurfaceWindow[] {
    return this.all.slice(0, SURFACE_LIMITS.maxWindows);
  }

  /** A window id that left the list and comes back gets the next generation. */
  update(input: SurfaceInput): void {
    const kept: { raw: RawWindow; frame: Box; display: number }[] = [];
    for (const w of input.windows) {
      const frame = flip(w.bounds, input.mainHeight, input.helperY);
      if (w.layer !== 0 || !(w.alpha > 0) || input.excludedPids.has(w.pid)) continue;
      if (frame.w < SURFACE_LIMITS.minSize || frame.h < SURFACE_LIMITS.minSize) continue;
      const mid = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
      const screen = input.screens.find((s) => contains(s.frame, mid)) ?? input.screens.find((s) => intersects(s.frame, frame));
      if (!screen) continue;
      kept.push({ raw: w, frame, display: screen.displayId });
    }
    const ids = new Set(kept.map((k) => k.raw.id));
    for (const id of ids) if (!this.listed.has(id)) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.listed = ids;
    this.onScreen = new Set(input.windows.map((w) => w.id));
    const chrome = input.screens.flatMap((s) => outsideVisible(s.frame, s.visible));
    this.all = kept.map((k, order) => ({
      window_id: k.raw.id, generation: this.generations.get(k.raw.id) ?? 1, display_id: k.display, frame: k.frame, order,
      edges: surfaceEdges(k.frame, [...kept.slice(0, order).map((x) => x.frame), ...chrome], input.screens.map((s) => s.frame)),
    }));
  }

  /** Where `id` stands after the last update; tracking is not bound by the snapshot's 32 windows. */
  presence(id: number): Presence {
    const w = this.all.find((x) => x.window_id === id);
    if (w) return { kind: 'listed', window: w };
    return this.onScreen.has(id) ? { kind: 'notListed' } : { kind: 'closed' };
  }
}

/** Tracking intervals in seconds. `aboveMargin` is in points. */
export const TRACKING = { snapshotInterval: 0.5, trackInterval: 1 / 30, keepalive: 0.1, maxTracks: 4, requestsPerSecond: 10,
  aboveMargin: 40, maxAbove: 8 } as const;

/** One line SurfaceTracking hands out. */
export type SurfaceMessage = { kind: 'surfaces'; seq: number; windows: SurfaceWindow[] } | { kind: 'surface'; update: SurfaceUpdate };

const gone = (trackId: string, reason: string): SurfaceMessage => ({ kind: 'surface', update: { track_id: trackId, state: 'gone', reason } });
const sameWindow = (a: SurfaceWindow, b: SurfaceWindow) => JSON.stringify(a) === JSON.stringify(b);

interface Track { id: string; windowId: number; generation: number; last: SurfaceWindow; sentAt: number; above: Box[] | null }

/** Window generations and `seq` reset on reconnect. Poll times are in seconds. */
export class SurfaceTracking {
  private readonly surfaces = new DesktopSurfaces();
  private tracks: Track[] = [];
  private pending: { id: string; windowId: number; generation: number | null }[] = [];
  private requestTimes: number[] = [];
  private seq = 0;
  private lastSnapshot: SurfaceWindow[] | null = null;
  private polledAt = -Infinity;
  private checkedAt = -Infinity;
  private refresh = true;
  private attachedId: string | null = null;
  private attachDue = false;

  /** The attached `track_id`, tracked or still pending. */
  get attached(): string | null {
    return this.attachedId;
  }

  /** The `above` of the attached track's latest `surface`; null while nothing is attached. */
  get attachedAbove(): Box[] | null {
    return this.attachedId === null ? null : this.tracks.find((t) => t.id === this.attachedId)?.above ?? null;
  }

  /** `attach`; an id that is not tracked or pending counts as null. Goes out on the next tick. */
  attach(id: string | null): void {
    const known = id !== null && (this.tracks.some((t) => t.id === id) || this.pending.some((p) => p.id === id)) ? id : null;
    if (known === this.attachedId) return;
    this.attachedId = known;
    this.attachDue = true;
    for (const t of this.tracks) {
      if (t.above === null) continue;
      t.above = null;
      t.sentAt = -Infinity;
    }
  }

  /** The front app, the Space or the displays changed: poll and check the snapshot on the next tick. */
  refreshSoon(): void {
    this.refresh = true;
  }

  /** `track_surface`; answered on the next tick, or at once with `gone` `too_many`. */
  track(id: string, windowId: number, generation: number | null, now: number): SurfaceMessage[] {
    this.requestTimes = this.requestTimes.filter((t) => now - t < 1);
    if (this.requestTimes.length >= TRACKING.requestsPerSecond || this.tracks.length + this.pending.length >= TRACKING.maxTracks) {
      return [gone(id, 'too_many')];
    }
    this.requestTimes.push(now);
    this.pending.push({ id, windowId, generation });
    return [];
  }

  untrack(id: string): void {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.pending = this.pending.filter((p) => p.id !== id);
    if (this.attachedId === id) this.attachedId = null;
  }

  /** Every link tick; `read` returns null while a requested read is pending. `body` is her body frame, null without one. */
  tick(now: number, body: Box | null, read: () => SurfaceInput | null): SurfaceMessage[] {
    const polling = this.refresh || this.attachDue || this.pending.length > 0 || now - this.polledAt >= TRACKING.snapshotInterval
      || (this.tracks.length > 0 && now - this.polledAt >= TRACKING.trackInterval);
    const out: SurfaceMessage[] = [];
    let input: SurfaceInput | null = null;
    const fresh = polling ? read() : null;
    if (fresh !== null) {
      input = fresh;
      this.surfaces.update(fresh);
      this.polledAt = now;
      if (this.refresh || now - this.checkedAt >= TRACKING.snapshotInterval) {
        this.checkedAt = now;
        const list = this.surfaces.windows;
        if (this.lastSnapshot === null || list.length !== this.lastSnapshot.length || list.some((w, i) => !sameWindow(w, this.lastSnapshot![i]!))) {
          this.lastSnapshot = list;
          out.push({ kind: 'surfaces', seq: this.seq, windows: list });
          this.seq += 1;
        }
      }
      this.refresh = false;
      this.attachDue = false;
      for (const p of this.pending) {
        const at = this.surfaces.presence(p.windowId);
        if (at.kind === 'listed' && (p.generation === null || p.generation === at.window.generation)) {
          this.tracks.push({ id: p.id, windowId: p.windowId, generation: at.window.generation, last: at.window, sentAt: -Infinity, above: null });
        } else {
          out.push(gone(p.id, at.kind === 'listed' ? 'generation' : at.kind === 'notListed' ? 'not_listed' : 'closed'));
        }
      }
      this.pending = [];
    }
    const kept: Track[] = [];
    for (const t of this.tracks) {
      if (input !== null) {
        const at = this.surfaces.presence(t.windowId);
        if (at.kind === 'notListed') {
          out.push(gone(t.id, 'not_listed'));
          continue;
        }
        if (at.kind !== 'listed' || at.window.generation !== t.generation) {
          out.push(gone(t.id, 'closed'));
          continue;
        }
        if (!sameWindow(at.window, t.last)) {
          t.last = at.window;
          t.sentAt = -Infinity;
        }
        if (t.id === this.attachedId) {
          const above = aboveRects(input, t.windowId, body);
          if (!sameRects(above, t.above)) {
            t.above = above;
            t.sentAt = -Infinity;
          }
        }
      }
      if (now - t.sentAt >= TRACKING.keepalive) {
        const window: SurfaceWindow = t.above === null ? { ...t.last } : { ...t.last, above: t.above };
        out.push({ kind: 'surface', update: { track_id: t.id, state: 'tracking', window } });
        t.sentAt = now;
      }
      kept.push(t);
    }
    const attached = this.attachedId;
    if (attached !== null && !kept.some((t) => t.id === attached) && !this.pending.some((p) => p.id === attached)) this.attachedId = null;
    this.tracks = kept;
    return out;
  }
}

/** The windows in front of `windowId` in the same read, layer 0, alpha > 0, not
 *  excluded, within `aboveMargin` of `body`, front to back; past `maxAbove`, the pair whose bounding box adds the least
 *  area becomes that box, at the front one's place. */
export function aboveRects(input: SurfaceInput, windowId: number, body: Box | null): Box[] {
  const at = input.windows.findIndex((w) => w.id === windowId);
  if (body === null || at < 0) return [];
  const reach = grow(body, TRACKING.aboveMargin);
  const rects = input.windows.slice(0, at).filter((w) => w.layer === 0 && w.alpha > 0 && !input.excludedPids.has(w.pid))
    .map((w) => flip(w.bounds, input.mainHeight, input.helperY)).filter((r) => r.w > 0 && r.h > 0 && intersects(r, reach));
  while (rects.length > TRACKING.maxAbove) {
    let best = { i: 0, j: 1, cost: Infinity };
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!, b = rects[j]!, u = union(a, b);
        const cost = u.w * u.h - a.w * a.h - b.w * b.h;
        if (cost < best.cost) best = { i, j, cost };
      }
    }
    rects[best.i] = union(rects[best.i]!, rects[best.j]!);
    rects.splice(best.j, 1);
  }
  return rects;
}

/** and the key pause `covered` waits for; seconds. */
export const COVER = { enterFraction: 0.15, leaveFraction: 0.05, dwell: 0.3, readInterval: 0.1, typingPause: 1.5 } as const;

/** Whether the front app's window covers her, from window list reads and her body frame. */
export class CoverState {
  covered = false;
  fraction = 0;
  /** The covering window while covered; null when the front app has none. */
  frame: Box | null = null;
  private since: number | null = null;

  /** One window list read; `body` is her body frame. */
  update(input: SurfaceInput, body: Box, now: number): 'entered' | 'left' | null {
    const window = coveringWindow(input);
    const overlap = window && intersection(window, body);
    const area = body.w * body.h;
    this.fraction = overlap === null || area <= 0 ? 0 : overlap.w * overlap.h / area;
    if (this.covered) this.frame = window;
    if (!(this.covered ? this.fraction < COVER.leaveFraction : this.fraction >= COVER.enterFraction)) {
      this.since = null;
      return null;
    }
    const start = this.since ?? now;
    this.since = start;
    if (now - start < COVER.dwell) return null;
    this.since = null;
    this.covered = !this.covered;
    this.frame = this.covered ? window : null;
    return this.covered ? 'entered' : 'left';
  }

  /** Dragged, hidden, attached, or the screen locked or asleep: nothing is judged, and a cover ends at once. */
  pause(): 'left' | null {
    this.since = null;
    if (!this.covered) return null;
    this.covered = false;
    this.frame = null;
    return 'left';
  }
}

/** The front app's frontmost layer 0 window; null when the front app is unknown, is
 *  excluded, or has none. */
export function coveringWindow(input: SurfaceInput): Box | null {
  const pid = input.frontPid;
  if (pid === null || input.excludedPids.has(pid)) return null;
  const w = input.windows.find((x) => x.pid === pid && x.layer === 0);
  return w ? flip(w.bounds, input.mainHeight, input.helperY) : null;
}

const INTERACTIVE = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXButton', 'AXPopUpButton', 'AXMenuButton', 'AXCheckBox',
  'AXRadioButton', 'AXLink', 'AXSlider', 'AXIncrementor', 'AXDisclosureTriangle', 'AXMenuItem', 'AXMenuBarItem', 'AXColorWell',
  'AXDateTimeArea']);
const BOUNDARIES = new Set(['AXWindow', 'AXApplication', 'AXWebArea']);

/** `chain` is the hit element, then its ancestors. */
export function firstInteractive(chain: UnderlayElement[]): UnderlayElement | null {
  for (const e of chain) {
    if (e.role !== null && BOUNDARIES.has(e.role)) return null;
    if (e.role !== null && INTERACTIVE.has(e.role) && e.frame !== null && e.frame.w > 0 && e.frame.h > 0) return e;
  }
  return null;
}

/** Seconds. */
export const PASS_THROUGH = { probeInterval: 0.05, refreshAfter: 0.5, maxAge: 2, maxEntries: 8 } as const;

/** Cached frames of the user's controls under her body, each with the time it was last probed. */
export class PassThroughCache {
  private entries: { frame: Box; probedAt: number }[] = [];
  private lastProbeAt = -Infinity;

  contains(p: Point, now: number): boolean {
    return this.entries.some((e) => now - e.probedAt < PASS_THROUGH.maxAge && contains(e.frame, p));
  }

  needsProbe(p: Point, now: number): boolean {
    if (now - this.lastProbeAt < PASS_THROUGH.probeInterval) return false;
    // Entries are kept oldest first, so the last one under `p` is the newest.
    const entry = this.entries.findLast((e) => now - e.probedAt < PASS_THROUGH.maxAge && contains(e.frame, p));
    return entry === undefined || now - entry.probedAt >= PASS_THROUGH.refreshAfter;
  }

  /** `element` is the interactive element at `p`, or null when there is none. */
  record(p: Point, element: UnderlayElement | null, now: number): void {
    this.lastProbeAt = now;
    this.entries = this.entries.filter((e) => !contains(e.frame, p));
    if (element?.frame == null) return;
    this.entries.push({ frame: element.frame, probedAt: now });
    if (this.entries.length > PASS_THROUGH.maxEntries) this.entries.splice(0, this.entries.length - PASS_THROUGH.maxEntries);
  }

  expire(now: number): void {
    this.entries = this.entries.filter((e) => now - e.probedAt < PASS_THROUGH.maxAge);
  }

  get rects(): Box[] {
    return this.entries.map((e) => e.frame);
  }
}

/** The cursor is near her capsules, in the capsules' space. */
export function nearCapsules(p: Point, bounds: Box | null, margin: number, near: number): boolean {
  return bounds !== null && contains(grow(bounds, margin + near), p);
}
