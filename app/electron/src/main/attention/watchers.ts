// The surface source, the give-way loop and the activity and timeline recorders as index.ts starts them, and
// C3 rule 39's turn toward the user's focus. The user's mouse presses (mouse-downs.ts) feed keep_clear's `control` and
// `near_clicks` and `near_clicks_10s`, and FocusVisibility hides her in the window viewport.
// All of them read the user's windows or input, so `--no-attention` starts none of them.
import { join } from 'node:path';
import { type ActivityPolicy, DEFAULT_POLICY } from '../../common/activity.ts';
import { appKitY, type AttentionSample, type HelperY, helperY, type Rect as HelperRect, type ReflexState, toAppKit } from '../../common/attention.ts';
import { type Box, type Capsule, capsuleHit, capsulesBox, CURSOR, readCapsules } from '../../common/c3.ts';
import { FocusSide } from '../../common/focus-side.ts';
import { FocusVisibility } from '../../common/focus-visibility.ts';
import { ControlTargets, gap, KEEP_CLEAR, type KeepClearRect, NearClickCells, NearClickCount } from '../../common/keepclear.ts';
import type { StreamEvent } from '../../common/page.ts';
import type { Rect } from '../../common/placement.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';
import { DEFAULT_TIMELINE_POLICY, type TimelinePolicy } from '../../common/timeline.ts';
import { startActivity } from '../activity/recorder.ts';
import { startGiveWay } from '../give-way/loop.ts';
import type { SurfaceTrackEvent } from '../renderer/link.ts';
import { type SurfaceLink, startSurfaces } from '../surfaces/source.ts';
import { TimelineRecorder } from '../timeline/recorder.ts';
import { BlacklistFile } from './blacklist.ts';
import { MouseDowns } from './mouse-downs.ts';

/** The link's tick, which runs FocusVisibility and the `control` hover. */
const TICK_MS = 1000 / 60;

/** C3's y of the helper's coordinates on each platform (C12 CONTRACT 「坐标」, the C3 Windows appendix). */
export function helperYFor(platform: 'mac' | 'windows'): HelperY {
  return platform === 'mac' ? appKitY : helperY;
}

/** HostLink options: `surfaces`, `opacity` and `layering` (for `onSurfaceTrack`) and `pass_through` go in the hello only
 *  when the surface source runs. */
export function surfaceLinkOptions(argv: readonly string[], track: (e: SurfaceTrackEvent) => void):
  { onSurfaceTrack?: (e: SurfaceTrackEvent) => void; offers?: 'pass_through'[] } {
  return argv.includes('--no-attention') ? {} : { onSurfaceTrack: track, offers: ['pass_through'] };
}

export interface WatcherOptions {
  argv: readonly string[];
  platform: 'mac' | 'windows';
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  link: SurfaceLink & { sendAttentionSide(source: string, kind: string, side: string): boolean; readonly lastCursorHit: boolean };
  agentd: { request(method: string, path: string, json?: unknown): Promise<{ status: number }> };
  /** `agentd_state_dir`, which holds blacklist.json. */
  agentdStateDir: string;
  /** config.json as saved now; null when it is missing or not an object. */
  saved(): Record<string, unknown> | null;
  /** The pointer in C3 global points. */
  cursor(): { x: number; y: number };
  /** This shell's processes (main and helper). */
  ownPids(): readonly number[];
  /** The attention sampler; null without one. */
  attention(): { readonly reflex: ReflexState | null; readonly systemPaused: boolean; readonly frontFullscreen: boolean } | null;
  /** Seconds since the last input. */
  keyIdle(): number;
  /** She is hidden, for any reason. */
  avatarHidden(): boolean;
  /** setAvatarHidden with the fullscreen rule's reason. */
  setHidden(hidden: boolean, reason: 'fullscreen' | 'fullscreen_exit'): void;
  /** FocusVisibility's hide or show (HostLink's `set_visible`), which is not the user's:
   *  the caller does not call userSetHidden for it. Without it FocusVisibility does not run. */
  setFocusHidden?(hidden: boolean): void;
  /** The companion log and the hostlink log. */
  log(line: string): void;
  linkLog(line: string): void;
  /** ObservationControl.state (`pausedUntil` in epoch milliseconds); without it she never turns to the focus (rule 39). */
  observation?(): { readonly meeting: boolean; readonly pausedUntil: number | null } | null;
  /** The main display's height, for the front window's bounds; without it she never turns to the focus. */
  mainHeight?(): number | null;
  /** Epoch milliseconds; Date.now when absent. */
  wall?(): number;
  /** Tests drive the timers; monotonic milliseconds for the surfaces. */
  clock?: { now(): number; every(ms: number, fn: () => void): () => void };
}

