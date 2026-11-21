// 调整大小's window: `stack.html#/resize` in a transparent overlay
// over the visible frame of the screen under her foot, shown without taking the front app. Only the four handles and the button
// bar the page reports take the pointer; Esc and a press outside them cancel, Return finishes. Only this page gets the
// `resize.*` ops. Frames are in the placement space (y up) unless named DIP or page.
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import { type AvatarCorner, CORNERS, limitOf, ResizeMode } from '../../common/avatar-resize.ts';
import { BridgeFailure, type Handler } from '../../common/bridge.ts';
import type { Box } from '../../common/c3.ts';
import { PageSession } from '../../common/page.ts';
import type { Point, Rect } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import { watch } from '../ops/events.ts';
import type { AvatarPlacer } from './controller.ts';

/** Where resize mode starts and where its values go. */
export type ResizeTarget = Pick<AvatarPlacer, 'resizeStart' | 'resizePreview' | 'resizeCommit'>;

export interface ResizeOverlayOptions {
  /** `stack.html#/resize`. */
  url: string;
  /** A hidden, transparent overlay window over the status level that clicks pass through and that never activates the app. */
  makeWindow(): BrowserWindow;
  toDip(r: Rect): Rectangle;
  /** A C3 global rect in the placement space. */
  fromC3(b: Box): Rect;
  /** The pointer in DIP. */
  cursor(): Point;
  /** `listener` hears each of the user's mouse presses, in C3 global points, until the returned function is called. */
  presses?(listener: (at: Point) => void): () => void;
  /** Gives the window's page the stack surface's bridge with `ops`. */
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  baseOps: ReadonlyMap<string, Handler<PageSession>>;
  target: ResizeTarget;
}

interface Region { x: number; y: number; width: number; height: number }

/** The pointer poll. */
const POLL_MS = 1000 / 30;
const ACTIONS = ['restoreDefault', 'done', 'cancel'] as const;

const within = (r: Region, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));

export class ResizeOverlayWindow {
  /** `resize.onState`: her frame in the page, the scale, 最小 / 最大 and the dragged corner; the last one replayed to a new page. */
  readonly states = new PushSource('state');
  private readonly o: ResizeOverlayOptions;
  private win: BrowserWindow | null = null;
  private mode: ResizeMode | null = null;
  private visible: Rect | null = null;
  private regions: Region[] = [];
  private ignoring = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unpress: (() => void) | null = null;

  constructor(options: ResizeOverlayOptions) {
    this.o = options;
  }

  get open(): boolean { return this.mode !== null; }

  /** False when there is no frame of hers to start on. */
  begin(): boolean {
    if (this.mode) return true;
    const start = this.o.target.resizeStart();
    if (!start) return false;
    const win = this.window();
    this.visible = start.visible;
    this.regions = [];
    this.mode = new ResizeMode(start.frame, start.scale, start.maximumScale, {
      onScaleChange: (scale, frame) => this.o.target.resizePreview(scale, frame),
      onCommit: (scale, frame) => this.o.target.resizeCommit(scale, frame),
      onFinish: () => this.end(),
    });
    this.push();
    win.setBounds(this.o.toDip(start.visible));
    win.showInactive();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.unpress = this.o.presses?.((at) => this.pressed(at)) ?? null;
    this.tick();
    return true;
  }

  stop(): void {
    this.end();
    this.win?.destroy();
    this.win = null;
  }

  /** Flips click-through over the handles and the bar, but never mid-drag; the poll's step, tests drive it. */
  tick(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.mode || this.mode.dragging !== null) return;
    const b = win.getBounds(), m = this.o.cursor();
    const interactive = this.regions.some((r) => within(r, m.x - b.x, m.y - b.y));
    if (this.ignoring !== interactive) return;
    this.ignoring = !interactive;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  private window(): BrowserWindow {
    if (this.win) return this.win;
    const win = this.win = this.o.makeWindow();
    const contents = win.webContents, id = contents.id;
    const page = new PageSession((sub, stream, kind, payload) => {
      if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
    });
    this.o.register(contents, page, new Map([...this.o.baseOps, ...Object.entries(this.ops())]));
    win.setFocusable(false);
    contents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) page.end(); });
    // A page that is gone or hung can never end its drag, and the window over the whole screen would keep the pointer.
    contents.on('render-process-gone', () => {
      page.end();
      this.mode?.cancel();
    });
    contents.on('unresponsive', () => this.mode?.cancel());
    // The panel never activates the app; a press in a region keys it so Esc and Return reach it.
    contents.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown' || !this.regions.some((r) => within(r, mouse.x, mouse.y))) return;
      win.setFocusable(true);
      win.focus();
    });
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !this.mode) return;
      if (input.key === 'Escape') this.mode.cancel();
      else if (input.key === 'Enter') this.mode.done();
      else return;
      e.preventDefault();
    });
    win.on('closed', () => {
      page.end();
      this.o.unregister(id);
      this.win = null;
      this.end();
    });
    void win.loadURL(this.o.url);
    return win;
  }

  private ops(): Record<string, Handler<PageSession>> {
    const editing = (): ResizeMode => {
      if (!this.mode) throw new BridgeFailure('failed', '调整大小已结束');
      return this.mode;
    };
    return {
      'resize.onState': watch('resize.onState', this.states),
      'resize.drag': ([corner, dx, dy]) => {
        if (!(CORNERS as readonly unknown[]).includes(corner) || !finite(dx, dy)) {
          throw new BridgeFailure('invalid_args', `${CORNERS.join(' | ')}, dx, dy: finite page points, y down`);
        }
        editing().drag(corner as AvatarCorner, dx as number, -(dy as number));
        this.push();
        return null;
      },
      'resize.endDrag': () => {
        editing().endDrag();
        this.push();
        return null;
      },
      'resize.act': ([name]) => {
        if (!(ACTIONS as readonly unknown[]).includes(name)) throw new BridgeFailure('invalid_args', ACTIONS.join(' | '));
        editing()[name as (typeof ACTIONS)[number]]();
        this.push();
        return null;
      },
      'window.setInteractiveRegions': ([list]) => {
        if (!Array.isArray(list) || list.length > 32) throw new BridgeFailure('invalid_args', 'Region[] of up to 32');
        this.regions = list.map((r: Record<string, unknown>) => {
          if (!finite(r?.x, r?.y, r?.width, r?.height)) throw new BridgeFailure('invalid_args', 'Region[] of up to 32');
          return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
        });
        this.tick();
        return null;
      },
    };
  }

  /** Her frame in the top-left space of the visible frame (CGRect.local(in:)). */
  private push(): void {
    const m = this.mode, v = this.visible;
    if (!m || !v) return;
    const f = m.frame;
    this.states.send({ frame: { x: f.x - v.x, y: v.y + v.h - (f.y + f.h), width: f.w, height: f.h }, scale: m.scale,
      limit: limitOf(m.scale), dragging: m.dragging });
  }

  /** A press outside the handles and the bar. */
  private pressed(at: Point): void {
    const v = this.visible, p = this.o.fromC3({ x: at.x, y: at.y, w: 0, h: 0 });
    if (!v || this.regions.some((r) => within(r, p.x - v.x, v.y + v.h - p.y))) return;
    this.mode?.cancel();
  }

  /** Leaves resize mode without committing or reverting. */
  private end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unpress?.();
    this.unpress = null;
    this.mode = null;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false);
    if (!this.ignoring) win.setIgnoreMouseEvents(true, { forward: true });
    this.ignoring = true;
    win.hide();
  }
}
