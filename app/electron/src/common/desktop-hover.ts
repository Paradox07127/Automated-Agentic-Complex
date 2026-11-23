// The pointer on her, for `desktop.onState`'s `dock` (her hover buttons): the capsule hit, its conditions, and the dead zone
// that opens the buttons after a rest and keeps them while the pointer heads for them. Rects are in the placement space.
import type { Rect } from './placement.ts';

export interface Point { x: number; y: number }
export interface Capsule { a: Point; b: Point; r: number }

/** True when `p` lies within `r` + `grow` of a capsule's segment. */
export function capsuleHit(p: Point, capsules: readonly Capsule[], grow = 0): boolean {
  return capsules.some((c) => {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - c.a.x) * dx + (p.y - c.a.y) * dy) / len2));
    const ex = c.a.x + t * dx - p.x, ey = c.a.y + t * dy - p.y, r = c.r + grow;
    return ex * ex + ey * ey <= r * r;
  });
}

/** Capsules older than this (seconds) hit nothing. */
export const CAPSULE_FRESH = 0.5;

/** HostLink.avatarHovered: the pointer hits her fresh capsules while she shows, is not dragged, does not click through and
 *  her character is not switching; with a mouse button down only when the last C3 `cursor` sent was a hit. `age` is null
 *  before any capsules; a field left out counts as false. */
export function avatarHovered(s: { hit: boolean; age: number | null; hidden: boolean; dragging: boolean; clickThroughAll: boolean;
  switching?: boolean; buttonsDown?: boolean; lastCursorHit?: boolean }): boolean {
  return s.hit && s.age !== null && s.age <= CAPSULE_FRESH && !s.hidden && !s.dragging && !s.clickThroughAll && !s.switching
    && (!s.buttonsDown || s.lastCursorHit === true);
}

/** Seconds of rest near her before the buttons open (crossing her at a normal pace takes less), and seconds off before they go. */
export const HOVER_DWELL = 0.30;
export const HOVER_GRACE = 0.60;
/** Her capsules grown this far start the rest, and this far keep the buttons: the 12 px between is the hysteresis. */
export const ENTER_GROW = 12;
export const KEEP_GROW = 24;
/** The buttons' card counts this far round, where each row's hit area reaches. */
export const DOCK_PAD = 3;
/** The safe triangle's far corners reach this far past the card's near edge. */
export const AIM_BUFFER = 4;
/** A pointer still this long in the safe triangle no longer heads for the buttons (menu-aim's delay). */
export const AIM_REST = 0.30;
/** The corridor starts this far inside her box. */
const CORRIDOR_OVERLAP = 8;

/** `idle`: closed; `arming`: resting near her; `open`; `leaving`: open through the grace. */
export type DockPhase = 'idle' | 'arming' | 'open' | 'leaving';

export interface DockState {
  phase: DockPhase;
  /** When `arming` or `leaving` began. */
  since: number;
  /** The last point in her keep zone while open: the safe triangle's apex. */
  exit: Point | null;
  /** The last point seen and when it last changed. */
  last: Point | null;
  movedAt: number;
  /** The pointer rested in the triangle: it holds nothing until the pointer is back in her keep zone. */
  aimEnded: boolean;
}

export const DOCK_IDLE: DockState = { phase: 'idle', since: 0, exit: null, last: null, movedAt: 0, aimEnded: false };

export interface DockSample {
  p: Point;
  /** The pointer within `ENTER_GROW`, and within `KEEP_GROW`, of her fresh capsules, under `avatarHovered`'s conditions. */
  enter: boolean;
  keep: boolean;
  /** Her capsules' box. */
  body: Rect | null;
  /** The buttons' card while it is placed; null before. */
  dock: Rect | null;
  /** Nothing opens and an open one closes at once: she hides, is dragged, clicks through, the wheel is open, hints are off. */
  blocked: boolean;
  /** 说话 is recording: the buttons stay. */
  held: boolean;
}

export const dockOpen = (s: DockState): boolean => s.phase === 'open' || s.phase === 'leaving';

