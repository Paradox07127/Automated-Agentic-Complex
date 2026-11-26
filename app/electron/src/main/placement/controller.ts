// Where the avatar stands on the desktop: it follows the renderer's reports
// over C3, remembers them in the support dir's files, sends `move_window` and `set_placement`, and gives the launch its
// `--agentic-complex-placement`. Platform-free: the displays and C3's coordinates come through `space`.
import { type ResizeStart, resizeStart } from '../../common/avatar-resize.ts';
import type { C3Message } from '../../common/c3.ts';
import { currentScreen } from '../../common/current-screen.ts';
import { type Capsule, capsuleHit } from '../../common/desktop-hover.ts';
import { capsuleBounds, KeepClearState, type KeepClearRect } from '../../common/keepclear.ts';
import {
  type AvatarPlacement, defaultAnchor, defaultOrigin, launchDisplay, MAX_COORDINATE, placementArgument, readPlacement, type Rect,
  type ScreenInfo, windowTarget,
} from '../../common/placement.ts';
import type { PlacementSpace } from '../platform/screens.ts';
import type { LinkEvent } from '../renderer/link.ts';
import { PlacementFiles, readPlacements, readState } from './store.ts';

/** What the placement needs of the host link. */
export interface PlacementLink {
  readonly capabilities: string[];
  readonly currentCharacter: string | null;
  readonly hidden: boolean;
  on(listener: (e: LinkEvent) => void): () => void;
  send(m: C3Message): boolean;
  sendMoveWindow(x: number, y: number): boolean;
  sendSetPlacement(p: { x?: number; y?: number; scale?: number }): boolean;
}

export interface PlacerOptions {
  link: PlacementLink;
  supportDir: string;
  space: PlacementSpace;
  /** config.json `stay_mode` is `stay` or `bust`: she gives way to nothing. */
  stayInPlace(): boolean;
  /** Seconds since the user last pressed a key. */
  keyIdle(): number;
  /** The main window's frame in the placement space while it is on screen; null otherwise. */
  mainWindow(): Rect | null;
  /** The user's screen targets in the placement space, read with the main window's. */
  keepClearSources?(): KeepClearRect[];
  log(line: string): void;
  /** Seconds; tests drive it. */
  clock?(): number;
}

