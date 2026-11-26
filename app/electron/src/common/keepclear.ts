// on the Companion side: when to ask the renderer to walk her
// clear of the user's targets over her body. Rects are in the placement space of src/common/placement.ts.
import { intersection, type Rect } from './placement.ts';

export type KeepClearKind = 'text_input' | 'caret' | 'control' | 'dialog' | 'banner' | 'ime' | 'near_clicks' | 'video' | 'game';
const PRIORITY: KeepClearKind[] = ['dialog', 'banner', 'caret', 'text_input', 'ime', 'control', 'near_clicks', 'video', 'game'];

export interface KeepClearRect { kind: KeepClearKind; frame: Rect }
export type KeepClearOutput = { send: { id: string; kind: KeepClearKind; rects: Rect[] } } | 'drop';

/** Seconds and points. A pass-through rect becomes a `control` target on a press in it or a `controlHover` hover, and stays
 *  one `controlKeep`; a press off her within `near` of her body counts toward `near_clicks`. */
export const KEEP_CLEAR = { settle: 1.2, typingPause: 1.5, cooldown: 8, margin: 8, maxRects: 8, idGrid: 32, rememberedIds: 32,
  controlHover: 1, controlKeep: 10, near: 120 } as const;

/** A half goes away from zero. */
const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/** FNV-1a 64 of the hit kinds and frames on a 32 pt grid, so a few points of jitter keep the id. */
export function keepClearId(hits: KeepClearRect[]): string {
  const keys = hits.map((h) => `${[h.frame.x, h.frame.y, h.frame.w, h.frame.h].map((v) => String(round(v / KEEP_CLEAR.idGrid))).join(',')}:${h.kind}`)
    .sort();
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(keys.join(';'))) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `kc-${hash.toString(16).padStart(16, '0')}`;
}

/** The distance between two rects; 0 when they touch or overlap. */
export function gap(a: Rect, b: Rect): number {
  return Math.hypot(Math.max(b.x - (a.x + a.w), 0, a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), 0, a.y - (b.y + b.h)));
}

const rank = (kind: KeepClearKind) => PRIORITY.indexOf(kind);
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

/** KeepClearState: one per connection; `update` every tick. */
export class KeepClearState {
  private runSince: number | null = null;
  private cooldownUntil = -Infinity;
  private sentIds: string[] = [];
  private outstanding = false;

  /** `body` is her capsules' bounds, null without any; `keyIdle` the seconds since the last key press. */
  update(rects: KeepClearRect[], body: Rect | null, keyIdle: number, blocked: boolean, now: number): KeepClearOutput | null {
    const valid = rects.filter((r) => r.frame.w > 0 && r.frame.h > 0);
    const hits = blocked || body === null ? [] : valid.filter((r) => intersection(grow(r.frame, KEEP_CLEAR.margin), body) !== null);
    if (hits.length === 0) {
      this.runSince = null;
      if (!this.outstanding) return null;
      this.outstanding = false;
      return 'drop';
    }
    const since = this.runSince ?? now;
    this.runSince = since;
    const urgent = hits.some((h) => h.kind === 'dialog' || h.kind === 'banner');
    if (now - since < KEEP_CLEAR.settle || keyIdle < KEEP_CLEAR.typingPause || !(urgent || now >= this.cooldownUntil)) return null;
    const id = keepClearId(hits);
    if (this.sentIds.includes(id)) return null;
    const ordered = [...hits].sort((a, b) => rank(a.kind) - rank(b.kind));
    const others = valid.filter((r) => !hits.includes(r)).sort((a, b) => gap(a.frame, body!) - gap(b.frame, body!));
    this.cooldownUntil = now + KEEP_CLEAR.cooldown;
    this.sentIds.push(id);
    if (this.sentIds.length > KEEP_CLEAR.rememberedIds) this.sentIds.splice(0, this.sentIds.length - KEEP_CLEAR.rememberedIds);
    this.outstanding = true;
    const kind = ordered[0]!.kind;
    // A screen-wide video/game rect would leave the host no spot clear of a smaller target.
    const sent = kind === 'video' || kind === 'game' ? [...ordered, ...others]
      : [...ordered, ...others].filter((r) => r.kind !== 'video' && r.kind !== 'game');
    return { send: { id, kind, rects: sent.slice(0, KEEP_CLEAR.maxRects).map((r) => r.frame) } };
  }
}

