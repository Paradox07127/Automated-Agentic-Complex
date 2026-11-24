// Bridge contract between the web UI and the shell.
// Single source of truth for bridge types; the web layer degrades by capability bits, never by platform name (`platform` only words text).
import type { AppInfo } from './appInfo';
import type { CameraOps } from './camera';
import type { ComputerUseOps } from './computerUse';
import type { AvatarAction, AvatarDetails, AvatarSwitchReply, CharacterLayer, ImportedMotionsResult, MotionImportResult, MotionPlaylist,
  MotionRemoveResult, OutfitImportResult, OutfitRemoveResult, MotionRenameResult, PhotoState, PlaylistPlayResult, PlaylistState } from './avatarDetails';
import type { DesktopOps, DesktopWindowOps, GlassRect, Region } from './desktop';
import type { OnboardingOps } from './onboarding';
import type { PermissionKind, PermissionState, SystemSettingsPane } from './permissions';
import type { DecideOptions, StackPayload } from './stackCards';
import type { RuntimeSnapshot } from './runtimeSnapshot';

export type { AppInfo };
export type * from './avatarDetails';
export type * from './camera';
export type * from './computerUse';
export type * from './desktop';
export type * from './motionOverrides';
export type * from './onboarding';
export type * from './permissions';
export type * from './runtimeSnapshot';
export type * from './services';
export type * from './stackCards';

export type Surface = 'main' | 'stack' | 'onboarding';

export type Unsubscribe = () => void;

/** Reported by each platform shell; the UI hides or degrades features whose bit is false. */
export interface Capabilities {
  screenCapture: boolean;
  computerUse: boolean;
  pushToTalk: boolean;
  hotkeys: boolean;
  revealInFinder: boolean;
  /** `permissions.openSettings` can open the system settings pane. */
  systemSettings: boolean;
  /** `open.runInTerminal` can start a command in a terminal window. */
  runInTerminal: boolean;
  nativeFilePicker: boolean;
  nativeConfirm: boolean;
  avatar: boolean;
  clickThrough: boolean; /** The avatar lists C3 `action_loop`: `avatar.playAction` takes `{ loop: true }`, `avatar.stopAction` ends it. */ actionLoop: boolean; /** The platform helper's `hello.ops` has the feature's ops (app/electron/src/common/bridge.ts `HELPER_BIT_OPS`), or no list is known. */ helperPushToTalk: boolean; helperWindowText: boolean; helperTypedText: boolean; helperActionTimeline: boolean; helperSelectedText: boolean;
}

export type CapabilityName = keyof Capabilities;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface BridgeError { code: string; detail?: string }

/** agentd's non-2xx JSON; extra keys (`current_version`, `runtime`, `run_id` …) stay here, not in `BridgeError`. */
export interface AgentdErrorBody { error: string; detail?: string; [k: string]: unknown }

/**
 * Three outcomes reach a page:
 * - agentd answered non-2xx: `body` is agentd's whole error JSON; `error.code` = `body.error` when it is a string,
 *   else `http_<status>`; `error.detail` = `body.detail`.
 * - the bridge did not send the request: status 0, `body` null, `error.code` one of invalid_method, invalid_path,
 *   unclassified_route, route_class, surface_not_allowed, invalid_body, handle_required, declined; or `offline`,
 *   the only code meaning agentd is unreachable.
 * - an op-level failure never resolves: the promise rejects with a `BridgeError` (forbidden_frame, op_not_allowed …).
 */
export interface AgentdResponse<T> {
  status: number;
  body: T | null;
  error?: BridgeError;
}

export type AgentdConnection = 'offline' | 'connected' | 'unauthorized';

export interface StreamEvent {
  event: string;
  id: string | null;
  data: string;
}

export type AppActionName =
  | 'restart_backend'
  | 'open_onboarding'
  | 'open_data_folder'
  | 'reveal_logs'
  | 'open_config'
  | 'copy_diagnostics'
  | 'test_approval_card'
  | 'test_announcement';

export type SupervisorTarget = 'agentd' | 'avatar';

export interface ProcessState {
  state: string;
  pid: number | null;
  /** Seconds before the restart while `state` is `backoff(N)`, else null. */
  backoff?: number | null;
  /** Share of one core since the previous read, in percent; null on the first read or when unreadable. */
  cpuPercent?: number | null;
  /** Physical memory footprint in MB; null while not running or unreadable. */
  memoryMB?: number | null;
  /** The shell's readings every 10 s since it started, oldest first, at most the last 30 minutes. */
  history?: ProcessReading[];
}

/** One reading of the shell's process sampler; `at` in ms since the epoch, the values null when unread. */
export interface ProcessReading {
  at: number;
  cpuPercent: number | null;
  memoryMB: number | null;
}