/** HostLink's tick, which runs the keep-clear check. */
const TICK = 0.1;
/** Seconds between reads of the keep-clear sources. */
const SOURCES_READ = 0.25;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class AvatarPlacer {
  private readonly o: PlacerOptions;
  private readonly files: PlacementFiles;
  private readonly clock: () => number;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The connection's latest `window_frame`, in the placement space, and its viewport; null before one. */
  private frame: Rect | null = null;
  private c3Frame: Rect | null = null;
  private viewport: 'window' | 'fullscreen' | null = null;
  private dragging = false;
  private placement: AvatarPlacement | null = null;
  private body: Rect | null = null;
  /** When `body` came (`clock`), and the host's `visual` rect sent with it in the global space. */
  private bodyAt: number | null = null;
  private visual: Rect | null = null;
  /** `body`'s capsules in the placement space, for the pointer's hit. */
  private capsules: Capsule[] = [];
  private keepClear = new KeepClearState();
  /** The keep-clear sources as last read, and when. */
  private sources: KeepClearRect[] = [];
  private sourcesAt = -Infinity;
  /** The first `window_frame` after a hello places the window. */
  private needsPlacement = false;
  /** The size slider's last value, or the reported scale. */
  private scaleSetting: number | null = null;
  private keepClearOfMainOn = false;

  constructor(options: PlacerOptions) {
    this.o = options;
    this.files = new PlacementFiles(options.supportDir);
    this.clock = options.clock ?? (() => performance.now() / 1000);
  }

  start(): void {
    this.unsubscribe ??= this.o.link.on((e) => this.event(e));
    this.timer ??= setInterval(() => this.tick(), TICK * 1000);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The value of `--agentic-complex-placement` for a fullscreen launch: the character's placement on its launch display. */
  launchPlacement(character: string): string | null {
    const screens = this.o.space.screens();
    if (screens.length === 0) return null;
    const display = launchDisplay(readState(this.o.supportDir), character, screens.map((s) => s.id), screens[0]!.id);
    const p = readPlacements(this.o.supportDir)[character]?.[String(display)];
    if (p === undefined) return null;
    const anchor = this.o.space.pointToC3({ x: p.x, y: p.y });
    return placementArgument({ ...anchor, scale: p.scale });
  }

  /** `avatar.setScale`: sends when the value differs from the last one known. */
  setScale(scale: number): void {
    if (scale === this.scaleSetting) return;
    const known = this.scaleSetting !== null;
    this.scaleSetting = scale;
    if (known) this.o.link.sendSetPlacement({ scale });
  }

  /** 调整大小's start; null before a `window_frame`. */
  resizeStart(): ResizeStart | null {
    return resizeStart(this.viewport === 'fullscreen', this.placement, this.frame, this.o.space.screens());
  }

  /** She follows the resize frame, its rollback on Esc too. */
  resizePreview(scale: number, preview: Rect): void {
    this.applyResize(scale, preview);
  }

  /** 完成: she ends where the preview was; a window remembers it. */
  resizeCommit(scale: number, preview: Rect): void {
    this.applyResize(scale, preview);
    if (this.viewport !== 'fullscreen') this.recordPosition(preview);
  }

  private applyResize(scale: number, preview: Rect): void {
    if (this.viewport === 'fullscreen') {
      // The fullscreen anchor is the bottom centre.
      const c3 = this.o.space.pointToC3({ x: preview.x + preview.w / 2, y: preview.y });
      this.o.link.sendSetPlacement({ x: c3.x, y: c3.y, scale });
      return;
    }
    // The window viewport takes scale alone and keeps the window's bottom centre, so the window first moves
    // its bottom centre onto the preview's.
    const frame = this.frame;
    if (frame) this.moveWindow({ x: preview.x + preview.w / 2 - frame.w / 2, y: preview.y }, frame);
    this.o.link.sendSetPlacement({ scale });
  }

  /** 放回默认位置: the anchor's screen's default anchor (fullscreen), or the default window position, remembered. */
  resetPosition(): void {
    const screens = this.o.space.screens();
    if (this.viewport === 'fullscreen') {
      const anchored = this.placement && screens.find((s) => s.id === this.placement!.displayId);
      const screen = anchored ?? screens[0];
      if (screen) this.setAnchor(defaultAnchor(screen.visibleFrame));
      return;
    }
    this.moveToDefault(screens);
  }

  /** 放到这块屏: the default position on screen `id`; false when there is no such screen. */
  placeOnScreen(id: number): boolean {
    const screen = this.o.space.screens().find((s) => s.id === id);
    if (!screen) {
      this.o.log(`place on screen: no screen ${id}`);
      return false;
    }
    if (this.viewport === 'fullscreen') this.setAnchor(defaultAnchor(screen.visibleFrame));
    else this.moveToDefault([screen]);
    return true;
  }

  /** `avatar.keepClearOfMain`: while on, the main window is a `dialog` she walks clear of. */
  keepClearOfMain(on: boolean): void {
    this.keepClearOfMainOn = on;
  }

  /** Displays came, went or changed size: the window goes back to its place for the display it is on. */
  screensChanged(): void {
    this.placeWindow();
  }

  private setAnchor(p: { x: number; y: number }): void {
    const c3 = this.o.space.pointToC3(p);
    this.o.link.sendSetPlacement({ x: c3.x, y: c3.y });
  }

  private moveToDefault(screens: ScreenInfo[]): void {
    const frame = this.frame;
    const origin = frame && defaultOrigin(frame, screens);
    if (!frame || !origin || !this.moveWindow(origin, frame)) return;
    this.recordPosition({ ...origin, w: frame.w, h: frame.h });
  }

  private moveWindow(origin: { x: number; y: number }, size: Rect): boolean {
    const c3 = this.o.space.rectToC3({ ...origin, w: size.w, h: size.h });
    return this.o.link.sendMoveWindow(c3.x, c3.y);
  }

  /** The remembered or default position and display for the window viewport. */
  private placeWindow(): void {
    const frame = this.frame, character = this.o.link.currentCharacter;
    if (!frame || character === null) return;
    this.needsPlacement = false;
    if (this.viewport === 'fullscreen') return;
    const origin = windowTarget(this.files.positions, character, frame, this.o.space.screens());
    if (origin) this.moveWindow(origin, frame);
  }

  private recordPosition(frame: Rect): void {
    const character = this.o.link.currentCharacter;
    if (character !== null) this.files.recordPosition(character, frame, this.o.space.screens());
  }

  private reset(): void {
    this.frame = this.c3Frame = this.placement = this.body = this.visual = this.viewport = null;
    this.bodyAt = null;
    this.capsules = [];
    this.dragging = false;
    this.keepClear = new KeepClearState();
    this.sources = [];
    this.sourcesAt = -Infinity;
  }

  private event(e: LinkEvent): void {
    if (e.kind === 'hello') {
      this.reset();
      this.needsPlacement = true;
    } else if (e.kind === 'lost') {
      this.reset();
    } else if (e.kind === 'message') {
      this.message(e.message);
    }
  }

  private message(m: C3Message): void {
    switch (m.type) {
      case 'window_frame': {
        const f = m.frame as Record<string, unknown> | undefined;
        if (typeof f !== 'object' || f === null || ![f.x, f.y, f.w, f.h].every(finite)) return;
        if ([f.x, f.y, f.w, f.h].some((v) => Math.abs(v as number) > MAX_COORDINATE)) return;
        this.c3Frame = { x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number };
        this.frame = this.o.space.rectFromC3(this.c3Frame);
        this.viewport = m.viewport === 'window' || m.viewport === 'fullscreen' ? m.viewport : null;
        if (!this.dragging && this.needsPlacement) this.placeWindow();
        break;
      }
      case 'drag':
        if (m.phase === 'begin') this.dragging = true;
        if (m.phase !== 'end') break;
        this.dragging = false;
        // The last `window_frame` of a drag arrives before its `end`. A fullscreen drag leaves the window in place.
        if (this.frame && this.viewport !== 'fullscreen') this.recordPosition(this.frame);
        break;
      case 'placement': {
        const p = readPlacement(m);
        if ('rejected' in p) return;
        const anchor = this.o.space.pointFromC3(p);
        this.placement = { ...p, ...anchor };
        // The size slider shows this scale, so saving it again sends nothing.
        this.scaleSetting = p.scale;
        const character = this.o.link.currentCharacter;
        if (character !== null) this.files.recordReported(this.placement, this.viewport, character);
        break;
      }
      case 'character_changed':
        this.placeWindow();
        break;
      case 'hit_capsules': {
        if (!Array.isArray(m.capsules)) return;
        const box = capsuleBounds(m.capsules);
        if (box === null) this.body = null;
        else if (m.space === 'global') this.body = this.o.space.rectFromC3(box);
        else this.body = this.c3Frame && this.o.space.rectFromC3({ ...box, x: box.x + this.c3Frame.x, y: box.y + this.c3Frame.y });
        this.capsules = this.body === null ? [] : this.placedCapsules(m.capsules, m.space === 'global' ? { x: 0, y: 0 } : this.c3Frame!);
        this.bodyAt = this.clock();
        this.visual = null;
        const v = m.visual;
        if (m.space === 'global' && Array.isArray(v) && v.length === 4 && v.every(finite) && v[2] > 0 && v[3] > 0
          && v.every((n) => Math.abs(n as number) <= MAX_COORDINATE)) {
          this.visual = this.o.space.rectFromC3({ x: v[0], y: v[1], w: v[2], h: v[3] });
        }
        break;
      }
    }
  }

  /** Each capsule's ends as discs of its radius, moved by `origin` and taken into the placement space. */
  private placedCapsules(capsules: unknown[], origin: { x: number; y: number }): Capsule[] {
    const out: Capsule[] = [];
    for (const c of capsules as Record<string, unknown>[]) {
      const a = c?.a, b = c?.b, r = c?.r;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2 || !finite(r) || ![...a, ...b].every(finite)) continue;
      const disc = (x: number, y: number) => {
        const q = this.o.space.rectFromC3({ x: x + origin.x - r, y: y + origin.y - r, w: 2 * r, h: 2 * r });
        return { x: q.x + q.w / 2, y: q.y + q.h / 2, r: q.w / 2 };
      };
      const ea = disc(a[0], a[1]), eb = disc(b[0], b[1]);
      out.push({ a: ea, b: eb, r: ea.r });
    }
    return out;
  }

  /** HostLink.avatarHovered's inputs at `mouse` (placement space): the capsule hit, their age on `clock`, and the drag. */
  hoverSample(mouse: { x: number; y: number }, grow = 0): { hit: boolean; age: number | null; dragging: boolean } {
    return { hit: capsuleHit(mouse, this.capsules, grow), age: this.bodyAt === null ? null : this.clock() - this.bodyAt, dragging: this.dragging };
  }

  /** The id of the screen she stands on; null when unknown. */
  currentScreen(): string | null {
    return currentScreen(this.viewport, this.placement?.displayId ?? null, this.frame, this.o.space.screens());
  }

  /** HostLink.avatarBodySample with her last placement and whether she is dragged, on `clock`, for the desktop panels. */
  anchorSample(): { now: number; body: Rect | null; bodyAt: number | null; visual: Rect | null; placement: AvatarPlacement | null;
    dragging: boolean } {
    return { now: this.clock(), body: this.body, bodyAt: this.body && this.bodyAt, visual: this.visual, placement: this.placement,
      dragging: this.dragging };
  }

  /** Use screen targets and the main window as keep-clear areas. */
  tick(): void {
    const link = this.o.link;
    if (!link.capabilities.includes('keep_clear')) return;
    const now = this.clock();
    // Give-way only acts in the fullscreen viewport.
    const blocked = this.dragging || link.hidden || this.viewport !== 'fullscreen' || this.o.stayInPlace();
    if (!blocked && now - this.sourcesAt >= SOURCES_READ) {
      this.sourcesAt = now;
      const main = this.keepClearOfMainOn ? this.o.mainWindow() : null;
      this.sources = [...this.o.keepClearSources?.() ?? [], ...(main ? [{ kind: 'dialog' as const, frame: main }] : [])];
    }
    const out = this.keepClear.update(this.sources, this.body, this.o.keyIdle(), blocked, now);
    if (out === null) return;
    if (out === 'drop') {
      link.send({ v: 1, type: 'keep_clear', id: null });
      return;
    }
    this.o.log(`keep_clear id=${out.send.id} kind=${out.send.kind} rects=${out.send.rects.length}`);
    link.send({ v: 1, type: 'keep_clear', id: out.send.id, kind: out.send.kind, rects: out.send.rects.map((r) => this.o.space.rectToC3(r)) });
  }
}
