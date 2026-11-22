// Where the desktop panels go so none covers her, for the panels this shell has: the bubble beside
// her head and the chip there too, the hud under her feet, the ring's row of icons under them, the command layer (ring, input, tune) beside her and
// the console under the menu bar button. Rects are in the placement space of placement.ts (y up, `screens[0]` the main one).
import type { Rect, ScreenInfo } from './placement.ts';

export type PanelKind = 'bubble' | 'chip' | 'hud' | 'ring' | 'cmd' | 'console';
export type CmdMode = 'ring' | 'input' | 'tune';
export type DockReason = 'hidden' | 'fullscreen' | 'offscreen' | 'stale' | 'noroom';
export type PanelSide = 'left' | 'right' | 'above' | 'below' | 'corner' | 'menubar' | 'status' | 'mouse';

/** Where a panel's visible card sits in its window: the transparent margin on each side. */
export interface CardInsets { left: number; right: number; top: number; bottom: number }

export const ZERO_INSETS: CardInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/** Until the page reports its card: the pages' paddings (the `.root` padding for cmd and console). */
export function fallbackInsets(kind: PanelKind): CardInsets {
  if (kind === 'ring') return ZERO_INSETS;
  // ChipRoot's `CHIP_PANEL`: its 36 px circle centred in 528 × 36, the tip's room either side.
  if (kind === 'chip') return { left: 246, right: 246, top: 0, bottom: 0 };
  if (kind === 'cmd' || kind === 'console') return { left: 16, right: 16, top: 16, bottom: 28 };
  return kind === 'bubble' ? { left: 16, right: 16, top: 22, bottom: 16 } : { left: 16, right: 16, top: 16, bottom: 16 };
}

/** The margins around `card`, a page rect with its origin top-left, in a page of `size`. */
export function insetsOf(card: Rect, size: { w: number; h: number }): CardInsets {
  return { left: card.x, right: size.w - (card.x + card.w), top: card.y, bottom: size.h - (card.y + card.h) };
}

/** The card in the window `frame`. */
export function cardIn(i: CardInsets, f: Rect): Rect {
  return { x: f.x + i.left, y: f.y + i.bottom, w: f.w - i.left - i.right, h: f.h - i.top - i.bottom };
}

/** The margin on the card's edge facing her while the panel is on her `side`. */
function near(i: CardInsets, side: PanelSide): number {
  return side === 'left' ? i.right : side === 'above' ? i.bottom : side === 'below' ? i.top : i.left;
}

/** Where the user dropped a panel beside her: its `gap` out from `side` of her keep-out, and `along` it from her head top
 *  (beside her the frame's bottom from her head top's y, above or below her its left from her head top's x). */
export interface UserOffset { side: PanelSide; gap: number; along: number }

/** The frame of `size` the offset `o` gives for the keep-out `k` and `head`. */
export function offsetFrame(o: UserOffset, size: { w: number; h: number }, k: Rect, head: Rect): Rect {
  const { w, h } = size;
  switch (o.side) {
    case 'left': return { x: k.x - o.gap - w, y: maxY(head) + o.along, w, h };
    case 'above': return { x: midX(head) + o.along, y: maxY(k) + o.gap, w, h };
    case 'below': return { x: midX(head) + o.along, y: k.y - o.gap - h, w, h };
    default: return { x: maxX(k) + o.gap, y: maxY(head) + o.along, w, h };
  }
}

/** The offset of the frame `f` the user dropped: the side of the keep-out `k` with the widest gap. */
export function userOffset(f: Rect, k: Rect, head: Rect): UserOffset {
  const gaps: [PanelSide, number][] = [['right', f.x - maxX(k)], ['left', k.x - maxX(f)], ['above', f.y - maxY(k)], ['below', k.y - maxY(f)]];
  const [side, gap] = gaps.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { side, gap, along: side === 'left' || side === 'right' ? f.y - maxY(head) : f.x - midX(head) };
}