/** `app.look()`: agentd took the 看一下 request; the screenshot follows natively. */
export interface LookReply {
  requestId: string;
}

export type SettingId = string;
export type SettingValue = string | number | boolean | null | string[];

export interface SettingSchema {
  id: SettingId;
  group: string;
  kind: 'toggle' | 'select' | 'text' | 'number' | 'hotkey' | 'path' | 'slider';
  label: string;
  destructive?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Slider rows: range and step of the stored value; `percent` reads it ×100. */
  min?: number; max?: number; step?: number; format?: 'percent' | 'degrees' | 'days';
}

export interface SettingsSnapshot {
  saved: Record<SettingId, SettingValue>;
  statuses: Record<SettingId, string>;
}

export interface SettingsSaveResult {
  restart: 'none' | 'avatar' | 'backend';
  notApplied: SettingId[];
  error?: string;
}

/** `settings.onChange`: saved values changed outside the settings pages (a menu, another window). */
export interface SettingsChange {
  ids: SettingId[];
}

export type HotkeyCheck = { ok: true } | { ok: false; conflictWith: string };

/** What turning a destructive setting off would delete now, by agentd category; `total` sums `counts`. */
export interface DeletionPreview {
  total: number;
  counts: Record<string, number>;
}

/** What the user decided on a desktop stack card, with the concurrency fields the agentd request needs. */
export type StackDecision =
  | { kind: 'approval'; verdict: 'allow' | 'allow_session' | 'deny'; generation: number; mode?: string }
  | { kind: 'answer'; expected_version: number; answers: Record<string, string[]> }
  | { kind: 'cancel-question'; expected_version: number }
  | { kind: 'accept'; task_id: string; delivery_id: string; expected_revision: number; generation: number }
  /** agentd's reject takes no note: the native side sends `note` as a separate resume or continue. */
  | { kind: 'reject'; task_id: string; delivery_id: string; expected_revision: number; generation: number; note?: string };

