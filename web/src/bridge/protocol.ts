// Bridge contract between the web UI and the shell.
// Single source of truth for bridge types; the web layer degrades by capability bits, never by platform name (`platform` only words text).
import type { FileAdopt } from './adopt';
import type { AppInfo } from './appInfo';
import type { AvatarOps } from './avatar';
import type { CameraOps } from './camera';
import type { CharacterOps } from './character';
import type { ComputerUseOps } from './computerUse';
import type { DesktopOps, DesktopWindowOps, GlassRect, Region } from './desktop';
import type { LogsOps } from './logs';
import type { MmdOps } from './mmd';
import type { OnboardingOps } from './onboarding';
import type { PermissionKind, PermissionState, SystemSettingsPane } from './permissions';
import type { PhotoOps } from './photo';
import type { ResizeOps } from './resize';
import type { ServicesOps } from './services';
import type { SettingsOps } from './settings';
import type { DecideOptions, StackPayload } from './stackCards';
import type { RuntimeSnapshot } from './runtimeSnapshot';

export type { AppInfo };
export type * from './avatar';
export type * from './avatarDetails';
export type * from './camera';
export type * from './character';
export type * from './computerUse';
export type * from './desktop';
export type * from './motionOverrides';
export type * from './onboarding';
export type * from './permissions';
export type * from './runtimeSnapshot';
export type * from './services';
export type * from './settings';
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
  /** One open panel takes files and folders together (`mmd.scan`); without it the page asks for files or a folder first. */
  filesOrFolderPicker: boolean;
  nativeConfirm: boolean;
  avatar: boolean;
  clickThrough: boolean;
  /** The avatar lists C3 `action_loop`: `avatar.playAction` takes `{ loop: true }`, `avatar.stopAction` ends it. */
  actionLoop: boolean;
  /** The platform helper's `hello.ops` has the feature's ops (app/electron/src/common/bridge.ts `HELPER_BIT_OPS`), or no list is known. */
  helperPushToTalk: boolean;
  helperWindowText: boolean;
  helperTypedText: boolean;
  helperActionTimeline: boolean;
  helperSelectedText: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface BridgeError { code: string; detail?: string }

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
  readonly surface: Surface;
  readonly platform: 'mac' | 'windows';
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
    request<T>(method: HttpMethod, path: string, body?: unknown): Promise<AgentdResponse<T>>;
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
  settings: SettingsOps;
  permissions: {
    /** Only the kinds the platform has a grant for. */
    status(): Promise<Partial<Record<PermissionKind, PermissionState>>>;
    /** Triggers the system prompt for a permission that was never asked. */
    request(kind: PermissionKind): Promise<PermissionState>;
    /** Opens the system settings pane; requires `capabilities.systemSettings`. */
    openSettings(pane: SystemSettingsPane): Promise<void>;
  };
  /** Available only on the onboarding surface. */
  onboarding: OnboardingOps;
  avatar: AvatarOps;
  character: CharacterOps;
  mmd: MmdOps;
  files: FileAdopt & {
    pickFile(o: { purpose: 'runtime_executable' | 'scope_file' }): Promise<PickedHandle | null>;
    pickFolder(o: { purpose: 'scope_root' | 'scope_output' | 'session_cwd' }): Promise<PickedHandle | null>;
    /** `with_text=1` on a trace turn asks natively first; false when declined or the save panel was cancelled. */
    saveAgentdExport(o: {
      path: '/memory/export' | `/memory/export?owner=${string}` | `/trace/turns/${string}`;
      suggestedName: string;
    }): Promise<boolean>;
  };
  open: {
    url(u: string): Promise<void>;
    artifact(path: string): Promise<void>;
    revealInFinder(path: string): Promise<void>;
    jumpToSession(id: string): Promise<void>;
    /** Runs a shell command in a new terminal window; requires `capabilities.runInTerminal`. */
    runInTerminal(command: string): Promise<void>;
  };
  clipboard: {
    writeText(t: string): Promise<void>;
  };
  computerUse: ComputerUseOps;
  logs: LogsOps;
  services: ServicesOps;
  /** The 调整镜头, 调整大小 and 拍照 overlay pages' own. */
  camera: CameraOps;
  resize: ResizeOps;
  photo: PhotoOps;
  window: DesktopWindowOps & {
    /** `glass`: the page's card rects for native glass; a report without it removes the glass. */
    setInteractiveRegions(r: Region[], glass?: GlassRect[]): void;
    close(): void;
    openMain(route: string): void;
    onRoute(cb: (route: string) => void): Unsubscribe;
    onVisibility(cb: (visible: boolean) => void): Unsubscribe;
    /** Hover for non-key panels. */
    onPointer(cb: (p: PointerState) => void): Unsubscribe;
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