export interface ShellWatchers {
  /** The helper said hello (true) or went (false). */
  helper(running: boolean): void;
  event(name: string, data: Record<string, unknown>): void;
  /** Each event of agentd's `/feed` (AgentStore.subscribe): `behavior` may turn her (rule 39). */
  feed(e: StreamEvent): void;
  /** Each attention sample (AttentionSampler.onSample). */
  sampled(s: AttentionSample): void;
  /** On while agentd runs and `observe_activity` is on. */
  agentd(running: boolean): void;
  /** LinkOptions.onSurfaceTrack. */
  track(e: SurfaceTrackEvent): void;
  /** The user's screen targets as last read, taken into the placement space by `fromC3`. */
  keepClear(fromC3: (r: Rect) => Rect): KeepClearRect[];
  /** The attention sampler's last sample is fullscreen. */
  readonly frontFullscreen: boolean;
  /** The fullscreen rule hides her. */
  readonly fullscreenHidden: boolean;
  /** She was hidden or shown for a reason other than fullscreen. */
  userSetHidden(): void;
  /** `listener` hears each mouse press of the user's, at the pointer in C3 global points, until the returned function is called. */
  onMouseDown(listener: (at: { x: number; y: number }) => void): () => void;
  /** HostLink.cursorState.nearClicks10s, for the attention sampler's `near_clicks_10s`. */
  nearClicks10s(): number;
  /** HostLink.buttonsDown: a button is down, or with a helper that sends no `mouse_up` a press came since the last tick. */
  readonly buttonsDown: boolean;
  stop(): void;
}

const every = (ms: number, fn: () => void) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

/** typingBehavior's test of a `behavior` event's data. */
const typingTrigger = (data: string): boolean => {
  try {
    const trigger = (JSON.parse(data) as { trigger?: { event?: unknown } | null } | null)?.trigger;
    return typeof trigger === 'object' && trigger !== null && trigger.event === 'typing';
  } catch {
    return false;
  }
};