/** `mode` is cmd's only; `statusItem`, the menu bar button's frame, the console's only. `pin` is the top-left the user pinned
 *  the panel at: it then neither follows her nor takes `userOffset`. */
export interface PanelRequest {
  kind: PanelKind; size: { w: number; h: number }; cardInsets: CardInsets; visible: boolean; mode?: CmdMode; statusItem?: Rect | null;
  userOffset?: UserOffset | null; pin?: { x: number; y: number } | null;
}

/** The side shown, the side waiting to replace it since `since`; the bubble's entry is the companion column's. `mode` is the
 *  cmd mode the sides belong to: a new mode starts without memory. */
export interface PanelMemory { side: PanelSide | null; candidate: PanelSide | null; since: number; hiddenAt: number | null; mode?: CmdMode }
export type LayoutMemory = Partial<Record<PanelKind, PanelMemory>>;

export interface LayoutInput {
  /** Her settled box; null without an avatar. */
  body: Rect | null;
  /** Her head top as a rect of no size; null means the middle of `body`'s top edge. */
  head?: Rect | null;
  screen?: number | null;
  lastScreen?: number | null;
  screens: ScreenInfo[];
  docked?: DockReason | null;
  mouse?: { x: number; y: number };
  requests: PanelRequest[];
  memory?: LayoutMemory;
  /** Seconds. */
  now?: number;
  /** Her placement's scale; her face's width in the bubble's keep-out goes with it. */
  scale?: number;
}

export interface PanelPlacement { frame: Rect; side: PanelSide; docked: DockReason | null; far: boolean }

export const EDGE = 8;
export const GAP = 8;
export const HYSTERESIS = 40;
export const FLIP_DELAY = 0.3;
export const SIDE_DELAY = 0.5;
export const SIDE_MEMORY = 600;
export const FAR_DISTANCE = 240;
export const KEEP_OUT_MARGIN = 8;
export const FACE_HALF_WIDTH = 60;
/** The height of the ring's row of icons along its panel's bottom (ring/geometry.ts `ROW_HEIGHT`). */
export const RING_ROW = 36;
/** The console page's transparent padding around its card (ConsoleRoot.module.css `.root`). */
export const CONSOLE_INSET = 16;
/** The console card's top below the menu bar. */
export const CONSOLE_DROP = 4;

const maxX = (r: Rect) => r.x + r.w;
const maxY = (r: Rect) => r.y + r.h;
const midX = (r: Rect) => r.x + r.w / 2;
const midY = (r: Rect) => r.y + r.h / 2;
export const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });
const contains = (r: Rect, x: number, y: number) => x >= r.x && x < maxX(r) && y >= r.y && y < maxY(r);

/** Rule 1: the body grown by `KEEP_OUT_MARGIN`. */
export function keepOut(body: Rect): Rect {
  return inset(body, -KEEP_OUT_MARGIN);
}

/** `kind`'s keep-out: the bubble's and the chip's is her face, `FACE_HALF_WIDTH` × `scale` either side of her head top over the body's. */
export function keepOutOf(kind: PanelKind, body: Rect, head: Rect, scale: number): Rect {
  const k = keepOut(body);
  if (kind !== 'bubble' && kind !== 'chip') return k;
  const a = FACE_HALF_WIDTH * scale;
  return { x: midX(head) - a, y: k.y, w: 2 * a, h: k.h };
}

/** True when the two rects share a positive area; touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
  return Math.min(maxX(a), maxX(b)) - Math.max(a.x, b.x) > 0.001 && Math.min(maxY(a), maxY(b)) - Math.max(a.y, b.y) > 0.001;
}

export function inside(f: Rect, v: Rect): boolean {
  return f.x >= v.x - 0.001 && maxX(f) <= maxX(v) + 0.001 && f.y >= v.y - 0.001 && maxY(f) <= maxY(v) + 0.001;
}

/** Rule 2: her head top's screen, else the tracker's, else the previous one, else the mouse's, else the first. */
export function layoutScreen(input: LayoutInput, head: Rect | null): ScreenInfo | null {
  const s = input.screens;
  if (head) {
    const hit = s.find((x) => contains(x.frame, midX(head), midY(head)));
    if (hit) return hit;
  }
  for (const id of [input.screen, input.lastScreen]) {
    const hit = id == null ? undefined : s.find((x) => x.id === id);
    if (hit) return hit;
  }
  const m = input.mouse ?? { x: 0, y: 0 };
  return s.find((x) => contains(x.frame, m.x, m.y)) ?? s[0] ?? null;
}

