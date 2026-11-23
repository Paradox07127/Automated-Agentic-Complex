// What the tray menu, the character menu and the menu bar icon are built from.
import type { ChildState } from './agentd.ts';

export interface MenuOption { id: string; name: string }

/** A 最近播报 entry. */
export interface MenuAnnouncement { id: string; text: string; time: string; unread: boolean }

export interface MenuState {
  recent: MenuAnnouncement[];
  quiet: boolean;
  freeRoam: boolean;
  characters: MenuOption[];
  currentCharacter: string | null;
  characterSwitching: boolean;
  /** 外观 appears only with two or more. */
  appearances: MenuOption[];
  currentAppearance: string | null;
  /** While an appearance loads the whole group is disabled; `""` disables it without marking an item. */
  appearanceSwitchingTo: string | null;
  /** Config failed to load: the tray menu keeps only the error, 打开主页, 诊断, a grey 重启后台和角色 and 退出. */
  configError: string | null;
}

/** The menu state before anything is known. */
export const MENU_STATE_DEFAULTS: MenuState = {
  recent: [], quiet: false, freeRoam: true,
  characters: [], currentCharacter: null, characterSwitching: false,
  appearances: [], currentAppearance: null, appearanceSwitchingTo: null,
  configError: null,
};

/** Features the app does not have, whose entries the menus leave out. */
export const ABSENT_FEATURES: ReadonlySet<'freeRoam'> = new Set();

/** The main window's hash routes the menus open. */
export const MENU_ROUTES = {
  home: '/home', conversation: '/chat', trace: '/trace', diag: '/diag', character: '/character', settings: '/settings',
} as const;

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
