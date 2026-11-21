// Where she is for the desktop panels: raw body samples from C3 `hit_capsules` and her `placement`
// turned into the follow phases and the box the panels follow. Rects are in the placement space (y up); times in seconds.
import type { Rect, ScreenInfo } from './placement.ts';

export interface AnchorInput {
  /** Her capsules' bounds; null without them. */
  body: Rect | null;
  bodyAt: number | null;
  hidden: boolean;
  frontFullscreen: boolean;
  dragging: boolean;
  now: number;
  screens: ScreenInfo[];
  /** `placementBox` of her last C3 `placement`; null before one. */
  placement: Rect | null;
  /** Her character and appearance; a change forgets the extents learned from her capsules. */
  figure: string | null;
  /** The host's box over every visible mesh of hers, sent with `body`; null when the host left it out. */
  visual: Rect | null;
}

export type DockPhase = 'hidden' | 'fullscreen' | 'offscreen' | 'stale';
export type AnchorPhase = 'settled' | 'moving' | 'dragging' | { docked: DockPhase };

export interface AnchorSnapshot {
  phase: AnchorPhase;
  body: Rect | null;
  /** Where panels follow: her body column on her placement, or without one the body once it stopped. */
  settledBody: Rect | null;
  /** Her head top on `settledBody`'s top edge, as a rect of no size. */
  head: Rect | null;
  screen: ScreenInfo | null;
  lastScreen: ScreenInfo | null;
  /** Her anchor, what her column's extents came from and her posture; null without a placement. */
  column: { anchor: { x: number; y: number }; source: 'visual' | 'capsules' | 'placement'; posture: Posture } | null;
}

interface Extents { lo: number; hi: number; top: number }
type Posture = 'standing' | 'seated' | 'lying';

export const SETTLE = 0.3;
export const DEAD_ZONE = 1.5;
export const SWAY_SETTLE = 1;
export const FOLLOW_STEP = 24;
export const FRESH = 0.5;
export const STALE = 3;
export const DRAG_GRACE = 0.15;
const COLUMN_SAMPLES = 15;
const HALF_WIDTH = { min: 60, max: 800 };
const VISUAL_PADDING = 24;
const LOW_TOP = 0.7;
const POSTURE_HOLD = 0.5;

const maxX = (r: Rect) => r.x + r.w;
const maxY = (r: Rect) => r.y + r.h;
const midX = (r: Rect) => r.x + r.w / 2;
const midY = (r: Rect) => r.y + r.h / 2;
const offset = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
const same = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const contains = (r: Rect, x: number, y: number) => x >= r.x && x < maxX(r) && y >= r.y && y < maxY(r);

/** C3 `placement`: the render's 540 × 780 pt at `scale` 1, bottom-centred on the anchor (her feet). */
export function placementBox(x: number, y: number, scale: number): Rect {
  return { x: x - 270 * scale, y, w: 540 * scale, h: 780 * scale };
}

/** Her body column on the placement box `p`: the median extents around her anchor at `p`'s scale, each side clamped. */
function column(p: Rect, extents: Extents[]): Rect {
  if (extents.length === 0) return p;
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  const s = p.w / 540;
  const lo = -Math.min(Math.max(-median(extents.map((e) => e.lo)), HALF_WIDTH.min), HALF_WIDTH.max);
  const hi = Math.min(Math.max(median(extents.map((e) => e.hi)), HALF_WIDTH.min), HALF_WIDTH.max);
  return { x: midX(p) + lo * s, y: p.y, w: (hi - lo) * s, h: median(extents.map((e) => e.top)) * s };
}

export function walkStep(height: number): number { return Math.max(12, 0.03 * height); }

/** The largest edge shift between two boxes. */
export function shift(a: Rect, b: Rect): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(maxX(a) - maxX(b)), Math.abs(a.y - b.y), Math.abs(maxY(a) - maxY(b)));
}

/** From `b` to `a`, on each axis the shift both its edges share, with its sign. */
function rootDelta(a: Rect, b: Rect): { dx: number; dy: number } {
  const shared = (d0: number, d1: number) => (d0 * d1 > 0 ? (d0 > 0 ? Math.min(d0, d1) : Math.max(d0, d1)) : 0);
  return { dx: shared(a.x - b.x, maxX(a) - maxX(b)), dy: shared(a.y - b.y, maxY(a) - maxY(b)) };
}

