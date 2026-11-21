// What the tray menu, the character menu and the menu bar icon are built from.
import type { ChildState } from './agentd.ts';
import { accelerator } from './desktop-hotkey.ts';
import { DEFAULT_PLUGINS, shellPlan, type Subsystem } from './plugins.ts';

export interface MenuOption { id: string; name: string }

/** A connection row: `<name> · <detail>`. */
export interface MenuService { name: string; detail: string }

/** A 最近播报 entry. */
export interface MenuAnnouncement { id: string; text: string; time: string; unread: boolean }

/** An outfit layer of the current appearance; `visible` is the check. */
export interface MenuLayer { id: string; name: string; visible: boolean }

/** A pose slot of the current character (`AvatarPoses.slots`); `id` is its row's action id, null without one. */
export interface MenuPose { slot: string; title: string; id: string | null; available: boolean }

export interface MenuState {
  services: MenuService[];
  recent: MenuAnnouncement[];
  quiet: boolean;
  clickThroughAll: boolean;
  freeRoam: boolean;
  avatarHidden: boolean;
  characters: MenuOption[];
  currentCharacter: string | null;
  characterSwitching: boolean;
  /** 外观 appears only with two or more. */
  appearances: MenuOption[];
  currentAppearance: string | null;
  /** While an appearance loads the whole group is disabled; `""` disables it without marking an item. */
  appearanceSwitchingTo: string | null;
  /** 服装分层 appears only with at least one layer. */
  layers: MenuLayer[];
  layersSwitching: boolean;
  /** 姿态 appears only when the avatar listed `poses`. */
  poses: MenuPose[];
  /** The held pose row's id; null when she is automatic. */
  currentPose: string | null;
  poseLocked: boolean;
  /** 更多 › 调整镜头… appears only when the avatar listed `camera_free`. */
  cameraFree: boolean;
  /** 更多 › 保存截图 is grey unless the avatar listed `capture`. */
  canCapture: boolean;
  /** 角色 › MMD appears only with at least one slot. */
  motionSlots: MenuOption[];
  playingSlot: string | null;
  /** `off`, `one` or `all`, as config.json writes it. */
  playlistLoop: string;
  playlistPlaying: boolean;
  /** The menu was opened with option held. */
  showsDiagnostics: boolean;
  /** Config failed to load: the tray menu keeps only the error, 打开主窗口, 对话, 会话面板 (with `sessions`), 重启子进程 and 退出. */
  configError: string | null;
  /** config.json hot key names; a name that is no hot key leaves its item without a shortcut. */
  quickInputHotkey: string;
  lookHotkey: string;
  clickThroughHotkey: string;
  /** shellPlan of the plug-ins agentd runs with: an item of a plug-in that is off is left out. */
  plan: ReadonlySet<Subsystem>;
}

/** The menu state before anything is known. */
export const MENU_STATE_DEFAULTS: MenuState = {
  plan: shellPlan(DEFAULT_PLUGINS),
  services: [], recent: [], quiet: false, clickThroughAll: false, freeRoam: true, avatarHidden: false,
  characters: [], currentCharacter: null, characterSwitching: false,
  appearances: [], currentAppearance: null, appearanceSwitchingTo: null, layers: [], layersSwitching: false,
  poses: [], currentPose: null, poseLocked: false, cameraFree: false, canCapture: false,
  motionSlots: [], playingSlot: null, playlistLoop: 'off', playlistPlaying: false,
  showsDiagnostics: false, configError: null,
  quickInputHotkey: 'control+space', lookHotkey: 'control+option+l', clickThroughHotkey: 'control+option+p',
};

/** Features the app does not have, whose entries the menus leave out. */
export const ABSENT_FEATURES: ReadonlySet<'clickThroughAll' | 'freeRoam' | 'liveLog' | 'diagnostics'> = new Set(['liveLog', 'diagnostics']);

