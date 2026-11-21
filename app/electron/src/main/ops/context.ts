// What the op handlers reach outside themselves. index.ts fills it from Electron; the tests from fakes.
import type { ChildState } from '../../common/agentd.ts';
import type { Handler, Surface } from '../../common/bridge.ts';
import type { ShellPlatform } from '../../common/config.ts';
import type { PermissionKind, PermissionState } from '../../common/onboarding.ts';
import type { EventSource, PageSession } from '../../common/page.ts';
import type { ImportProgress } from '../../common/import-state.ts';
import type { MmdSync } from '../../common/mmd-sync.ts';
import type { Route } from '../../common/routes.ts';
import type { SlotState } from '../../common/runtime.ts';
import type { LookResult } from '../../common/screen-context.ts';
import type { AgentdClient } from '../agentd/client.ts';
import type { AgentStore } from '../agentd/store.ts';
import type { HelperReply } from '../helper/client.ts';
import type { SwitchOutcome } from '../../common/switch.ts';
import type { TurnMarks } from '../../common/turn-marks.ts';
import type { AvatarHost, AvatarPlacement, LooksHost } from './avatar.ts';
import type { ComputerUseHost } from './computer-use.ts';
import type { Commands } from './jump.ts';
import type { PreviewHost } from './preview.ts';

export type Op = Handler<PageSession>;
/** A tool's last stdout line that is not progress, its exit status and, when that is not 0, the end of its stderr. */
export interface ToolResult { last: string; status: number; stderr: string }
export type Ops = Record<string, Op>;