const KINDS: PanelKind[] = ['bubble', 'chip', 'hud', 'ring', 'cmd', 'console'];

/** A side and its frame with `slack` more room; null when it has not. */
interface Candidate { side: PanelSide; frame: (slack: number) => Rect | null }

export function place(input: LayoutInput): { placements: Partial<Record<PanelKind, PanelPlacement>>; memory: LayoutMemory } {
  const head = input.head ?? (input.body ? { x: midX(input.body), y: maxY(input.body), w: 0, h: 0 } : null);
  const memory: LayoutMemory = { ...input.memory };
  const screen = layoutScreen(input, head);
  if (!screen) return { placements: {}, memory };
  const now = input.now ?? 0;
  const column = memory.bubble;
  if (column) {
    if (!input.requests.some((r) => r.visible && (r.kind === 'bubble' || r.kind === 'chip'))) memory.bubble = { ...column, hiddenAt: column.hiddenAt ?? now };
    else if (column.hiddenAt !== null && now - column.hiddenAt >= SIDE_MEMORY) delete memory.bubble;
    else memory.bubble = { ...column, hiddenAt: null };
  }
  const pass = new Pass(input, head, screen, memory);
  for (const kind of KINDS) {
    const request = input.requests.find((r) => r.kind === kind);
    // The ring only shows around her.
    if (!request?.visible || (kind === 'ring' && pass.docked !== null)) {
      if (kind !== 'bubble') delete pass.memory[kind];
      continue;
    }
    pass.out[kind] = pass.place(request);
    if (kind === 'hud') pass.liftBubble();
  }
  return { placements: pass.out, memory: pass.memory };
}

class Pass {
  readonly input: LayoutInput;
  readonly head: Rect | null;
  memory: LayoutMemory;
  readonly screen: ScreenInfo;
  readonly v: Rect;
  readonly docked: DockReason | null;
  readonly out: Partial<Record<PanelKind, PanelPlacement>> = {};

  constructor(input: LayoutInput, head: Rect | null, screen: ScreenInfo, memory: LayoutMemory) {
    this.input = input;
    this.head = head;
    this.memory = memory;
    this.screen = screen;
    this.v = inset(screen.visibleFrame, EDGE);
    this.docked = input.docked ?? (input.body === null ? 'hidden' : null);
  }