/** The three, idle until the helper says hello; null with `--no-attention`. */
export function shellWatchers(o: WatcherOptions): ShellWatchers | null {
  if (o.argv.includes('--no-attention')) return null;
  const clock = o.clock ?? { now: () => performance.now(), every };
  const y = helperYFor(o.platform);
  const stayInPlace = () => ['stay', 'bust'].includes(o.saved()?.stay_mode as string);
  const blacklist = new BlacklistFile(join(o.agentdStateDir, 'blacklist.json'));
  const seconds = () => clock.now() / 1000;
  const link = o.link;
  // HostLink.Connection's: new at each hello.
  let visibility = new FocusVisibility();
  let controls = new ControlTargets();
  let cells = new NearClickCells();
  /** The rects of the latest `pass_through`, the `control` source's. */
  let passThrough: readonly Box[] = [];
  const kinematics = new NearClickCount();
  // While FocusVisibility hides her, rule 35 still judges her, on her last body.
  const surfaceLink: SurfaceLink = {
    get hello() { return link.hello; },
    get capabilities() { return link.capabilities; },
    get hidden() { return link.hidden && !visibility.hidden; },
    on: (listener) => link.on((e) => {
      if (visibility.hidden && e.kind === 'message' && e.message.type === 'hit_capsules' && readCapsules(e.message.capsules).length === 0) return;
      listener(e);
    }),
    sendSurfaces: (seq, windows) => link.sendSurfaces(seq, windows),
    sendSurface: (s) => link.sendSurface(s),
    sendCovered: (w) => link.sendCovered(w),
    sendPassThrough: (rects) => link.sendPassThrough(rects),
    setHitExclusions: (rects) => {
      passThrough = rects.passThrough;
      return link.setHitExclusions(rects);
    },
    cursorMoved: () => link.cursorMoved(),
  };
  const surfaces = startSurfaces({
    helper: o.helper, link: surfaceLink, cursor: o.cursor, ownPids: o.ownPids, keyIdle: o.keyIdle,
    systemPaused: () => o.attention()?.systemPaused ?? false, stayInPlace, helperY: y,
    now: clock.now, every: clock.every, log: o.linkLog,
  });
  let rects: KeepClearRect[] = [];
  const giveWay = startGiveWay({
    helper: o.helper, ownPids: o.ownPids, reflex: () => o.attention()?.reflex ?? null,
    keepClear: (next) => { rects = next; },
    covered: () => surfaces.isCovered,
    // On Windows efw keeps her out of captures itself (C3 Windows appendix).
    fullscreenBehavior: () => { const v = o.saved()?.fullscreen_behavior; return typeof v === 'string' ? v : 'hide'; },
    hideOnScreenCapture: () => o.platform === 'mac' && o.saved()?.hide_on_screen_capture !== false,
    // HostLink.sendSetVisible: any hide or show but FocusVisibility's own cancels its pending change.
    avatarHidden: o.avatarHidden, setHidden: (hidden, reason) => { visibility.manual(seconds()); o.setHidden(hidden, reason); }, every: clock.every, log: (line) => o.linkLog(`HOSTLINK ${line}`), helperY: y,
  });
  const timeline = new TimelineRecorder({
    helper: o.helper,
    post: async (body) => {
      try {
        return (await o.agentd.request('POST', '/context/timeline', body)).status;
      } catch {
        return 0;
      }
    },
    blacklist: () => blacklist.rules(),
    policy: (): TimelinePolicy => {
      const s = o.saved();
      if (s === null) return DEFAULT_TIMELINE_POLICY;
      return { allowActions: s.observe_activity !== false && s.share_actions === true,
        allowWindowText: s.share_window_text === true, allowTypedText: s.share_typed_text === true,
        redact: s.redact_sensitive !== false };
    },
    ownPids: o.ownPids, now: Date.now, every: clock.every, log: o.log,
  });
  const activity = startActivity({
    helper: o.helper,
    post: async (body) => {
      try {
        return (await o.agentd.request('POST', '/context/events', body)).status;
      } catch {
        return 0;
      }
    },
    blacklist: () => blacklist.rules(),
    // The default policy without saved settings.
    policy: (): ActivityPolicy => {
      const s = o.saved();
      if (s === null) return DEFAULT_POLICY;
      return { allowTypedText: s.share_typed_text === true, senseCounts: s.sense_input_counts !== false, redact: s.redact_sensitive !== false };
    },
    ownPids: o.ownPids, now: Date.now, every: clock.every, log: o.log, timeline: (e) => timeline.mirror(e),
  });
  // HostLink.avatarBodySample's frame: the bounds of this avatar's latest `hit_capsules` in global points. `at` is when they
  // came (seconds), `focusBody` her last body in global points.
  let avatar: { capsules: Box | null; list: Capsule[]; at: number | null; global: boolean; frame: Box | null; viewport: unknown;
    dragging: boolean; focusBody: Box | null } | null = null;
  const unlisten = link.on((e) => {
    if (e.kind === 'hello') {
      avatar = { capsules: null, list: [], at: null, global: false, frame: null, viewport: null, dragging: false, focusBody: null };
      visibility = new FocusVisibility();
      controls = new ControlTargets();
      cells = new NearClickCells();
      passThrough = [];
    } else if (e.kind === 'lost') {
      avatar = null;
      // HostLink.closeConnection: her focus hide goes with the connection.
      if (visibility.hidden) {
        visibility = new FocusVisibility();
        o.setFocusHidden?.(false);
      }
    } else if (e.kind === 'message' && avatar && e.message.type === 'hit_capsules') {
      avatar.list = readCapsules(e.message.capsules);
      avatar.capsules = capsulesBox(avatar.list);
      avatar.at = seconds();
      avatar.global = e.message.space === 'global';
    } else if (e.kind === 'message' && avatar && e.message.type === 'window_frame') {
      const f = e.message.frame as Record<string, number>;
      avatar.frame = { x: f.x!, y: f.y!, w: f.w!, h: f.h! };
      avatar.viewport = e.message.viewport;
    } else if (e.kind === 'message' && avatar && e.message.type === 'drag') {
      if (e.message.phase === 'begin') avatar.dragging = true;
      if (e.message.phase === 'end') avatar.dragging = false;
    }
  });
  const bodyBox = (): Box | null => {
    const b = avatar?.capsules, origin = avatar?.global ? { x: 0, y: 0 } : avatar?.frame;
    return b && origin ? { x: b.x + origin.x, y: b.y + origin.y, w: b.w, h: b.h } : null;
  };
  const body = (): HelperRect | null => {
    const b = bodyBox();
    return b && { x: b.x, y: b.y, width: b.w, height: b.h };
  };
  /** HostLink.body's hit: global point `g` is on her capsules. */
  const hitAt = (g: { x: number; y: number }): boolean => {
    const origin = avatar?.global ? { x: 0, y: 0 } : avatar?.frame;
    return !!origin && capsuleHit({ x: g.x - origin.x, y: g.y - origin.y }, avatar!.list);
  };
  /** A press since the last tick, and `buttonsDown()` with mouse.buttonsDown. */
  let pressed = false;
  const mouse = new MouseDowns({ helper: o.helper, cursor: o.cursor, now: seconds, log: o.log });
  // A press is also a near click.
  mouse.on((at, ts) => {
    pressed = true;
    const box = bodyBox();
    kinematics.click(ts, at, box, hitAt(at));
    if (avatar?.frame && link.capabilities.includes('keep_clear') && !link.lastCursorHit && box !== null
      && gap({ ...at, w: 0, h: 0 }, box) <= KEEP_CLEAR.near) cells.record(at, ts);
  });
  const stopTick = clock.every(TICK_MS, () => {
    const a = avatar, press = pressed;
    pressed = false;
    if (!a) return;
    const now = seconds();
    a.focusBody = bodyBox() ?? a.focusBody;
    if (o.setFocusHidden && a.viewport === 'window' && a.focusBody && (!link.hidden || visibility.hidden)) {
      const hovering = !link.hidden && a.at !== null && now - a.at <= CURSOR.fresh && hitAt(o.cursor());
      const visible = visibility.update(surfaces.isCovered, now, a.dragging || press || mouse.buttonsDown || hovering);
      if (visible !== null) {
        o.setFocusHidden(!visible);
        link.cursorMoved();
      }
    }
    if (a.frame && link.capabilities.includes('keep_clear')) controls.update(o.cursor(), passThrough, press, now);
  });
  // False when config.json cannot be read.
  const observeActivity = () => {
    const saved = o.saved();
    return saved !== null && saved.observe_activity !== false;
  };
  const wall = o.wall ?? Date.now;
  /** The gate focusSampled and typingBehavior share. */
  const observing = () => {
    const s = o.observation?.() ?? null;
    return s !== null && observeActivity() && !s.meeting && (s.pausedUntil === null || s.pausedUntil <= wall());
  };
  const focus = new FocusSide();
  const focusSampled = (s: AttentionSample) => {
    if (!observing() || s.locked || s.asleep || s.secureInput || s.frontIncognito === true) {
      focus.sample(null, null, null, s.ts);
      return;
    }
    const mainHeight = o.mainHeight?.() ?? null;
    const frame = s.frontBounds && mainHeight !== null ? toAppKit(s.frontBounds, mainHeight, y) : null;
    focus.sample(s.front?.windowId ?? null, frame, body(), s.ts, (side) => o.link.sendAttentionSide('focus', 'window', side));
  };
  return {
    helper(running) {
      surfaces.helper(running);
      giveWay.helper(running);
      activity.helper(running);
      mouse.helper(running);
    },
    event(name, data) {
      surfaces.event(name, data);
      giveWay.event(name, data);
      activity.event(name, data);
      timeline.event(name, data);
      mouse.event(name, data);
    },
    feed(e) {
      if (e.event !== 'behavior' || !observing() || !typingTrigger(e.data)) return;
      focus.typing(wall() / 1000, (side) => o.link.sendAttentionSide('focus', 'typing', side));
    },
    sampled(s) {
      giveWay.sampled(s);
      focusSampled(s);
      surfaces.sampled(s);
      activity.update(s);
      timeline.update(s);
    },
    agentd(running) {
      if (running && observeActivity()) {
        activity.start();
        timeline.start();
      } else {
        activity.stop();
        timeline.stop();
      }
    },
    track: (e) => surfaces.track(e),
    // The screen targets, then the controls, then the near click cells.
    keepClear: (fromC3) => [...rects, ...controls.rects.map((frame) => ({ kind: 'control' as const, frame })),
      ...cells.rects(seconds()).map((frame) => ({ kind: 'near_clicks' as const, frame }))].map((k) => ({ kind: k.kind, frame: fromC3(k.frame) })),
    get frontFullscreen() { return o.attention()?.frontFullscreen ?? false; },
    get fullscreenHidden() { return giveWay.fullscreenHidden; },
    userSetHidden: () => {
      visibility.manual(seconds());
      giveWay.userSetHidden();
    },
    onMouseDown: (listener) => mouse.on((at) => listener(at)),
    nearClicks10s: () => kinematics.count(seconds()),
    get buttonsDown() { return pressed || mouse.buttonsDown; },
    stop() {
      stopTick();
      unlisten();
      activity.stop();
      timeline.stop();
      giveWay.stop();
      surfaces.stop();
    },
  };
}
