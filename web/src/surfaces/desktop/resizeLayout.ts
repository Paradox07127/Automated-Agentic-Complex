// The resize overlay's layout in page points, y down from the top-left of her screen's visible frame.
import type { Region } from '../../bridge';
import type { ResizeCorner } from '../../bridge/resize';

type Size = { width: number; height: number };

export const CORNERS: readonly ResizeCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

const SCALE_MIN = 0.5;
const SCALE_MAX = 2;
/** Chip bottom to frame top. */
const CHIP_GAP = 12;
/** The corner brackets stand this far off the frame. */
export const BRACKET_OUTSET = 8;
const BAR_SIDE_INSET = 12;
const BAR_EDGE_INSET = 14;
/** Bottom-right (board), bottom-left, top-right, top-left. */
const BAR_CANDIDATES: readonly ResizeCorner[] = ['bottomRight', 'bottomLeft', 'topRight', 'topLeft'];

export const isRight = (c: ResizeCorner) => c === 'topRight' || c === 'bottomRight';
export const isTop = (c: ResizeCorner) => c === 'topLeft' || c === 'topRight';

/** The corner's point of `r`. */
export const cornerPoint = (c: ResizeCorner, r: Region) => ({ x: isRight(c) ? r.x + r.width : r.x, y: isTop(c) ? r.y : r.y + r.height });

export const percentText = (scale: number) => `${Math.round(scale * 100)} %`;

/** `scale` along the ruler, 0–1. */
export const rulerPosition = (scale: number) => (Math.min(Math.max(scale, SCALE_MIN), SCALE_MAX) - SCALE_MIN) / (SCALE_MAX - SCALE_MIN);

function overlap(a: Region, b: Region): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function barRect(corner: ResizeCorner, page: Size, bar: Size): Region {
  return {
    x: isRight(corner) ? page.width - BAR_SIDE_INSET - bar.width : BAR_SIDE_INSET,
    y: isTop(corner) ? BAR_EDGE_INSET : page.height - BAR_EDGE_INSET - bar.height,
    ...bar,
  };
}

/** The chip is centred 12 pt above the frame, below it when that leaves the page, kept in the page. The bar takes the first corner
 *  of the page, inset 12 pt from the side and 14 pt from the edge, that overlaps neither her bracketed frame nor the chip; the
 *  corner overlapping her least when every one does. */
export function resizeLayout(frame: Region, page: Size, chipSize: Size, barSize: Size): { chip: Region; bar: Region; barCorner: ResizeCorner } {
  let top = frame.y - CHIP_GAP - chipSize.height;
  if (top < 0) top = frame.y + frame.height + CHIP_GAP;
  const chip = {
    x: Math.min(Math.max(frame.x + frame.width / 2 - chipSize.width / 2, 0), page.width - chipSize.width),
    y: Math.max(Math.min(top, page.height - chipSize.height), 0),
    ...chipSize,
  };
  const zone = { x: frame.x - BRACKET_OUTSET, y: frame.y - BRACKET_OUTSET, width: frame.width + 2 * BRACKET_OUTSET,
    height: frame.height + 2 * BRACKET_OUTSET };
  const candidates = BAR_CANDIDATES.map((c) => ({ corner: c, rect: barRect(c, page, barSize) }));
  const pick = candidates.find((c) => overlap(c.rect, zone) === 0 && overlap(c.rect, chip) === 0)
    ?? candidates.reduce((best, c) => (overlap(c.rect, zone) < overlap(best.rect, zone) ? c : best));
  return { chip, bar: pick.rect, barCorner: pick.corner };
}
