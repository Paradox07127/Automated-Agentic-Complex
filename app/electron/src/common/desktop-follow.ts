// Moves the desktop panels after her: feed it every tick
// while a panel shows or the command layer is open. The panels follow one box of hers, which she leaves only past the dead
// zone; none moves while one is frozen or key; while she is dragged or walks and `WALK_FADE` after, the bubble hides and the
// chip and dock fade to `DRAG_ALPHA`. Opening and closing the wheel, the console and 快速输入 in the bubble are here
// too, and so are the panels the user dragged: their offsets from her, their pins and their resets, and C3 rule 39's
// presents: a presented panel shows once she has made her gesture for it.
import { type AnchorInput, type AnchorSnapshot, AnchorTracker, shift } from './desktop-anchor.ts';
import type { SelectionCommand } from './desktop-hotkey.ts';
import type { WindowCommand } from './handover.ts';
import {
  anchorPayload, type AnchorPayload, cardIn, type CardInsets, type CmdMode, type DockReason, EDGE, fallbackInsets, type FollowState, GAP, inset,
  keepOut, keepOutOf, type LayoutInput, type LayoutMemory, layoutScreen, overlaps, place, type PanelKind, type PanelPlacement, type PanelSide,
  type UserOffset, userOffset, WHEEL_PANEL, wheelFrame,
} from './desktop-layout.ts';
import type { Point, Rect, ScreenInfo } from './placement.ts';

/** One desktop panel as the follower drives it; frames are in the placement space. */
export interface FollowPanel {
  readonly isShown: boolean;
  /** The pointer is near its regions, or a key was pressed in it lately. */
  readonly isFrozen: boolean;
  readonly isKey: boolean;
  /** The user is dragging it by a drag region; left out, never. */
  readonly isDragging?: boolean;
  /** The page's content size; null before the first. */
  readonly contentSize: { w: number; h: number } | null;
  /** Where the page's card sits in that size; null before the page reports one. */
  readonly cardInsets: CardInsets | null;
  move(frame: Rect, animated: boolean): void;
  setAlpha(alpha: number, animated: boolean): void;
  pushAnchor(anchor: AnchorPayload): void;
  takeKey(): void;
  releaseKey(): void;
}

/** The panels' user offsets, one per panel kind, kept across launches. */
export interface OffsetStore {
  get(kind: PanelKind): UserOffset | null;
  set(kind: PanelKind, offset: UserOffset): void;
  clear(kind: PanelKind): void;
}

/** An `OffsetStore` that keeps nothing across launches. */
export function memoryOffsets(): OffsetStore {
  const saved = new Map<PanelKind, UserOffset>();
  return { get: (k) => saved.get(k) ?? null, set: (k, o) => { saved.set(k, o); }, clear: (k) => { saved.delete(k); } };
}

/** protocol.ts `DesktopCommand`, as far as the shell sends it. `at` is the wheel's centre in its page, CSS px from the top-left;
 *  `ringPointer` is the held right button that opened the wheel (C3 rule 56) in the same px, `ms` since it went down. */
export type DesktopCommand = { kind: 'open'; mode: CmdMode; prefill?: string; at?: Point } | { kind: 'close' } | { kind: 'openConsole' }
  | { kind: 'scope'; scopeId: string; files: number } | SelectionCommand | { kind: 'expandStack' } | { kind: 'notice'; text: string }
  | { kind: 'ringPointer'; phase: 'move'; x: number; y: number } | { kind: 'ringPointer'; phase: 'up'; x: number; y: number; ms: number }
  | WindowCommand;

/** C3 rule 39: a presented panel waits this long for her stroke before it shows anyway, and on close this long before it goes
 *  anyway. */
export const PRESENT_OPEN_WAIT = 3.5;
export const PRESENT_CLOSE_WAIT = 1.5;

/** One present: its side and time once `open` went out, whether the panel may show, and since when it closes. */
interface Present { token: string; side: 'left' | 'right' | null; openedAt: number | null; released: boolean; closingAt: number | null;
  closing: boolean }

export const GLIDE = 0.35;
/** A panel's `desk: … frame` line goes out at most this often, in seconds, with its latest frame. */
const FRAME_LOG_EVERY = 60;
export const DRAG_ALPHA = 0.4;
export const WALK_FADE = 0.15;
const TOLERANCE = 0.5;
const SIZE_STEP = 2;
const RESIZE_INTERVAL = 0.1;
const COLLISION_HOLD = 0.3;
const FACE_SLACK = 4;
const ANCHOR_SETTLE = 0.15;
/** The console waits this long for its page to report its own size. */
export const CONSOLE_SIZE_WAIT = 0.3;
/** A drop with its top-left this close to the panel's default slot's takes the slot. */
export const SNAP_DISTANCE = 12;
/** A drop further than this from her box pins the panel to the screen. */
export const PIN_DISTANCE = 400;
/** A drop keeps at most this gap from her keep-out. */
export const MAX_USER_GAP = 96;
const KINDS: PanelKind[] = ['bubble', 'chip', 'dock', 'cmd', 'console'];

