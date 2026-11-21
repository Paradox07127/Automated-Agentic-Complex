// One desktop panel window, sized to its content and placed by its owner: `stack.html#<route>` in a
// transparent overlay, shown while its page reports cards or regions, placed by the owner's follower, and clicked through
// except where the pointer is in a region the page reported. Frames are in the placement space (y up). It takes the
// keyboard for a command the app started or right after a click in a region, without activating the app.
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import type { FollowPanel } from '../../common/desktop-follow.ts';
import { type AnchorPayload, type CardInsets, insetsOf, type PanelKind } from '../../common/desktop-layout.ts';
import { PageSession } from '../../common/page.ts';
import type { Rect } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import { guardWebContents, type WebGuardPorts } from '../web-guard.ts';

/** A region the page reported, in its CSS px, top-left origin. */
export interface Region { x: number; y: number; width: number; height: number; drag: boolean }

export interface PanelOptions {
  kind: PanelKind;
  /** The page's hash route. */
  route: string;
  url: string;
  /** The subscription that tells the page is alive. */
  aliveOn: 'stack.onCards' | 'window.onAnchor';
  makeWindow(): BrowserWindow;
  toDip(r: Rect): Rectangle;
  /** The pointer, in DIPs, and in the placement space. */
  cursor(): { x: number; y: number };
  mouse(): { x: number; y: number };
  /** Gives the window's page its bridge. */
  register(contents: WebContents, page: PageSession): void;
  unregister(id: number): void;
  log(line: string): void;
  /** The page's navigation, edit menu and error log guards; absent leaves them off. */
  guard?: WebGuardPorts;
}

export const MAX_REGIONS = 32;
const FREEZE_SLOP = 12;
const HIDE_DELAY_MS = 1000;
const KEY_GRACE_MS = 1000;
const THAW_DELAY_MS = 400;
const SIZE_STEP = 2;
/** `releaseKey` hides these routes' panels instead of ordering them front again. */
const COMMAND_ROUTES = new Set(['/cmd', '/console']);

const within = (r: { x: number; y: number; width: number; height: number }, x: number, y: number, slop = 0) =>
  x >= r.x - slop && x < r.x + r.width + slop && y >= r.y - slop && y < r.y + r.height + slop;

export class DesktopPanel implements FollowPanel {
  readonly pointer = new PushSource('pointer');
  readonly anchorState = new PushSource('anchor');
  readonly visibility = new PushSource('visibility');
  readonly anchor = new PushSource('anchor');
  isShown = false;
  /** The last mouse down in a region (epoch ms), for StackDecisions' gesture. */
  lastRegionClick: number | null = null;
  /** Called on each show or hide. */
  onVisibility: () => void = () => {};
  /** The panel lost the keyboard. */
  onBlur: () => void = () => {};
  /** A drag by a drag region ended away from where it began; the panel's frame then. */
  onUserMoved: (frame: Rect) => void = () => {};
  /** A double click in a drag region. */
  onResetOffset: () => void = () => {};
  private readonly o: PanelOptions;
  private win: BrowserWindow | null = null;
  private page: PageSession | null = null;
  private preferredSize: { w: number; h: number } | null = null;
  private regions: Region[] = [];
  private glass: Rect[] = [];
  private cards = new Set<string>();
  private closedCards: Set<string> | null = null;
  private awaitingFrame = false;
  private frozen = false;
  private thawFrom: number | null = null;
  private pointerOutside = false;
  private pressedInRegion = false;
  private ignoring = true;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;
  private placed: 'docked' | 'settled' = 'docked';
  /** Command panels only accept regions while their owner has opened a command. */
  private commandRequested = false;
  /** `takeKey` came while hidden: the panel takes key when it shows. */
  private keyOnShow = false;
  /** The frame the owner last gave it, or the user dragged it to. */
  private frame: Rect | null = null;
  /** The pointer and the frame as the running drag by a drag region began; null while none runs. */
  private drag: { pointer: { x: number; y: number }; from: Rect } | null = null;

