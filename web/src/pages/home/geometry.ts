import { KEY1, KEY2, KEY3, KEY4, SLOT_L, SLOT_R } from './outlines';
import type { Pt } from '../../ui/game/Slab';

// Design coordinates of the watch face: the game's 1920×1080 watch canvas at half size, scaled to the page by useFit.
// Offsets are CSS px from the ring centre, y down.

export const STAGE = { w: 960, h: 540 } as const;
/** Centre of every ring and of the map disc. */
export const C = { x: 480, y: 270 } as const;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A `w`×`h` box centred `x`, `y` from the ring centre, in stage coordinates. */
export function box(x: number, y: number, w: number, h: number): Box {
  return { left: r1(C.x + x - w / 2), top: r1(C.y + y - h / 2), width: r1(w), height: r1(h) };
}

/** A `w`×`h` box centred `x`, `y` from a node's pivot (a zero-size point). */
export function around(x: number, y: number, w: number, h: number): Box {
  return { left: r1(x - w / 2), top: r1(y - h / 2), width: r1(w), height: r1(h) };
}

export type Outline = Array<readonly [number, number]>;

export interface KeyShape {
  box: Box;
  /** Outline in the key's own px. */
  pts: Outline;
  /** Where its content centres, in its own px. */
  mid: readonly [number, number];
}