const maxX = (r: Rect) => r.x + r.w;
const maxY = (r: Rect) => r.y + r.h;
const midX = (r: Rect) => r.x + r.w / 2;
const midY = (r: Rect) => r.y + r.h / 2;
const offset = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
const contains = (r: Rect, x: number, y: number) => x >= r.x && x < maxX(r) && y >= r.y && y < maxY(r);
const sameRect = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const near = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < TOLERANCE && Math.abs(a.y - b.y) < TOLERANCE && Math.abs(a.w - b.w) < TOLERANCE
  && Math.abs(a.h - b.h) < TOLERANCE;
const sameAnchor = (a: AnchorPayload | undefined, b: AnchorPayload) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** The dead zone's radius for her box of `height`. */
export function followRadius(height: number): number { return Math.max(48, 0.12 * height); }

/** How far two rects overlap: the shorter side of their overlap; 0 without one. */
function depth(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(Math.min(maxX(a), maxX(b)) - Math.max(a.x, b.x), Math.min(maxY(a), maxY(b)) - Math.max(a.y, b.y)));
}

function distance(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - maxX(a), a.x - maxX(b)), dy = Math.max(0, b.y - maxY(a), a.y - maxY(b));
  return Math.sqrt(dx * dx + dy * dy);
}

/** The edge of frame `f` on `side` of her that faces her, as a rect of no width or no height. */
function attachEdge(f: Rect, side: PanelSide): Rect {
  switch (side) {
    case 'right': return { x: f.x, y: f.y, w: 0, h: f.h };
    case 'left': return { x: maxX(f), y: f.y, w: 0, h: f.h };
    case 'above': return { x: f.x, y: f.y, w: f.w, h: 0 };
    default: return { x: f.x, y: maxY(f), w: f.w, h: 0 };
  }
}

export class DesktopFollow {
  state: FollowState = 'docked';
  /** The command layer's mode while it is open. */
  cmdMode: CmdMode | null = null;
  /** 快速输入 in the bubble, from `openQuickInput` to `closeQuickInput`. */
  quickInputOpen = false;
  /** The console under the menu bar button, from `openConsole` to `closeConsole`, apart from the command layer. */
  consoleOpen = false;
  /** The command panel showed since `open`, and the console since `openConsole`; one hiding afterwards is its page closing it. */
  private cmdShown = false;
  private consoleShown = false;
  /** The console panel was placed before. */
  private consolePlaced = false;
  /** The console's content size from before its first open, and since when it waits for its own. */
  private consoleOldSize: { w: number; h: number } | null = null;
  private consoleWaitFrom: number | null = null;
  private statusItem: Rect | null = null;
  private readonly consoleCommand: (c: DesktopCommand) => void;
  private collidingSince: number | null = null;
  private readonly command: (c: DesktopCommand) => void;
  private readonly panels: Partial<Record<PanelKind, FollowPanel>>;
  private readonly log: (line: string) => void;
  private tracker = new AnchorTracker();
  private memory: LayoutMemory = {};
  private glideUntil: number | null = null;
  private followed: Rect | null = null;
  private followedCapsules: Rect | null = null;
  private headDX: number | null = null;
  private scale = 1;
  private faceSince: number | null = null;
  private placedNow = false;
  private anchorBox: Rect | null = null;
  private anchorSince = 0;
  private lastStep = { dx: 0, dy: 0 };
  private capsules: Rect | null = null;
  private applied: Partial<Record<PanelKind, Rect>> = {};
  private placedSize: Partial<Record<PanelKind, { w: number; h: number }>> = {};
  /** Placement units per CSS px of each panel's page, for this step. */
  private ratios: Partial<Record<PanelKind, number>> = {};
  private readonly pixelsPerDip: (screen: ScreenInfo) => number;
  private sides: Partial<Record<PanelKind, PanelSide>> = {};
  private movedAt: Partial<Record<PanelKind, number>> = {};
  private anchors: Partial<Record<PanelKind, AnchorPayload>> = {};
  private alphas: Partial<Record<PanelKind, number>> = {};
  private stoppedAt: number | null = null;
  private loggedPhase: string | null = null;
  private loggedColumn: string | null = null;
  private loggedFrames: Partial<Record<PanelKind, string>> = {};
  /** When each panel's frame line went out; a changed frame waits FRAME_LOG_EVERY after it. */
  private loggedFramesAt: Partial<Record<PanelKind, number>> = {};
  private readonly offsets: OffsetStore;
  /** Pinned panels' top-left corners, and the display she stood on when each was pinned. */
  private pins: Partial<Record<PanelKind, { topLeft: { x: number; y: number }; screen: number | null }>> = {};
  /** The open wheel's panel frame, centred where it opened. */
  private wheel: Rect | null = null;
  /** Panels dropped or reset since the last tick. */
  private placeNow = new Set<PanelKind>();
  private lastInput: LayoutInput | null = null;
  /** Her box while she is on screen, live while she walks. */
  private live: Rect | null = null;
  private presents: Partial<Record<PanelKind, Present>> = {};
  /** C3 rule 39 `present` (token, left or right, true for `open`); false when it did not reach her, which then is not waited for. */
  onPresent: (token: string, side: 'left' | 'right', open: boolean) => boolean = () => false;
  /** A present's close is done, at its stroke or `PRESENT_CLOSE_WAIT` after it: the owner hides the panel now. */
  onPresentClosed: (kind: PanelKind) => void = () => {};