  place(r: PanelRequest): PanelPlacement {
    if (r.kind === 'console') return this.console(r);
    const head = this.head, body = this.input.body;
    if (this.docked !== null || !head || !body) {
      if (r.kind === 'bubble') {
        if (this.memory.bubble) this.memory.bubble = { ...this.memory.bubble, candidate: null };
      } else delete this.memory[r.kind];
      return this.dockedPlacement(r, this.docked ?? 'hidden');
    }
    const k = keepOutOf(r.kind, body, head, this.input.scale ?? 1);
    if (r.pin) {
      const f = { x: r.pin.x, y: r.pin.y - r.size.h, w: r.size.w, h: r.size.h };
      return { frame: f, side: Pass.sideOf(cardIn(r.cardInsets, f), k), docked: null, far: true };
    }
    const dragged = r.userOffset ? this.dragged(r, r.userOffset, k, head) : null;
    if (dragged) {
      const side = Pass.sideOf(cardIn(r.cardInsets, dragged), k);
      this.memory[r.kind] = { side, candidate: null, since: 0, hiddenAt: null, ...(r.kind === 'cmd' ? { mode: r.mode ?? 'input' } : {}) };
      return this.placed(dragged, side, r);
    }
    if (r.kind === 'hud') return this.hud(r, head, body);
    if (r.kind === 'ring') return this.placed(this.ringFrame(r, head, body), 'below', r);
    if (r.kind === 'bubble' || r.kind === 'chip') return this.column(r, k, (s) => Pass.beside(s, r.size, r.cardInsets, k, this.v, maxY(head), midX(head), 0));
    const v = this.v;
    const roomier: PanelSide = maxX(v) - maxX(k) >= k.x - v.x ? 'right' : 'left';
    const other: PanelSide = roomier === 'left' ? 'right' : 'left';
    const beside = (s: PanelSide, top = maxY(head)): Candidate =>
      ({ side: s, frame: (slack) => Pass.beside(s, r.size, r.cardInsets, k, v, top, s === 'below' ? midX(body) : midX(head), slack) });
    const mode = r.mode ?? 'input';
    let candidates: Candidate[];
    if (mode === 'ring') {
      const top = midY(body) + (r.size.h - r.cardInsets.top - r.cardInsets.bottom) / 2;
      candidates = [beside(roomier, top), beside(other, top)];
    } else if (mode === 'tune') candidates = [beside('above'), beside(roomier), beside(other)];
    else candidates = [beside('below'), beside(roomier), beside('above')];
    const others = [this.out.bubble?.frame, this.out.hud?.frame].filter((x): x is Rect => !!x);
    const clear = candidates.map((c): Candidate => ({ side: c.side, frame: (slack) => {
      const f = c.frame(slack);
      return f && others.some((o) => overlaps(f, o)) ? null : f;
    } }));
    if (clear.some((c) => c.frame(0) !== null)) candidates = clear;
    return this.choose(r, mode, candidates);
  }

  /** Rule 6: a side other than the current one must fit with `HYSTERESIS` to spare, and wins only after it has been wanted
   *  for `FLIP_DELAY`; a current side that no longer fits at all is left at once. */
  choose(r: PanelRequest, mode: CmdMode, candidates: Candidate[]): PanelPlacement {
    const now = this.input.now ?? 0;
    const remembered = this.memory[r.kind];
    let mem: PanelMemory = remembered && remembered.mode === mode ? remembered : { side: null, candidate: null, since: 0, hiddenAt: null, mode };
    const current = mem.side;
    let wanted: PanelPlacement | null = null;
    for (const c of candidates) {
      const f = c.frame(current === null || c.side === current ? 0 : HYSTERESIS);
      if (f) {
        wanted = this.placed(f, c.side, r);
        break;
      }
    }
    if (!wanted) {
      for (const c of candidates) {
        const f = c.frame(0);
        if (f) {
          wanted = this.placed(f, c.side, r);
          break;
        }
      }
    }
    const target = wanted ?? this.noRoom(r);
    let held: PanelPlacement | null = null;
    const c = current === null ? undefined : candidates.find((x) => x.side === current);
    if (c) {
      const f = c.frame(0);
      held = f && this.placed(f, current!, r);
    } else if (current === 'corner') held = this.noRoom(r);
    if (held && held.side !== target.side) {
      if (mem.candidate !== target.side) mem = { ...mem, candidate: target.side, since: now };
      if (now - mem.since < FLIP_DELAY) {
        this.memory[r.kind] = mem;
        return held;
      }
    }
    this.memory[r.kind] = { side: target.side, candidate: null, since: 0, hiddenAt: null, mode };
    return target;
  }