  constructor(options: PanelOptions) {
    this.o = options;
  }

  get isFrozen(): boolean { return this.frozen; }
  get isKey(): boolean { return !!this.win && !this.win.isDestroyed() && this.win.isFocused(); }
  get isDragging(): boolean { return this.drag !== null; }
  get contentSize(): { w: number; h: number } | null { return this.preferredSize; }

  /** `p` (placement space) is in the frame the panel shows at; false while it is not placed. */
  contains(p: { x: number; y: number }): boolean {
    const f = this.frame;
    return this.isShown && !this.awaitingFrame && f !== null && p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h;
  }

  /** Around the bounds of the page's cards. */
  get cardInsets(): CardInsets | null {
    const size = this.preferredSize, first = this.glass[0];
    if (!size || !first) return null;
    const union = this.glass.slice(1).reduce((a, g) => {
      const x = Math.min(a.x, g.x), y = Math.min(a.y, g.y);
      return { x, y, w: Math.max(a.x + a.w, g.x + g.w) - x, h: Math.max(a.y + a.h, g.y + g.h) - y };
    }, first);
    return insetsOf(union, size);
  }

  /** Loads the page hidden; it shows once it has something to show. */
  start(): void {
    if (this.win) return;
    const win = this.win = this.o.makeWindow();
    const contents = win.webContents, id = contents.id;
    const page = this.page = new PageSession((sub, stream, kind, payload) => {
      if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
    });
    this.o.register(contents, page);
    if (this.o.guard) guardWebContents(contents, 'stack', this.o.guard);
    contents.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument) return;
      page.end();
      this.alive = false;
    });
    contents.on('render-process-gone', () => page.end());
    // A left mouse down in a drag region drags the panel instead of reaching the page, until the mouse up.
    contents.on('before-mouse-event', (e, mouse) => {
      if (mouse.type === 'mouseDown' && mouse.button === 'left') {
        this.mouseDown(mouse.x, mouse.y);
        if (this.regions.some((r) => r.drag && within(r, mouse.x, mouse.y))) {
          e.preventDefault();
          if (mouse.clickCount === 2) this.onResetOffset();
          else this.dragBegan();
        }
      }
      if (mouse.type === 'mouseMove' && this.drag) {
        e.preventDefault();
        this.dragMoved();
      }
      if (mouse.type === 'mouseUp') {
        this.pressedInRegion = false;
        if (this.drag) {
          e.preventDefault();
          this.dragEnded();
        }
      }
    });
    // Unfocusable but while it takes key: a key panel that hides would hand the keyboard to another panel, not back.
    win.setFocusable(false);
    win.on('blur', () => {
      if (!win.isDestroyed()) win.setFocusable(false);
      this.onBlur();
    });
    win.on('closed', () => {
      page.end();
      this.o.unregister(id);
      this.win = null;
    });
    void win.loadURL(this.o.url);
  }

  stop(): void {
    this.win?.destroy();
    this.win = null;
  }

  /** The page subscribed to `op`. */
  markAlive(op: string): void {
    if (op !== this.o.aliveOn || this.alive) return;
    this.alive = true;
    this.desk(`alive ${op}`);
  }

  /** The card ids of the last pushed payload; a card that was not there at `close` reopens a closed panel. */
  setCards(ids: string[]): void {
    const set = new Set(ids);
    if (this.closedCards) this.closedCards = [...set].every((id) => this.closedCards!.has(id)) ? set : null;
    this.cards = set;
    this.updateShown();
  }

  /** `window.setInteractiveRegions`: more than `MAX_REGIONS` rects or a non-finite one drops the call. */
  setInteractiveRegions(regions: Region[], glass: Rect[]): void {
    if (this.isCommand && !this.commandRequested) return;
    if (regions.length > MAX_REGIONS) return;
    const finite = (v: number[]) => v.every(Number.isFinite);
    if (!regions.every((r) => finite([r.x, r.y, r.width, r.height])) || !glass.every((g) => finite([g.x, g.y, g.w, g.h]))) return;
    this.regions = regions.filter((r) => r.width > 0 && r.height > 0);
    this.glass = glass;
    this.updateShown();
    if (this.isShown) this.poll();
  }

  /** `window.setContentSize`: a change under `SIZE_STEP` is dropped; the owner's next `setFrame` takes it. */
  setContentSize(size: { w: number; h: number }): void {
    const old = this.preferredSize;
    if (old && Math.abs(old.w - size.w) < SIZE_STEP && Math.abs(old.h - size.h) < SIZE_STEP) return;
    const text = (s: { w: number; h: number }) => `${Math.round(s.w)}x${Math.round(s.h)}`;
    if (!old || text(old) !== text(size)) this.desk(`${old ? 'content size' : 'first content size'} ${text(size)}`);
    this.preferredSize = size;
  }

  /** `window.contentRect`. */
  contentRect(): { width: number; height: number } {
    const b = this.win?.getBounds();
    return { width: b?.width ?? 0, height: b?.height ?? 0 };
  }

  /** `window.close`: hidden until a new card arrives; the command panel shows again with its next layer's regions. */
  close(): void {
    if (this.isCommand) {
      this.commandRequested = false;
      this.keyOnShow = false;
      this.clearRegions();
    } else {
      this.closedCards = this.cards;
    }
    this.hide('window.close');
  }

  /** `window.requestKey`: makes the panel key, without activating the app, only right after a click in a region. */
  requestKey(): boolean {
    if (!this.isShown || !this.clickedInRegion()) return false;
    this.makeKey();
    return true;
  }

  /** Makes the panel key for a command the app started, with no click needed; a hidden panel takes key when it shows. */
  takeKey(): void {
    if (!this.win) return;
    if (this.isCommand) this.commandRequested = true;
    if (this.isShown && !this.awaitingFrame) this.makeKey();
    else this.keyOnShow = true;
  }

  /** `window.releaseKey`: the command panel hides; the others are ordered out and straight back in, which gives up key
   *  without activating another window. */
  releaseKey(): void {
    this.keyOnShow = false;
    if (this.isCommand) {
      this.commandRequested = false;
      this.clearRegions();
      this.hide('releaseKey');
    } else if (this.isShown && !this.awaitingFrame && this.win && !this.win.isDestroyed()) {
      this.win.hide();
      this.win.showInactive();
    }
  }

  private get isCommand(): boolean { return COMMAND_ROUTES.has(this.o.route); }

  /** A panel window's `focus` keys it without activating the app. */
  private makeKey(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setFocusable(true);
    this.win.focus();
  }

  private clearRegions(): void {
    this.regions = [];
    this.glass = [];
  }

  /** Places the panel for its owner; a panel waiting to be shown lands at once and then shows. */
  move(frame: Rect, animated: boolean): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const bounds = this.o.toDip(frame);
    this.frame = frame;
    if (this.awaitingFrame) {
      this.awaitingFrame = false;
      win.setBounds(bounds, false);
      this.poll();
      win.showInactive();
      if (this.keyOnShow) {
        this.keyOnShow = false;
        this.makeKey();
      }
      return;
    }
    win.setBounds(bounds, animated);
    if (this.isShown) this.poll();
  }

  setAlpha(alpha: number): void {
    if (this.win && !this.win.isDestroyed()) this.win.setOpacity(alpha);
  }

  pushAnchor(anchor: AnchorPayload): void {
    this.anchor.send(anchor);
    this.placed = anchor.docked ? 'docked' : 'settled';
    this.pushAnchorState();
  }

  /** One pointer poll from the owner's clock; none while hidden. */
  tick(): void {
    if (this.isShown) this.poll();
  }

  /** Sets click-through from the pointer and pushes `window.onPointer` and the frozen state on change. */
  private poll(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds(), m = this.o.cursor();
    const x = m.x - b.x, y = m.y - b.y;
    const inside = this.regions.some((r) => within(r, x, y));
    const interactive = inside || this.pressedInRegion;
    if (this.ignoring === interactive) {
      this.ignoring = !interactive;
      win.setIgnoreMouseEvents(!interactive, { forward: true });
    }
    const inPanel = x >= 0 && y >= 0 && x < b.width && y < b.height;
    if (inPanel || !this.pointerOutside) this.pointer.send({ x, y, inside });
    this.pointerOutside = !inPanel;
    const hold = this.isKey || this.regions.some((r) => within(r, x, y, FREEZE_SLOP)) || (this.frozen && this.pressedInRegion);
    if (hold) {
      this.thawFrom = null;
      if (this.frozen) return;
      this.frozen = true;
      this.pushAnchorState();
    } else if (this.frozen) {
      const since = this.thawFrom ?? Date.now();
      this.thawFrom = since;
      if (Date.now() - since < THAW_DELAY_MS) return;
      this.thawFrom = null;
      this.frozen = false;
      this.pushAnchorState();
    }
  }

  private dragBegan(): void {
    this.drag = this.frame && { pointer: this.o.mouse(), from: this.frame };
  }

  /** The panel moved by the pointer's travel since the drag began. */
  private dragMoved(): void {
    const d = this.drag, win = this.win;
    if (!d || !win || win.isDestroyed()) return;
    const p = this.o.mouse();
    this.frame = { ...d.from, x: d.from.x + p.x - d.pointer.x, y: d.from.y + p.y - d.pointer.y };
    win.setBounds(this.o.toDip(this.frame), false);
  }

  private dragEnded(): void {
    const d = this.drag, f = this.frame;
    this.drag = null;
    if (d && f && (f.x !== d.from.x || f.y !== d.from.y)) this.onUserMoved(f);
  }

  private mouseDown(x: number, y: number): void {
    if (!this.regions.some((r) => within(r, x, y))) return;
    this.lastRegionClick = Date.now();
    this.pressedInRegion = true;
  }

  /** Whether the panel saw a mouse down in a region less than `KEY_GRACE_MS` ago. */
  clickedInRegion(): boolean {
    return this.lastRegionClick !== null && Date.now() - this.lastRegionClick < KEY_GRACE_MS;
  }

  private pushAnchorState(): void {
    this.anchorState.send(this.frozen ? 'frozen' : this.placed);
  }

  private updateShown(): void {
    const wanted = this.win !== null && this.closedCards === null && (this.cards.size > 0 || this.regions.length > 0);
    if (wanted) {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = null;
      if (this.isShown) return;
      this.awaitingFrame = true;
      this.isShown = true;
      this.desk(`shown (${this.cards.size === 0 ? `regions ${this.regions.length}` : `cards ${this.cards.size}`})`);
      this.visibility.send(true);
      this.onVisibility();
    } else if (this.isShown && !this.hideTimer) {
      this.hideTimer = setTimeout(() => this.hide('no content'), HIDE_DELAY_MS);
    }
  }

  private hide(reason: string): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.isShown) return;
    this.desk(`hidden (${reason})`);
    this.win?.hide();
    this.awaitingFrame = false;
    this.isShown = false;
    if (!this.ignoring) this.win?.setIgnoreMouseEvents(true, { forward: true });
    this.ignoring = true;
    this.pressedInRegion = false;
    this.drag = null;
    this.frozen = false;
    this.thawFrom = null;
    this.pushAnchorState();
    this.visibility.send(false);
    this.onVisibility();
  }

  /** One `desk:` line naming this panel. */
  private desk(line: string): void {
    this.o.log(`desk: ${this.o.route.slice(1)} ${line}`);
  }
}