  /** `command` sends to every page's `desktop.onCommand` but the console's, `consoleCommand` to the console's only;
   *  `pixelsPerDip` is a display's placement units per DIP. */
  constructor(panels: Partial<Record<PanelKind, FollowPanel>>, log: (line: string) => void = () => {},
    command: (c: DesktopCommand) => void = () => {}, consoleCommand: (c: DesktopCommand) => void = () => {},
    offsets: OffsetStore = memoryOffsets(), pixelsPerDip: (screen: ScreenInfo) => number = () => 1) {
    this.panels = panels;
    this.log = log;
    this.command = command;
    this.consoleCommand = consoleCommand;
    this.offsets = offsets;
    this.pixelsPerDip = pixelsPerDip;
  }

  /** While a panel shows, or the command layer or the console is open. */
  get wantsTicks(): boolean {
    return this.cmdMode !== null || this.consoleOpen || KINDS.some((k) => this.panels[k]?.isShown);
  }

  /** The wheel and the console close on a click outside them; input only on esc or send. */
  get closesOnOutsideClick(): boolean {
    return this.consoleOpen || (this.cmdMode !== null && this.cmdMode !== 'input');
  }

  /** Opens the command layer in `mode`; it takes key as soon as it shows. `wheel` centres the wheel's panel on `centre`
   *  (placement space), kept on its screen; with `at` the page gets that point as the wheel's centre. */
  open(mode: CmdMode, prefill?: string, wheel?: { centre: Point; screens: ScreenInfo[]; at: boolean }): void {
    const cmd = this.panels.cmd, size = cmd?.contentSize;
    this.log(`desk: open ${mode} (cmdMode was ${this.cmdMode ?? 'none'}); cmd panel `
      + (cmd ? `shown=${cmd.isShown} size=${size ? `${Math.round(size.w)}x${Math.round(size.h)}` : 'none'}` : 'missing'));
    this.cmdMode = mode;
    this.cmdShown = false;
    delete this.applied.cmd;
    let at: Point | undefined;
    this.wheel = null;
    if (wheel) {
      const c = wheel.centre, screen = wheel.screens.find((x) => contains(x.frame, c.x, c.y)) ?? wheel.screens[0];
      const ratio = screen ? this.pixelsPerDip(screen) : 1;
      const f = this.wheel = wheelFrame(c, WHEEL_PANEL * ratio, wheel.screens);
      if (wheel.at) at = { x: Math.round((c.x - f.x) / ratio), y: Math.round((maxY(f) - c.y) / ratio) };
    }
    this.command({ kind: 'open', mode, ...(prefill === undefined ? {} : { prefill }), ...(at ? { at } : {}) });
    cmd?.takeKey();
  }

  /** Hides the command layer, which hands the keyboard back. */
  close(): void {
    if (this.cmdMode === null) return;
    this.log(`desk: close ${this.cmdMode}`);
    this.cmdMode = null;
    this.cmdShown = false;
    this.wheel = null;
    this.command({ kind: 'close' });
    this.panels.cmd?.releaseKey();
  }

  /** Opens the console under the menu bar button `statusItem`; it takes key as soon as it shows. Its first open waits for a
   *  content size other than the one its page had before. */
  openConsole(statusItem: Rect | null): void {
    const console = this.panels.console, size = console?.contentSize;
    this.log(`desk: open console (console was ${this.consoleOpen ? 'open' : 'closed'}); console panel `
      + (console ? `shown=${console.isShown} size=${size ? `${Math.round(size.w)}x${Math.round(size.h)}` : 'none'}` : 'missing'));
    this.consoleOpen = true;
    this.statusItem = statusItem;
    this.consoleShown = false;
    delete this.applied.console;
    this.consoleOldSize = this.consolePlaced ? null : size ?? null;
    this.consoleWaitFrom = null;
    this.consoleCommand({ kind: 'openConsole' });
    console?.takeKey();
  }

