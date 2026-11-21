// C3 rules 12, 19 and 20 on the Companion side: where the avatar window or anchor goes, what is remembered per character and display, and
// the shapes of window-positions.json, placements.json and the placement keys of state.json. Every point and rect is in
// one global space with y up and `screens[0]` the main display (src/main/platform/screens.ts maps each platform onto it).

export interface Point { x: number; y: number }
/** `x`, `y` is the bottom-left corner. */
export interface Rect { x: number; y: number; w: number; h: number }
/** A display; `id` is the one C3 `display_id` and the files use. */
export interface ScreenInfo { id: number; frame: Rect; visibleFrame: Rect }

/** From the main screen's visible right and bottom edges to the default window. */
export const MARGIN = 24;
export const SCALE = { min: 0.5, max: 2 } as const;
/** HostLink.maxCoordinate: a message with a larger coordinate is dropped whole. */
export const MAX_COORDINATE = 100000;
const REASONS = ['start', 'drag', 'behavior', 'set_placement'];

/** A C3 `placement`: the anchor, the scale and the display it is on. */
export interface AvatarPlacement { x: number; y: number; scale: number; displayId: number }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** handlePlacement's checks in its order; `rejected` is the `why` it logs. */
export function readPlacement(m: Record<string, unknown>): AvatarPlacement | { rejected: string } {
  if ([m.x, m.y].some((v) => typeof v === 'number' && Math.abs(v) > MAX_COORDINATE)) return { rejected: 'coordinate' };
  const x = num(m.x), y = num(m.y), scale = num(m.scale), display = num(m.display_id);
  if (x === null || y === null || scale === null || display === null || typeof m.reason !== 'string') return { rejected: 'missing_field' };
  if (scale < SCALE.min || scale > SCALE.max) return { rejected: 'scale' };
  if (display <= 0 || !Number.isInteger(display) || display > 0xffffffff) return { rejected: 'display_id' };
  if (!REASONS.includes(m.reason)) return { rejected: 'reason' };
  return { x, y, scale, displayId: display };
}

/** The overlap of two rects; null when they only touch or are apart. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The screen sharing the largest area with `frame`, the first of equals; null when it touches none. */
export function screenFor(frame: Rect, screens: ScreenInfo[]): ScreenInfo | null {
  let best: ScreenInfo | null = null, area = 0;
  for (const s of screens) {
    const i = intersection(s.frame, frame);
    if (i !== null && i.w * i.h > area) {
      best = s;
      area = i.w * i.h;
    }
  }
  return best;
}

/** Moves `origin` so a window of `size` lies inside `visibleFrame`, keeping its bottom-left on screen if it is larger. */
export function clamp(origin: Point, size: { w: number; h: number }, visibleFrame: Rect): Point {
  const vf = visibleFrame;
  return { x: Math.max(vf.x, Math.min(origin.x, vf.x + vf.w - size.w)), y: Math.max(vf.y, Math.min(origin.y, vf.y + vf.h - size.h)) };
}

/** Bottom-right of the main screen's visible frame, MARGIN from its right and bottom edges. */
export function defaultOrigin(size: { w: number; h: number }, screens: ScreenInfo[]): Point | null {
  const main = screens[0];
  if (main === undefined) return null;
  const vf = main.visibleFrame;
  return clamp({ x: vf.x + vf.w - MARGIN - size.w, y: vf.y + MARGIN }, size, vf);
}

/** The fullscreen viewport's default anchor on a screen: 200 in from its right, on its visible bottom (rule 19). */
export function defaultAnchor(visibleFrame: Rect): Point {
  return { x: visibleFrame.x + visibleFrame.w - 200, y: visibleFrame.y };
}

/** window-positions.json: character → display id → the window's bottom-left. */
export type Positions = Record<string, Record<string, Point>>;
/** placements.json (fullscreen viewport only): character → display id → the last placement. */
export type Placements = Record<string, Record<string, { x: number; y: number; scale: number }>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSONDecoder's all or nothing: one malformed entry and the whole file reads as empty. */
function decode<T>(v: unknown, keys: string[]): Record<string, Record<string, T>> {
  if (!isObject(v)) return {};
  const out: Record<string, Record<string, T>> = {};
  for (const [character, displays] of Object.entries(v)) {
    if (!isObject(displays)) return {};
    out[character] = {};
    for (const [display, entry] of Object.entries(displays)) {
      if (!isObject(entry) || !keys.every((k) => num(entry[k]) !== null)) return {};
      out[character][display] = Object.fromEntries(keys.map((k) => [k, entry[k]])) as T;
    }
  }
  return out;
}

export const decodePositions = (v: unknown): Positions => decode<Point>(v, ['x', 'y']);
export const decodePlacements = (v: unknown): Placements => decode<{ x: number; y: number; scale: number }>(v, ['x', 'y', 'scale']);

/** `frame`'s origin under the display it mostly lies on; null for a frame on no display. */
export function withPosition(positions: Positions, character: string, frame: Rect, screens: ScreenInfo[]): Positions | null {
  const screen = screenFor(frame, screens);
  if (screen === null) return null;
  return { ...positions, [character]: { ...positions[character], [String(screen.id)]: { x: frame.x, y: frame.y } } };
}

/** The record for the window's display clamped onto that screen, else the default. */
export function windowTarget(positions: Positions, character: string, frame: Rect, screens: ScreenInfo[]): Point | null {
  const screen = screenFor(frame, screens);
  const origin = screen === null ? undefined : positions[character]?.[String(screen.id)];
  if (screen !== null && origin !== undefined) return clamp(origin, frame, screen.visibleFrame);
  return defaultOrigin(frame, screens);
}

/** state.json `window_scale[character]`: the window viewport's last placement scale. */
export function windowScale(state: Record<string, unknown>, character: string): number | null {
  const v = isObject(state.window_scale) ? state.window_scale[character] : undefined;
  return typeof v === 'number' ? v : null;
}

/** The character's last fullscreen display while it is connected, else `main`. */
export function launchDisplay(state: Record<string, unknown>, character: string, connected: number[], main: number): number {
  const last = isObject(state.last_display) ? state.last_display[character] : undefined;
  return typeof last === 'number' && Number.isInteger(last) && connected.includes(last) ? last : main;
}

/** printf's `%.<digits>f`: an exact tie rounds to even, where toFixed rounds it away from 0. */
export function fixed(value: number, digits: number): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  // toFixed(100) is the exact decimal expansion of any value a placement can hold.
  const exact = Math.abs(value).toFixed(100), dot = exact.indexOf('.');
  if (!/^50*$/.test(exact.slice(dot + 1 + digits))) return `${sign}${Math.abs(value).toFixed(digits)}`;
  let n = BigInt(exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + digits));
  if (n % 2n === 1n) n += 1n;
  const s = n.toString().padStart(digits + 1, '0');
  return `${sign}${digits > 0 ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s}`;
}

/** `--agentic-complex-placement`'s value, `%.1f,%.1f,%.3f`. */
export function placementArgument(p: { x: number; y: number; scale: number }): string {
  return `${fixed(p.x, 1)},${fixed(p.y, 1)},${fixed(p.scale, 3)}`;
}
