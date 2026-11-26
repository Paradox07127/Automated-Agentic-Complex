// Desktop panel types and the `desktop` ops of the bridge, re-exported by protocol.ts.
import type { PluginId } from './plugins.generated';
import type { AnchorState, ProcessState, Rect, Unsubscribe } from './protocol';

/** `hud` is the stack cards' page, which native no longer opens as a panel. */
export type DesktopPanel = 'cmd' | 'console' | 'bubble' | 'chip' | 'dock' | 'hud';
export type DockReason = 'hidden' | 'fullscreen' | 'offscreen' | 'stale' | 'noroom';

/** Where the native layout put this panel relative to her; pushed only when it changes. */
export interface DesktopAnchor {
  panel: DesktopPanel;
  state: AnchorState;
  side: 'left' | 'right' | 'above' | 'below' | 'corner' | 'menubar' | 'status' | 'mouse';
  docked: DockReason | null;
  /** More than 240pt from her head: the page draws an edge caret toward her. */
  far: boolean;
  toHead: { dx: number; dy: number } | null;
  room: { width: number; height: number };
}

/** A drag region moves the panel natively; double-clicking it clears the panel's user offset. */
export interface Region extends Rect {
  drag?: boolean;
}

/** A `[data-glass]` card the native panel lays glass under (corner radius 12, at most 4); same space as `Region`. */
export interface GlassRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CmdMode = 'ring' | 'input';

export type DesktopCommand =
  /** `at`: the wheel's centre in its page, CSS px from the top-left, where she was right-clicked; the hot key's open has none. */
  | { kind: 'open'; mode: CmdMode; prefill?: string; at?: { x: number; y: number } }
  /** The console page's own channel (`#/console`) opens with it; the other pages never get it. */
  | { kind: 'openConsole' }
  | { kind: 'close' }
  | { kind: 'focusTop' }
  | { kind: 'expandStack' }
  /** The selection hot key's one read, sent just before the `open` of 快速输入 it belongs to. */
  | { kind: 'selection'; source: 'selection' | 'clipboard'; text: string; app: string | null; truncated: boolean }
  /** The selection hot key read nothing; `message` says why. Sent like `selection`. */
  | { kind: 'selectionRefused'; message: string }
  /** 快速输入 opens with a drop scope of `files` files; what is sent from it carries `scopeId`. Sent like `selection`. */
  | { kind: 'scope'; scopeId: string; files: number }
  /** 快速输入 opens with the window she was dragged onto; what is sent from it carries `lookWindow`. Sent like `selection`. */
  | { kind: 'window'; windowId: number; pid: number; app: string | null; title: string | null }
  /** A short line the bubble shows for a few seconds, such as why a click on her asked nothing. */
  | { kind: 'notice'; text: string }
  /** The held right button that opened the wheel, in the wheel page's CSS px; `ms` since it went down. */
  | { kind: 'ringPointer'; phase: 'move'; x: number; y: number }
  | { kind: 'ringPointer'; phase: 'up'; x: number; y: number; ms: number };

export type DesktopActionName =
  | 'look'
  | 'hide'
  | 'show'
  | 'clickThroughAll'
  | 'quiet'
  | 'quietEnd'
  | 'gift'
  | 'freeRoam'
  | 'switchCharacter'
  | 'placeOnScreen'
  | 'resetPosition'
  | 'resize'
  /** Her wheel's 拍照: the photo bar under her. */
  | 'photo'
  | 'restartAll'
  | 'quit'
  | 'resetBoxes'
  | 'openSessions'
  | 'openStack'
  | 'claimRitual'
  | 'quickInput'
  | 'cmdMode'
  /** 说话 on her hover buttons: `start` as a press of the push-to-talk key, `stop` as its release. */
  | 'talk'
  /** 停止 on her wheel: ends the user's play on her, whichever page or panel started it. */
  | 'stopPlay'
  /** Her wheel's 姿态: holds the pose row `arg`; none is 自动. */
  | 'pose';