  /** Hides the console, which hands the keyboard back. */
  closeConsole(): void {
    if (!this.consoleOpen) return;
    this.log('desk: close console');
    this.consoleOpen = false;
    this.consoleShown = false;
    this.consoleCommand({ kind: 'close' });
    this.panels.console?.releaseKey();
  }

  /** Opens 快速输入 in the bubble, which takes key. The console and the command layer close, or a bare `close` goes out so a
   *  page that kept its last open starts afresh; `first` goes out just before the open. */
  openQuickInput(prefill?: string, first?: DesktopCommand): void {
    this.log(`desk: open quick input (cmdMode was ${this.cmdMode ?? 'none'})`);
    if (this.cmdMode === null) this.command({ kind: 'close' });
    else this.close();
    this.closeConsole();
    if (first) this.command(first);
    this.quickInputOpen = true;
    this.command(prefill === undefined ? { kind: 'open', mode: 'input' } : { kind: 'open', mode: 'input', prefill });
    this.panels.bubble?.takeKey();
  }

  /** The bubble page put 快速输入 away: the bubble hands the keyboard back. */
  closeQuickInput(): void {
    this.quickInputOpen = false;
    this.panels.bubble?.releaseKey();
  }

  /** One tick from a raw sample. */
  tick(input: AnchorInput, mouse: { x: number; y: number }): void {
    this.placedNow = input.placement !== null;
    if (input.placement) this.scale = input.placement.w / 540;
    this.step(this.tracker.update(input), input.screens, input.now, mouse);
  }