export interface OpsContext {
  surface: Surface;
  /** The settings defaults and save effects that differ by platform; absent is macOS. */
  platform?: ShellPlatform;
  /** protocol/ui-bridge/routes.json. */
  routes: Route[];
  config: {
    path: string;
    /** null when config.json did not load. */
    supportDir: string | null;
    devResources: string | null;
  };
  /** null when config.json did not load. */
  agentd: AgentdClient | null;
  /** `GET /feed`, followed while the app runs. */
  store: AgentStore | null;
  /** `GET /diag/stream`, connected while a page subscribes. */
  diag: EventSource | null;
  /** `avatar` is the renderer's state; `restartAvatar` and `avatarPid` are there once the renderer is supervised. `tunnel` is
   *  the TTS tunnel's, null without `tts_tunnel_host`; absent is null. */
  supervisor: {
    state(): ChildState; pid(): number | undefined; restart(): void; avatar(): ChildState; restartAvatar?(): void;
    avatarPid?(): number | undefined; tunnel?(): SlotState | null; tunnelPid?(): number | undefined;
  } | null;
  /** The renderer over C3; null or absent without one. */
  avatar?: AvatarHost | null;
  /** A process's user + system CPU seconds, null when unreadable; null or absent leaves `cpuPercent` 0. */
  cpuSeconds?: ((pid: number) => number | null) | null;
  /** Her appearance, layers, action switches and mod settings; null or absent without a renderer link. */
  looks?: LooksHost | null;
  /** The character switch (CharacterSwitch); null or absent without a renderer link. `held` while a motion tool runs. */
  switcher?: { readonly busy: boolean; held: boolean; readonly current: string | null; switchOutcome(id: string): Promise<SwitchOutcome> } | null;
  /** The shared MMD library's bake into the current character and its `sync` events; null or absent without a library. */
  mmdSync?: { sync: MmdSync; events: EventSource } | null;
  /** Where she stands on the desktop; null or absent without a renderer link. */
  placement?: AvatarPlacement | null;
  /** The character page's live preview; null or absent where there is none (Windows). */
  preview?: PreviewHost | null;
  /** The C12 platform helper (`HelperSupervisor.request`): `helper_exited` while none runs; null or absent without one. */
  helper?: { request(op: string, params?: Record<string, unknown>): Promise<HelperReply> } | null;
  /** Push-to-talk's protocol.ts `PushToTalkState` values (`voice.onPushToTalk`); null or absent without push-to-talk. */
  pushToTalk?: EventSource | null;
  /** The T1 marks of the main window's conversation messages; null or
   *  absent for none. */
  turnMarks?: Pick<TurnMarks, 'acceptedBody'> | null;
  /** The programs session jumps and `open.runInTerminal` run; absent runs them for real. */
  commands?: Commands;
  /** The character library and agentd's tools; null when config.json did not load. */
  library: {
    /** config.json `character_catalog`; null without a library. */
    catalog: string | null;
    /** The character agentd was started with; empty for none. */
    launched: string;
    /** The configured character's name, for the onboarding guide. */
    characterName: string;
    /** The guide's command that installs session hooks, without `--target`. */
    hookCommand: string;
    /** The Metal host the tools validate with; throws the reason when there is none. */
    validationHost(): string;
    /** Runs `<python> <agentd_dir>/<script> <args>` in the agentd directory; `progress` gets each progress line as it comes. */
    runTool(script: string, args: string[], progress?: (p: ImportProgress) => void): Promise<ToolResult>;
    /** The library's characters changed: reads again the roster the renderer launches from. */
    rosterChanged(): void;
  } | null;
  /** onboarding step 1's rows as the shell reads them without the helper: the login item's, and the rest unread. */
  permission(kind: PermissionKind): PermissionState;
  /** Asks the user natively; true to go on. */
  confirm(text: string): Promise<boolean>;
  shell: {
    openExternal(url: string): Promise<void>;
    /** Resolves to an error message, empty on success (Electron's `shell.openPath`). */
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): void;
  };
  clipboard: { writeText(text: string): void };
  dialog: {
    /** The chosen path, or null when cancelled. */
    pickFile(purpose: string): Promise<string | null>;
    pickFolder(purpose: string): Promise<string | null>;
    /** A `.endfield-character` package or a folder with character.json; null when cancelled. */
    pickPackage(): Promise<string | null>;
    /** false when cancelled. */
    saveFile(data: Buffer, suggestedName: string): Promise<boolean>;
  };
  /** `buildGit` for `app.info`; absent is empty. */
  app: { version: string; os: string; buildGit?: string; build?: string };
  /** The system login item; null on an instance that must not touch it. */
  loginItem: { enabled(): boolean | null; set(on: boolean): void };
  /** `app.action`'s desktop test cards; false when the desktop cannot show one; absent without the desktop panels. */
  testCard?: ((kind: 'approval' | 'announcement') => boolean) | null;
  /** A saved setting the running shell takes at once (`fpsSettingsSaved`, `hotkeySaved`, `touchSettingsSaved`,
   *  `renderLiveSaved`: renderer/saved.ts); absent without one. */
  saved?: { fps(): void; hotkey(key: string, name: string): void; touch?(): void; renderLive?(keys: string[]): void } | null;
  /** Native changes to saved settings (`settings.onChange`). */
  settingsChanges: EventSource;
  /** `app.runtime`'s wire and `app.onRuntime`'s source; null or absent leaves both unimplemented. */
  runtime?: { snapshot(): unknown; events: EventSource } | null;
  /** `app.look`'s `POST /look`: the main window's straight to agentd, the desktop panels' through the screen context
   *  capturer; null or absent without one. */
  look?: (() => Promise<LookResult>) | null;
  /** The computer control host; null or absent leaves `computerUse.*` unimplemented. */
  computerUse?: ComputerUseHost | null;
  /** Push-to-talk's trial readouts (push-to-talk.ts `VoiceTrial`) as event `trial`; null or absent without push-to-talk. */
  voiceTrial?: EventSource | null;
  /** Opens the first-run guide's window or brings it front; null or absent leaves `open_onboarding` unimplemented. */
  openOnboarding?: (() => void) | null;
  /** Closes the guide's window; `home` then opens the main window at `destination`. */
  endOnboarding?: ((home: boolean, destination: 'home' | 'chat' | 'privacy' | 'model') => void) | null;
  /** Opens the main window at a hash route without `#` and brings it front; null or absent without one.
   *  `activate: false` is the agent's entry: shown without taking the focus, and a focused main window keeps its page. */
  openMain?: ((route: string, activate?: boolean) => void) | null;
  /** The desktop panels' 快速输入 (`app.openQuickInput`); null when config.json did not load. */
  openQuickInput?: (() => void) | null;
  log(line: string): void;
  /** The hot keys the system refused or that are no hot key, by config.json key; absent is
   *  none. */
  unregisteredHotkeys?: (() => Record<string, string>) | null;
  /** Records the next hot key pressed in the main window (true allows right Option alone); null or
   *  absent leaves `settings.recordHotkey` unimplemented. */
  recordHotkey?: ((rightOption: boolean) => Promise<string | null>) | null;
}
