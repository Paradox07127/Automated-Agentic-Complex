// The menu bar icon of each state: the app's mark (app/packaging/ui-art-src/brand/emblem.svg without its hatch, corners and
// wordmark) 18 pt high with the state's mark after it, drawn black on transparent at 2x for `nativeImage.createFromBitmap`.
import type { MenuBarIconState } from '../../common/menus.ts';

type Point = [number, number];
/** Coverage test of one point, in pt from the top left. */
type Shape = (x: number, y: number) => boolean;

export interface IconBitmap {
  /** Pixels; the image is half as many points. */
  width: number;
  height: number;
  /** BGRA, premultiplied: black with the coverage as alpha. */
  pixels: Uint8Array;
}

const H = 18;
const SCALE = 2;
/** Samples per pixel side. */
const SUB = 4;

/** emblem.svg's units to pt: its chevron, 362 units tall from y 18, fills 1.5–15.5 pt, centred on x 9. */
const pt = ([x, y]: Point): Point => [9 + (x - 256) * 14 / 362, 1.5 + (y - 18) * 14 / 362];
/** The orbit's -9° tilt about (256, 300), in emblem units. */
function tilt([x, y]: Point): Point {
  const a = -9 * Math.PI / 180, dx = x - 256, dy = y - 300;
  return [256 + dx * Math.cos(a) - dy * Math.sin(a), 300 + dx * Math.sin(a) + dy * Math.cos(a)];
}
function cubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  return Array.from({ length: 25 }, (_, i): Point => {
    const t = i / 24, u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  }).map((p) => pt(tilt(p)));
}
const CHEVRON: Point[] = ([[256, 18], [440, 380], [362, 380], [256, 168], [150, 380], [72, 380]] as Point[]).map(pt);
/** 4 units larger than emblem.svg's, so that it keeps its corners at 36 px. */
const DIAMOND: Point[] = ([[256, 246], [292, 282], [256, 318], [220, 282]] as Point[]).map(pt);
/** The orbit's front arc, which ends the legs with a gap above it, and its two back arcs. */
const ORBIT_FRONT = cubic([34, 300], [110, 372], [402, 372], [478, 300]);
const ORBIT = [ORBIT_FRONT, cubic([34, 300], [62, 270], [112, 250], [164, 243]), cubic([348, 243], [400, 250], [450, 270], [478, 300])];
/** The marks on their 10-unit grid. */
const MARKS: Partial<Record<MenuBarIconState, Point[][]>> = {
  error: [[[5, 1.5], [5, 5.8]], [[5, 8.3], [5, 8.3]]],
  switching: [[[1.5, 3.2], [8.5, 3.2]], [[6.3, 1], [8.5, 3.2], [6.3, 5.4]], [[8.5, 6.8], [1.5, 6.8]], [[3.7, 4.6], [1.5, 6.8], [3.7, 9]]],
  restarting: [[[1.5, 3.2], [8.5, 3.2]], [[6.3, 1], [8.5, 3.2], [6.3, 5.4]], [[8.5, 6.8], [1.5, 6.8]], [[3.7, 4.6], [1.5, 6.8], [3.7, 9]]],
  observationPaused: [[[3.5, 1.5], [3.5, 8.5]], [[6.5, 1.5], [6.5, 8.5]]],
  meetingMode: [[[1.5, 2.5], [8.5, 2.5], [8.5, 7.5], [1.5, 7.5], [1.5, 2.5]]],
  quiet: [[[1.5, 2.5], [8.5, 2.5], [8.5, 7.5], [1.5, 7.5], [1.5, 2.5]]],
  clickThroughAll: [[[5, 1.5], [5, 8.5]], [[2, 5.5], [5, 8.5], [8, 5.5]]],
};
/** The state mark's rect: 8 pt square, 2 pt after the app's mark, centred. */
const MARK = { x: H + 2, y: (H - 8) / 2, size: 8 };

/** Stroke glyphs for the badge count in a 4 × 7 box, standing in for the mono font. */
const GLYPHS: Record<string, Point[][]> = {
  '0': [[[1, 0], [3, 0], [4, 1], [4, 6], [3, 7], [1, 7], [0, 6], [0, 1], [1, 0]]],
  '1': [[[1, 1], [2, 0], [2, 7]], [[0.8, 7], [3.2, 7]]],
  '2': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2.5], [0, 7], [4, 7]]],
  '3': [[[0, 0], [4, 0], [2, 3], [3, 3], [4, 4], [4, 6], [3, 7], [1, 7], [0, 6]]],
  '4': [[[3, 7], [3, 0], [0, 5], [4, 5]]],
  '5': [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 6], [3, 7], [0, 7]]],
  '6': [[[3, 0], [1, 0], [0, 1], [0, 6], [1, 7], [3, 7], [4, 6], [4, 4], [3, 3], [0, 3]]],
  '7': [[[0, 0], [4, 0], [1.5, 7]]],
  '8': [[[1, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.4], [1, 3.4], [0, 2.5], [0, 1], [1, 0]],
    [[1, 3.4], [0, 4.4], [0, 6], [1, 7], [3, 7], [4, 6], [4, 4.4], [3, 3.4]]],
  '9': [[[4, 3.6], [1, 3.6], [0, 2.6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6], [3, 7], [1, 7]]],
  '+': [[[0, 3.5], [4, 3.5]], [[2, 1.5], [2, 5.5]]],
};
/** A mono digit's advance at 10 pt. */
const ADVANCE = 6;

