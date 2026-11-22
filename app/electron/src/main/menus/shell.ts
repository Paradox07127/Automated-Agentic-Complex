// The menus and the menu bar icon as index.ts wires them: the state a menu opens with, the ports its
// items call, and the icon drawn again on each change it shows.
import { mkdirSync } from 'node:fs';
import type { ActionRow } from '../../common/c3.ts';
import { iconState, MENU_STATE_DEFAULTS, type MenuBarStatus, type MenuOption, type MenuState } from '../../common/menus.ts';
import type { Subsystem } from '../../common/plugins.ts';
import type { PushToTalk } from '../../common/push-to-talk.ts';
import type { RecentAnnouncements } from '../../common/recent-announcements.ts';
import { mainRoute } from '../../common/stack-cards.ts';
import type { CharacterSwitch } from '../../common/switch.ts';
import { poseMenu } from '../camera/pose.ts';
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
  const { link, looks, switcher, observation, camera, interaction } = o;
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
  /** Each character's actions as the last menu open read them. */
  const motionActions = new Map<string, ActionRow[]>();
  /** The slot last played from the menu, null once 连播 starts. */
  let playedSlot: string | null = null;

  /** mmdSlots: the current character's `mmd_` actions, the ones in its list first in list order, the rest in action order. */
  const mmd = (): Pick<MenuState, 'motionSlots' | 'playingSlot' | 'playlistLoop' | 'playlistPlaying'> => {
    const character = current(), playlist = o.playlist?.() ?? null;
    if (character === null || !playlist) return { motionSlots: [], playingSlot: null, playlistLoop: 'off', playlistPlaying: false };
    // There is no synchronous read: this open shows the list the previous one fetched, and a failed read leaves none (`try?`).
    void link?.actions(character).then((a) => motionActions.set(character, a.actions), () => motionActions.delete(character));
    const saved = playlist.saved(character);
    const rank = (id: string) => (saved.items.includes(id) ? saved.items.indexOf(id) : saved.items.length);
    const motionSlots = (motionActions.get(character) ?? []).filter((a) => a.id.startsWith('mmd_')).map((a, i) => ({ a, i }))
      .sort((x, y) => rank(x.a.id) - rank(y.a.id) || x.i - y.i).map(({ a }) => ({ id: a.id, name: a.name }));
    const s = playlist.state;
    if (s.kind !== 'playing') return { motionSlots, playingSlot: null, playlistLoop: saved.loop, playlistPlaying: false };
    return { motionSlots, playingSlot: playedSlot ?? saved.items[s.index] ?? null, playlistLoop: saved.loop, playlistPlaying: true };
  };

  const state = (opened: { diagnostics: boolean } = { diagnostics: false }): MenuState => {
    const saved = o.settings();
    const hotkey = (key: string, fallback: string) => (typeof saved[key] === 'string' ? saved[key] : fallback);
    const poses = camera ? poseMenu(camera.poses) : null;
    const characters = o.characters();
    const appearance = link?.currentAppearance ?? null, hidden = link?.hiddenLayers ?? [];
    // refreshObservationState: quiet, meeting and pause set elsewhere show in the icon once agentd answers.
    if (observation && o.processes().agentdConnected) void observation.load().then(refreshIcon);
    return {
      ...MENU_STATE_DEFAULTS,
      ...mmd(),
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
      currentAppearance: appearance,
      // The target of a running switch is not known; "" greys the group without marking an item.
      appearanceSwitchingTo: link?.appearanceSwitching ? '' : null,
      layers: (link?.layers ?? []).filter((l) => l.appearances?.some((a) => a === appearance) ?? true)
        .map((l) => ({ id: l.id, name: l.name, visible: !hidden.includes(l.id) })),
      layersSwitching: link?.layersSwitching ?? false,
      poses: poses?.options.map((p) => ({ slot: p.slot, title: p.title, id: p.id, available: p.available })) ?? [],
      currentPose: poses?.current ?? null, poseLocked: poses?.locked ?? false,
      cameraFree: link?.capabilities.includes('camera_free') ?? false,
      canCapture: link?.capabilities.includes('capture') ?? false,
      quickInputHotkey: hotkey('hotkey_quick_input', 'control+option+space'), lookHotkey: hotkey('hotkey_look', 'control+option+l'),
      clickThroughHotkey: hotkey('hotkey_click_through', 'control+option+p'),
      plan: o.plan(),
    };
  };

  const ports = (): MenuPorts => {
    const desktop = o.desktop(), placer = o.placer(), context = o.context, playlist = o.playlist?.() ?? null, recent = o.recent;
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
      toggleLayer: looks && link ? (id) => {
        const now = link.hiddenLayers, hidden = now.includes(id) ? now.filter((h) => h !== id) : [...now, id];
        looks.setLayers(hidden).catch((e: unknown) => o.log(`layers hidden=${hidden.join(',')} failed: ${message(e)}`));
      } : undefined,
      setPose: camera ? (id) => camera.poseActions.setPose(id) : undefined,
      beginCamera: camera ? () => { camera.camera.begin(); } : undefined,
      togglePoseLock: camera ? () => camera.poseActions.togglePoseLock() : undefined,
      restartChildren: o.restartChildren,
      capture: link ? {
        take: async () => {
          mkdirSync(o.capture.dir, { recursive: true });
          return (await link.capture('transparent')).file;
        },
        saved: o.capture.saved,
      } : undefined,
      giveGift: interaction ? () => {
        void interaction.actions.gift().catch((e: unknown) => o.desktop()?.notice(message(e)));
      } : undefined,
      resetPanels: desktop ? () => desktop.resetOffsets() : undefined,
      handClipboard: o.handClipboard,
      selectRegion: o.selectRegion,
      playSlot: playlist ? (id) => {
        playedSlot = id;
        playlist.playSlot(id);
      } : undefined,
      playPlaylist: playlist ? () => {
        playedSlot = null;
        playlist.start(0);
      } : undefined,
      stopPlaylist: playlist ? () => playlist.stop() : undefined,
      setPlaylistLoop: playlist ? (loop) => {
        const character = current();
        if (character === null || (loop !== 'off' && loop !== 'one' && loop !== 'all')) return;
        try {
          playlist.save(character, { ...playlist.saved(character), loop });
        } catch (e) {
          o.log(`playlist loop=${loop} failed: ${message(e)}`);
        }
      } : undefined,
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