function rootShift(a: Rect, b: Rect): number {
  const d = rootDelta(a, b);
  return Math.max(Math.abs(d.dx), Math.abs(d.dy));
}

/** Turns raw body samples into the follow phases; feed it every tick. */
export class AnchorTracker {
  private motion: 'settled' | 'moving' | 'dragging' = 'settled';
  private body: Rect | null = null;
  private settled: Rect | null = null;
  private walkFrom: Rect | null = null;
  private lastFreshAt: number | null = null;
  private stillCenter = { x: 0, y: 0 };
  private stillSince = 0;
  private swayCenter = { x: 0, y: 0 };
  private swaySince = 0;
  private dragEndedAt: number | null = null;
  private placement: Rect | null = null;
  private box: Rect | null = null;
  private boxBody: Rect | null = null;
  private grounded: { box: Rect; body: Rect } | null = null;
  private headDX = 0;
  private lastScreenId: number | null = null;
  private samples: Partial<Record<Posture, Extents[]>> = {};
  private visualSamples: Partial<Record<Posture, Extents[]>> = {};
  private wantsSample = false;
  private figure: string | null | undefined = undefined;
  private posture: Posture = 'standing';
  private nextPosture: { posture: Posture; since: number } | null = null;

  private setSettled(b: Rect | null): void {
    this.settled = b;
    this.walkFrom = b;
  }

  update(input: AnchorInput): AnchorSnapshot {
    const now = input.now;
    const sample = input.body && input.bodyAt !== null && now - input.bodyAt <= FRESH ? input.body : null;
    if (sample) this.lastFreshAt = now;

    if (input.dragging) {
      this.motion = 'dragging';
      this.dragEndedAt = null;
    } else if (this.motion === 'dragging') {
      this.dragEndedAt ??= now;
      if (now - this.dragEndedAt >= DRAG_GRACE) {
        this.motion = 'settled';
        this.dragEndedAt = null;
      }
    }

    let refresh = false;
    if (input.figure !== this.figure) {
      this.figure = input.figure;
      this.samples = {};
      this.visualSamples = {};
      this.posture = 'standing';
      this.nextPosture = null;
      this.wantsSample = true;
      refresh = this.motion !== 'dragging';
    }
    if (sample) this.track(sample, now);
    const p = input.placement;
    if (p && !same(p, this.placement)) {
      this.placement = p;
      this.wantsSample = true;
      refresh = true;
      if (this.motion === 'moving') this.motion = 'settled';
      if (this.motion !== 'dragging' && this.body) this.setSettled(this.body);
    } else if (this.motion === 'dragging' && sample && this.boxBody) {
      this.box = this.box && offset(this.box, midX(sample) - midX(this.boxBody), midY(sample) - midY(this.boxBody));
      this.boxBody = sample;
    } else if (!this.boxBody) {
      this.boxBody = this.body;
    }
    if (this.motion === 'dragging') {
      this.nextPosture = null;
    } else if (sample && this.placement) {
      const seen = this.postureOf(sample, this.placement);
      if (seen === this.posture) this.nextPosture = null;
      else if (this.nextPosture?.posture !== seen) this.nextPosture = { posture: seen, since: now };
      else if (now - this.nextPosture.since >= POSTURE_HOLD) {
        this.posture = seen;
        this.nextPosture = null;
        this.wantsSample = true;
        if (this.motion === 'settled') this.setSettled(sample);
      }
    }
    if (this.wantsSample && this.motion !== 'dragging' && sample && this.placement
      && this.postureOf(sample, this.placement) === this.posture) {
      const pl = this.placement, s = pl.w / 540;
      const e = [...(this.samples[this.posture] ?? []), { lo: (sample.x - midX(pl)) / s, hi: (maxX(sample) - midX(pl)) / s, top: (maxY(sample) - pl.y) / s }];
      this.samples[this.posture] = e.slice(-COLUMN_SAMPLES);
      const v = input.visual;
      if (v) {
        const ve = [...(this.visualSamples[this.posture] ?? []), {
          lo: (v.x - midX(pl)) / s + VISUAL_PADDING, hi: (maxX(v) - midX(pl)) / s - VISUAL_PADDING, top: (maxY(v) - pl.y) / s - VISUAL_PADDING,
        }];
        this.visualSamples[this.posture] = ve.slice(-COLUMN_SAMPLES);
      }
      this.wantsSample = false;
      refresh = true;
    }
    if (refresh && this.placement) {
      const c = column(this.placement, this.visualSamples[this.posture] ?? this.samples[this.posture] ?? []);
      this.box = c;
      this.boxBody = this.body;
      this.headDX = midX(this.placement) - c.x;
    }
    // A flight brings no placement: settled up there, her column goes with her root until she comes down.
    if (refresh || this.motion === 'dragging') {
      this.grounded = null;
    } else if (sample && this.placement && this.box) {
      const from = this.grounded?.body ?? this.boxBody;
      if (from) {
        const step = walkStep(from.h);
        const lifted = sample.y - from.y > step && maxY(sample) - maxY(from) > step;
        if (!this.grounded && lifted && this.motion === 'settled') {
          this.grounded = { box: this.box, body: from };
        } else if (this.grounded && !lifted) {
          this.box = this.grounded.box;
          this.boxBody = this.grounded.body;
          this.grounded = null;
        }
        if (this.grounded && this.boxBody && rootShift(sample, this.boxBody) > step) {
          const d = rootDelta(sample, this.boxBody);
          this.box = offset(this.box, d.dx, d.dy);
          this.boxBody = sample;
        }
      }
    }
    const settledBody = this.box ?? this.settled;
    const pl = this.placement;
    const placedColumn = pl && { anchor: { x: midX(pl), y: pl.y }, posture: this.posture,
      source: this.visualSamples[this.posture] ? 'visual' as const : this.samples[this.posture] ? 'capsules' as const : 'placement' as const };
    const head = settledBody && { x: settledBody.x + (this.box === null ? settledBody.w / 2 : this.headDX), y: maxY(settledBody), w: 0, h: 0 };
    const headScreen = head ? input.screens.find((s) => contains(s.frame, head.x, head.y)) ?? null : null;
    if (headScreen) this.lastScreenId = headScreen.id;
    const lastScreen = this.lastScreenId === null ? null : input.screens.find((s) => s.id === this.lastScreenId) ?? null;
    const screen = headScreen ?? lastScreen ?? input.screens[0] ?? null;

    let phase: AnchorPhase;
    if (input.hidden) phase = { docked: 'hidden' };
    else if (input.frontFullscreen) phase = { docked: 'fullscreen' };
    else if (this.lastFreshAt === null || now - this.lastFreshAt >= STALE) phase = { docked: 'stale' };
    else if (!headScreen) phase = { docked: 'offscreen' };
    else phase = this.motion;
    return { phase, body: this.body, settledBody, head, screen, lastScreen, column: placedColumn };
  }