  /** Rule 6 for the companion column, the bubble and the chip beside her head: first the side with more room; then that side while it
   *  fits with `GAP` to spare. One that does not gives way to a side with `HYSTERESIS` more room once that side has been
   *  wanted for `SIDE_DELAY`, or at once when it cannot hold the panel at all. Above or below her only when neither does. */
  column(r: PanelRequest, k: Rect, frame: (s: PanelSide) => Rect | null): PanelPlacement {
    const now = this.input.now ?? 0, v = this.v;
    const reach = (s: PanelSide) => GAP + r.size.w - near(r.cardInsets, s);
    const room: Record<string, number> = { left: k.x - v.x, right: maxX(v) - maxX(k) };
    const fits = (s: PanelSide) => room[s]! >= reach(s) + GAP;
    const roomier: PanelSide = room.right! >= room.left! ? 'right' : 'left';
    const other: PanelSide = roomier === 'left' ? 'right' : 'left';
    let mem: PanelMemory = this.memory.bubble ?? { side: null, candidate: null, since: 0, hiddenAt: null };
    let order: PanelSide[];
    const s = mem.side;
    if (s === 'left' || s === 'right') {
      const o: PanelSide = s === 'left' ? 'right' : 'left';
      if (fits(s)) {
        mem = { ...mem, candidate: null };
      } else if (fits(o) && room[o]! >= room[s]! + HYSTERESIS && frame(o) !== null) {
        if (mem.candidate !== o) mem = { ...mem, candidate: o, since: now };
        const held = frame(s);
        if (now - mem.since < SIDE_DELAY && room[s]! >= reach(s) && held) {
          this.memory.bubble = mem;
          return this.placed(held, s, r);
        }
      } else {
        mem = { ...mem, candidate: null };
      }
      order = mem.candidate === o ? [o, s] : [s, o];
    } else if (s === null) {
      order = [roomier, other];
    } else {
      order = [...[roomier, other].filter(fits), s, roomier, other];
    }
    for (const side of [...order, 'above', 'below'] as PanelSide[]) {
      const f = frame(side);
      if (!f) continue;
      if (side !== mem.side) mem = { side, candidate: null, since: 0, hiddenAt: mem.hiddenAt };
      this.memory.bubble = mem;
      return this.placed(f, side, r);
    }
    this.memory.bubble = { side: 'corner', candidate: null, since: 0, hiddenAt: null };
    return this.noRoom(r);
  }

  /** The hud's card centred under her `body`, its top `GAP` below her feet, or below the ring's row while the ring shows;
   *  without the room there its frame sits on the screen's bottom, over her shins, and grows up. Kept on screen, not out of
   *  her keep-out. */
  hud(r: PanelRequest, head: Rect, body: Rect): PanelPlacement {
    const w = r.size.w, h = r.size.h, i = r.cardInsets, v = this.v;
    const ring = this.input.requests.find((x) => x.kind === 'ring' && x.visible);
    const top = ring ? this.ringFrame(ring, head, body).y : body.y;
    const x = Math.min(Math.max(midX(body) - (w - i.left - i.right) / 2 - i.left, v.x), maxX(v) - w);
    const y = Math.min(Math.max(top - GAP + i.top - h, v.y), maxY(v) - h);
    return this.placed({ x, y, w, h }, 'below', r);
  }

  /** The ring's frame: its row of icons along the bottom, `RING_ROW` high, centred on her feet (her head top's x on her
   *  body's bottom) with its top `GAP` below them. Kept on screen: at the bottom it sits over her shoes, at a side it
   *  slides along. Not kept out of her keep-out. */
  ringFrame(r: PanelRequest, head: Rect, body: Rect): Rect {
    const w = r.size.w, h = r.size.h, v = this.v;
    const x = Math.min(Math.max(midX(head) - w / 2, v.x), maxX(v) - w);
    const y = Math.min(Math.max(body.y - GAP - RING_ROW, v.y), maxY(v) - h);
    return { x, y, w, h };
  }

  /** The card of a bubble beside her meeting the hud's moves up to `GAP` above it, kept on screen; a pinned bubble stays. */
  liftBubble(): void {
    const b = this.out.bubble, h = this.out.hud;
    const r = this.input.requests.find((x) => x.kind === 'bubble');
    if (!b || (b.side !== 'left' && b.side !== 'right') || !h || h.docked !== null || !r || r.pin) return;
    const hud = cardIn(this.input.requests.find((x) => x.kind === 'hud')?.cardInsets ?? ZERO_INSETS, h.frame);
    if (!overlaps(cardIn(r.cardInsets, b.frame), hud)) return;
    const y = Math.min(maxY(hud) + GAP - r.cardInsets.bottom, maxY(this.v) - b.frame.h);
    this.out.bubble = this.placed({ ...b.frame, y }, b.side, r);
  }