/** One-time opaque handle; never a path string. */
export interface PickedHandle {
  readonly handle: string;
  readonly displayName: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

/** C3 rule 58: where the desktop play `playAction` started last stands: `tS` of `durationS` seconds into the clip playing now. */ export interface ActionProgress { id: string; tS: number; durationS: number; paused: boolean }

/** A rect of the page's viewport in CSS px, and the action to play there (`loop`: over and over); absent plays the current character's idle. */
export type PreviewPlacement = { x: number; y: number; w: number; h: number; action?: string; loop?: boolean; request?: number };

export interface CharacterAppearance {
  id: string; name: string; desc: string;
  kind?: 'original' | 'imported'; warnings?: string[]; // warnings: imported only, its import report's warning codes
}

export interface CharacterEntry {
  id: string;
  name: string;
  /** Latin name for the nameplate. */
  en: string;
  appearances: CharacterAppearance[];
  active: boolean;
  /** The package has a voice profile; without one she only shows text and never speaks (agentd `voice_enabled`). */
  voice: boolean;
  /** `agentic-complex-ui://app/characters/<id>/head.png`; absent when the package has no head. */
  head?: string;
  /** `agentic-complex-ui://app/characters/<id>/portrait.png` (≤1024 px); absent when the package has no portrait. */ portrait?: string;
  /** `agentic-complex-ui://app/characters/<id>/background.png`, the character page's watermark; absent when the package has none. */ background?: string;
  /** The current character only, and only when her appearance has outfit layers. */ layers?: CharacterLayer[];
}

/** Switch result; a rejection names the CharacterSwitch stage it stopped at and why. */
export type CharacterSwitchResult = { ok: true } | { ok: false; stage: 'prepare' | 'avatar' | 'commit'; reason: string };

export interface PushToTalkState {
  phase: 'idle' | 'listening' | 'transcribing' | 'sent' | 'error';
  partial?: string;
  error?: string;
}

export type ComputerUseScope = 'observation' | 'text' | 'image' | 'control';

export interface ComputerUseState {
  granted: ComputerUseScope[];
  active: boolean;
}

export type AnchorState = 'settled' | 'moving' | 'glide' | 'frozen' | 'dragging' | 'docked';

export interface A11yState {
  reduceMotion: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
  /** Always false: native lays no glass under the `[data-glass]` cards. */
  glass: boolean;
}

export interface PointerState {
  x: number;
  y: number;
  inside: boolean;
}

export interface AgenticComplexBridge {
  readonly surface: Surface; readonly platform: 'mac' | 'windows';
  readonly capabilities: Readonly<Capabilities>;
  app: {
    info(): Promise<AppInfo>;
    action(name: AppActionName): Promise<void>;
    /** 看一下; rejects `blocked` (detail: agentd's reason) or `offline`. */
    look(): Promise<LookReply>;
    /** 打开就地输入: the native quick input panel. */
    openQuickInput(): Promise<void>;
    runtime(): Promise<RuntimeSnapshot>;
    /** Pushes the current snapshot at once, then each changed one. */
    onRuntime(cb: (s: RuntimeSnapshot) => void): Unsubscribe;
  };
  agentd: {
    request<T>(
      method: HttpMethod,
      path: string,
      body?: unknown,
      opts?: { idempotencyKey?: string },
    ): Promise<AgentdResponse<T>>;
    connection(): Promise<AgentdConnection>;
  };
  feed: {
    subscribe(onEvent: (e: StreamEvent) => void, onReload: () => void, afterSeq?: string): Unsubscribe;
  };
  diag: {
    subscribe(onEvent: (e: StreamEvent) => void, onReload: () => void): Unsubscribe;
  };
  supervisor: {
    state(): Promise<Record<SupervisorTarget, ProcessState>>;
    restart(target: SupervisorTarget | 'all'): Promise<void>;
  };
  settings: {
    /** Only ids the UI may edit. */
    schema(): Promise<SettingSchema[]>;
    read(): Promise<SettingsSnapshot>;
    save(changes: Record<SettingId, SettingValue>): Promise<SettingsSaveResult>;
    /**
     * Records that the user confirmed a data-deleting change. The web layer has already shown its own danger confirmation,
     * so the native side only logs the consent and must not ask again; `false`: the shell refused, the change is not written.
     */
    confirmDestructive(id: SettingId): Promise<boolean>;
    /** Counts for the danger dialog of a destructive setting; deletes nothing. */
    previewDestructive(id: SettingId): Promise<DeletionPreview>;
    validateHotkey(id: SettingId, combo: string): Promise<HotkeyCheck>;
    recordHotkey(id: SettingId): Promise<string | null>;
    wipeLocalData(): Promise<void>;
    /** Pushes the ids whose saved value the native side changed outside the settings pages; read them again. */
    onChange(cb: (c: SettingsChange) => void): Unsubscribe;
  };
  permissions: {
    /** Only the kinds the platform has a grant for. */ status(): Promise<Partial<Record<PermissionKind, PermissionState>>>;
    /** Triggers the system prompt for a permission that was never asked. */
    request(kind: PermissionKind): Promise<PermissionState>;
    /** Opens the system settings pane; requires `capabilities.systemSettings`. */
    openSettings(pane: SystemSettingsPane): Promise<void>;
  };
  /** Available only on the onboarding surface. */
  onboarding: OnboardingOps;
  avatar: import('./motionOverrides').MotionAvatarOps & {
    state(): Promise<AvatarState>;
    details(): Promise<AvatarDetails>;
    setVisible(visible: boolean): Promise<void>; setScale(scale: number): Promise<void>;
    /** While on, she walks clear of the main window (C3 rule 42, fullscreen viewport); main surface only. */ keepClearOfMain(on: boolean): Promise<void>;
    resetPosition(): Promise<void>; toggleClickThroughAll(): Promise<void>; stopSpeech(): Promise<void>;
    actions(): Promise<AvatarAction[]>;
    /** `loop` (needs `capabilities.actionLoop`) plays it until `stopAction`, which ends the play this started last, at once when none plays; main surface only. */ playAction(id: string, speed: ActionSpeed, o?: { loop?: boolean }): Promise<void>; stopAction(): Promise<void>;
    /** Pauses, resumes or seeks to `atS` that play (C3 rule 58); `not_implemented` when her renderer does not list `action_transport`, `not_playing` when none plays; main surface only. */ controlAction(op: 'pause' | 'resume' | 'seek', atS?: number): Promise<void>;
    /** That play as it stands, then each report; null once it ends. Nothing while her renderer reports none. */ onActionProgress(cb: (p: ActionProgress | null) => void): Unsubscribe;
    setActionSwitches(switches: Record<string, boolean>): Promise<AvatarSwitchReply>;
    setAppearance(id: string): Promise<void>;
    /** Takes the whole hidden layer set; main surface only. */ setLayers(hidden: string[]): Promise<void>;
    /** Plays the current character's MMD list from item `start` (default 0); not on onboarding. */ playPlaylist(o?: { start?: number }): Promise<PlaylistPlayResult>;
    stopPlaylist(): Promise<{ ok: true }>; playlistState(): Promise<PlaylistState>;
    presentation: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
    /** The photo panel's state (C3 `set_render.photo`); main surface only. */ photo: { set(s: PhotoState): Promise<void> };
    /** Saves a PNG of her and resolves with its file name (C3 `capture`); main surface only. */ capture(o: { background: 'transparent' }): Promise<{ file: string }>;
    /** The character page's live preview, drawn by the shell over the page; main surface only. */
    preview: {
      /** Places or moves it and plays `action`; true once the character is drawn there, false where the shell has no live preview. */
      show(at: PreviewPlacement): Promise<boolean>; hide(): Promise<void>; /** The inspection camera; absent `tilt`, `pan`, `frame` are 0, [0, 0], [0, 0, 1, 1]. The shell keeps it across loads. */ view(v: import('./motionOverrides').PreviewView): Promise<void>;
      /** `{ fraction }` 0–1 while a load builds her anew; null once none does (drawn, failed, replaced). A clip change reports none. */ onProgress(cb: (p: { fraction: number } | null) => void): Unsubscribe;
    };
    onState(cb: (s: AvatarState) => void): Unsubscribe;
    onStats(cb: (s: AvatarStats) => void): Unsubscribe;
  };
  character: import('./mmd').ImportStateOps & {
    list(): Promise<CharacterEntry[]>;
    switchTo(id: string): Promise<CharacterSwitchResult>;
    importPackage(): Promise<{ ok: boolean; reason?: string }>;
    importMotion(): Promise<MotionImportResult>;
    importOutfit(): Promise<OutfitImportResult>; removeOutfit(appearanceId: string): Promise<OutfitRemoveResult>;
    listImportedMotions(): Promise<ImportedMotionsResult>;
    /** `id` is 1–64 bytes; `title` is trimmed and must then be 1–64 characters, else the call rejects with `bad_args`. */
    renameMotion(id: string, title: string): Promise<MotionRenameResult>;
    removeMotion(id: string): Promise<MotionRemoveResult>;
    getPlaylist(): Promise<MotionPlaylist>; setPlaylist(p: MotionPlaylist): Promise<{ ok: true }>;
  };
  mmd: import('./mmd').MmdOps; voice: { onPushToTalk(cb: (s: PushToTalkState) => void): Unsubscribe };
  files: import('./adopt').FileAdopt & {
    pickFile(o: { purpose: 'runtime_executable' | 'scope_file' }): Promise<PickedHandle | null>;
    pickFolder(o: { purpose: 'scope_root' | 'scope_output' | 'session_cwd' }): Promise<PickedHandle | null>;
    /** `with_text=1` on a trace turn asks natively first; false when declined or the save panel was cancelled. */
    saveAgentdExport(o: {
      path: '/history/export' | '/memory/export' | `/trace/turns/${string}`;
      suggestedName: string;
    }): Promise<boolean>;
  };
  open: {
    url(u: string): Promise<void>;
    artifact(path: string): Promise<void>;
    revealInFinder(path: string): Promise<void>;
    jumpToSession(id: string): Promise<void>;
    runFeedCommand(c: { action: 'open' | 'jump'; target: string }): Promise<void>;
    /** Runs a shell command in a new terminal window; requires `capabilities.runInTerminal`. */
    runInTerminal(command: string): Promise<void>;
  };
  clipboard: {
    writeText(t: string): Promise<void>;
  };
  computerUse: ComputerUseOps; logs: import('./logs').LogsOps; services: import('./services').ServicesOps;
  /** The 调整镜头 and 调整大小 overlay pages' own. */
  camera: CameraOps; resize: import('./resize').ResizeOps;
  window: DesktopWindowOps & {
    contentRect(): Promise<{ width: number; height: number }>;
    /** `glass`: the page's card rects for native glass; a report without it removes the glass. */
    setInteractiveRegions(r: Region[], glass?: GlassRect[]): void;
    close(): void;
    requestKey(): void;
    openMain(route: string): void;
    onRoute(cb: (route: string) => void): Unsubscribe;
    onVisibility(cb: (visible: boolean) => void): Unsubscribe;
    /** Hover for non-key panels. */
    onPointer(cb: (p: PointerState) => void): Unsubscribe;
    onAnchorState(cb: (s: AnchorState) => void): Unsubscribe;
    onA11y(cb: (a: A11yState) => void): Unsubscribe;
  };
  stack: {
    /** Pushes the whole card set on subscribe and after every change; `onError` when the source is unreachable. */
    onCards(cb: (p: StackPayload) => void, onError?: (e: BridgeError) => void): Unsubscribe;
    decide(id: string, decision: StackDecision, opts?: DecideOptions): Promise<void>;
    /** An error, notice or delivery card moves to history; any other card folds, and a reminder stays due. */
    collapse(id: string): Promise<void>;
  };
  desktop: DesktopOps;
}
