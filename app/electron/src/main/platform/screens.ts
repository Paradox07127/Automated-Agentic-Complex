// The placement space of src/common/placement.ts (one global space, y up, the main display first) over Electron's
// displays, and the map between it and C3's coordinates. Electron gives DIPs, y down from the primary display's top-left.
// macOS: C3 uses AppKit points, y up from the main display's bottom-left, which is the placement space.
// Windows: C3 uses physical pixels, y down; the placement space is those pixels with y negated.
// Both branches are pure over the `screen` passed in; platform/index.ts picks one by process.platform.
import type { Display, Rectangle } from 'electron';
import type { Point, Rect, ScreenInfo } from '../../common/placement.ts';

/** What this needs of Electron's `screen`; `dipToScreenRect` exists on Windows only. */
export interface ElectronScreen {
  getAllDisplays(): Display[];
  getPrimaryDisplay(): Display;
  dipToScreenRect?(window: null, rect: Rectangle): Rectangle;
  screenToDipRect?(window: null, rect: Rectangle): Rectangle;
}

export interface PlacementSpace {
  /** The connected displays, the main one first. */
  screens(): ScreenInfo[];
  /** An Electron DIP rect, such as a window's bounds. */
  fromDip(r: Rectangle): Rect;
  rectFromC3(r: Rect): Rect;
  rectToC3(r: Rect): Rect;
  pointFromC3(p: Point): Point;
  pointToC3(p: Point): Point;
}

const flip = (r: Rect): Rect => ({ x: r.x, y: -(r.y + r.h), w: r.w, h: r.h });
const flipPoint = (p: Point): Point => ({ x: p.x, y: -p.y });
const rect = (r: Rectangle): Rect => ({ x: r.x, y: r.y, w: r.width, h: r.height });

export function placementSpace(screen: ElectronScreen, platform: 'mac' | 'windows'): PlacementSpace {
  const fromDip = platform === 'mac'
    ? (r: Rectangle): Rect => ({ x: r.x, y: screen.getPrimaryDisplay().bounds.height - (r.y + r.height), w: r.width, h: r.height })
    : (r: Rectangle): Rect => flip(rect(screen.dipToScreenRect!(null, r)));
  const same = <T>(v: T) => v;
  return {
    screens: () => {
      const primary = screen.getPrimaryDisplay().id;
      const all = screen.getAllDisplays();
      return [...all.filter((d) => d.id === primary), ...all.filter((d) => d.id !== primary)]
        .map((d) => ({ id: d.id, frame: fromDip(d.bounds), visibleFrame: fromDip(d.workArea) }));
    },
    fromDip,
    rectFromC3: platform === 'mac' ? same : flip,
    rectToC3: platform === 'mac' ? same : flip,
    pointFromC3: platform === 'mac' ? same : flipPoint,
    pointToC3: platform === 'mac' ? same : flipPoint,
  };
}

/** `fromDip`'s inverse: the Electron DIP rect, such as a window's bounds, of a placement space rect. */
export function dipRect(screen: ElectronScreen, platform: 'mac' | 'windows'): (r: Rect) => Rectangle {
  if (platform === 'mac') return (r) => ({ x: r.x, y: screen.getPrimaryDisplay().bounds.height - (r.y + r.h), width: r.w, height: r.h });
  return (r) => {
    const f = flip(r);
    return screen.screenToDipRect!(null, { x: f.x, y: f.y, width: f.w, height: f.h });
  };
}