export interface DesktopState {
  hidden: boolean;
  clickThroughAll: boolean;
  freeRoam: boolean;
  quietUntil: number | null;
  /** Epoch ms her hide expires; null while she shows or the hide does not expire. */
  hiddenUntil?: number | null;
  /** Her hover buttons: open after a rest on her, on the side native placed them; compact while she is under 200 px tall. */
  dock: DesktopDock;
  showPresence?: boolean;
  showHoverHints?: boolean;
  character: { id: string; name: string } | null;
  characters: { id: string; name: string }[];
  screens: { id: string; name: string; current: boolean }[];
  hotkeys: Record<string, string>;
  /** `helper`: the platform helper; null where the shell has none. */
  pips: { agentd: ProcessState; avatar: ProcessState; voice: 'on' | 'off' | 'denied'; helper?: ProcessState | null };
  computerUseActive: boolean;
  /** The plug-ins agentd runs with, in the registry's order. */
  plugins: PluginId[];
  /** The action id the user plays on her now, from any page or panel; null while none plays. */
  playing?: string | null;
  /** Her pose slots in menu order and the held row's id; null while her renderer has none. */
  poses?: DesktopPoses | null;
  /** Both her renderer and this app list C3 `capture` (拍照's shutter). */
  capture?: boolean;
}

/** A slot's `id` is its pose row's, null when she has none; `reason` says why it cannot be chosen, null when it can. */
export interface DesktopPoses {
  slots: { title: string; id: string | null; reason: string | null }[];
  current: string | null;
}

export interface DesktopDock {
  open: boolean;
  side: 'left' | 'right' | 'above';
  compact: boolean;
}

/** The entry a `/say` was typed in (agentd api/speech.py `SURFACES`). */
export type SaySurface = 'quick_input' | 'bubble_reply' | 'thought_offer';

export interface SayRequest {
  text: string;
  attachWindow: boolean;
  noMemory: boolean;
  /** A `POST /agent/scopes` scope the turn may read. */
  scopeId?: string;
  surface?: SaySurface;
  /** The selection typed with; agentd puts it in this turn's context only. */
  quote?: { text: string; app: string | null };
  /** The line (bar/line id) or thought (thought id) of hers the text answers. */
  replyTo?: SayReplyTo;
  /** agentd `/say` `look_window`. */
  lookWindow?: { windowId: number; pid: number };
}

/** agentd `/say` `reply_to`. */
export interface SayReplyTo {
  kind: 'line' | 'thought';
  id: string;
}

/** A refusal carries agentd's status and error code; `detail` is a sentence the page already has (a bridge refusal). */
export type SayResult = { ok: true } | { ok: false; reason: 'agentd' | 'kernel' | 'rejected'; status?: number; code?: string; detail?: string };

/** The desktop panels' `window` ops besides the stack's; they reject `unavailable` where the shell has no desktop host. */
export interface DesktopWindowOps {
  /** The content size in CSS px, which the native panel takes as its own. */
  setContentSize(s: { width: number; height: number }): void;
  /** Hands the keyboard back to the app that had it. */
  releaseKey(): void;
  /** Subscribing also tells the native panel the page is alive. */
  onAnchor(cb: (a: DesktopAnchor) => void): Unsubscribe;
  /** One info line in native's ui.log. */
  logInfo(message: string): void;
}

/** The desktop panels (bubble, chip, dock, cmd, console); the ops reject `unavailable` where the shell has no desktop host. */
export interface DesktopOps {
  onState(cb: (s: DesktopState) => void): Unsubscribe;
  /** agentd's `/desktop/presence` JSON, forwarded as it came. */
  onPresence(cb: (raw: unknown) => void): Unsubscribe;
  onCommand(cb: (c: DesktopCommand) => void): Unsubscribe;
  /** 快速输入: the main process sends it to agentd's `POST /say` for the page. */
  say(r: SayRequest): Promise<SayResult>;
  /**
   * `arg` is the character id of `switchCharacter`, the screen id of `placeOnScreen`, the mode (`ring` | `input`) for
   * `cmdMode`, or `start` | `stop` for `talk`. `quickInput` opens
   * 快速输入 in the bubble; its optional `arg`, `{"scopeId", "files"}` as JSON, opens it with that drop scope.
   */
  action(name: DesktopActionName, arg?: string): Promise<void>;
  /** One line, at most 200 characters, that her bubble shows for a few seconds as a `notice` command. */
  notice(text: string): void;
  /** 最近播报: the last 20 announcements, newest first. */
  onRecent(cb: (rows: RecentAnnouncement[]) => void): Unsubscribe;
  /** Marks one read and opens its session in the main window when it has one. */
  openAnnouncement(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

/** A 最近播报 row; `time` is the local `HH:mm` it came at. */
export interface RecentAnnouncement {
  id: string;
  text: string;
  time: string;
  unread: boolean;
}