const contains = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** The pass-through rects the pointer pressed in or rested on. */
export class ControlTargets {
  private hover: { frame: Rect; since: number } | null = null;
  private controls: { frame: Rect; at: number }[] = [];

  get rects(): Rect[] { return this.controls.map((c) => c.frame); }

  /** Each tick: `g` the pointer, `passThrough` the rects sent in `pass_through`, `pressStarted` a press since the last tick. */
  update(g: { x: number; y: number }, passThrough: readonly Rect[], pressStarted: boolean, now: number): void {
    const under = passThrough.findLast((r) => contains(r, g));
    const same = (r: Rect) => JSON.stringify(r) === JSON.stringify(under);
    if (under) {
      const since = this.hover && same(this.hover.frame) ? this.hover.since : now;
      this.hover = { frame: under, since };
      if (pressStarted || now - since >= KEEP_CLEAR.controlHover) this.controls = [...this.controls.filter((c) => !same(c.frame)), { frame: under, at: now }];
    } else {
      this.hover = null;
    }
    this.controls = this.controls.filter((c) => now - c.at < KEEP_CLEAR.controlKeep);
  }
}

/** Seconds and points. */
export const NEAR_CLICKS = { cell: 50, window: 600, minPresses: 3, maxCells: 64 } as const;

/** The user's work area near her, 50 pt cells pressed at least 3 times in 600 s. */
export class NearClickCells {
  /** Oldest press first, by each cell's latest press. */
  private cells: { x: number; y: number; presses: number[] }[] = [];

  record(p: { x: number; y: number }, now: number): void {
    const x = Math.floor(p.x / NEAR_CLICKS.cell), y = Math.floor(p.y / NEAR_CLICKS.cell);
    const presses = (this.cells.find((c) => c.x === x && c.y === y)?.presses ?? []).filter((t) => now - t < NEAR_CLICKS.window);
    this.cells = [...this.cells.filter((c) => c.x !== x || c.y !== y), { x, y, presses: [...presses, now] }];
    if (this.cells.length > NEAR_CLICKS.maxCells) this.cells.splice(0, this.cells.length - NEAR_CLICKS.maxCells);
  }

  rects(now: number): Rect[] {
    return this.cells.filter((c) => c.presses.filter((t) => now - t < NEAR_CLICKS.window).length >= NEAR_CLICKS.minPresses)
      .map((c) => ({ x: c.x * NEAR_CLICKS.cell, y: c.y * NEAR_CLICKS.cell, w: NEAR_CLICKS.cell, h: NEAR_CLICKS.cell }));
  }
}

/** Presses off her within 120 pt of her bounds over the last 10 s, for `near_clicks_10s`. */
export class NearClickCount {
  private presses: number[] = [];

  click(ts: number, p: { x: number; y: number }, bounds: Rect | null, hit: boolean): void {
    if (hit || bounds === null || gap({ ...p, w: 0, h: 0 }, bounds) > KEEP_CLEAR.near) return;
    this.presses = [...this.presses.filter((t) => ts - t < 10), ts];
  }

  count(now: number): number {
    return this.presses.filter((t) => now - t < 10).length;
  }
}

/** The window's frame while it is on screen, else null. */
export function shownFrame(frame: Rect, visible: boolean, minimized: boolean, occluded: boolean): Rect | null {
  return visible && !minimized && !occluded ? frame : null;
}

/** HostLinkFraming.capsuleBounds over C3 `hit_capsules` items; null when none is well formed. */
export function capsuleBounds(capsules: unknown): Rect | null {
  if (!Array.isArray(capsules)) return null;
  let box: Rect | null = null;
  for (const c of capsules as Record<string, unknown>[]) {
    const a = c?.a, b = c?.b, r = c?.r;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2 || typeof r !== 'number'
      || ![...a, ...b].every((v) => typeof v === 'number')) continue;
    const [ax, ay] = a as number[], [bx, by] = b as number[];
    const one = { x: Math.min(ax!, bx!) - r, y: Math.min(ay!, by!) - r, w: Math.abs(bx! - ax!) + 2 * r, h: Math.abs(by! - ay!) + 2 * r };
    box = box === null ? one : union(box, one);
  }
  return box;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