function distance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Round caps and joins: every point within half the width of a segment. */
function stroke(lines: Point[][], width: number): Shape {
  const segments: [Point, Point][] = lines.flatMap((l) => l.slice(1).map((p, i): [Point, Point] => [l[i]!, p]));
  return (x, y) => segments.some(([a, b]) => distance([x, y], a, b) <= width / 2);
}

/** `line` cut into dashes `on` long, `off` apart, from its start. */
function dashed(line: Point[], on: number, off: number): Point[][] {
  const at = [0];
  for (let i = 1; i < line.length; i++) at.push(at[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]));
  const total = at.at(-1)!;
  const point = (d: number): Point => {
    let i = 1;
    while (i < line.length - 1 && at[i]! < d) i++;
    const a = line[i - 1]!, b = line[i]!, t = (d - at[i - 1]!) / (at[i]! - at[i - 1]!);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const out: Point[][] = [];
  for (let start = 0; start < total; start += on + off) {
    const end = Math.min(start + on, total);
    out.push([point(start), ...line.filter((_, i) => at[i]! > start && at[i]! < end), point(end)]);
  }
  return out;
}

const place = (lines: Point[][], x: number, y: number, scale: number): Point[][] =>
  lines.map((l) => l.map(([px, py]): Point => [x + px * scale, y + py * scale]));

/** Even-odd fill. */
function polygon(points: Point[]): Shape {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!, [xj, yj] = points[j]!;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

/** Below a polyline running left to right, within its x span. */
function below(line: Point[]): Shape {
  return (x, y) => {
    const i = line.findIndex((p) => p[0] >= x);
    if (i <= 0) return false;
    const [ax, ay] = line[i - 1]!, [bx, by] = line[i]!;
    return y > ay + (by - ay) * (x - ax) / (bx - ax);
  };
}

/** A rect with half-height round ends. */
function capsule(x: number, y: number, w: number, h: number): Shape {
  const r = h / 2, a: Point = [x + r, y + r], b: Point = [x + w - r, y + r];
  return (px, py) => distance([px, py], a, b) <= r;
}

export function iconBitmap(state: MenuBarIconState, badge = 0): IconBitmap {
  const text = badge > 9 ? '9+' : String(Math.max(badge, 0));
  const badgeWidth = Math.max(12, text.length * ADVANCE + 5);
  const badgeRect = { x: H + 9 - badgeWidth, y: 0, w: badgeWidth, h: 12 };
  const mark = MARKS[state];
  const widthPt = state === 'pendingApproval' ? badgeRect.x + badgeRect.w
    : mark || state === 'recording' ? MARK.x + MARK.size : H;
  // Hidden: the chevron's dashed outline alone.
  const ops: { clear: boolean; shape: Shape }[] = state === 'hidden' ? [{ clear: false, shape: stroke(dashed([...CHEVRON, CHEVRON[0]!], 2, 1.5), 1.2) }]
    : [{ clear: false, shape: polygon(CHEVRON) }, { clear: true, shape: below(ORBIT_FRONT) }, { clear: true, shape: stroke([ORBIT_FRONT], 2.6) },
      { clear: false, shape: polygon(DIAMOND) }, { clear: false, shape: stroke(ORBIT, 1) }];
  if (state === 'recording') {
    const cx = MARK.x + 5 * 0.8, cy = MARK.y + 5 * 0.8, r = 3 * 0.8;
    ops.push({ clear: false, shape: (x, y) => Math.hypot(x - cx, y - cy) <= r });
  } else if (mark) {
    ops.push({ clear: false, shape: stroke(place(mark, MARK.x, MARK.y, MARK.size / 10), 1.5) });
  }
  if (state === 'pendingApproval') {
    const { x, y, w, h } = badgeRect, left = x + w / 2 - text.length * ADVANCE / 2;
    ops.push({ clear: true, shape: capsule(x - 1.5, y - 1.5, w + 3, h + 3) }, { clear: false, shape: capsule(x, y, w, h) },
      { clear: true, shape: stroke([...text].flatMap((c, i) => place(GLYPHS[c]!, left + i * ADVANCE + 1, y + h / 2 - 3.5, 1)), 1.2) });
  }
  const width = widthPt * SCALE, height = H * SCALE, pixels = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let alpha = 0;
      for (const op of ops) {
        let hits = 0;
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            if (op.shape((px + (sx + 0.5) / SUB) / SCALE, (py + (sy + 0.5) / SUB) / SCALE)) hits++;
          }
        }
        const c = hits / (SUB * SUB);
        alpha = op.clear ? alpha * (1 - c) : alpha + c * (1 - alpha);
      }
      pixels[(py * width + px) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, pixels };
}

/** `b` for the Windows notification area, which fits each icon into a square and has no template images: centred on a
 *  square, white when `white` (a dark taskbar). */
export function squareIcon(b: IconBitmap, white: boolean): IconBitmap {
  const side = Math.max(b.width, b.height), dx = Math.floor((side - b.width) / 2), dy = Math.floor((side - b.height) / 2);
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const alpha = b.pixels[(y * b.width + x) * 4 + 3]!, at = ((y + dy) * side + x + dx) * 4;
      pixels.fill(white ? alpha : 0, at, at + 3);
      pixels[at + 3] = alpha;
    }
  }
  return { width: side, height: side, pixels };
}
