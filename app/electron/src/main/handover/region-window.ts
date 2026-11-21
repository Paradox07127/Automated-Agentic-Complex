// 框选给她看…'s window: `stack.html#/region` in a transparent window over the whole screen under the
// pointer, shown without taking the front app, taking one drag. Esc once it is key, the page's cancel (a right click), a press
// off that screen or a rect with a side under 8 pt ends it with nothing. One window per selection; only its page gets the
// `region.*` ops.
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import { BridgeFailure, type Handler } from '../../common/bridge.ts';
import { regionRect } from '../../common/handover.ts';
import { PageSession } from '../../common/page.ts';
import type { Point, Rect } from '../../common/placement.ts';
import type { PlacementSpace } from '../platform/screens.ts';

export interface RegionWindowOptions {
  /** `stack.html#/region`. */
  url: string;
  /** A hidden, transparent, borderless window over every panel that never activates the app. */
  makeWindow(): BrowserWindow;
  space: Pick<PlacementSpace, 'screens' | 'fromDip' | 'rectToC3' | 'pointFromC3'>;
  toDip(r: Rect): Rectangle;
  /** The pointer in DIP. */
  cursor(): Point;
  /** `listener` hears each of the user's mouse presses, in C3 global points, until the returned function is called. */
  presses?(listener: (at: Point) => void): () => void;
  /** Gives the window's page the stack surface's bridge with `ops`. */
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  baseOps: ReadonlyMap<string, Handler<PageSession>>;
}

const inside = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const isPoint = (p: unknown): p is Point => {
  const o = p as Record<string, unknown> | null;
  return typeof o?.x === 'number' && Number.isFinite(o.x) && typeof o.y === 'number' && Number.isFinite(o.y);
};

export class RegionSelectWindow {
  private readonly o: RegionWindowOptions;
  private win: BrowserWindow | null = null;
  private frame: Rect | null = null;
  private done: ((rect: Rect | null) => void) | null = null;
  private unpress: (() => void) | null = null;

  constructor(options: RegionWindowOptions) {
    this.o = options;
  }

  /** The dragged rect in C3 global points, or null for a cancel; a selection showing is cancelled. */
  select(): Promise<Rect | null> {
    this.finish(null);
    const space = this.o.space, screens = space.screens(), c = this.o.cursor();
    const mouse = space.fromDip({ x: c.x, y: c.y, width: 0, height: 0 });
    const screen = screens.find((s) => inside(s.frame, mouse)) ?? screens[0];
    if (!screen) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.done = resolve;
      this.frame = screen.frame;
      const win = this.win = this.window();
      win.setBounds(this.o.toDip(screen.frame));
      win.showInactive();
      this.unpress = this.o.presses?.((at) => {
        if (this.frame && !inside(this.frame, space.pointFromC3(at))) this.finish(null);
      }) ?? null;
    });
  }

  /** Cancels a selection showing. */
  stop(): void {
    this.finish(null);
  }

  private window(): BrowserWindow {
    const win = this.o.makeWindow();
    const contents = win.webContents, id = contents.id;
    const page = new PageSession((sub, stream, kind, payload) => {
      if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
    });
    this.o.register(contents, page, new Map([...this.o.baseOps, ...Object.entries(this.ops(win))]));
    win.setFocusable(false);
    win.setIgnoreMouseEvents(false);
    contents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) page.end(); });
    // A page that is gone can no longer end the selection, and its window would take every click on the screen.
    contents.on('render-process-gone', () => {
      page.end();
      if (this.win === win) this.finish(null);
    });
    // Nor can a page that did not load.
    contents.on('did-fail-load', (_e, _code, _description, _url, isMainFrame) => {
      if (isMainFrame && this.win === win) this.finish(null);
    });
    // The window never activates the app; a press keys it so Esc reaches it.
    contents.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown') return;
      win.setFocusable(true);
      win.focus();
    });
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || this.win !== win) return;
      e.preventDefault();
      this.finish(null);
    });
    win.on('closed', () => {
      page.end();
      this.o.unregister(id);
      if (this.win === win) this.finish(null);
    });
    void win.loadURL(this.o.url);
    return win;
  }

  private ops(win: BrowserWindow): Record<string, Handler<PageSession>> {
    const open = () => {
      if (this.win !== win) throw new BridgeFailure('failed', '框选已结束');
    };
    return {
      'region.finish': ([from, to]) => {
        if (!isPoint(from) || !isPoint(to)) throw new BridgeFailure('invalid_args', 'from, to: {x, y} in page points, y down');
        open();
        const r = regionRect(from, to), b = win.getBounds();
        this.finish(r && this.o.space.rectToC3(this.o.space.fromDip({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height })));
        return null;
      },
      'region.cancel': () => {
        open();
        this.finish(null);
        return null;
      },
    };
  }

  private finish(rect: Rect | null): void {
    const done = this.done, win = this.win;
    if (!done) return;
    this.done = null;
    this.win = null;
    this.frame = null;
    this.unpress?.();
    this.unpress = null;
    if (win && !win.isDestroyed()) win.destroy();
    done(rect);
  }
}
