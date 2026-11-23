// The menus and the menu bar icon as index.ts wires them: the state a menu opens with, the ports its
// items call, and the icon drawn again on each change it shows.
import { iconState, MENU_STATE_DEFAULTS, type MenuBarStatus, type MenuOption, type MenuState } from '../../common/menus.ts';
import type { PushToTalk } from '../../common/push-to-talk.ts';
import type { RecentAnnouncements } from '../../common/recent-announcements.ts';
import { mainRoute } from '../../common/stack-cards.ts';
import type { CharacterSwitch } from '../../common/switch.ts';
import type { DesktopAssembly } from '../desktop/assembly.ts';
import type { Interaction } from '../interaction/shell.ts';
import type { ObservationControl } from '../ops/observation.ts';
import type { AvatarPlacer } from '../placement/controller.ts';
import type { HostLink } from '../renderer/link.ts';
import type { AvatarLooks } from '../renderer/looks.ts';
import { type IconBitmap, iconBitmap } from './icon.ts';
import type { MenuPorts } from './items.ts';

export interface ShellMenusOptions {
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** The roster; null when config.json did not load. */
  characters(): MenuOption[] | null;
  /** The character the app launched with; '' for none. */
  launched: string;
  /** processStatus of the children now. */
  processes(): Pick<MenuBarStatus, 'agentdConnected' | 'childFailed' | 'restarting'>;
  link: Pick<HostLink, 'hidden' | 'clickThroughAll' | 'currentCharacter' | 'currentAppearance' | 'appearances' | 'appearanceSwitching'> | null;
  /** The same switch as `avatar.setAppearance`. */
  looks: Pick<AvatarLooks, 'setAppearance'> | null;
  switcher: Pick<CharacterSwitch, 'busy' | 'select'> | null;
  observation: Pick<ObservationControl, 'state' | 'quietUntil' | 'load' | 'setQuiet'> | null;
  pushToTalk: Pick<PushToTalk, 'held'> | null;
  interaction: Pick<Interaction, 'actions'> | null;
  /** The desktop panels; null until the app is ready. */
  desktop(): Pick<DesktopAssembly, 'resetOffsets'> | null;
  placer(): Pick<AvatarPlacer, 'resetPosition'> | null;
  restartChildren(): void;
  openMain(route: string): void;
  quit(): void;
  settingsChanged(keys: string[]): void;
  /** companion.log. */
  log(line: string): void;
  /** Puts the icon in the menu bar or the notification area. */
  setIcon?(icon: IconBitmap): void;
  /** 最近播报; absent leaves it empty. */
  recent?: Pick<RecentAnnouncements, 'rows' | 'open' | 'markAllRead'>;
}

export interface ShellMenus {
  /** Read when a menu opens. */
  state(): MenuState;
  /** Read when a menu opens; an absent port greys its item. */
  ports(): MenuPorts;
  /** refreshStatusIcon: after each change of a child, her visibility, recording, quiet or a character switch. */
  refreshIcon(): void;
  /** StackSource.onCount. */
  pendingApprovalsChanged(count: number): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 最近播报's pick, from the menu or the console: read, and the sessions page with its session selected; one without a
 *  session leads nowhere. */
export function openAnnouncement(recent: Pick<RecentAnnouncements, 'open'>, openMain: (route: string) => void, id: string): void {
  const session = recent.open(id);
  if (session !== null) openMain(mainRoute('/overview', [['sel', session], ['focus', `task-${session}`]]));
}

export function shellMenus(o: ShellMenusOptions): ShellMenus {
  const { link, looks, switcher, observation, interaction } = o;
  let pending = 0;

  const refreshIcon = () => {
    if (!o.setIcon) return;
    o.setIcon(iconBitmap(iconState({
      ...o.processes(),
      pendingApprovals: pending, recording: o.pushToTalk?.held ?? false, avatarHidden: link?.hidden ?? false,
      switching: switcher?.busy ?? false,
      observationPaused: observation?.state.pausedUntil != null, meetingMode: observation?.state.meeting ?? false,
      clickThroughAll: link?.clickThroughAll ?? false, quietUntil: observation?.quietUntil() ?? null,
    }), pending));
  };

  const current = () => link?.currentCharacter ?? (o.launched === '' ? null : o.launched);

  const state = (): MenuState => {
    const saved = o.settings();
    const characters = o.characters();
    // refreshObservationState: quiet, meeting and pause set elsewhere show in the icon once agentd answers.
    if (observation && o.processes().agentdConnected) void observation.load().then(refreshIcon);
    return {
      ...MENU_STATE_DEFAULTS,
      recent: o.recent?.rows() ?? [],
      configError: characters ? null : '请查看设置',
      quiet: (observation?.quietUntil() ?? null) !== null,
      freeRoam: !['stay', 'bust'].includes(saved.stay_mode as string),
      characters: characters ?? [],
      currentCharacter: current(),
      characterSwitching: switcher?.busy ?? false,
      appearances: (link?.appearances ?? []).map((a) => ({ id: a.id, name: a.name })),
      currentAppearance: link?.currentAppearance ?? null,
      // The target of a running switch is not known; "" greys the group without marking an item.
      appearanceSwitchingTo: link?.appearanceSwitching ? '' : null,
    };
  };

  const ports = (): MenuPorts => {
    const desktop = o.desktop(), placer = o.placer(), recent = o.recent;
    return {
      openMain: o.openMain, quit: o.quit, log: o.log,
      openAnnouncement: recent ? (id) => openAnnouncement(recent, o.openMain, id) : undefined,
      markAllAnnouncementsRead: recent ? () => recent.markAllRead() : undefined,
      // applyQuiet: the icon follows once agentd has it.
      setQuiet: observation ? async (until) => {
        await observation.setQuiet(until);
        refreshIcon();
      } : undefined,
      toggleFreeRoam: interaction ? () => interaction.actions.freeRoam() : undefined,
      settingsChanged: o.settingsChanged,
      resetPosition: placer ? () => placer.resetPosition() : undefined,
      resetPanels: desktop ? () => desktop.resetOffsets() : undefined,
      switchCharacter: switcher ? (id) => switcher.select(id) : undefined,
      switchAppearance: looks ? (id) => {
        looks.setAppearance(id).catch((e: unknown) => o.log(`appearance id=${id} failed: ${message(e)}`));
      } : undefined,
      restartChildren: o.restartChildren,
    };
  };

  return {
    state, ports, refreshIcon,
    pendingApprovalsChanged: (count) => {
      if (count === pending) return;
      pending = count;
      refreshIcon();
    },
  };
}