  /** Rule 7: the offset's frame kept on screen; null when its card lands in the keep-out, so the panel takes its default slot. */
  dragged(r: PanelRequest, o: UserOffset, k: Rect, head: Rect): Rect | null {
    const f = offsetFrame(o, r.size, k, head), v = this.v;
    const c = { ...f, x: Math.min(Math.max(f.x, v.x), maxX(v) - f.w), y: Math.min(Math.max(f.y, v.y), maxY(v) - f.h) };
    return inside(c, v) && !overlaps(cardIn(r.cardInsets, c), k) ? c : null;
  }

  /** The side of the keep-out `k` the card `f` stands on. */
  static sideOf(f: Rect, k: Rect): PanelSide {
    if (f.x >= maxX(k) - 0.001) return 'right';
    if (maxX(f) <= k.x + 0.001) return 'left';
    return f.y >= maxY(k) - 0.001 ? 'above' : 'below';
  }

  /** Rule 5: on the menu bar button's screen, the card inside the page's inset hangs `CONSOLE_DROP` below the menu bar with
   *  its right edge on the button's, kept on screen; it stays there even over her. */
  console(r: PanelRequest): PanelPlacement {
    this.memory.console = { side: 'status', candidate: null, since: 0, hiddenAt: null };
    return this.placed(this.consoleFrame(r), 'status', r);
  }

  consoleFrame(r: PanelRequest): Rect {
    const item = r.statusItem ?? null;
    const s = (item && this.input.screens.find((x) => contains(x.frame, midX(item), midY(item)))) || this.screen;
    const v = inset(s.visibleFrame, EDGE);
    const { w, h } = r.size, cardWidth = w - 2 * CONSOLE_INSET;
    const cardX = Math.max(Math.min(item ? maxX(item) : maxX(v), maxX(v)) - cardWidth, v.x);
    // A button in a taskbar at the bottom (Windows) has the card stand on the taskbar instead.
    if (item && midY(item) < midY(s.frame)) {
      return { x: cardX - CONSOLE_INSET, y: Math.max(maxY(item), s.visibleFrame.y) + CONSOLE_DROP - CONSOLE_INSET, w, h };
    }
    const top = (item ? item.y : maxY(s.visibleFrame)) - CONSOLE_DROP;
    return { x: cardX - CONSOLE_INSET, y: top + CONSOLE_INSET - h, w, h };
  }

  /** Rules 3–5 when docked: the bubble becomes the subtitle bar when she is hidden or fullscreen, and the chip goes there
   *  too, else either goes to a corner;
   *  the hud goes to a corner; ring, input and tune open on the mouse's screen. */
  dockedPlacement(r: PanelRequest, reason: DockReason): PanelPlacement {
    const w = r.size.w, h = r.size.h, v = this.v;
    if ((r.kind === 'bubble' || r.kind === 'chip') && (reason === 'hidden' || reason === 'fullscreen')) {
      return { frame: { x: midX(v) - w / 2, y: maxY(v) - h, w, h }, side: 'menubar', docked: reason, far: false };
    }
    if (r.kind === 'cmd') {
      const m = this.input.mouse ?? { x: 0, y: 0 };
      const s = (this.input.screens.find((x) => contains(x.frame, m.x, m.y)) ?? this.input.screens[0]!).visibleFrame;
      const y = (r.mode ?? 'input') === 'input' ? s.y + s.h * 0.25 : midY(s) - h / 2;
      return { frame: { x: midX(s) - w / 2, y, w, h }, side: 'mouse', docked: reason, far: false };
    }
    return { frame: this.corner(r.size), side: 'corner', docked: reason, far: false };
  }

  noRoom(r: PanelRequest): PanelPlacement {
    return { frame: this.corner(r.size), side: 'corner', docked: 'noroom', far: false };
  }