  step(snapshot: AnchorSnapshot, screens: ScreenInfo[], now: number, mouse: { x: number; y: number }): void {
    const cmd = this.panels.cmd;
    if (cmd && this.cmdMode !== null) {
      if (cmd.isShown) this.cmdShown = true;
      else if (this.cmdShown) {
        this.log(`desk: cmd ${this.cmdMode} closed by the page`);
        this.cmdMode = null;
        this.cmdShown = false;
        this.wheel = null;
      }
    }
    const console = this.panels.console;
    if (console && this.consoleOpen) {
      if (console.isShown) this.consoleShown = true;
      else if (this.consoleShown) {
        this.log('desk: console closed by the page');
        this.consoleOpen = false;
        this.consoleShown = false;
      }
    }
    const docked: DockReason | null = typeof snapshot.phase === 'object' ? snapshot.phase.docked : null;
    const phase = docked ? `docked(${docked})` : 'following';
    if (phase !== this.loggedPhase) {
      this.loggedPhase = phase;
      this.log(`desk: anchor ${phase}`);
    }
    const c = snapshot.column, b = snapshot.settledBody;
    if (snapshot.phase === 'settled' && c && b) {
      const n = Math.round;
      const line = `desk: column anchor ${n(c.anchor.x)},${n(c.anchor.y)} rect ${n(b.x)},${n(b.y)} ${n(b.w)}x${n(b.h)} source ${c.source} posture ${c.posture}`;
      if (line !== this.loggedColumn) {
        this.loggedColumn = line;
        this.log(line);
      }
    }
    const frozen = KINDS.some((k) => this.panels[k]?.isShown && (this.panels[k]!.isFrozen || this.panels[k]!.isKey));
    const old = this.consoleOldSize;
    if (this.consoleOpen && old && console?.isShown) {
      const from = this.consoleWaitFrom ?? now, size = console.contentSize;
      this.consoleWaitFrom = from;
      if (!size || size.w !== old.w || size.h !== old.h || now - from >= CONSOLE_SIZE_WAIT) {
        this.consoleOldSize = null;
        this.consoleWaitFrom = null;
      }
    }
    const consoleWaits = this.consoleOpen && this.consoleOldSize !== null;
    const shown = KINDS.filter((k) => this.panels[k]?.isShown && this.panels[k]!.contentSize !== null && !(k === 'console' && consoleWaits));
    for (const kind of KINDS) {
      if (shown.includes(kind)) continue;
      delete this.applied[kind];
      delete this.placedSize[kind];
      delete this.sides[kind];
    }
    // A page's sizes go by the display its panel was placed on, else by the one the layout would pick.
    const lastHead = this.followed && this.head(this.followed);
    const home = layoutScreen({ body: this.followed, head: lastHead, screen: snapshot.screen?.id ?? null,
      lastScreen: snapshot.lastScreen?.id ?? null, screens, mouse, requests: [] }, lastHead);
    for (const kind of KINDS) {
      const f = this.applied[kind], on = (f && screens.find((s) => contains(s.frame, midX(f), midY(f)))) || home;
      this.ratios[kind] = on ? this.pixelsPerDip(on) : 1;
    }

    let next: FollowState;
    if (docked) next = 'docked';
    else if (snapshot.phase === 'dragging') next = 'dragging';
    else if (snapshot.phase === 'moving') next = 'moving';
    else next = this.glideUntil !== null && now < this.glideUntil ? 'glide' : 'settled';
    if (frozen) next = 'frozen';
    let follow = next !== 'frozen' && next !== 'moving';
    const previous = this.capsules;
    if (snapshot.body) this.capsules = snapshot.body;
    const step = previous && this.capsules ? { dx: midX(this.capsules) - midX(previous), dy: midY(this.capsules) - midY(previous) } : { dx: 0, dy: 0 };
    let liveBox = snapshot.settledBody;
    if (snapshot.phase === 'moving' && this.followed && this.followedCapsules && snapshot.body) {
      liveBox = offset(this.followed, midX(snapshot.body) - midX(this.followedCapsules), midY(snapshot.body) - midY(this.followedCapsules));
    }
    if (!docked && liveBox) this.live = liveBox;
    const screenId = snapshot.screen?.id;
    if (screenId != null) {
      for (const kind of KINDS) {
        const pin = this.pins[kind];
        if (pin && pin.screen !== null && pin.screen !== screenId) delete this.pins[kind];
      }
    }
    // The bubble, chip and dock hold on her anchor; her capsules push only the command layer.
    const capsules = this.capsules;
    const colliding = capsules ? this.attached(shown).some((p) => p.kind === 'cmd' && overlaps(p.card, keepOut(capsules))) : false;
    this.collidingSince = colliding ? this.collidingSince ?? now : null;
    const onFace = snapshot.settledBody ? (() => {
      const box = snapshot.settledBody;
      const face = keepOutOf('bubble', box, this.head(box), this.scale);
      return this.attached(shown).some((p) => p.kind === 'bubble' && depth(p.card, face) > FACE_SLACK);
    })() : false;
    this.faceSince = onFace ? this.faceSince ?? now : null;
    if (!sameRect(snapshot.settledBody, this.anchorBox)) {
      this.anchorBox = snapshot.settledBody;
      this.anchorSince = now;
    }
    // On her placement the settled panels wait for her box to hold, so they never go to one it passed.
    if (this.placedNow && now - this.anchorSince < ANCHOR_SETTLE && (next === 'settled' || next === 'glide')) follow = false;
    const box = snapshot.settledBody;
    if (box) {
      const take = (b: Rect) => {
        this.followed = b;
        this.followedCapsules = snapshot.body;
        this.headDX = snapshot.head ? midX(snapshot.head) - box.x : null;
      };
      if (!this.followed || docked || next === 'dragging') take(box);
      else if (follow && this.leavesDeadZone(box, shown, screens, now)) take(box);
      else if (next === 'moving' && liveBox && this.tagsAlong(liveBox, step, shown, now)) {
        take(liveBox);
        follow = true;
      }
    } else {
      this.followed = null;
      this.followedCapsules = null;
    }
    this.lastStep = step;
    const resized = new Set(shown.filter((k) => {
      const a = this.placedSize[k], s = this.size(k);
      return !!a && (a.w !== s.w || a.h !== s.h);
    }));

    let placements: Partial<Record<PanelKind, PanelPlacement>> = {};
    const input: LayoutInput = {
      body: this.followed, head: this.followed && this.head(this.followed), screen: snapshot.screen?.id ?? null,
      lastScreen: snapshot.lastScreen?.id ?? null, screens, docked, mouse, now, scale: this.scale, memory: this.memory,
      requests: shown.map((kind) => ({ kind, size: this.size(kind), cardInsets: this.insets(kind), visible: true,
        userOffset: this.offsets.get(kind), pin: kind === 'cmd' && this.wheel ? { x: this.wheel.x, y: maxY(this.wheel) } : this.pins[kind]?.topLeft ?? null,
        ...(kind === 'cmd' && this.cmdMode ? { mode: this.cmdMode } : {}), ...(kind === 'console' ? { statusItem: this.statusItem } : {}) })),
    };
    this.lastInput = input;
    if (follow || resized.size > 0 || this.placeNow.size > 0 || shown.some((k) => !this.applied[k])) {
      const result = place(input);
      placements = result.placements;
      this.memory = result.memory;
    }

    const held = this.stepPresents(shown, placements, now);
    const carried = this.placeNow;
    this.placeNow = new Set();
    let glided = false;
    for (const kind of shown) {
      const panel = this.panels[kind], placement = placements[kind];
      if (!panel || !placement || panel.isDragging || held.has(kind)) continue;
      const target = placement.frame, current = this.applied[kind];
      if (current) {
        if (resized.has(kind)) {
          if (now - (this.movedAt[kind] ?? -Infinity) < RESIZE_INTERVAL) continue;
          panel.move(target, true);
        } else {
          if ((!follow && !carried.has(kind)) || near(current, target)) continue;
          if (next === 'dragging') panel.move(target, false);
          else {
            panel.move(target, true);
            glided = true;
          }
        }
      } else {
        panel.move(target, false);
      }
      this.applied[kind] = target;
      this.placedSize[kind] = this.size(kind);
      this.sides[kind] = placement.side;
      this.movedAt[kind] = now;
      if (kind === 'console') this.consolePlaced = true;
    }
    for (const kind of KINDS) {
      if (this.applied[kind]) continue;
      delete this.loggedFrames[kind];
      delete this.loggedFramesAt[kind];
    }
    if (next !== 'dragging') {
      for (const kind of shown) {
        const a = this.applied[kind];
        if (!a) continue;
        const line = `${Math.round(a.x)},${Math.round(a.y)} ${Math.round(a.w)}x${Math.round(a.h)}`;
        if (line === this.loggedFrames[kind] || now - (this.loggedFramesAt[kind] ?? -Infinity) < FRAME_LOG_EVERY) continue;
        this.loggedFrames[kind] = line;
        this.loggedFramesAt[kind] = now;
        this.log(`desk: ${kind} frame ${line}`);
      }
    }
    if (glided) {
      this.glideUntil = now + GLIDE;
      if (next === 'settled') next = 'glide';
    }
    if (next === 'moving') this.stoppedAt = null;
    else if (this.state === 'moving') this.stoppedAt = now;
    const walking = next === 'moving' || (this.stoppedAt !== null && now - this.stoppedAt < WALK_FADE);
    this.state = next;

    for (const kind of shown) {
      const panel = this.panels[kind]!;
      const alpha = next === 'dragging' || (walking && kind !== 'cmd' && kind !== 'console') ? (kind === 'bubble' ? 0 : DRAG_ALPHA) : 1;
      if (alpha !== (this.alphas[kind] ?? 1)) {
        // The bubble hides and shows again at once.
        panel.setAlpha(alpha, alpha !== 0 && (this.alphas[kind] ?? 1) !== 0);
        this.alphas[kind] = alpha;
      }
      const last = this.anchors[kind], placement = placements[kind];
      let anchor: AnchorPayload;
      if (next === 'dragging' && last) anchor = { ...last, state: 'dragging' };
      else if (placement) anchor = anchorPayload(kind, placement, next, snapshot.head, screens);
      else if (last) anchor = { ...last, state: next };
      else continue;
      if (sameAnchor(last, anchor)) continue;
      this.anchors[kind] = anchor;
      panel.pushAnchor(anchor);
    }
    // The bubble page draws nothing while she is docked, so its panel hides; only this tells it the dock ended.
    for (const kind of KINDS) {
      const panel = this.panels[kind], last = this.anchors[kind];
      if (shown.includes(kind) || !panel || !last || last.docked === docked) continue;
      const anchor = { ...last, docked, state: next };
      this.anchors[kind] = anchor;
      panel.pushAnchor(anchor);
    }
  }

