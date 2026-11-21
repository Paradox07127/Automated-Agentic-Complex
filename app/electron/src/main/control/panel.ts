// The 电脑操作 panel: `stack.html#/computer` in an opaque
// floating window above the bubbles, placed over her head and shown without taking the front app. A
// published state shows it (with `raise`) or updates it in place; 收起 stops the task and keeps it hidden until a session asks
// for permission again; while the web desktop shows a working or paused session as a stack card the panel stays hidden.
// Frames are in the placement space (y up).
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import type { Handler } from '../../common/bridge.ts';
import { CARD_PHASES, type ComputerUsePanelState, headAnchor, PANEL_WIDTH, panelFrame } from '../../common/computer-control.ts';
import { PageSession } from '../../common/page.ts';
import type { Point, Rect, ScreenInfo } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import { computerUsePanelOps, type PanelHost } from '../ops/computer-use.ts';

export interface ControlPanelOptions {
  host: PanelHost;
  /** `stack.html#/computer`. */
  url: string;
  /** A hidden, opaque, frameless window at the approval level that takes clicks without activating the app. */
  makeWindow(): BrowserWindow;
  toDip(r: Rect): Rectangle;
  /** Her body (C3 `hit_capsules`), null without her. */
  body(): Rect | null;
  /** The connected displays, the main one first. */
  screens(): ScreenInfo[];
  /** The pointer. */
  mouse(): Point;
  /** The web desktop is up, which shows `CARD_PHASES` as a stack card instead. */
  webDesktop(): boolean;
  /** Gives the window's page the stack surface's bridge with `ops`. */
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  /** The stack surface's ops (`computerUse.stop` among them). */
  baseOps: ReadonlyMap<string, Handler<PageSession>>;
}

/** The window, over `overlayOptions()`: opaque white 0.08 with a shadow, as wide as the view. */
export const CONTROL_PANEL_WINDOW = { transparent: false, backgroundColor: '#141414', hasShadow: true, width: PANEL_WIDTH, height: 220 } as const;

const sameRect = (a: Rect | null, b: Rect) => a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export class ControlPanel {
  /** `computerUse.onPanel`: the panel state, the last one replayed to a new page. */
  readonly states = new PushSource('state');
  private readonly o: ControlPanelOptions;
  private win: BrowserWindow | null = null;
  private shown = false;
  private dismissed = false;
  private frame: Rect | null = null;
  private fittingHeight = 0;

  constructor(options: ControlPanelOptions) {
    this.o = options;
    this.states.send(options.host.state);
  }

  get isShown(): boolean { return this.shown; }

  /** Loads the page hidden. */
  start(): void {
    if (this.win) return;
    const win = this.win = this.o.makeWindow();
    const contents = win.webContents, id = contents.id;
    const page = new PageSession((sub, stream, kind, payload) => {
      if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
    });
    this.o.register(contents, page, new Map([...this.o.baseOps, ...Object.entries(computerUsePanelOps(this.o.host, this))]));
    contents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) page.end(); });
    contents.on('render-process-gone', () => page.end());
    win.on('closed', () => {
      page.end();
      this.o.unregister(id);
      this.win = null;
      this.shown = false;
    });
    void win.loadURL(this.o.url);
  }

  stop(): void {
    this.win?.destroy();
    this.win = null;
    this.shown = false;
  }

  /** `raise` false updates a shown panel in place and never brings a hidden one forward. */
  present(state: ComputerUsePanelState, raise: boolean): void {
    if (state.phase === 'waitingPermission') this.dismissed = false;
    this.states.send(state);
    if (this.o.webDesktop() && CARD_PHASES.has(state.phase)) return this.hide();
    if (this.dismissed || !(raise || this.shown)) return;
    this.place();
    if (!this.win) return;
    this.win.showInactive();
    this.shown = true;
  }

  /** The panel's 收起: the task stops, and the panel stays hidden until a session asks for permission again. */
  dismiss(): Promise<void> {
    this.dismissed = true;
    this.hide();
    return this.o.host.dismiss();
  }

  /** `window.setContentSize`: the page's fitting height. */
  setContentSize(height: number): void {
    this.fittingHeight = height;
    if (this.shown) this.place();
  }

  /** The displays changed. */
  place(): void {
    if (!this.win || !(this.shown || !this.dismissed)) return;
    const { head, visible } = headAnchor(this.o.body(), this.o.screens());
    const frame = panelFrame(head, visible, this.fittingHeight, this.shown ? this.frame : null, this.o.mouse());
    if (sameRect(this.frame, frame)) return;
    this.frame = frame;
    this.win.setBounds(this.o.toDip(frame));
  }

  private hide(): void {
    if (this.shown) this.win?.hide();
    this.shown = false;
  }
}