/** A shape given in ring-centre coordinates, placed in its bounding box. */
function place(outline: Outline, mid: readonly [number, number]): KeyShape {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const b = box((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0);
  const local = ([x, y]: readonly [number, number]) => [r1(C.x + x - b.left), r1(C.y + y - b.top)] as const;
  return { box: b, pts: outline.map(local), mid: local(mid) };
}

/** A sprite's outline (in its unit frame) drawn `w`×`h` centred `x`, `y` from the ring centre; its content centres at
 *  `mid` in the same unit frame. */
function sprite(outline: readonly Pt[], x: number, y: number, w: number, h: number, mid: Pt = [0.5, 0.5]): KeyShape {
  const ring = ([u, v]: Pt) => [x - w / 2 + u * w, y - h / 2 + v * h] as const;
  return place(outline.map(ring), ring(mid));
}

/** LeftBtn1–4: rightbutton_bg01–04 at their game size and place (half size), raised 40 px to clear the player card. */
const LEFT_KEYS = [
  sprite(KEY1, -294.3, -149.2, 145.4, 81.5),
  sprite(KEY2, -322.7, -67.1, 117.4, 82.3),
  sprite(KEY3, -325.9, 16.6, 120, 84.1),
  sprite(KEY4, -305, 88.7, 131, 63.5),
];

/** The large keys on the left, top to bottom; at most four. */
export function leftTiles(n: number): KeyShape[] {
  return LEFT_KEYS.slice(0, n);
}

/** The right-hand list's rows, two keys a row: 68 px apart (the game's 152 × 0.4165, scaled with the keys), the first at
 *  y −108 with the list at its top. */
export const ROW = { y0: -108, pitch: 68 } as const;
/** Row centres' x along the column, one a row with the list at its top: Group1–9's x (×0.4165 from Group1 at 330), so
 *  the column bows out at the second row and draws in toward the bottom as in the game. */
const ARC_X = [330, 347.5, 338, 314, 287.5, 252.5, 229.6, 206.3, 183] as const;

/** x of a row centre at `y`: the game moves each row along a curve by where it stands in the window
 *  (UIScrollCellSlantEffect, whose code is not read); this takes the line between the rows' places at rest, carried on
 *  past either end. */
export function arcX(y: number): number {
  const t = (y - ROW.y0) / ROW.pitch;
  const i = Math.min(Math.max(Math.floor(t), 0), ARC_X.length - 2);
  return ARC_X[i]! + (ARC_X[i + 1]! - ARC_X[i]!) * (t - i);
}

/** The list's window in y, from under the banner to a strip of the sixth row. A key fades out over `fade` px inside
 *  either end: RectMask2D's softness 48 ramps the alpha over half of it, 24 game px, 12 here. */
export const LIST = { top: -152, bottom: 220, fade: 12 } as const;

/** A right-hand key: button_bg01 at 64 px (the game's 143 × 0.4165 = 59.6, enlarged so an 11px four-character name
 *  clears the rim), the two of a row touching as in Group1–9; the sprite's own clear margin is the gap. */
export const KEY = { w: 64, h: 64, gap: 0 } as const;

/** Key `i` of the list scrolled `s` px: its box, and its row centre's y. */
export function listKey(i: number, s: number): { box: Box; y: number } {
  const y = ROW.y0 + ROW.pitch * Math.floor(i / 2) - s;
  const dx = (KEY.w + KEY.gap) / 2;
  return { box: box(arcX(y) + (i % 2 === 0 ? -dx : dx), y, KEY.w, KEY.h), y };
}

/** How far a list of `n` keys scrolls: until its last row clears the bottom fade. */
export function listMax(n: number): number {
  const last = ROW.y0 + ROW.pitch * (Math.ceil(n / 2) - 1);
  return Math.max(0, last + KEY.h / 2 - (LIST.bottom - LIST.fade));
}

/** UpLineNode and BottonLineNode (387×30 at half size): fixed over and under the list, off the column's arc as in the game. */
export const LIST_LINES = [box(arcX(LIST.top + 5) + 47, LIST.top + 5, 194, 15), box(arcX(LIST.bottom + 10) + 7, LIST.bottom + 10, 194, 15)] as const;

/** TopLeftBtn1–3: settings, reminders, pending. */
export const TOP_ICONS = [box(-326, -222, 52, 48), box(-270, -222, 52, 48), box(-214, -222, 52, 48)] as const;

/** The component status row, top centre over the ring. */
export const STATUS: Box = box(0, -256, 316, 22);

/** Top_RightNode: the clock strip, top right, left of the close key; as wide as the time and the longest date. */
export const COUNTERS: Box = box(312, -240, 204, 30);

/** CloseButtonNode: closes the window, top right. */
export const CLOSE: Box = box(446, -240, 32, 32);

/** BannerNode: the news banner over the right-hand keys. */
export const BANNER: Box = box(318, -182, 236, 60);

/** The player card's place, bottom left under the large keys. */
export const CARD: Box = box(-272, 180, 224, 76);

/** TechtreeNode and ReportNode: watchfactory_bg and its mirror at 1.078 × half size, either side of straight down, 4 px
 *  below the game's place and still clear of the bottom triangle. The content sits in the tall yellow part by the inner
 *  edge, above the white strip. */
export const BAR_SLOTS = [sprite(SLOT_L, -77.4, 204, 148.8, 55, [0.68, 0.36]), sprite(SLOT_R, 75.2, 204, 148.8, 55, [0.32, 0.36])] as const;
/** HudBgShdow's glow under both slots. */
export const BAR: Box = box(0, 206, 360, 70);

/** GlowLeftBtn / GlowRightBtn bloom behind the key columns. */
export const GLOWS = [box(-333.5, -30, 203, 424), box(345, -4, 237, 458)] as const;

/** MiddleRing01 tick blocks (deco_inring01_1 126.5×206.5): centre and the flattened 2D transform. */
export const TICKS: ReadonlyArray<{ x: number; y: number; m: string; fill?: 'top' | 'bottom'; amount?: number }> = [
  { x: -203.3, y: -106.1, m: '0.516,-0.011,0.011,0.516' },
  { x: -230.3, y: 19.5, m: '0.425,-0.294,0.294,0.424' },
  { x: -184.5, y: 135.6, m: '0.188,-0.481,0.481,0.188', fill: 'top', amount: 0.459 },
  { x: 206.5, y: -98.7, m: '-0.276,0.436,-0.436,-0.276' },
  { x: 231.3, y: 30.2, m: '-0.468,0.218,-0.218,-0.467' },
  { x: 191.6, y: 140.1, m: '-0.515,-0.035,0.035,-0.514', fill: 'bottom', amount: 0.758 },
];

/** TriagleNode: centre and the angle of each ui_triangle_fx. */
export const TRIANGLES: ReadonlyArray<[number, number, number]> = [
  [-24.6, -255.3, -9.2],
  [208.8, -148.9, 50.7],
  [233.4, 106.4, 110.7],
  [24.6, 255.3, 170.8],
  [-208.8, 148.9, -129.2],
  [-233.4, -106.4, -69.3],
];

/** The six ui_out2_ring points on OutRing. */
export const RING_DOTS: ReadonlyArray<[number, number]> = [
  [347.8, 215.1],
  [-363.7, 187],
  [-408.9, -6.5],
  [409.1, -6.5],
  [-226.6, -340.8],
  [236.5, -333.9],
];

/** Watch_Dot crosses: [x, y, alpha]. */
export const CROSSES: ReadonlyArray<[number, number, number]> = [-151.5, -115.5, 44, 80, 221, 257].flatMap((y, i): Array<[number, number, number]> => [
  [-227, y, i % 2 === 0 ? 1 : 0.5],
  [236.5, y - 2.5, i % 2 === 0 ? 1 : 0.5],
]);

/** TechLineNode: [x, y, angle of the mesh's x axis on screen, yellow]. The mesh lines are drawn as short strokes. */
export const TECHLINES: ReadonlyArray<[number, number, number, boolean]> = [
  [-203, -98.5, 112.6, false],
  [-226.5, -25.5, 92.1, false],
  [-230.3, 45.4, 85.2, false],
  [-204, 124.5, 85.2, false],
  [-106.6, 203.8, 89.2, true],
  [201.5, -88.5, -122.2, true],
];