  /** The user dragged `kind` by a drag region to `frame`, where she is now. With its top-left within `SNAP_DISTANCE` of its
   *  default slot's it goes back there and drops its offset; further than `PIN_DISTANCE` from her box it is pinned there
   *  until she stands on another display or it is reset; otherwise its gap from her keep-out, at most `MAX_USER_GAP`, is
   *  kept. The panels follow that box from here. */
  userMoved(kind: PanelKind, frame: Rect): void {
    const live = this.live;
    if (!live) return;
    delete this.pins[kind];
    const slot = this.defaultSlot(kind, live);
    if (slot && Math.hypot(frame.x - slot.x, maxY(frame) - maxY(slot)) <= SNAP_DISTANCE) {
      this.offsets.clear(kind);
    } else if (distance(frame, live) > PIN_DISTANCE) {
      this.offsets.clear(kind);
      this.pins[kind] = { topLeft: { x: frame.x, y: maxY(frame) }, screen: this.lastInput?.screen ?? null };
    } else {
      const head = this.head(live);
      const o = userOffset(frame, keepOutOf(kind, live, head, this.scale), head);
      o.gap = Math.min(o.gap, MAX_USER_GAP);
      this.offsets.set(kind, o);
      this.sides[kind] = o.side;
    }
    this.followed = live;
    this.followedCapsules = this.capsules;
    this.applied[kind] = frame;
    this.placeNow.add(kind);
  }