const maxX = (r: Rect) => r.x + r.w;
const maxY = (r: Rect) => r.y + r.h;
const within = (p: Point, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= maxX(r) + pad && p.y >= r.y - pad && p.y <= maxY(r) + pad;

/** Which side of her box the card is on. */
function sideOf(body: Rect, dock: Rect): 'left' | 'right' | 'above' {
  if (dock.x >= maxX(body) - CORRIDOR_OVERLAP) return 'right';
  if (maxX(dock) <= body.x + CORRIDOR_OVERLAP) return 'left';
  return 'above';
}

/** The rect from just inside her box to the card's near edge, as wide (or high) as the card. */
export function dockCorridor(body: Rect, dock: Rect): Rect {
  const o = CORRIDOR_OVERLAP;
  switch (sideOf(body, dock)) {
    case 'right': return { x: maxX(body) - o, y: dock.y, w: dock.x - maxX(body) + o, h: dock.h };
    case 'left': return { x: maxX(dock), y: dock.y, w: body.x + o - maxX(dock), h: dock.h };
    default: return { x: dock.x, y: maxY(body) - o, w: dock.w, h: dock.y - maxY(body) + o };
  }
}

/** The exit point and the card's near edge, `AIM_BUFFER` longer at each end. */
export function aimTriangle(exit: Point, body: Rect, dock: Rect): [Point, Point, Point] {
  const b = AIM_BUFFER;
  switch (sideOf(body, dock)) {
    case 'right': return [exit, { x: dock.x, y: dock.y - b }, { x: dock.x, y: maxY(dock) + b }];
    case 'left': return [exit, { x: maxX(dock), y: dock.y - b }, { x: maxX(dock), y: maxY(dock) + b }];
    default: return [exit, { x: dock.x - b, y: dock.y }, { x: maxX(dock) + b, y: dock.y }];
  }
}

export function inTriangle(p: Point, [a, b, c]: [Point, Point, Point]): boolean {
  const s = (p1: Point, p2: Point, p3: Point) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * One tick of the dead zone: idle → (within `ENTER_GROW`) arming → (`HOVER_DWELL` still within `KEEP_GROW`) open →
 * (off her keep zone, the corridor, the safe triangle and the card) leaving → (`HOVER_GRACE`) idle; arming off the keep zone
 * goes back to idle, leaving back on it to open.
 */
export function dockStep(s: DockState, x: DockSample, now: number): DockState {
  const moved = !s.last || s.last.x !== x.p.x || s.last.y !== x.p.y;
  const base = { ...s, last: x.p, movedAt: moved ? now : s.movedAt };
  if (x.blocked) return { ...DOCK_IDLE, last: x.p, movedAt: base.movedAt };
  switch (s.phase) {
    case 'idle':
      return x.enter ? { ...base, phase: 'arming', since: now } : base;
    case 'arming':
      if (!x.keep) return { ...base, phase: 'idle' };
      return now - s.since >= HOVER_DWELL ? { ...base, phase: 'open', exit: x.p, aimEnded: false } : base;
    default: {
      if (x.keep) return { ...base, phase: 'open', exit: x.p, aimEnded: false };
      const { body, dock } = x;
      const near = !!dock && (within(x.p, dock, DOCK_PAD) || (!!body && within(x.p, dockCorridor(body, dock))));
      const inAim = !s.aimEnded && !!dock && !!body && !!s.exit && inTriangle(x.p, aimTriangle(s.exit, body, dock));
      const aimEnded = s.aimEnded || (inAim && !near && now - base.movedAt >= AIM_REST);
      const inside = x.held || near || (inAim && !aimEnded);
      if (inside) return { ...base, phase: 'open', aimEnded };
      if (s.phase === 'open') return { ...base, phase: 'leaving', since: now, aimEnded };
      return now - s.since >= HOVER_GRACE ? { ...DOCK_IDLE, last: x.p, movedAt: base.movedAt } : { ...base, aimEnded };
    }
  }
}
