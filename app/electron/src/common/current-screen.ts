// `desktop.onState`'s `screens[].current`.
import type { Rect, ScreenInfo } from './placement.ts';

/** Her screen's id: in the fullscreen viewport her placement's display, else the screen under the middle of her window's
 *  bottom edge (placement space, y up); null when unknown. */
export function currentScreen(viewport: string | null, placementDisplay: number | null, frame: Rect | null,
  screens: readonly ScreenInfo[]): string | null {
  if (viewport === 'fullscreen') return placementDisplay === null ? null : String(placementDisplay);
  if (frame === null) return null;
  const x = frame.x + frame.w / 2, y = frame.y;
  const s = screens.find((d) => x >= d.frame.x && x < d.frame.x + d.frame.w && y >= d.frame.y && y < d.frame.y + d.frame.h);
  return s ? String(s.id) : null;
}
