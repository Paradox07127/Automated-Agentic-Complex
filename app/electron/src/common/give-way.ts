// Giving way to the user over the platform helper's readings: the screen targets she walks clear of and
// hiding her in fullscreen. The front window covering her is src/common/surfaces.ts's. Helper rects come in its
// coordinates (the main display's top left, y down) and leave in C3 global points through a `HelperY`.
// The helper already applies ScreenTargets.isEditable, caretRect, dialogButtons, bannerRects and imeRects (AX.swift AXRules).
import { appKitY, type AttentionSample, decodeRect, type HelperY, type Rect as HelperRect, type ReflexState } from './attention.ts';
import type { KeepClearRect } from './keepclear.ts';
import type { Rect } from './placement.ts';

/** Seconds between reads; a focused field larger than `fieldMax` is a document view, of
 *  which only the caret counts; the points the caret grows by on each side. */
export const FEED = { interval: 0.5, fieldMax: { w: 800, h: 160 }, caretGrow: { w: 60, h: 8 } } as const;

/** `mainHeight` is the main display's height. */
export function fromHelper(r: HelperRect, mainHeight: number, y: HelperY = appKitY): Rect {
  return { x: r.x, y: y(r.y, r.height, mainHeight), w: r.width, h: r.height };
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The helper's `focus`, as far as the feed reads it. */
export interface Focus { pid: number; frame: HelperRect; caret: HelperRect | null; editable: boolean }

/** `ax.focused`'s `focus`; null when it is null or malformed. */
export function decodeFocus(v: unknown): Focus | null {
  const o = obj(v);
  const frame = o && decodeRect(o.frame);
  if (!o || !frame || num(o.pid) === null) return null;
  return { pid: o.pid as number, frame, caret: decodeRect(o.caret), editable: o.editable === true };
}

/** A `rect` array such as `ax.overlays`' `banners`; malformed items are left out. */
export function decodeRects(v: unknown): HelperRect[] {
  return Array.isArray(v) ? v.map(decodeRect).filter((x): x is HelperRect => x !== null) : [];
}

/** Her own windows never take the focus. */
export function othersFocus(focus: Focus | null, ownPids: readonly number[]): Focus | null {
  return focus && !ownPids.includes(focus.pid) ? focus : null;
}

/** One read: `buttons` is `ax.dialog_buttons` of the focus's app, `reflex` AttentionSampler.reflex (C3 global points). */
export interface FeedReading { focus: Focus | null; buttons: HelperRect[]; banners: HelperRect[]; ime: HelperRect[]; reflex: ReflexState | null }

/** In C3 global points. */
export function feedRects(r: FeedReading, mainHeight: number, y: HelperY = appKitY): KeepClearRect[] {
  const out: KeepClearRect[] = [];
  const at = (b: HelperRect) => fromHelper(b, mainHeight, y);
  const f = r.focus;
  if (f?.editable) {
    if (f.frame.width <= FEED.fieldMax.w && f.frame.height <= FEED.fieldMax.h) out.push({ kind: 'text_input', frame: at(f.frame) });
    if (f.caret) {
      const c = at(f.caret), g = FEED.caretGrow;
      out.push({ kind: 'caret', frame: { x: c.x - g.w, y: c.y - g.h, w: c.w + 2 * g.w, h: c.h + 2 * g.h } });
    }
  }
  out.push(...r.buttons.map((b): KeepClearRect => ({ kind: 'dialog', frame: at(b) })));
  out.push(...r.banners.map((b): KeepClearRect => ({ kind: 'banner', frame: at(b) })));
  out.push(...r.ime.map((b): KeepClearRect => ({ kind: 'ime', frame: at(b) })));
  const x = r.reflex;
  if (x) out.push({ kind: x.kind, frame: { x: x.rect.x, y: x.rect.y, w: x.rect.width, h: x.rect.height } });
  return out;
}

// ---- Fullscreen

export type FullscreenStep = 'hide' | 'show' | 'none';

/** `behavior` is the raw `fullscreen_behavior`. */
export function fullscreenStep(o: { fullscreen: boolean; wasFullscreen: boolean; behavior: string; hiddenByUser: boolean;
  hiddenByFullscreen: boolean; captureStarted?: boolean }): FullscreenStep {
  const hide = o.behavior === 'hide';
  if (o.hiddenByFullscreen && (!o.fullscreen || !hide)) return 'show';
  // Only on entering, so a user who shows her again during fullscreen keeps it.
  if (o.fullscreen && (!o.wasFullscreen || o.captureStarted === true) && hide && !o.hiddenByUser && !o.hiddenByFullscreen) return 'hide';
  return 'none';
}

/** A video or game seen in fullscreen keeps her watching until the
 *  front app changes or leaves fullscreen. */
export function fullscreenWatching(was: boolean, fullscreen: boolean, reflex: boolean, samePid: boolean): boolean {
  return fullscreen && (reflex || (was && samePid));
}

export function captureHides(screenCaptured: boolean | null, hideOnScreenCapture: () => boolean): boolean {
  return screenCaptured === true && hideOnScreenCapture();
}

/** 全屏时：隐藏, and a screen capture, after each attention sample. */
export class FullscreenHider {
  /** She is hidden by this rule. */
  hidden = false;
  private was = false;
  private wasCaptured = false;
  /** The last read screenCaptured: an unread one (the mic or camera in use) does not end a capture. */
  private capturing = false;
  /** A capture began while she was hidden for another reason: hide her when that reason shows her. */
  private captureOwed = false;
  private watching = false;
  private watchPid: number | null = null;

  /** `reflex`: AttentionSampler.reflex is set; `avatarHidden`: she is hidden for any reason. The step to take, or null. */
  sampled(s: AttentionSample, reflex: boolean, avatarHidden: boolean, config: { behavior(): string; hideOnScreenCapture(): boolean }):
    { hide: boolean; behavior: string; captured: boolean } | null {
    const front = s.fullscreen ?? this.was;
    const pid = s.front?.pid ?? null;
    this.watching = fullscreenWatching(this.watching, front, reflex, pid === this.watchPid);
    this.watchPid = pid;
    if (s.screenCaptured !== null) this.capturing = s.screenCaptured;
    const captured = captureHides(this.capturing, config.hideOnScreenCapture);
    const fullscreen = (front && !this.watching) || captured;
    const was = this.was, wasCaptured = this.wasCaptured;
    this.was = fullscreen;
    this.wasCaptured = captured;
    const owed = captured && (this.captureOwed || !wasCaptured);
    this.captureOwed = owed;
    if (fullscreen === was && captured === wasCaptured && !this.hidden && !(owed && !avatarHidden)) return null;
    const behavior = captured ? 'hide' : config.behavior();
    const step = fullscreenStep({ fullscreen, wasFullscreen: was, behavior, hiddenByUser: avatarHidden && !this.hidden,
      hiddenByFullscreen: this.hidden, captureStarted: owed });
    this.captureOwed = step === 'none' && owed && !this.hidden;
    if (step === 'none') return null;
    this.hidden = step === 'hide';
    return { hide: this.hidden, behavior, captured };
  }

  /** A hide or show for any other reason: leaving fullscreen does not undo it. */
  userSet(): void {
    this.hidden = false;
  }
}