  /** A double click on a drag region: back to its default slot. */
  resetOffset(kind: PanelKind): void {
    this.offsets.clear(kind);
    delete this.pins[kind];
    this.placeNow.add(kind);
  }

  /** 复位浮窗. */
  resetOffsets(): void {
    for (const kind of KINDS) this.offsets.clear(kind);
    this.pins = {};
    this.placeNow = new Set(KINDS);
  }

  /** `kind`'s next show waits for her: `open` goes out with its side once it is laid out, and it is placed at `stroke(token)`
   *  or `PRESENT_OPEN_WAIT` later. False for a panel already placed or presenting. */
  present(kind: PanelKind, token: string): boolean {
    if (this.applied[kind] || this.presents[kind]) return false;
    this.presents[kind] = { token, side: null, openedAt: null, released: false, closingAt: null, closing: false };
    return true;
  }

  /** Sends `close` for `kind`'s present; true when one went out, and `onPresentClosed` follows. A present whose `open` did not
   *  go out yet is dropped. */
  dismissPresent(kind: PanelKind): boolean {
    const p = this.presents[kind];
    if (!p) return false;
    if (p.closing) return true;
    if (p.side === null || !this.onPresent(p.token, p.side, false)) {
      delete this.presents[kind];
      return false;
    }
    p.closing = true;
    return true;
  }

  /** Her `motion.stroke` for `token`: an opening panel is placed at the next tick, a closing one is done now. */
  stroke(token: string): void {
    const kind = KINDS.find((k) => this.presents[k]?.token === token);
    const p = kind && this.presents[kind];
    if (!kind || !p || p.side === null) return;
    if (p.closing) {
      delete this.presents[kind];
      this.onPresentClosed(kind);
    } else {
      p.released = true;
    }
  }

  /** Sends the presents' `open` once their panels are laid out, closes those whose panel went, and ends the waits; returns the
   *  panels not to place yet. */
  private stepPresents(shown: PanelKind[], placements: Partial<Record<PanelKind, PanelPlacement>>, now: number): Set<PanelKind> {
    const held = new Set<PanelKind>();
    for (const kind of KINDS) {
      const p = this.presents[kind];
      if (!p) continue;
      const showing = this.panels[kind]?.isShown === true;
      if (p.closing) {
        p.closingAt ??= now;
        if (!showing || now - p.closingAt >= PRESENT_CLOSE_WAIT) {
          delete this.presents[kind];
          this.onPresentClosed(kind);
          continue;
        }
      } else if (p.openedAt !== null && p.side !== null) {
        if (!showing) {
          delete this.presents[kind];
          this.onPresent(p.token, p.side, false);
          continue;
        }
        if (now - p.openedAt >= PRESENT_OPEN_WAIT) p.released = true;
      } else {
        if (!shown.includes(kind)) continue;
        const placement = placements[kind];
        if (!placement) {
          held.add(kind);
          continue;
        }
        // For a panel above, below or elsewhere, the side of her its centre is on.
        const side = placement.side === 'left' || placement.side === 'right' ? placement.side
          : midX(placement.frame) < (this.followed ? midX(this.followed) : midX(placement.frame)) ? 'left' : 'right';
        if (!this.onPresent(p.token, side, true)) {
          delete this.presents[kind];
          continue;
        }
        p.side = side;
        p.openedAt = now;
      }
      if (!p.released) held.add(kind);
    }
    return held;
  }

  /** `kind`'s card where it shows beside her now, and the side it is on; null while it is not placed. */
  placedCard(kind: PanelKind): { card: Rect; side: PanelSide } | null {
    const f = this.applied[kind], side = this.sides[kind];
    return f && side ? { card: cardIn(this.insets(kind), f), side } : null;
  }

  /** `kind`'s frame with neither offset nor pin, for her box `body`, on the last tick's layout input; null when it was not
   *  shown or docked. */
  private defaultSlot(kind: PanelKind, body: Rect): Rect | null {
    const input = this.lastInput;
    if (!input || !input.requests.some((r) => r.kind === kind)) return null;
    const p = place({ ...input, body, head: this.head(body),
      requests: input.requests.map((r) => (r.kind === kind ? { ...r, userOffset: null, pin: null } : r)) }).placements[kind];
    return p && p.docked === null ? p.frame : null;
  }

  private head(box: Rect): Rect {
    return { x: box.x + (this.headDX ?? box.w / 2), y: maxY(box), w: 0, h: 0 };
  }

