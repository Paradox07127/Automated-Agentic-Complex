// Icon ring panel geometry: one row of icons along the panel's bottom; native puts the row's top 8 pt under her feet with
// the same row height, the panel centred on her feet.

/** The fixed panel; a card or tip opens above the row inside it. */
export const RING_PANEL = { width: 360, height: 320 };
/** Native's `DesktopLayout.ringRow`. */
export const ROW_HEIGHT = 36;
export const ICON_SIZE = 30;
/** From one icon's centre to the next. */
const ICON_STEP = 40;
/** Space kept between a card or tip and the panel's edges. */
const EDGE = 8;
const ROW_TOP = RING_PANEL.height - ROW_HEIGHT;

export interface IconPoint {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Centres of `n` icons left to right, the row centred on `feet`, her feet's page x, as far as the panel allows. */
export function iconCenters(n: number, feet: number): IconPoint[] {
  const half = (n * ICON_STEP) / 2;
  const mid = clamp(feet, half, RING_PANEL.width - half);
  return Array.from({ length: n }, (_, i) => ({ x: mid - half + ICON_STEP * (i + 0.5), y: ROW_TOP + ROW_HEIGHT / 2 }));
}

/** A card's width. */
export const CARD_WIDTH = 260;

/** Room for a card or tip `gap` px above the row, so it never covers an icon. */
export function cardRoom(gap: number): { width: number; maxHeight: number } {
  return { width: CARD_WIDTH, maxHeight: ROW_TOP - gap - EDGE };
}

/** Where a `w`×`h` card or tip goes: centred over icon `p`, `gap` px above the row. Kept inside the panel. */
export function above(p: IconPoint, w: number, h: number, gap: number): { left: number; top: number } {
  return { left: clamp(p.x - w / 2, EDGE, RING_PANEL.width - EDGE - w), top: Math.max(EDGE, ROW_TOP - gap - h) };
}