  private postureOf(b: Rect, p: Rect): Posture {
    const standing = this.samples.standing;
    if (!standing?.length || !(maxY(b) - p.y < LOW_TOP * column(p, standing).h)) return 'standing';
    return b.w > b.h ? 'lying' : 'seated';
  }

  private track(b: Rect, now: number): void {
    this.body = b;
    const center = { x: midX(b), y: midY(b) };
    const settled = this.settled;
    if (!settled) {
      this.setSettled(b);
      return;
    }
    switch (this.motion) {
      case 'dragging':
        this.setSettled(b);
        break;
      case 'settled':
        if (rootShift(b, this.walkFrom ?? settled) > walkStep(settled.h)) {
          this.motion = 'moving';
          this.stillCenter = center;
          this.stillSince = now;
          this.swayCenter = center;
          this.swaySince = now;
        }
        break;
      case 'moving':
        if (Math.hypot(center.x - this.swayCenter.x, center.y - this.swayCenter.y) > walkStep(settled.h)) {
          this.swayCenter = center;
          this.swaySince = now;
        }
        if (Math.hypot(center.x - this.stillCenter.x, center.y - this.stillCenter.y) > DEAD_ZONE) {
          this.stillCenter = center;
          this.stillSince = now;
        }
        if (now - this.stillSince >= SETTLE || now - this.swaySince >= SWAY_SETTLE) {
          this.motion = 'settled';
          if (shift(b, settled) >= FOLLOW_STEP) this.setSettled(b);
          this.walkFrom = b;
        }
        break;
    }
  }
}
