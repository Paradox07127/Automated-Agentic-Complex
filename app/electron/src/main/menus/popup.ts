// Where the character menu pops up (at the click, on any screen): Menu.popup's window and its x, y. Menu.popup places the menu relative to that window's content
// and keeps it on that window's screen, so the window is one on the click's display, a shown one before a hidden one.
import type { Rectangle } from 'electron';
import type { Point } from '../../common/placement.ts';

export interface PopupWindow<W> {
  window: W;
  visible: boolean;
  /** getContentBounds, in DIP. */
  content: Rectangle;
}

export interface CharacterMenuPorts<W> {
  /** A point in C3 global points as an Electron DIP point. */
  toDip(at: Point): Point;
  /** The bounds, in DIP, of the display nearest `p`. */
  display(p: Point): Rectangle;
  /** The app's windows that are not destroyed. */
  windows(): PopupWindow<W>[];
}

/** Menu.popup's options for a right click at `at`, in C3 global points; null without a window, where Menu.popup throws. */
export function characterMenuPopup<W>(at: Point, ports: CharacterMenuPorts<W>): { window: W; x: number; y: number } | null {
  const p = ports.toDip(at), d = ports.display(p);
  const meets = (r: Rectangle) => r.x < d.x + d.width && d.x < r.x + r.width && r.y < d.y + d.height && d.y < r.y + r.height;
  const rank = (w: PopupWindow<W>) => (meets(w.content) ? 2 : 0) + (w.visible ? 1 : 0);
  const best = ports.windows().reduce<PopupWindow<W> | null>((a, w) => (a === null || rank(w) > rank(a) ? w : a), null);
  return best && { window: best.window, x: Math.round(p.x - best.content.x), y: Math.round(p.y - best.content.y) };
}
