// Giving way over the platform helper: the screen targets every 0.5 s (`ax.focused`, `ax.dialog_buttons`, `ax.overlays`)
// and the fullscreen hiding after each attention sample. `screens.list` gives the main display height for the helper's rects.
import { type AttentionSample, decodeRect, type HelperY, type ReflexState } from '../../common/attention.ts';
import { decodeFocus, decodeRects, FEED, feedRects, type Focus, FullscreenHider, othersFocus } from '../../common/give-way.ts';
import type { KeepClearRect } from '../../common/keepclear.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';

export interface GiveWayPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** This shell's processes (main and helper): their focus never counts. */
  ownPids(): readonly number[];
  /** AttentionSampler.reflex. */
  reflex(): ReflexState | null;
  /** The screen targets, in C3 global points, each time a read changes them. */
  keepClear(rects: KeepClearRect[]): void;
  /** Whether the surface source reports a covering window. */
  covered(): boolean;
  /** config.json `fullscreen_behavior` and `hide_on_screen_capture`. */
  fullscreenBehavior(): string;
  hideOnScreenCapture(): boolean;
  /** She is hidden, for any reason. */
  avatarHidden(): boolean;
  /** Hides or shows her for this rule; the caller does not call userSetHidden for these two reasons. */
  setHidden(hidden: boolean, reason: 'fullscreen' | 'fullscreen_exit'): void;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
  /** The helper rects' C3 y (AppKit's when absent). */
  helperY?: HelperY;
}

export class GiveWay {
  private readonly ports: GiveWayPorts;
  private timers: (() => void)[] = [];
  private mainHeight: number | null = null;
  private rects: KeepClearRect[] = [];
  private feeding = false;
  private readonly hider = new FullscreenHider();
  private readonly failed = new Map<string, string>();
  /** `workspace.watch` answered; after a restart the supervisor asks for it again. */
  private workspaceWatched = false;

  constructor(ports: GiveWayPorts) {
    this.ports = ports;
  }

  /** The front app's window covers her. */
  get covered(): boolean {
    return this.ports.covered();
  }

  /** She is hidden by the fullscreen rule. */
  get fullscreenHidden(): boolean {
    return this.hider.hidden;
  }

  /** The helper said hello (true) or went (false). */
  helper(running: boolean): void {
    this.stopTimers();
    if (!running) {
      this.mainHeight = null;
      if (this.rects.length > 0) this.handOn([]);
      return;
    }
    if (!this.workspaceWatched) {
      void this.ports.helper.request('workspace.watch', { enabled: true }).then((r) => {
        if (this.answered('workspace.watch', r)) this.workspaceWatched = true;
      });
    }
    void this.readScreens();
    this.timers = [this.ports.every(FEED.interval * 1000, () => { void this.feed(); })];
  }

  /** A helper event; only `workspace.changed` for the displays is read. */
  event(name: string, data: Record<string, unknown>): void {
    if (name === 'workspace.changed' && data.reason === 'screens') void this.readScreens();
  }

  /** After each attention sample. */
  sampled(s: AttentionSample): void {
    const p = this.ports;
    const step = this.hider.sampled(s, p.reflex() !== null, p.avatarHidden(),
      { behavior: () => p.fullscreenBehavior(), hideOnScreenCapture: () => p.hideOnScreenCapture() });
    if (step === null) return;
    p.setHidden(step.hide, step.hide ? 'fullscreen' : 'fullscreen_exit');
    p.log(step.hide ? `FULLSCREEN hide behavior=${step.behavior} captured=${step.captured}` : `FULLSCREEN show behavior=${step.behavior}`);
  }

  /** She was hidden or shown for a reason other than this rule's. */
  userSetHidden(): void {
    this.hider.userSet();
  }

  stop(): void {
    this.stopTimers();
  }

  private stopTimers(): void {
    for (const stop of this.timers) stop();
    this.timers = [];
  }

  /** Logs a failed op once until it answers again; true when it answered. */
  private answered(op: string, r: HelperAnswer): r is { ok: true; result: Record<string, unknown> } {
    if (r.ok) {
      this.failed.delete(op);
      return true;
    }
    if (this.failed.get(op) !== r.error.code) this.ports.log(`GIVEWAY ${op} failed code=${r.error.code}`);
    this.failed.set(op, r.error.code);
    return false;
  }

  private async readScreens(): Promise<void> {
    const r = await this.ports.helper.request('screens.list', {});
    if (!this.answered('screens.list', r) || !Array.isArray(r.result.screens)) return;
    const main = (r.result.screens as Record<string, unknown>[]).find((s) => s?.primary === true);
    this.mainHeight = decodeRect(main?.frame)?.height ?? null;
  }

  private handOn(rects: KeepClearRect[]): void {
    this.rects = rects;
    this.ports.keepClear(rects);
  }

  private async feed(): Promise<void> {
    if (this.feeding) return;
    this.feeding = true;
    try {
      if (this.mainHeight === null) await this.readScreens();
      const [target, overlays] = await Promise.all([this.focus(), this.ports.helper.request('ax.overlays', {})]);
      const mainHeight = this.mainHeight;
      if (mainHeight === null || this.timers.length === 0) return;
      const seen = this.answered('ax.overlays', overlays);
      const rects = feedRects({ ...target, banners: seen ? decodeRects(overlays.result.banners) : [],
        ime: seen ? decodeRects(overlays.result.ime) : [], reflex: this.ports.reflex() }, mainHeight, this.ports.helperY);
      if (JSON.stringify(rects) !== JSON.stringify(this.rects)) this.handOn(rects);
    } finally {
      this.feeding = false;
    }
  }

  /** The focus of another app and its dialog buttons. The app is `ax.focused`'s `app_pid`, even
   *  without a focused control; without the field (Windows) it is the focus's. */
  private async focus(): Promise<{ focus: Focus | null; buttons: ReturnType<typeof decodeRects> }> {
    const r = await this.ports.helper.request('ax.focused', {});
    if (!this.answered('ax.focused', r)) return { focus: null, buttons: [] };
    const own = this.ports.ownPids();
    const app = r.result.app_pid;
    const focus = othersFocus(decodeFocus(r.result.focus), own);
    const pid = 'app_pid' in r.result ? (typeof app === 'number' && !own.includes(app) ? app : null) : focus?.pid ?? null;
    if (pid === null) return { focus: null, buttons: [] };
    const b = await this.ports.helper.request('ax.dialog_buttons', { pid });
    return { focus, buttons: this.answered('ax.dialog_buttons', b) ? decodeRects(b.result.buttons) : [] };
  }
}

/** The loop, idle until `helper(true)`. */
export function startGiveWay(ports: GiveWayPorts): GiveWay {
  return new GiveWay(ports);
}
