// 调整镜头's window: `stack.html#/camera` in a transparent overlay over the visible frame
// of the screen under her foot, shown without taking the front app. Only the receiving area and the button bar the page
// reports take the pointer; Esc and a press outside them cancel, Return finishes. Only this page gets the `camera.*` ops.
// Frames are in the placement space (y up) unless named DIP.
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import { BridgeFailure, type Handler } from '../../common/bridge.ts';
import type { Box } from '../../common/c3.ts';
import { cameraArea, CameraMode, type CameraValue } from '../../common/camera-model.ts';
import { PageSession } from '../../common/page.ts';
import type { Point, Rect, ScreenInfo } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import { watch } from '../ops/events.ts';
import type { AvatarCamera, CameraOverlay } from './gesture.ts';

/** What camera mode's values go to. */
export type CameraTarget = Pick<AvatarCamera, 'live' | 'cancelled' | 'commit'>;

export interface CameraOverlayOptions {
  /** `stack.html#/camera`. */
  url: string;
  /** A hidden, transparent overlay window over the status level that clicks pass through and that never activates the app. */
  makeWindow(): BrowserWindow;
  toDip(r: Rect): Rectangle;
  /** A C3 global rect in the placement space. */
  fromC3(b: Box): Rect;
  /** The connected displays, the main one first. */
  screens(): ScreenInfo[];
  /** The pointer in DIP. */
  cursor(): Point;
  /** `listener` hears each of the user's mouse presses, in C3 global points, until the returned function is called. */
  presses?(listener: (at: Point) => void): () => void;
  /** Gives the window's page the stack surface's bridge with `ops`. */
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  baseOps: ReadonlyMap<string, Handler<PageSession>>;
  camera: CameraTarget;
}

interface Region { x: number; y: number; width: number; height: number }

/** The pointer poll. */
const POLL_MS = 1000 / 30;
const ACTIONS = ['fullBody', 'closeup', 'reset', 'commit', 'cancel'] as const;

const within = (r: Region, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));

export class CameraOverlayWindow implements CameraOverlay {
  /** `camera.onState`: the area, the value and what the buttons may do; the last one replayed to a new page. */
  readonly states = new PushSource('state');
  private readonly o: CameraOverlayOptions;
  private win: BrowserWindow | null = null;
  private mode: CameraMode | null = null;
  private visible: Rect | null = null;
  private area: Region | null = null;
  private regions: Region[] = [];
  private ignoring = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unpress: (() => void) | null = null;

  constructor(options: CameraOverlayOptions) {
    this.o = options;
  }

  get open(): boolean { return this.mode !== null; }

  begin(visual: Box, value: CameraValue, closeupZoom: number | null): void {
    if (this.mode) return;
    const figure = this.o.fromC3(visual), screens = this.o.screens();
    const foot = { x: figure.x + figure.w / 2, y: figure.y };
    const screen = screens.find((s) => foot.x >= s.frame.x && foot.x < s.frame.x + s.frame.w && foot.y >= s.frame.y
      && foot.y < s.frame.y + s.frame.h) ?? screens[0];
    if (!screen) return;
    const win = this.window();
    const visible = this.visible = screen.visibleFrame;
    this.area = cameraArea(figure, visible);
    this.regions = [];
    this.mode = new CameraMode(value, closeupZoom, {
      onChange: (v) => {
        this.o.camera.live(v);
        this.push();
      },
      onCommit: (v) => this.o.camera.commit(v),
      onCancel: () => this.o.camera.cancelled(),
      onFinish: () => this.end(),
    });
    this.push();
    win.setBounds(this.o.toDip(visible));
    win.showInactive();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.unpress = this.o.presses?.((at) => this.pressed(at)) ?? null;
    this.tick();
  }

  stop(): void {
    this.end();
    this.win?.destroy();
    this.win = null;
  }

  /** Flips click-through over the area and the bar, but never mid-drag; the poll's step, tests drive it. */
  tick(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.mode || this.mode.dragging) return;
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
      else if (input.key === 'Enter') this.mode.commit();
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
    const editing = (): CameraMode => {
      if (!this.mode) throw new BridgeFailure('failed', '调整镜头已结束');
      return this.mode;
    };
    const numbers = (args: unknown[], n: number, what: string): number[] => {
      if (!finite(...args.slice(0, n)) || args.length < n) throw new BridgeFailure('invalid_args', what);
      return args.slice(0, n) as number[];
    };
    return {
      'camera.onState': watch('camera.onState', this.states),
      'camera.drag': (args) => {
        const [dx, dy] = numbers(args, 2, 'dx, dy: finite page points, y down');
        editing().drag(dx!, -dy!);
        return null;
      },
      'camera.endDrag': () => {
        editing().endDrag();
        return null;
      },
      'camera.scroll': (args) => {
        editing().scroll(numbers(args, 1, 'deltaY: finite points, positive zooms in')[0]!);
        return null;
      },
      'camera.magnify': (args) => {
        editing().magnify(numbers(args, 1, 'magnification: finite')[0]!);
        return null;
      },
      'camera.act': ([name]) => {
        if (!(ACTIONS as readonly unknown[]).includes(name)) throw new BridgeFailure('invalid_args', ACTIONS.join(' | '));
        editing()[name as (typeof ACTIONS)[number]]();
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

  private push(): void {
    const m = this.mode;
    if (!m || !this.area) return;
    this.states.send({ area: this.area, value: m.value, editing: m.phase === 'editing', closeup: m.closeupEnabled });
  }

  /** A press outside the area and the bar. */
  private pressed(at: Point): void {
    const v = this.visible, p = this.o.fromC3({ x: at.x, y: at.y, w: 0, h: 0 });
    if (!v || this.regions.some((r) => within(r, p.x - v.x, v.y + v.h - p.y))) return;
    this.mode?.cancel();
  }

  /** Leaves camera mode without committing or reverting and destroys the transient overlay window. */
  private end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unpress?.();
    this.unpress = null;
    this.mode = null;
    const win = this.win;
    this.win = null;
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false);
    if (!this.ignoring) win.setIgnoreMouseEvents(true, { forward: true });
    this.ignoring = true;
    win.destroy();
  }
}
