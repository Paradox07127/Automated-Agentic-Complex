import { KEY1, KEY2, KEY3, KEY4, SLOT_L, SLOT_R } from './outlines';
import type { Pt } from './Slab';

// Design coordinates of the watch face: the game's 1920×1080 watch canvas at half size, scaled to the page by useFit.
// Offsets are CSS px from the ring centre, y down.

export const STAGE = { w: 960, h: 540 } as const;
/** Centre of every ring and of the map disc. */
export const C = { x: 480, y: 270 } as const;
/** The map disc: RADIUS 400 game px. */
export const DISC_R = 200;

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

/** Row centres of the right-hand grid, two keys a row: x from Group1–5's offsets (×0.4165), so the column bows out at
 *  the second row and draws in toward the bottom as in the game; rows 68 px apart (the game's 152 × 0.4165, scaled with
 *  the keys). */
const ROWS = [
  { x: 330, y: -108 },
  { x: 347.5, y: -40 },
  { x: 338, y: 28 },
  { x: 314, y: 96 },
  { x: 287.5, y: 164 },
] as const;
/** A right-hand key: button_bg01 at 64 px (the game's 143 × 0.4165 = 59.6, enlarged so an 11px four-character name
 *  clears the rim), the two of a row touching as in Group1–5; the sprite's own clear margin is the gap. */
export const KEY = { w: 64, h: 64, gap: 0 } as const;

/** The keys on the right, two a row; at most ten. */
export function rightTiles(n: number): Box[] {
  return Array.from({ length: Math.min(n, ROWS.length * 2) }, (_, i) => {
    const r = ROWS[Math.floor(i / 2)]!;
    const dx = (KEY.w + KEY.gap) / 2;
    return box(r.x + (i % 2 === 0 ? -dx : dx), r.y, KEY.w, KEY.h);
  });
}

/** TopLeftBtn1–3: settings, reminders, pending. */
export const TOP_ICONS = [box(-326, -222, 52, 48), box(-270, -222, 52, 48), box(-214, -222, 52, 48)] as const;

/** The component status row, top centre over the ring. */
export const STATUS: Box = box(0, -256, 316, 22);

/** Top_RightNode: the clock strip, top right, left of the close key. */
export const COUNTERS: Box = box(286, -240, 256, 30);

/** CloseButtonNode: closes the window, top right. */
export const CLOSE: Box = box(446, -240, 32, 32);

/** BannerNode: the news banner over the right-hand keys. */
export const BANNER: Box = box(318, -182, 236, 60);

/** The player card's place, bottom left under the large keys. */
export const CARD: Box = box(-272, 180, 224, 76);

/** TechtreeNode and ReportNode: watchfactory_bg and its mirror at 1.078 × half size, either side of straight down. The
 *  content sits in the tall yellow part by the inner edge, above the white strip. */
export const BAR_SLOTS = [sprite(SLOT_L, -77.4, 200, 148.8, 55, [0.68, 0.36]), sprite(SLOT_R, 75.2, 200, 148.8, 55, [0.32, 0.36])] as const;
/** HudBgShdow's glow under both slots. */
export const BAR: Box = box(0, 202, 360, 70);

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