  /** Top-right, else top-left, else bottom-right: the first that keeps clear of her, of the bubble and hud placed so far, and of
   *  an open console. */
  corner(size: { w: number; h: number }): Rect {
    const { w, h } = size, v = this.v;
    const tr = { x: maxX(v) - w, y: maxY(v) - h, w, h }, tl = { x: v.x, y: maxY(v) - h, w, h }, br = { x: maxX(v) - w, y: v.y, w, h };
    const console = this.input.requests.find((x) => x.kind === 'console' && x.visible);
    const avoid = [this.input.body && keepOut(this.input.body), this.out.bubble?.frame, this.out.hud?.frame, console && this.consoleFrame(console)]
      .filter((x): x is Rect => !!x);
    return [tr, tl].find((f) => !avoid.some((a) => overlaps(f, a))) ?? br;
  }

  placed(f: Rect, side: PanelSide, r: PanelRequest): PanelPlacement {
    const head = this.head;
    const far = head ? Pass.distance(midX(head), midY(head), cardIn(r.cardInsets, f)) > FAR_DISTANCE : false;
    return { frame: f, side, docked: null, far };
  }

  /** A frame of `size` whose card stands `GAP` out from one side of the keep-out `k`: beside it with the card's top at
   *  `top`, or above / below it with the card centred on `mx`; the free axis is clamped into `v`. Null unless the side has
   *  the frame's room plus `slack`. */
  static beside(side: PanelSide, size: { w: number; h: number }, i: CardInsets, k: Rect, v: Rect, top: number, mx: number,
    slack: number): Rect | null {
    const { w, h } = size, g = GAP;
    if (w > v.w || h > v.h) return null;
    const y = Math.min(Math.max(top + i.top - h, v.y), maxY(v) - h);
    const x = Math.min(Math.max(mx - (w - i.left - i.right) / 2 - i.left, v.x), maxX(v) - w);
    switch (side) {
      case 'right': {
        const rx = maxX(k) + g - i.left;
        return maxX(v) - rx >= w + slack ? { x: rx, y, w, h } : null;
      }
      case 'left': {
        const lx = k.x - g + i.right - w;
        return lx - v.x >= slack ? { x: lx, y, w, h } : null;
      }
      case 'above': {
        const ay = maxY(k) + g - i.bottom;
        return maxY(v) - ay >= h + slack ? { x, y: ay, w, h } : null;
      }
      case 'below': {
        const by = k.y - g + i.top - h;
        return by - v.y >= slack ? { x, y: by, w, h } : null;
      }
      default:
        return null;
    }
  }

  static distance(px: number, py: number, f: Rect): number {
    const dx = Math.max(f.x - px, 0, px - maxX(f)), dy = Math.max(f.y - py, 0, py - maxY(f));
    return Math.sqrt(dx * dx + dy * dy);
  }
}

/** protocol.ts `AnchorState`. */
export type FollowState = 'settled' | 'moving' | 'glide' | 'frozen' | 'dragging' | 'docked';

/** protocol.ts `DesktopAnchor`. */
export interface AnchorPayload {
  panel: PanelKind; state: FollowState; side: PanelSide; docked: DockReason | null; far: boolean;
  toHead: { dx: number; dy: number } | null; room: { width: number; height: number };
}

/** `toHead` runs from the panel's centre to her head in page pixels, y down; `room` is the
 *  visible frame of the panel's screen less the layout's edge. */
export function anchorPayload(kind: PanelKind, p: PanelPlacement, state: FollowState, head: Rect | null,
  screens: ScreenInfo[]): AnchorPayload {
  const f = p.frame;
  const screen = screens.find((s) => contains(s.frame, midX(f), midY(f))) ?? screens[0];
  const v = screen ? inset(screen.visibleFrame, EDGE) : null;
  const toHead = head ? { dx: Math.round(midX(head) - midX(f)), dy: Math.round(midY(f) - midY(head)) } : null;
  return { panel: kind, state, side: p.side, docked: p.docked, far: p.far, toHead, room: { width: v?.w ?? 0, height: v?.h ?? 0 } };
}