/** The main window's hash routes the menus open. */
export const MENU_ROUTES = {
  home: '/home', conversation: '/chat', pending: '/overview?focus=pending', sessions: '/overview?focus=running', memory: '/memory',
  trace: '/diag?tab=timeline', monitor: '/diag?tab=run', character: '/character', settings: '/settings',
  photo: '/character?view=photo',
} as const;

export const POSE_TITLES: Readonly<Record<string, string>> = { stand: '站', akimbo: '叉腰', sit: '坐', floor: '坐地', lie: '躺' };

/** A hot key name as an Electron accelerator; undefined for right option or a name that is no hot key. */
export function menuAccelerator(name: string): string | undefined {
  return accelerator(name) ?? undefined;
}

export type QuietSpan = 'halfHour' | 'hour' | 'untilMorning';

/** The end of a quiet span in epoch seconds; 到明早 is the next local 07:00 strictly after `now` (ms). */
export function quietUntil(span: QuietSpan, now: number): number {
  if (span === 'halfHour') return Math.floor(now / 1000) + 30 * 60;
  if (span === 'hour') return Math.floor(now / 1000) + 60 * 60;
  const morning = new Date(now);
  morning.setHours(7, 0, 0, 0);
  if (morning.getTime() <= now) {
    morning.setDate(morning.getDate() + 1);
    morning.setHours(7, 0, 0, 0);
  }
  return Math.floor(morning.getTime() / 1000);
}

// MARK: menu bar icon

export type MenuBarLevel = 'running' | 'recovering' | 'failed';

export function childLevel(s: ChildState): MenuBarLevel {
  switch (s.kind) {
    case 'running': return 'running';
    case 'stopped': case 'starting': case 'backoff': return 'recovering';
    case 'portInUse': case 'failed': return 'failed';
  }
}

export interface MenuBarStatus {
  agentdConnected: boolean;
  /** A child process failed or the config failed to load. */
  childFailed: boolean;
  /** agentd or the avatar is stopped, starting or waiting out a backoff. */
  restarting: boolean;
  pendingApprovals: number;
  recording: boolean;
  avatarHidden: boolean;
  switching: boolean;
  observationPaused: boolean;
  meetingMode: boolean;
  clickThroughAll: boolean;
  /** Epoch seconds; null when quiet is off. */
  quietUntil: number | null;
}

/** The menu bar status's process part; `shown` are the children the menu lists. */
export function processStatus(configFailed: boolean, agentd: ChildState, avatar: ChildState, shown: ChildState[]):
  Pick<MenuBarStatus, 'agentdConnected' | 'childFailed' | 'restarting'> {
  return {
    agentdConnected: agentd.kind === 'running',
    childFailed: configFailed || shown.some((s) => childLevel(s) === 'failed'),
    restarting: [agentd, avatar].some((s) => childLevel(s) === 'recovering'),
  };
}

export type MenuBarIconState = 'normal' | 'pendingApproval' | 'recording' | 'error' | 'restarting' | 'hidden' | 'switching'
  | 'observationPaused' | 'meetingMode' | 'clickThroughAll' | 'quiet';

/** MenuBarIconState.resolve: the key the user holds, then failures, then what waits on the user, then modes. */
export function iconState(s: MenuBarStatus): MenuBarIconState {
  if (s.recording) return 'recording';
  if (s.childFailed) return 'error';
  if (!s.agentdConnected) return s.restarting ? 'restarting' : 'error';
  if (s.pendingApprovals > 0) return 'pendingApproval';
  if (s.restarting) return 'restarting';
  if (s.switching) return 'switching';
  if (s.clickThroughAll) return 'clickThroughAll';
  // Quiet turns meeting and pause on too.
  if (s.quietUntil !== null) return 'quiet';
  if (s.meetingMode) return 'meetingMode';
  if (s.observationPaused) return 'observationPaused';
  if (s.avatarHidden) return 'hidden';
  return 'normal';
}
