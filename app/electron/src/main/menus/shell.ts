// The menus and the menu bar icon as index.ts wires them: the state a menu opens with, the ports its
// items call, and the icon drawn again on each change it shows.
import { iconState, MENU_STATE_DEFAULTS, type MenuBarStatus, type MenuOption, type MenuState } from '../../common/menus.ts';
import type { Subsystem } from '../../common/plugins.ts';
import type { PushToTalk } from '../../common/push-to-talk.ts';
import type { RecentAnnouncements } from '../../common/recent-announcements.ts';
import { mainRoute } from '../../common/stack-cards.ts';
import type { CharacterSwitch } from '../../common/switch.ts';
import type { ShellCamera } from '../camera/shell.ts';
import type { ShellContext } from '../context/shell.ts';
import type { DesktopAssembly } from '../desktop/assembly.ts';
import type { Interaction } from '../interaction/shell.ts';
import type { AvatarPlaylist } from '../ops/avatar.ts';
import type { ObservationControl } from '../ops/observation.ts';
import type { AvatarPlacer } from '../placement/controller.ts';
import type { HostLink } from '../renderer/link.ts';
import type { AvatarLooks } from '../renderer/looks.ts';
import { type IconBitmap, iconBitmap } from './icon.ts';
import type { MenuPorts } from './items.ts';

export interface ShellMenusOptions {
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** MenuState.plan. */
  plan(): ReadonlySet<Subsystem>;
  /** The roster; null when config.json did not load. */
  characters(): MenuOption[] | null;
  /** The character the app launched with; '' for none. */
  launched: string;
  /** The children's rows, `<name> · <detail>` (menuLines). */
  services(): string[];
  /** processStatus of the children now. */
  processes(): Pick<MenuBarStatus, 'agentdConnected' | 'childFailed' | 'restarting'>;
  link: Pick<HostLink, 'hidden' | 'clickThroughAll' | 'currentCharacter' | 'currentAppearance' | 'capabilities' | 'appearances'
    | 'layers' | 'hiddenLayers' | 'appearanceSwitching' | 'layersSwitching' | 'capture' | 'actions'> | null;
  /** The same switches as `avatar.setAppearance` and `avatar.setLayers`. */
  looks: Pick<AvatarLooks, 'setAppearance' | 'setLayers'> | null;
  switcher: Pick<CharacterSwitch, 'busy' | 'select'> | null;
  observation: Pick<ObservationControl, 'state' | 'quietUntil' | 'load' | 'setQuiet'> | null;
  camera: Pick<ShellCamera, 'poses' | 'poseActions' | 'camera'> | null;
  pushToTalk: Pick<PushToTalk, 'held'> | null;
  context: Pick<ShellContext, 'look'> | null;
  interaction: Pick<Interaction, 'actions'> | null;
  /** The desktop panels; null until the app is ready. */
  desktop(): Pick<DesktopAssembly, 'openQuickInput' | 'notice' | 'resetOffsets'> | null;
  placer(): Pick<AvatarPlacer, 'resetPosition'> | null;
  /** The capture directory and notifyCaptureSaved. */
  capture: { dir: string; saved(file: string): void };
  /** The user hides or shows her. */
  setHidden(hidden: boolean): void;
  restartChildren(): void;
  openMain(route: string): void;
  quit(): void;
  settingsChanged(keys: string[]): void;
  /** companion.log. */
  log(line: string): void;
  /** Puts the icon in the menu bar or the notification area. */
  setIcon?(icon: IconBitmap): void;
  /** MenuPorts.handClipboard. */
  handClipboard?: (() => void) | undefined;
  /** MenuPorts.selectRegion. */
  selectRegion?: (() => void) | undefined;
  /** The main window's PlaylistHost (`avatarPlaylist` of its ops context); null or absent leaves 角色 › MMD out. */
  playlist?: () => Pick<AvatarPlaylist, 'state' | 'saved' | 'save' | 'start' | 'stop' | 'playSlot'> | null;
  /** 最近播报; absent leaves it empty. */
  recent?: Pick<RecentAnnouncements, 'rows' | 'open' | 'markAllRead'>;
}

export interface ShellMenus {
  /** Read when a menu opens; `diagnostics` when it opened with option held (showMenu(diagnostics:)). */
  state(o?: { diagnostics: boolean }): MenuState;
  /** Read when a menu opens; an absent port greys its item. */
  ports(): MenuPorts;
  /** refreshStatusIcon: after each change of a child, her visibility, recording, quiet or a character switch. */
  refreshIcon(): void;
  /** StackSource.onCount. */
  pendingApprovalsChanged(count: number): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  const state = (opened: { diagnostics: boolean } = { diagnostics: false }): MenuState => {
    const saved = o.settings();
    const hotkey = (key: string, fallback: string) => (typeof saved[key] === 'string' ? saved[key] : fallback);
    const characters = o.characters();
    // refreshObservationState: quiet, meeting and pause set elsewhere show in the icon once agentd answers.
    if (observation && o.processes().agentdConnected) void observation.load().then(refreshIcon);
    return {
      ...MENU_STATE_DEFAULTS,
      recent: o.recent?.rows() ?? [],
      showsDiagnostics: opened.diagnostics,
      services: o.services().map((line) => {
        const [name = '', ...detail] = line.split(' · ');
        return { name, detail: detail.join(' · ') };
      }),
      configError: characters ? null : '请查看设置',
      quiet: (observation?.quietUntil() ?? null) !== null,
      clickThroughAll: link?.clickThroughAll ?? false,
      freeRoam: !['stay', 'bust'].includes(saved.stay_mode as string),
      avatarHidden: link?.hidden ?? false,
      characters: characters ?? [],
      currentCharacter: current(),
      characterSwitching: switcher?.busy ?? false,
      appearances: (link?.appearances ?? []).map((a) => ({ id: a.id, name: a.name })),
      currentAppearance: link?.currentAppearance ?? null,
      // The target of a running switch is not known; "" greys the group without marking an item.
      appearanceSwitchingTo: link?.appearanceSwitching ? '' : null,
      quickInputHotkey: hotkey('hotkey_quick_input', 'control+option+space'), lookHotkey: hotkey('hotkey_look', 'control+option+l'),
      clickThroughHotkey: hotkey('hotkey_click_through', 'control+option+p'),
      plan: o.plan(),
    };
  };

  const ports = (): MenuPorts => {
    const desktop = o.desktop(), placer = o.placer(), context = o.context, recent = o.recent;
    return {
      openMain: o.openMain, quit: o.quit, log: o.log,
      look: context ? () => { void context.look(); } : undefined,
      quickInput: desktop ? () => desktop.openQuickInput() : undefined,
      // The sessions page with the session selected; one without a session leads nowhere.
      openAnnouncement: recent ? (id) => {
        const session = recent.open(id);
        if (session !== null) o.openMain(mainRoute('/overview', [['sel', session], ['focus', `task-${session}`]]));
      } : undefined,
      markAllAnnouncementsRead: recent ? () => recent.markAllRead() : undefined,
      // applyQuiet: the icon follows once agentd has it.
      setQuiet: observation ? async (until) => {
        await observation.setQuiet(until);
        refreshIcon();
      } : undefined,
      toggleClickThroughAll: interaction ? () => interaction.actions.clickThroughAll() : undefined,
      toggleFreeRoam: interaction ? () => interaction.actions.freeRoam() : undefined,
      settingsChanged: o.settingsChanged,
      toggleHidden: link ? () => o.setHidden(!link.hidden) : undefined,
      resetPosition: placer ? () => placer.resetPosition() : undefined,
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
