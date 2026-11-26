// 调整大小's resize mode (board 07 P–R): one uniform scale in 0.5–2, dragged from any corner with the opposite corner
// fixed; and where it starts. Rects are in the placement space (y up).
import type { Point, Rect, ScreenInfo } from './placement.ts';

export const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
export type AvatarCorner = (typeof CORNERS)[number];
export type ResizePhase = 'editing' | 'committed' | 'cancelled';

/** Metrics.avatarScale. */
const SCALE_MIN = 0.5, SCALE_MAX = 2;
const DEFAULT_SCALE = 1;

const isRight = (c: AvatarCorner) => c === 'topRight' || c === 'bottomRight';
const isTop = (c: AvatarCorner) => c === 'topLeft' || c === 'topRight';
const OPPOSITE: Record<AvatarCorner, AvatarCorner> = { topLeft: 'bottomRight', topRight: 'bottomLeft', bottomLeft: 'topRight',
  bottomRight: 'topLeft' };
const clampScale = (s: number) => Math.min(Math.max(s, SCALE_MIN), SCALE_MAX);

/** The corner's point of `r`. */
export const cornerPoint = (c: AvatarCorner, r: Rect): Point => ({ x: isRight(c) ? r.x + r.w : r.x, y: isTop(c) ? r.y + r.h : r.y });

/** 最小 and 最大 of the range. */
export function limitOf(s: number): 'min' | 'max' | null {
  if (s <= SCALE_MIN + 1e-9) return 'min';
  if (s >= SCALE_MAX - 1e-9) return 'max';
  return null;
}

export interface ResizeCallbacks {
  /** Live scale and frame while editing; also the entry values on a cancel that undoes a change. */
  onScaleChange(scale: number, frame: Rect): void;
  /** Final scale and frame, once, on 完成. */
  onCommit(scale: number, frame: Rect): void;
  /** After 完成 or a cancel. */
  onFinish(): void;
}

export class ResizeMode {
  readonly initialScale: number;
  readonly initialFrame: Rect;
  readonly maximumScale: number;
  /** Her size at scale 1. */
  private readonly base: { w: number; h: number };
  scale: number;
  frame: Rect;
  dragging: AvatarCorner | null = null;
  phase: ResizePhase = 'editing';
  private dragStart: Rect;
  private readonly c: ResizeCallbacks;

  /** `frame` is her rect at `scale`. */
  constructor(frame: Rect, scale: number, maximumScale: number, callbacks: ResizeCallbacks) {
    const upper = Number.isFinite(maximumScale) ? Math.min(Math.max(maximumScale, SCALE_MIN), SCALE_MAX) : SCALE_MAX;
    const s = Math.min(clampScale(scale), upper);
    this.maximumScale = upper;
    this.initialScale = this.scale = s;
    this.initialFrame = this.frame = this.dragStart = frame;
    this.base = { w: frame.w / s, h: frame.h / s };
    this.c = callbacks;
  }

  get limit(): 'min' | 'max' | null {
    return this.scale >= this.maximumScale - 1e-9 ? 'max' : limitOf(this.scale);
  }

  /** `dx`, `dy`: the pointer's movement since the drag began, in points (y up). */
  drag(corner: AvatarCorner, dx: number, dy: number): void {
    if (this.phase !== 'editing') return;
    if (this.dragging !== corner) {
      this.dragging = corner;
      this.dragStart = this.frame;
    }
    const anchorCorner = OPPOSITE[corner], anchor = cornerPoint(anchorCorner, this.dragStart), start = cornerPoint(corner, this.dragStart);
    const p = { x: start.x + dx, y: start.y + dy };
    // Project the pointer onto the frame's diagonal through the anchor.
    const ux = (isRight(corner) ? 1 : -1) * this.base.w, uy = (isTop(corner) ? 1 : -1) * this.base.h;
    const s = ((p.x - anchor.x) * ux + (p.y - anchor.y) * uy) / (ux * ux + uy * uy);
    this.apply(Math.min(clampScale(s), this.maximumScale), (w, h) => ({ x: isRight(anchorCorner) ? anchor.x - w : anchor.x,
      y: isTop(anchorCorner) ? anchor.y - h : anchor.y }));
  }

  endDrag(): void { this.dragging = null; }

  /** 恢复默认: back to 100 %, anchored at the foot's midpoint; stays in resize mode. */
  restoreDefault(): void {
    if (this.phase !== 'editing') return;
    this.dragging = null;
    const foot = { x: this.frame.x + this.frame.w / 2, y: this.frame.y };
    this.apply(Math.min(DEFAULT_SCALE, this.maximumScale), (w) => ({ x: foot.x - w / 2, y: foot.y }));
  }

  /** 完成 or Return. */
  done(): void {
    if (this.phase !== 'editing') return;
    this.dragging = null;
    this.phase = 'committed';
    this.c.onCommit(this.scale, this.frame);
    this.c.onFinish();
  }

  /** Esc or a press outside: back to the entry scale, no commit. */
  cancel(): void {
    if (this.phase !== 'editing') return;
    this.dragging = null;
    const changed = this.scale !== this.initialScale || !sameRect(this.frame, this.initialFrame);
    this.scale = this.initialScale;
    this.frame = this.initialFrame;
    this.phase = 'cancelled';
    if (changed) this.c.onScaleChange(this.scale, this.frame);
    this.c.onFinish();
  }

  private apply(scale: number, origin: (w: number, h: number) => Point): void {
    const w = this.base.w * scale, h = this.base.h * scale, o = origin(w, h), frame = { x: o.x, y: o.y, w, h };
    if (scale === this.scale && sameRect(frame, this.frame)) return;
    this.scale = scale;
    this.frame = frame;
    this.c.onScaleChange(this.scale, this.frame);
  }
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export interface ResizeStart {
  frame: Rect;
  scale: number;
  maximumScale: number;
  /** The visible frame of the screen under her foot, which the overlay covers. */
  visible: Rect;
}

/** Her rect at her scale, the largest scale and her screen; null without a frame or a
 *  screen. `placement` is her last reported one, `windowFrame` the last `window_frame`'s. */
export function resizeStart(fullscreen: boolean, placement: { x: number; y: number; scale: number } | null, windowFrame: Rect | null,
  screens: ScreenInfo[]): ResizeStart | null {
  // The fullscreen anchor is the bottom centre; scale 1 is 540×780 pt.
  const frame = fullscreen && placement
    ? { x: placement.x - 270 * placement.scale, y: placement.y, w: 540 * placement.scale, h: 780 * placement.scale }
    : windowFrame;
  if (!frame) return null;
  const foot = { x: frame.x + frame.w / 2, y: frame.y };
  const screen = screens.find((s) => foot.x >= s.frame.x && foot.x < s.frame.x + s.frame.w && foot.y >= s.frame.y
    && foot.y < s.frame.y + s.frame.h) ?? screens[0];
  if (!screen) return null;
  const v = screen.visibleFrame;
  // The window viewport fits the entire 540×780 pt surface inside its screen; the preview promises no more.
  return { frame, scale: placement?.scale ?? 1, maximumScale: fullscreen ? 2 : Math.min(2, v.w / 540, v.h / 780), visible: v };
}
