// Whether the pointer rests on her, for `desktop.onState`'s `avatarHovered` (the ring opens on it): the capsule hit, the
// conditions, and the dwell and grace for the web panels.

export interface Point { x: number; y: number }
export interface Capsule { a: Point; b: Point; r: number }

/** True when `p` lies within `r` of a capsule's segment. */
export function capsuleHit(p: Point, capsules: readonly Capsule[]): boolean {
  return capsules.some((c) => {
    const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - c.a.x) * dx + (p.y - c.a.y) * dy) / len2));
    const ex = c.a.x + t * dx - p.x, ey = c.a.y + t * dy - p.y;
    return ex * ex + ey * ey <= c.r * c.r;
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

/** Seconds inside before it counts, and seconds outside it still counts, so the pointer can reach the hint. */
export const HOVER_DWELL = 0.12;
export const HOVER_GRACE = 0.35;

export class DesktopHover {
  private entered: number | null = null;
  private lastInside = -Infinity;

  update(inside: boolean, now: number): boolean {
    if (inside) {
      this.entered ??= now;
      this.lastInside = now;
    } else if (now - this.lastInside > HOVER_GRACE) {
      this.entered = null;
    }
    return this.entered !== null && now - this.entered >= HOVER_DWELL;
  }

  reset(): void {
    this.entered = null;
    this.lastInside = -Infinity;
  }
}

/** With the web panels up. `present`: she is linked, shows, has a body and does not click through;
 *  `hovered`: `avatarHovered`; `hints`: config.json `desktop_hover_hints` is not false. */
export class AvatarHover {
  private readonly hover = new DesktopHover();
  private _hovered = false;
  onChange: (hovered: boolean) => void = () => {};

  get hovered(): boolean { return this._hovered; }

  tick(s: { present: boolean; hovered: boolean; hints: boolean }, now: number): void {
    if (!s.present) {
      this.hover.reset();
      this.set(false);
      return;
    }
    this.set(this.hover.update(s.hints && s.hovered, now));
  }

  private set(value: boolean): void {
    if (value === this._hovered) return;
    this._hovered = value;
    this.onChange(value);
  }
}
