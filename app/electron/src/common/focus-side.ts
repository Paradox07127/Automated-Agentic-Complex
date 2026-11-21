// C3 rule 39 `attention_side` with source `focus`: a focused window far from her
// that keeps the focus, and agentd's typing behavior, turn her toward the window's side.
import type { Rect } from './attention.ts';

export type Side = 'left' | 'right';

/** FocusSide.distance, .dwell, .typingInterval: points between the window's centre and hers, then seconds. */
export const FOCUS_SIDE = { distance: 300, dwell: 3, typingInterval: 180 } as const;

const midX = (r: Rect) => r.x + r.width / 2;
const midY = (r: Rect) => r.y + r.height / 2;

/** FocusSide: the side of her body the focused window's centre is on. Frames are in one space, e.g. C3 global points. */
export class FocusSide {
  private window: number | null = null;
  private focusSide: Side | null = null;
  private since = 0;
  private turned = false;
  private frame: Rect | null = null;
  private body: Rect | null = null;
  private typedAt = -Infinity;

  /** One sample of the front window and her body; `now` in seconds. A moved window can earn another reaction after it
   *  settles. `deliver` false keeps the side for a later sample. */
  sample(window: number | null, frame: Rect | null, body: Rect | null, now: number, deliver: (side: Side) => boolean = () => true): Side | null {
    this.frame = frame;
    this.body = body;
    const previousWindow = this.window;
    this.window = window;
    const farSide = frame && body && Math.hypot(midX(frame) - midX(body), midY(frame) - midY(body)) > FOCUS_SIDE.distance ? this.side() : null;
    if (window !== previousWindow || farSide !== this.focusSide) {
      this.focusSide = farSide;
      this.since = now;
      this.turned = false;
    }
    if (this.turned || farSide === null || now - this.since < FOCUS_SIDE.dwell || !deliver(farSide)) return null;
    this.turned = true;
    return farSide;
  }

  /** agentd's typing behavior arrived: the focused window's side, at most once per `typingInterval` seconds. */
  typing(now: number, deliver: (side: Side) => boolean = () => true): Side | null {
    if (now - this.typedAt < FOCUS_SIDE.typingInterval) return null;
    const side = this.side();
    if (side === null || !deliver(side)) return null;
    this.typedAt = now;
    return side;
  }

  private side(): Side | null {
    if (this.window === null || !this.frame || !this.body) return null;
    return midX(this.frame) < midX(this.body) ? 'left' : 'right';
  }
}