  private insets(kind: PanelKind): CardInsets {
    const i = this.panels[kind]?.cardInsets ?? fallbackInsets(kind), r = this.ratios[kind] ?? 1;
    return { left: i.left * r, right: i.right * r, top: i.top * r, bottom: i.bottom * r };
  }

  /** `kind`'s content size in placement units; one within `SIZE_STEP` of the size it was placed for keeps that. */
  private size(kind: PanelKind): { w: number; h: number } {
    const page = this.panels[kind]?.contentSize ?? { w: 0, h: 0 }, r = this.ratios[kind] ?? 1;
    const size = { w: page.w * r, h: page.h * r };
    const a = this.placedSize[kind];
    return a && Math.abs(a.w - size.w) < SIZE_STEP && Math.abs(a.h - size.h) < SIZE_STEP ? a : size;
  }

  /** The shown panels beside her, not pinned, docked, cornered or under the menu bar, with their frames and cards. */
  private attached(shown: PanelKind[]): { kind: PanelKind; frame: Rect; card: Rect; side: PanelSide }[] {
    return shown.flatMap((kind) => {
      const f = this.applied[kind], s = this.sides[kind];
      if (this.pins[kind] || !f || !s || !['left', 'right', 'above', 'below'].includes(s)) return [];
      return [{ kind, frame: f, card: cardIn(this.insets(kind), f), side: s }];
    });
  }

  /** Her settled `box` leaves the followed one's dead zone: no panel shows, it is more than `followRadius` off, her face has
   *  been on the bubble's card or her capsules' keep-out on the command layer's card for `COLLISION_HOLD`, or a side beside
   *  `box` is short of the bubble's or the command layer's reach (plus `GAP` beside her for the bubble). */
  private leavesDeadZone(box: Rect, shown: PanelKind[], screens: ScreenInfo[], now: number): boolean {
    if (!this.followed || shown.length === 0) return true;
    if (shift(box, this.followed) > followRadius(box.h)) return true;
    const head = this.head(box);
    if (this.faceSince !== null && now - this.faceSince >= COLLISION_HOLD) return true;
    if (this.collidingSince !== null && now - this.collidingSince >= COLLISION_HOLD) return true;
    const screen = screens.find((s) => head.x >= s.frame.x && head.x < maxX(s.frame) && head.y >= s.frame.y && head.y < maxY(s.frame));
    if (!screen) return false;
    const v = inset(screen.visibleFrame, EDGE);
    for (const p of this.attached(shown)) {
      if (p.kind !== 'bubble' && p.kind !== 'cmd') continue;
      const k = keepOutOf(p.kind, box, head, this.scale);
      const i = this.insets(p.kind);
      const reachIn = GAP - (p.side === 'left' ? i.right : p.side === 'above' ? i.bottom : p.side === 'below' ? i.top : i.left);
      const w = reachIn + p.frame.w + (p.kind === 'cmd' ? 0 : GAP), h = reachIn + p.frame.h;
      if (p.side === 'right' && maxX(v) - maxX(k) < w) return true;
      if (p.side === 'left' && k.x - v.x < w) return true;
      if (p.side === 'above' && maxY(v) - maxY(k) < h) return true;
      if (p.side === 'below' && k.y - v.y < h) return true;
    }
    return false;
  }

  /** While she walks, at her `live` box: her capsules' keep-out has been on the command layer's card for `COLLISION_HOLD`, or
   *  her face will be on the bubble's card or that keep-out on the command layer's by the next sample at a pace she kept, or
   *  her head stands more than twice `followRadius` further from a card's attach edge than on the followed box. */
  private tagsAlong(live: Rect, step: { dx: number; dy: number }, shown: PanelKind[], now: number): boolean {
    const followed = this.followed;
    if (!followed) return false;
    if (this.collidingSince !== null && now - this.collidingSince >= COLLISION_HOLD) return true;
    const far = 2 * followRadius(followed.h);
    const paced = step.dx * this.lastStep.dx + step.dy * this.lastStep.dy > 0;
    const capsules = this.capsules;
    const ahead = paced && capsules ? keepOut(offset(capsules, step.dx, step.dy)) : null;
    const next = offset(live, step.dx, step.dy);
    const face = paced ? keepOutOf('bubble', next, this.head(next), this.scale) : null;
    for (const p of this.attached(shown)) {
      const k = p.kind === 'bubble' ? face : p.kind === 'cmd' ? ahead : null;
      if (k && overlaps(p.card, k)) return true;
      const edge = attachEdge(p.card, p.side);
      if (distance(this.head(live), edge) - distance(this.head(followed), edge) > far) return true;
    }
    return false;
  }
}
