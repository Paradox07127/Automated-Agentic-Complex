// The bridge's `avatar` ops: her desktop state and stats, the desktop play and its transport, and the character page's live preview.
import type { AvatarAction, AvatarDetails, AvatarSwitchReply, PlaylistPlayResult, PlaylistState } from './avatarDetails';
import type { MotionAvatarOps, PreviewControl, PreviewPosition, PreviewView } from './motionOverrides';
import type { Unsubscribe } from './protocol';

export interface AvatarState {
  running: boolean;
  visible: boolean;
  scale: number;
  clickThroughAll: boolean;
  speaking: boolean;
  characterId: string | null;
  appearanceId: string | null;
}

export interface AvatarStats {
  /** When the host measured it (epoch ms); absent means now. */
  at?: number;
  fps: number;
  frameMs: number;
  cpuPercent: number;
  frameMsP95?: number;
  gpuMs?: number;
}

export type ActionSpeed = 0.5 | 1 | 2;

/** Where the desktop play `playAction` started last stands: `tS` of `durationS` seconds into the clip playing now. */
export interface ActionProgress {
  id: string;
  tS: number;
  durationS: number;
  paused: boolean;
}

/**
 * A rect of the page's viewport in CSS px, and the action to play there (`loop`: over and over); absent plays the current
 * character's idle; `stage` (with `action`) plays its camera and music, silent at 0 s until `control` resumes it.
 */
export type PreviewPlacement = { x: number; y: number; w: number; h: number; action?: string; loop?: boolean; request?: number; stage?: boolean };

/** The character page's live preview, drawn by the shell over the page; main surface only. */
export interface PreviewOps {
  /** Places or moves it and plays `action`; true once the character is drawn there, false where the shell has no live preview. */
  show(at: PreviewPlacement): Promise<boolean>;
  hide(): Promise<void>;
  /** The inspection camera; absent `tilt`, `pan`, `frame` are 0, [0, 0], [0, 0, 1, 1]. The shell keeps it across loads. */
  view(v: PreviewView): Promise<void>;
  /** `{ fraction }` 0–1 while a load builds her anew; null once none does (drawn, failed, replaced). A clip change reports none. */
  onProgress(cb: (p: { fraction: number } | null) => void): Unsubscribe;
  /** Pauses, resumes or seeks (seconds) the stage preview; nothing without one. */
  control(c: PreviewControl): Promise<void>;
  /** The stage preview's playhead while it is on screen; null once there is none (another show, hidden, failed). */
  onPosition(cb: (p: PreviewPosition | null) => void): Unsubscribe;
}

export type AvatarOps = MotionAvatarOps & {
  state(): Promise<AvatarState>;
  details(): Promise<AvatarDetails>;
  setVisible(visible: boolean): Promise<void>;
  setScale(scale: number): Promise<void>;
  /** While on, she walks clear of the main window in fullscreen. Main surface only. */
  keepClearOfMain(on: boolean): Promise<void>;
  resetPosition(): Promise<void>;
  toggleClickThroughAll(): Promise<void>;
  stopSpeech(): Promise<void>;
  actions(): Promise<AvatarAction[]>;
  /**
   * `loop` (needs `capabilities.actionLoop`) plays it until `stopAction`, which ends the play this started last, at once when none
   * plays; main surface only.
   */
  playAction(id: string, speed: ActionSpeed, o?: { loop?: boolean }): Promise<void>;
  stopAction(): Promise<void>;
  /**
   * Pauses, resumes or seeks to `atS` that play; `not_implemented` when her renderer does not list `action_transport`, `not_playing`
   * when none plays; main surface only.
   */
  controlAction(op: 'pause' | 'resume' | 'seek', atS?: number): Promise<void>;
  /** That play as it stands, then each report; null once it ends. Nothing while her renderer reports none. */
  onActionProgress(cb: (p: ActionProgress | null) => void): Unsubscribe;
  /** `character` is the one the page shows; another current character rejects with `character_changed`, as do the calls below that take one. */
  setActionSwitches(character: string, switches: Record<string, boolean>): Promise<AvatarSwitchReply>;
  setAppearance(id: string): Promise<void>;
  /** Hides `hide` and shows `show`; her other layers, every appearance's, stay as they are; main surface only. */
  setLayers(character: string, change: { hide: string[]; show: string[] }): Promise<void>;
  /** Plays the current character's MMD list from item `start` (default 0); not on onboarding. */
  playPlaylist(o?: { start?: number }): Promise<PlaylistPlayResult>;
  stopPlaylist(): Promise<{ ok: true }>;
  playlistState(): Promise<PlaylistState>;
  preview: PreviewOps;
  onState(cb: (s: AvatarState) => void): Unsubscribe;
  onStats(cb: (s: AvatarStats) => void): Unsubscribe;
};
