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

/** LeftBottomNode01 (×0.876): CharInfo, Activity, Gacha, Purchase, each on its rightbutton_bg sprite. */
const LEFT_KEYS = [
  { x: -294.3, y: -109.2, w: 145.4, h: 81.5 },
  { x: -322.7, y: -27.1, w: 117.4, h: 82.3 },
  { x: -325.9, y: 56.6, w: 120, h: 84.1 },
  { x: -305, y: 128.7, w: 131, h: 63.5 },
] as const;

/** The large keys on the left, top to bottom; at most four. */
export function leftTiles(n: number): Box[] {
  return LEFT_KEYS.slice(0, n).map((k) => box(k.x, k.y, k.w, k.h));
}

/** RightBotton (×0.833) Group1–5 centres: two keys per group, each group shifted along the ring. */
const GROUPS = [
  { x: 284.5, y: -60.2 },
  { x: 302, y: 3 },
  { x: 292.3, y: 66 },
  { x: 268.7, y: 127.7 },
  { x: 242, y: 189.3 },
] as const;
/** button_bg01 143 game px ×0.833. */
export const KEY = 59.6;

/** The square keys on the right, two per group; at most ten. */
export function rightTiles(n: number): Box[] {
  return Array.from({ length: Math.min(n, GROUPS.length * 2) }, (_, i) => {
    const g = GROUPS[Math.floor(i / 2)]!;
    return box(g.x + (i % 2 === 0 ? -KEY / 2 : KEY / 2), g.y, KEY, KEY);
  });
}

/** Small icons right of the keys, top to bottom along the ring; 36 px apart. */
export function sideIcons(n: number): Box[] {
  return Array.from({ length: n }, (_, i) => {
    const y = -60 + (i - (n - 1) / 2) * 36 + 60;
    return box(404 - (y * y) / 900, y, 36, 32);
  });
}

/** Width of the face centred on the ring: the side icons reach 422 px right of centre, the left keys 386 px left. */
export const FACE_W = 844;

/** TopLeftBtn1 (mail) and TopLeftBtn3 (notice). */
export const TOP_ICONS = [box(-248, -181, 44, 44), box(-194.5, -181, 44, 44)] as const;

/** Where the wallet bar's top-right corner sits on screen. */
export const CLOCK: Box = box(255, -212, 176, 70);

/** HudBgShdow (×1.078): the glow band and its two yellow slots, TechtreeNode then ReportNode. */
export const BAR: Box = box(0, 200, 298, 55.5);
export const BAR_SLOTS = [box(-77.4, 201, 148.8, 55), box(75.2, 200, 148.8, 55)] as const;

/** GlowLeftBtn / GlowRightBtn bloom behind the key columns. */
export const GLOWS = [box(-333.5, 10, 203, 424), box(313, 76, 237, 458)] as const;

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
