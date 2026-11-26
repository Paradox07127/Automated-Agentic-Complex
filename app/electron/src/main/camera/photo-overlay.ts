// 拍照's window: `stack.html#/photo` in a transparent overlay over the visible frame of the screen under her foot, shown
// without taking the front app. Only the bar the page reports takes the pointer; Esc and a press outside it close it. While it
// is open her renderer holds the photo state (C3 `set_render.photo`). Only this page gets the `photo.*` ops.
// Frames are in the placement space (y up) unless named DIP or page.
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import { BridgeFailure, type Handler } from '../../common/bridge.ts';
import type { Box } from '../../common/c3.ts';
import { PageSession } from '../../common/page.ts';
import type { Point, Rect, ScreenInfo } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import type { AvatarHost } from '../ops/avatar.ts';
import { watch } from '../ops/events.ts';

/** Where the photo state and the shutter go. */
export type PhotoTarget = Pick<AvatarHost, 'hello' | 'companionCapabilities' | 'sendPhoto' | 'capture' | 'on'>;

export interface PhotoOverlayOptions {
  /** `stack.html#/photo`. */
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
  /** Her figure in C3 global points; null while she has none. */
  figure(): Box | null;
  link: PhotoTarget;
}

interface Region { x: number; y: number; width: number; height: number }

/** `photo.onState`: her figure in the page and whether both sides list C3 `photo` and `capture`. */
interface PhotoOverlayState { anchor: Region; photo: boolean; capture: boolean }

/** The pointer poll. */
const POLL_MS = 1000 / 30;
/** C3 `set_render.photo` ranges. */
const APERTURE = { min: 1.4, max: 32 }, FOCUS = { min: 0.1, max: 10 };
/** The game's camera on opening: f/32, focus on her. */
const OPEN_APERTURE = 32;

const within = (r: Region, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));

export class PhotoOverlayWindow {
  /** `photo.onState`: the last one replayed to a new page. */
  readonly states = new PushSource('state');
  private readonly o: PhotoOverlayOptions;
  private win: BrowserWindow | null = null;
  private state: PhotoOverlayState | null = null;
  private visible: Rect | null = null;
  private regions: Region[] = [];
  private ignoring = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unpress: (() => void) | null = null;
  private unlink: (() => void) | null = null;

  constructor(options: PhotoOverlayOptions) {
    this.o = options;
  }

  get open(): boolean { return this.state !== null; }

  /** False when she has no figure to stand the bar under. */
  begin(): boolean {
    if (this.state) return true;
    const visual = this.o.figure();
    if (!visual) return false;
    const figure = this.o.fromC3(visual), screens = this.o.screens();
    const foot = { x: figure.x + figure.w / 2, y: figure.y };
    const screen = screens.find((s) => foot.x >= s.frame.x && foot.x < s.frame.x + s.frame.w && foot.y >= s.frame.y
      && foot.y < s.frame.y + s.frame.h) ?? screens[0];
    if (!screen) return false;
    const win = this.window();
    const v = this.visible = screen.visibleFrame;
    const listed = this.o.link.hello?.capabilities ?? [];
    const both = (c: string) => listed.includes(c) && this.o.link.companionCapabilities.includes(c);
    // Her figure in the top-left space of the visible frame.
    this.state = { anchor: { x: figure.x - v.x, y: v.y + v.h - (figure.y + figure.h), width: figure.w, height: figure.h },
      photo: both('photo'), capture: both('capture') };
    this.regions = [];
    if (this.state.photo) this.o.link.sendPhoto?.(true, OPEN_APERTURE, null);
    this.states.send(this.state);
    win.setBounds(this.o.toDip(v));
    win.showInactive();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.unpress = this.o.presses?.((at) => this.pressed(at)) ?? null;
    this.unlink = this.o.link.on?.((e) => { if (e.kind === 'lost') this.close(); }) ?? null;
    this.tick();
    return true;
  }

  stop(): void {
    this.close();
    this.win?.destroy();
    this.win = null;
  }

  /** Flips click-through over the bar; the poll's step, tests drive it. */
  tick(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.state) return;
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
    // A page that is gone or hung can never close it, and the window over the whole screen would keep the pointer.
    contents.on('render-process-gone', () => {
      page.end();
      this.close();
    });
    contents.on('unresponsive', () => this.close());
    // The panel never activates the app; a press in a region keys it so Esc reaches it.
    contents.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type !== 'mouseDown' || !this.regions.some((r) => within(r, mouse.x, mouse.y))) return;
      win.setFocusable(true);
      win.focus();
    });
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !this.state || input.key !== 'Escape') return;
      this.close();
      e.preventDefault();
    });
    win.on('closed', () => {
      page.end();
      this.o.unregister(id);
      this.win = null;
      this.close();
    });
    void win.loadURL(this.o.url);
    return win;
  }

  private ops(): Record<string, Handler<PageSession>> {
    const opened = () => {
      if (!this.state) throw new BridgeFailure('failed', '拍照已结束');
    };
    return {
      'photo.onState': watch('photo.onState', this.states),
      'photo.set': ([s]) => {
        const o = typeof s === 'object' && s !== null && !Array.isArray(s) ? s as Record<string, unknown> : null;
        const { aperture, focus } = o ?? {};
        if (typeof aperture !== 'number' || aperture < APERTURE.min || aperture > APERTURE.max
          || !(focus === 'auto' || (typeof focus === 'number' && focus >= FOCUS.min && focus <= FOCUS.max))) {
          throw new BridgeFailure('invalid_args', '{aperture 1.4–32, focus auto or 0.1–10}');
        }
        opened();
        // Whether it was sent does not reach the page.
        this.o.link.sendPhoto?.(true, aperture, typeof focus === 'number' ? focus : null);
        return null;
      },
      'photo.capture': async () => {
        opened();
        const link = this.o.link;
        if (!link.capture) throw new BridgeFailure('not_implemented', 'photo.capture');
        try {
          return { file: (await link.capture('transparent')).file };
        } catch (e) {
          throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
        }
      },
      'photo.close': () => {
        this.close();
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

  /** A press outside the bar. */
  private pressed(at: Point): void {
    const v = this.visible, p = this.o.fromC3({ x: at.x, y: at.y, w: 0, h: 0 });
    if (!v || this.regions.some((r) => within(r, p.x - v.x, v.y + v.h - p.y))) return;
    this.close();
  }

  /** Ends the photo state, once, and destroys the transient overlay window. */
  private close(): void {
    const state = this.state;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unpress?.();
    this.unpress = null;
    this.unlink?.();
    this.unlink = null;
    this.state = null;
    if (state?.photo) this.o.link.sendPhoto?.(false, OPEN_APERTURE, null);
    const win = this.win;
    this.win = null;
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false);
    if (!this.ignoring) win.setIgnoreMouseEvents(true, { forward: true });
    this.ignoring = true;
    win.destroy();
  }
}
