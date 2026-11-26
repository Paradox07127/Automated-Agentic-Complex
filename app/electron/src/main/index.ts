// Electron main process: serves web/dist (from the repo with `--dev-web-server`, the vite dev server's pages) at
// agentic-complex-ui://app/, opens the main window, keeps a tray icon.
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, screen,
  shell, systemPreferences, Tray, webContents,
  type NativeImage, type Rectangle,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import routes from '../../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { a11ySource } from '../common/a11y.ts';
import { appearanceOf, applyAppearance, glassSupported, mainWindowGround } from '../common/appearance.ts';
import { type ChildState } from '../common/agentd.ts';
import type { Rect as HelperRect } from '../common/attention.ts';
import { boot, BridgeFailure, handle, type Handler, type Reply, type Surface } from '../common/bridge.ts';
import { computerUseState } from '../common/computer-control.ts';
import type { ActionPlayed } from '../common/c3.ts';
import { DesktopPlay } from '../common/desktop-action.ts';
import { avatarHovered } from '../common/desktop-hover.ts';
import { AVATAR_STAGE_TITLES } from '../common/stack-source.ts';
import { shownFrame } from '../common/keepclear.ts';
import type { Rect } from '../common/placement.ts';
import { rendererPreflight } from '../common/components.ts';
import { type Config, configLogLine, launchCharacter, SERVICE_IDS, type ServiceId, statusTitle, webLogsDir } from '../common/config.ts';
import { FeedSource, SharedSource } from '../common/feed.ts';
import { processStatus } from '../common/menus.ts';
import { hookCommand } from '../common/onboarding.ts';
import { PageSession } from '../common/page.ts';
import { DEFAULT_PLUGINS, enabledPlugins, shellPlan, type Subsystem } from '../common/plugins.ts';
import { PushSource } from '../common/push.ts';
import { desktopScreens } from '../common/desktop-screens.ts';
import { DEV_WEB_FLAG, devWebServer } from '../common/dev-web.ts';
import { RecentAnnouncements } from '../common/recent-announcements.ts';
import { PushToTalk, pushToTalkState, speechLocale } from '../common/push-to-talk.ts';
import { startupWindow } from '../common/startup.ts';
import { trayTitle } from '../common/tray-title.ts';
import { TurnMarks } from '../common/turn-marks.ts';
import { agentdTts, diagTts, RuntimeCoordinator, runtimeJson } from '../common/runtime.ts';
import { current, desktopHotkeys, settingValues } from '../common/settings.ts';
import { CharacterSwitch } from '../common/switch.ts';
import { ORIGIN, SCHEME } from '../common/ui.ts';
import { AvatarVisibility } from '../common/visibility-reason.ts';
import { AgentdClient, FeedClient } from './agentd/client.ts';
import { agentdForwarding } from './agentd/forward.ts';
import { AgentStore } from './agentd/store.ts';
import { AgentdSupervisor } from './agentd/supervisor.ts';
import type { AmbientSampler } from './ambient/sampler.ts';
import { ambientOffers, shellAmbient } from './ambient/shell.ts';
import { AxWatchMux } from './attention/ax-watch.ts';
import { BlacklistFile } from './attention/blacklist.ts';
import { shellAttention } from './attention/shell.ts';
import { helperYFor, shellRecorders, shellWatchers, surfaceLinkOptions } from './attention/watchers.ts';
import { CameraOverlayWindow } from './camera/overlay.ts';
import { PhotoOverlayWindow } from './camera/photo-overlay.ts';
import { desktopPoses, wheelPose } from './camera/pose.ts';
import { CAMERA_OFFERS, shellCamera } from './camera/shell.ts';
import { feedCommands } from './commands/feed.ts';
import { looksCommands } from './commands/looks.ts';
import {
  configPathFromArgs, DEFAULT_AGENTD_STATE_DIR, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR, lastCharacter, loadConfig, quitAfterFromArgs, supportDirOf,
} from './config.ts';
import { agentdLook, anyOwnCapture, lookReceipt, shellContext, type ShellContext } from './context/shell.ts';
import { CONTROL_PANEL_WINDOW, ControlPanel } from './control/panel.ts';
import { shellControl } from './control/shell.ts';
import { regExe, syncBrowserHost } from './browser-host.ts';
import { DesktopAssembly } from './desktop/assembly.ts';
import { trayClick, trayClickOf } from './desktop/tray.ts';
import { devReload } from './dev-reload.ts';
import { devWebResponse } from './dev-web.ts';
import { DropHandover, opsMotionImport } from './handover/drop.ts';
import { shellWindowHandover } from './handover/window.ts';
import { HotkeyRecorder } from './hotkeys/record.ts';
import { type ShellHotkeys, shellHotkeys, unregisteredHotkeys } from './hotkeys/shell.ts';
import { interactionShell } from './interaction/shell.ts';
import { appendLog, flushErrors, recordError } from './log.ts';
import { appMenu, pageShortcut } from './menus/app.ts';
import { SettingsChanges } from './menus/items.ts';
import { type IconBitmap, iconBitmap, squareIcon } from './menus/icon.ts';
import { openAnnouncement, shellMenus } from './menus/shell.ts';
import { trayContextMenu } from './menus/tray.ts';
import { SystemNotifier } from './notify/system.ts';
import { greetOnDesktop, onboardingWindow, type OnboardingDestination, playToEnd } from './onboarding/window.ts';
import { adoptPasted, adoptPaths, clearPasted, filePage, SCOPE_FILE_TYPES } from './ops/adopt.ts';
import { bundleBuild } from './ops/app.ts';
import { cpuSecondsReader, processUsageReader } from './ops/avatar.ts';
import { characterArt, dropMmdScans, mmdScanRoot, shellMmdSync } from './ops/character.ts';
import { reloadAvatar } from './ops/holding.ts';
import { watch } from './ops/events.ts';
import { type OpsContext, registry } from './ops/index.ts';
import { ObservationControl } from './ops/observation.ts';
import { sessionsRoute } from './ops/open.ts';
import { saveSettings, settingsOps } from './ops/settings.ts';
import { ProcessHistory, processState } from './ops/supervisor.ts';
import { runAgentdTool, validationHost } from './ops/tools.ts';
import { HelperSupervisor } from './helper/supervisor.ts';
import { type PackagedLaunch, packagedConfigPath, packagedContents, preparePackaged, webRoot } from './packaged.ts';
import { AvatarPlacer } from './placement/controller.ts';
import { ResizeOverlayWindow } from './placement/resize-overlay.ts';
import { nextTraceEpoch } from './placement/store.ts';
import {
  c3Dip, c3Space, c3Transport, helperExecutable, hideFromDock, makeOverlay, osName, overlayOptions, playAlert, previewAddon, pythonFlags,
  setNotificationId, shellPlatform, trayImage,
} from './platform/index.ts';
import type { PlacementSpace } from './platform/screens.ts';
import { PreviewController } from './preview/controller.ts';
import { loadMotionLibrary } from './preview/library.ts';
import { activeDevice, PipeTransport } from './preview/pipe.ts';
import { type PreviewAddon, WindowPreview } from './preview/window.ts';
import { CAPTURE_OFFERS, linkAvatarHost, MOTION_OFFERS, resendStoredOverrides } from './renderer/avatar-host.ts';
import { HostLink, hostPipePath, hostSocketPath, previewPipePath } from './renderer/link.ts';
import { AvatarLooks, linkSwitchPorts, rememberedLooks } from './renderer/looks.ts';
import { quitOnSignals } from './quit.ts';
import { rendererReports } from './renderer/reports.ts';
import { liveSaved } from './renderer/saved.ts';
import { WeatherDriver } from './renderer/weather.ts';
import { type Loading, lookArguments, RendererSupervisor } from './renderer/supervisor.ts';
import { singleInstance } from './single-instance.ts';
import { TitleOverlay, titleNames, titleScreen } from './title/overlay.ts';
import { ServiceSupervisor } from './services/supervisor.ts';
import { uiServer, type UiResponse } from './ui-scheme.ts';
import { velopackStartup } from './velopack.ts';
import { guardWebContents, type WebGuardPorts } from './web-guard.ts';
import { c3Cursor, currentCharacterOf, handleNudge, helloBuild, notifySettings, pagesRoot, refreshRoster } from './wiring.ts';

// Before any other startup code: a Velopack hook run must exit without taking the lock, a window or a child.
if (shellPlatform() === 'windows') await velopackStartup();

/** Put in by build.mjs: the checkout's commit, and the release profile's UI art directory relative to the checkout. */
declare const AAC_BUILD_GIT: string | undefined;
declare const AAC_UI_ART: string | undefined;

// This file is bundled to app/electron/dist/main.mjs.
const WEB_DIST = resolve(import.meta.dirname, '../../../web/dist');
/** The web-ui component's ui/art (build_components.py `copy_ui_art`) from its source; null without one. */
const UI_ART = typeof AAC_UI_ART === 'string' && AAC_UI_ART !== '' ? resolve(import.meta.dirname, '../../..', AAC_UI_ART) : null;
const PRELOAD = join(import.meta.dirname, 'preload.cjs');
/** Without a composition lock there is no agentd component to take the launcher from. */
const LAUNCHER = resolve(import.meta.dirname, '../../Resources/agentd_launcher.py');
/** The repo's app/, under which the platform helper is built. */
const APP_DIR = resolve(import.meta.dirname, '../..');

/** The app bundle's `Resources`; a packaged app has `distribution.json` there (packaged.ts). */
const RESOURCES = process.resourcesPath;
const CONTENTS = packagedContents(RESOURCES);
const PYTHON_FLAGS = pythonFlags(CONTENTS !== null);
/** The vite dev server the pages come from; never for a packaged app. */
const DEV_WEB = devWebServer(process.argv, CONTENTS !== null);
/** The served root with DEV_WEB: only `art/` and `characters/` are read under it. */
const WEB_SRC = resolve(import.meta.dirname, '../../../web');
/** parent_watch.py: beside the packaged app's resources, else the repo's. */
const WATCHER = CONTENTS === null ? resolve(import.meta.dirname, '../../Resources/parent_watch.py') : join(RESOURCES, 'parent_watch.py');
const SUPPORT_BASE = dirname(DEFAULT_SUPPORT_DIR);
/** A `--config` run prepares nothing of the packaged app's and touches none of its files. */
const explicitConfig = process.argv.includes('--config');
/** The packaged launch failed: config.json is not loaded and the config error shows. */
let bootstrapError: unknown = null;
const configPath = (() => {
  if (!explicitConfig) {
    try {
      return packagedConfigPath(RESOURCES, SUPPORT_BASE) ?? configPathFromArgs(process.argv);
    } catch (e) {
      bootstrapError = e;
    }
  }
  return configPathFromArgs(process.argv);
})();
// A packaged config.json sits in its support dir, also before preparePackaged first writes it.
const supportDir = supportDirOf(configPath, explicitConfig ? DEFAULT_SUPPORT_DIR : dirname(configPath));
/** Where the renderer writes `photo.capture`'s files. */
const CAPTURE_DIR = join(homedir(), 'Pictures/Agentic Complex');
// Chromium's profile stays with the support dir, so a `--config` run touches nothing of the installed app.
app.setPath('userData', join(supportDir, 'electron'));
/** Resolved at the end of the start-up in app.whenReady below. */
let started = () => {};
const shellStarted = new Promise<void>((resolve) => { started = resolve; });
// One instance per support dir, taken before the packaged launch writes anything; a later launch shows the main window.
if (!singleInstance({ requestLock: () => app.requestSingleInstanceLock(),
  on: (event, listener) => (event === 'activate' ? app.on(event, listener) : app.on(event, listener)),
  ready: shellStarted, showMain: () => openMain(), pid: process.pid, appPath: app.getAppPath(),
  log: (line) => appendLog(supportDir, 'companion', line) })) process.exit(0);
appendLog(supportDir, 'companion', `STARTED pid=${process.pid} app=${app.getAppPath()} config=${configPath}`);
let packaged: PackagedLaunch | null = null;
if (!explicitConfig && bootstrapError === null) {
  try {
    packaged = preparePackaged({ resources: RESOURCES, supportBase: SUPPORT_BASE, agentdStateDir: DEFAULT_AGENTD_STATE_DIR, platform: shellPlatform() });
  } catch (e) {
    bootstrapError = e;
  }
}
/** `app.runtime`; `runtimeChanged` sends it what this shell reads of its parts. */
const runtime = new RuntimeCoordinator(Date.now);
const runtimeEvents = new PushSource('runtime');
runtime.observe((s) => runtimeEvents.send(runtimeJson(s)));
let config: Config | null = null;
try {
  if (bootstrapError !== null) throw bootstrapError;
  config = loadConfig(configPath);
} catch (e) {
  appendLog(supportDir, 'companion', configLogLine(e));
  runtime.send({ kind: 'configError', error: e instanceof Error ? e.message : String(e) });
}
let agentdState: ChildState = { kind: 'stopped' };
let helperState: ChildState = { kind: 'stopped' };
let rendererState: ChildState = (config && rendererPreflight(config)) ?? { kind: 'stopped' };
const launched = config ? launchCharacter(config, lastCharacter(config.supportDir)) : '';

/** A JSON object file as read; null when it is missing or not an object. */
const savedCache = new Map<string, { mtimeMs: number; size: number; value: Record<string, unknown> | null }>();

function readSaved(path: string): Record<string, unknown> | null {
  try {
    const st = statSync(path);
    const hit = savedCache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const value = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
    savedCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return null;
  }
}

/** A JSON object file as read; `{}` when it is missing or not an object. */
function readObject(path: string): Record<string, unknown> {
  return readSaved(path) ?? {};
}

const transport = c3Transport();
const runtimePath = config ? join(config.agentdStateDir, 'ui-runtime.json') : null;
const agentdClient = runtimePath === null ? null : new AgentdClient(runtimePath);
/** The link's trace, behavior receipts and motion requests on their way to agentd. */
const forwarding = agentdClient === null ? null : (() => {
  const client = agentdClient;
  return agentdForwarding({
    epoch: Date.now(),
    post: async (path, body) => {
      try {
        const reply = await client.request('POST', path, body);
        let json: unknown = null;
        try {
          json = JSON.parse(reply.body.toString('utf8'));
        } catch { /* not JSON: null */ }
        return { status: reply.status, body: json };
      } catch {
        return { status: 0, body: null };
      }
    },
    log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`),
  });
})();
/** The T1 marks of the lines 快速输入, 按住说话 and the main window hand to agentd. */
const turnMarks = forwarding && new TurnMarks(forwarding.mark);
/** Made at the first cursor sample, after the app is ready. */
let cursorSpace: PlacementSpace | null = null;
const surfaceOptions = surfaceLinkOptions(process.argv, (e) => watchers?.track(e));
/** What the link reports to agentd beside trace and receipts (renderer/reports.ts). */
const reports = config && agentdClient !== null ? rendererReports({
  agentd: agentdClient, agentdRunning: () => agentdState.kind === 'running', settings: () => readObject(configPath),
  dockOpen: () => desktop?.dockShown ?? false,
  log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`),
  companionLog: (line) => appendLog(config!.supportDir, 'companion', line),
  stroke: (token) => desktop?.stroke(token),
}) : null;
/** What is dropped on her or handed over from the clipboard, on its way to the cards. */
const drops = config && new DropHandover({
  desktop: () => desktop && { addDrop: (items, truncated) => desktop!.source.addDrop(items, truncated), notice: (text) => desktop!.notice(text) },
  importMotion: (files) => opsMotionImport(opsContext('main'))(files),
  log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`),
});
const hostLink = config && new HostLink({
  path: transport === 'pipe' ? hostPipePath(config.supportDir) : hostSocketPath(config.supportDir, process.getuid?.() ?? 0),
  transport, pid: process.pid, build: helloBuild(app.getVersion(), typeof AAC_BUILD_GIT === 'string' ? AAC_BUILD_GIT : undefined),
  cursor: () => c3Cursor(cursorSpace ??= c3Space(screen), screen.getCursorScreenPoint()),
  // Annotated: `watchers` is made from this link, so its type cannot come from here.
  buttonsDown: (): boolean => watchers?.buttonsDown ?? false,
  traceEpoch: () => nextTraceEpoch(config!.supportDir),
  recordError: (e) => recordError(config!.supportDir, e),
  ...(forwarding && { onTrace: forwarding.onTrace, onBehaviorReceipt: forwarding.onBehaviorReceipt, onMotionState: forwarding.onMotionState,
    onUserPlay: forwarding.onUserPlay, onMotionRequest: forwarding.onMotionRequest, onReaction: forwarding.onReaction, onDragBegin: forwarding.onDragBegin }),
  ...reports?.options,
  onClick: (e) => interaction?.click(e),
  onRightDrag: (e) => interaction?.rightDrag(e),
  onMoving: (on) => desktop?.setMoving(on),
  onDrop: (d) => drops?.drop(d),
  onDragRelease: (at, excludedPids) => windowHandover?.(at, excludedPids),
  onPoseState: (s) => camera?.poses.state(s), onCameraGesture: (g) => camera?.camera.gesture(g),
  onPresentationState: (s) => weather?.state(s),
  fps: () => {
    const s = readObject(configPath);
    return { idleLowFps: s.idle_low_fps === true, userFps: [30, 45, 60].includes(Number(s.render_fps)) ? Number(s.render_fps) : 60,
      batteryLow: s.battery_low_fps !== false };
  },
  log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`),
  remembered: config ? rememberedLooks(config.supportDir, configPath) : undefined,
  ...surfaceOptions,
  offers: [...(surfaceOptions.offers ?? []), ...ambientOffers(process.argv), ...MOTION_OFFERS, ...CAPTURE_OFFERS, ...CAMERA_OFFERS],
});
if (reports) hostLink?.on(reports.linkEvent);
// The stored motion overrides again on each list she sends.
if (config && hostLink) resendStoredOverrides(hostLink, configPath, (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`));
/** Her appearance, layers, action switches and mod settings, remembered in state.json and config.json. */
const looks = config && hostLink && new AvatarLooks({ link: hostLink, supportDir: config.supportDir, configPath,
  log: (line) => appendLog(config!.supportDir, 'companion', line) });
looks?.start();
/** The 天气 rows onto the desktop renderer. */
const weather = config && hostLink && new WeatherDriver({ link: hostLink,
  settings: () => {
    try {
      return readObject(configPath);
    } catch (e) {
      appendLog(config!.supportDir, 'companion', `weather: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  },
  log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`) });
/** The gesture camera, the conversation close-up and the poses (camera/shell.ts); 调整镜头's window is not there yet. */
/** 调整镜头's window, kept to end it at quit. */
let cameraOverlay: CameraOverlayWindow | null = null;
const camera = config && hostLink && shellCamera({ link: hostLink, configPath, avatarPid: () => renderer?.pid,
  save: (values) => saveSettings(configPath, values), settingsChanged: (keys) => settingsChanges.changed(keys),
  restartAvatar: () => { void renderer?.restart(); },
  // HostLink.avatarFigureFrame: her visual rect, else her body's, else her window's.
  figure: () => {
    const s = placer?.anchorSample(), r = c3Rect(s?.visual ?? s?.body ?? null);
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : hostLink.avatarFrame;
  },
  // Made now, used at the first 调整镜头: what it reads is defined further down.
  overlay: (target) => cameraOverlay = new CameraOverlayWindow({
    url: `${ORIGIN}/stack.html#/camera`,
    makeWindow: () => {
      const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      makeOverlay(win, 'camera', macAddon);
      guardWebContents(win.webContents, 'stack', webGuard);
      return win;
    },
    toDip: (r) => c3Dip(screen)(r), fromC3: (b) => (cursorSpace ??= c3Space(screen)).rectFromC3(b),
    screens: () => (cursorSpace ??= c3Space(screen)).screens(), cursor: () => screen.getCursorScreenPoint(),
    presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
    register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
    unregister: (id) => pages.delete(id),
    get baseOps() { return overlayOps('camera'); },
    camera: target,
  }),
  log: (line) => appendLog(config!.supportDir, 'companion', line) });
/** What the user plays on her, for the desktop wheel's 停止; the panels hear each change. */
const play = new DesktopPlay();
hostLink?.on((e) => {
  const changed = e.kind === 'lost' ? play.lost() : e.kind === 'message' && e.message.type === 'action_played' && play.played(e.message as ActionPlayed);
  // The wheel's 拍照 follows her hello's `capture`.
  if (changed || e.kind === 'hello' || e.kind === 'lost') desktop?.pushState();
});
/** Made once the app is ready: Electron's `screen` is not there before. */
let placer: AvatarPlacer | null = null;
/** 调整大小's window, kept to end it at quit. */
let resizeOverlay: ResizeOverlayWindow | null = null;
/** 拍照's window, kept to end it at quit. */
let photoOverlay: PhotoOverlayWindow | null = null;
const renderer = config && new RendererSupervisor({
  config, reload: () => loadConfig(configPath), settings: () => readObject(configPath), state: () => readObject(join(config!.supportDir, 'state.json')),
  // The last character a switch remembered, as at the app's launch.
  character: () => launchCharacter(config!, lastCharacter(config!.supportDir)),
  placement: (character) => placer?.launchPlacement(character) ?? null, link: hostLink,
  captureDir: CAPTURE_DIR, platform: shellPlatform(), previewRendezvous: () => addon?.rendezvous() ?? undefined,
  onStatus: (state) => {
    rendererState = state;
    // The sampler runs while she does.
    if (state.kind === 'running') ambient?.start();
    else ambient?.stop();
    runtimeChanged();
  },
  onLoading: (loading) => showAvatarLoading(loading),
});
// The watchdog's kill goes to the process whose hello it watched.
hostLink?.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer?.pid) renderer.kill(e.reason); });
/** The `services` the shell runs a process for (`ssh`, `local`); the others start nothing. */
const services = config && new Map(SERVICE_IDS.map((id) => [id, new ServiceSupervisor({
  id, config, watcherScript: WATCHER,
  onStatus: () => runtimeChanged(),
})]));
/** 重启后台, 重启子进程 and a saved record start the services (all, or `only`) again with config.json read again. */
function restartServices(what: string, only?: ServiceId): void {
  if (!services) return;
  let fresh: Config;
  try {
    fresh = loadConfig(configPath);
  } catch (e) {
    appendLog(supportDir, 'companion', `restart ${what}: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const [id, service] of services) if (only === undefined || id === only) void service.restart(fresh);
}
const supervisor = config && new AgentdSupervisor({
  config, reload: () => loadConfig(configPath), launcherScript: config.agentdLauncher ?? LAUNCHER, pythonFlags: PYTHON_FLAGS,
  // Read at each start: a switch or the first import changes it.
  character: (c) => launchCharacter(c, lastCharacter(c.supportDir)),
  privacyConfigPath: configPath, onStatus: (state) => {
    agentdState = state;
    runtimeChanged();
    // Before agentd first runs there is no ui-runtime.json; connecting earlier only grows the reconnect backoff.
    if (state.kind === 'running') {
      setAppMenu();
      if (shellPlatform() === 'windows') {
        void syncBrowserHost(supervisor!.plugins.screen_awareness, { supportDir: config.supportDir, agentdStateDir: config.agentdStateDir,
          python: config.python, pythonFlags: PYTHON_FLAGS, script: resolve(config.agentdDir, '..', 'browser', 'native_host.py'),
          registry: regExe(), log: (line) => appendLog(config.supportDir, 'companion', line) });
      }
      store?.start();
      void seedTts(state);
      renderer?.startIfStopped();
      // Ready once the character is read, for this run only.
      void switcher?.agentdReady().then(() => { if (agentdState === state) runtime.send({ kind: 'agentdReady' }); });
      void observation?.load().then(() => menus.refreshIcon());
      reports?.agentdReady();
    }
    desktop?.agentd(state.kind === 'running');
    // No 按住说话 while the character switches.
    pushToTalk?.agentd(state.kind === 'running' && !switcher?.busy && plan().has('pushToTalk'));
    attention?.agentd(state.kind === 'running');
    // The context capture after the attention sampler.
    context?.agentd(state.kind === 'running' && plan().has('context'));
    recorders?.agentd(state.kind === 'running');
  },
  onHealth: (stage, degraded) => runtime.send({ kind: 'agentdHealth', stage, degraded }),
});
/** shellPlan of the plug-ins agentd runs with: a 重启后台 after a plug-in changed applies it to what starts with agentd. */
const plan = (): ReadonlySet<Subsystem> => shellPlan(supervisor?.plugins ?? DEFAULT_PLUGINS);
/** The platform addon: on macOS the preview's Mach rendezvous with the renderer and the desktop panels' `setPreventsActivation`,
 *  on Windows the preview's named pipe. */
const nativeAddon = config ? previewAddon(join(import.meta.dirname, 'native/preview.node')) : null;
const macAddon = nativeAddon && 'mac' in nativeAddon ? nativeAddon.mac : null;
/** The GPU process has reported its device: the Windows preview checks the renderer's adapter against it. */
const gpuReported = new Promise<void>((resolve) => app.once('gpu-info-update', () => resolve()));
/** The preview's transport to the renderer. */
const addon: PreviewAddon | null = nativeAddon === null ? null : 'mac' in nativeAddon ? nativeAddon.mac : new PipeTransport({
  addon: nativeAddon.pipe, name: previewPipePath(config!.supportDir, process.pid), log: (line) => log(line),
  gpu: async () => { await gpuReported; return activeDevice(await app.getGPUInfo('complete')); },
});
/** The character page's live preview; none without a renderer link or the preview's rendezvous. */
const preview = (() => {
  const service = addon?.rendezvous() ?? null;
  if (!config || !hostLink || !addon || service === null) return null;
  const catalog = config.characterCatalog;
  return new PreviewController({
    view: new WindowPreview({ addon, service, platform: shellPlatform(), window: () => mainWindow, log: (line) => log(line) }),
    avatar: () => ({ character: currentCharacterOf(switcher, hostLink, launched), appearance: hostLink.currentAppearance,
      hiddenLayers: hostLink.hiddenLayers }),
    library: async (id) => (catalog ? loadMotionLibrary(catalog, id, shellPlatform()) : null),
    modSettings: (id) => looks?.modSettings(id) ?? {},
    renderArgs: () => [...lookArguments(readObject(configPath)), '--agentic-complex-scene-stage', 'charinfo'],
  });
})();
/** The renderer restart after a package write; the preview keeps each action's old bundle until told. */
const restartAfterPackageChange = () => { void renderer?.restart(); preview?.packagesChanged(); };
/** The character switch over the renderer link and agentd. */
const switcher = config && hostLink && (() => {
  const client = agentdClient;
  const sw = new CharacterSwitch(linkSwitchPorts({
    link: hostLink, supportDir: config.supportDir, agentd: client && ((method, path, json) => client.request(method, path, json)),
    agentdRunning: () => agentdState.kind === 'running', restartAvatar: () => { void renderer?.restart(); },
    renderable: (id) => config!.characters.find((c) => c.id === id)?.renderEnabled !== false,
    log: (line) => appendLog(config!.supportDir, 'companion', line),
  }));
  hostLink.on((e) => { if (e.kind === 'character') sw.avatar(e.event); });
  return sw;
})();
/** The shared MMD library baked into each new current character. */
const mmdSync = config?.characterCatalog && hostLink && switcher ? shellMmdSync({
  catalog: config.characterCatalog,
  runTool: (script, args, progress, signal) => runAgentdTool(config!.python, PYTHON_FLAGS, config!.agentdDir, script, args, progress, signal),
  validationHost: () => validationHost(config!.avatarExecutable, config!.avatarApp),
  reload: () => reloadAvatar({ switcher, supervisor: { restartAvatar: restartAfterPackageChange },
    log: (line) => appendLog(config!.supportDir, 'companion', line) }, hostLink),
  current: () => switcher.current,
  log: (line) => appendLog(config!.supportDir, 'companion', `AVATAR ${line}`),
}) : null;
/** 雷霆大字's window (title/overlay.ts) at each completed switch; its BrowserWindow is made at each title. */
const titleOverlay = config && new TitleOverlay({
  url: `${ORIGIN}/stack.html#/title`,
  makeWindow: () => {
    const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    makeOverlay(win, 'title', macAddon);
    guardWebContents(win.webContents, 'stack', webGuard);
    return win;
  },
  toDip: (r) => c3Dip(screen)(r),
  screen: () => titleScreen(placer?.currentScreen() ?? null, (cursorSpace ??= c3Space(screen)).screens()),
  names: (id) => (config.characterCatalog ? titleNames(config.characterCatalog, id) : null)
    ?? { name: config.characters.find((c) => c.id === id)?.name ?? id, en: '' },
  enabled: () => readObject(configPath).switch_title !== false,
});
if (switcher) {
  switcher.onChange = (view) => {
    runtime.send({ kind: 'character', view });
    titleOverlay?.view(view);
    void mmdSync?.sync.follow(view.current);
    pushToTalk?.agentd(agentdState.kind === 'running' && !view.switching && plan().has('pushToTalk'));
    menus.refreshIcon();
    desktop?.pushState();
  };
}
const store = runtimePath === null ? null : new AgentStore(runtimePath, undefined, (line) => appendLog(config!.supportDir, 'companion', line));
/** voice_state events seen; a /diag/state read that one overtook is dropped. */
let voiceStates = 0;
store?.subscribe((e) => {
  const tts = e.event === 'voice_state' ? agentdTts(e.data) : null;
  if (!tts) return;
  voiceStates += 1;
  runtime.send({ kind: 'tts', view: tts });
});
/** agentd sends voice_state only on a change: the voice it starts with is read once per run. */
async function seedTts(run: ChildState): Promise<void> {
  if (agentdClient === null) return;
  const seen = voiceStates;
  try {
    const reply = await agentdClient.request('GET', '/diag/state');
    const tts = reply.status === 200 ? diagTts(JSON.parse(reply.body.toString('utf8'))) : null;
    if (tts && agentdState === run && voiceStates === seen) runtime.send({ kind: 'tts', view: tts });
  } catch (e) {
    appendLog(config!.supportDir, 'companion', `tts state: /diag/state failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
store?.subscribe((e) => turnMarks?.feed(e));
store?.subscribe((e) => void handleNudge(e, hostLink, helper, { helperY: helperYFor(shellPlatform()), mainHeight: () => screen.getPrimaryDisplay().bounds.height },
  (line) => appendLog(config!.supportDir, 'companion', line)));
const sharedBlacklist = config && !process.argv.includes('--no-attention')
  ? new BlacklistFile(join(config.agentdStateDir, 'blacklist.json')).watch()
  : null;
let axWatch: AxWatchMux | null = null;
/** The C12 platform helper; the ops reach it through `OpsContext.helper`. */
const helper = config && new HelperSupervisor({
  executable: helperExecutable(APP_DIR, undefined, CONTENTS), supportDir: config.supportDir, clientVersion: app.getVersion(),
  onStatus: (state) => {
    helperState = state;
    axWatch?.helper(state.kind === 'running');
    pushToTalk?.helper(state.kind === 'running');
    attention?.helper(state.kind === 'running');
    watchers?.helper(state.kind === 'running');
    recorders?.helper(state.kind === 'running');
    context?.helper(state.kind === 'running');
    control?.helper(state.kind === 'running');
  },
  onEvent: (e) => {
    axWatch?.event(e.event, e.data);
    pushToTalk?.event(e.event, e.data);
    attention?.event(e.event, e.data);
    watchers?.event(e.event, e.data);
    recorders?.event(e.event, e.data);
    ambient?.event(e.event, e.data);
    context?.event(e.event, e.data);
    control?.event(e.event, e.data);
  },
});
axWatch = helper && !process.argv.includes('--no-attention') ? new AxWatchMux(helper) : null;
/** The status monitor's CPU and memory readings, shared across surfaces via `ac-helper` when running. */
const processUsage = helper ? processUsageReader(helper) : null;
const cpuSeconds = processUsage ? processUsage.cpuSeconds : cpuSecondsReader(shellPlatform(), null);
const residentMB = processUsage?.residentMB ?? null;
/** supervisor.state's `history`: one sampler from launch, read by every surface. */
const processHistory = new ProcessHistory({
  platform: shellPlatform(), cpuSeconds, residentMB, services: services && { view: (id) => services.get(id)!.view },
  supervisor: supervisor && { state: () => supervisor.state, pid: () => supervisor.pid, avatar: () => rendererState, avatarPid: () => renderer?.pid },
});
processHistory.start();
/** A test run's switch: push-to-talk is left out, so the helper registers no key and opens no microphone. */
const noPushToTalk = process.argv.includes('--no-push-to-talk');
/** `voice.onPushToTalk`'s values; sent as they come, none replayed. */
const pushToTalkEvents = new PushSource('state', { replay: false });
/** `voice.onTrial`'s values for the guide's voice step. */
const voiceTrials = new PushSource('trial', { replay: false });
/** 按住说话 over the helper. */
const pushToTalk = config && helper && agentdClient !== null && !noPushToTalk ? (() => {
  const client = agentdClient;
  const hotkey = readObject(configPath).voice_hotkey;
  return new PushToTalk(typeof hotkey === 'string' ? hotkey : 'right_option', {
    helper,
    agentd: async (method, path, json, headers) => {
      const reply = await client.request(method, path, json, headers);
      return { status: reply.status, body: reply.body.toString('utf8') };
    },
    ...(turnMarks && { marks: turnMarks }),
    stopSpeech: (generation) => { hostLink?.stopSpeech(generation); },
    onHint: (hint) => {
      pushToTalkEvents.send(pushToTalkState(hint));
      desktop?.source.setVoiceHint(hint);
      menus.refreshIcon();
    },
    onTrial: (trial) => voiceTrials.send(trial),
    locale: () => {
      const setting = readObject(configPath).asr_locale;
      return speechLocale(typeof setting === 'string' ? setting : 'auto', app.getPreferredSystemLanguages());
    },
    now: Date.now,
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    log: (line) => appendLog(config!.supportDir, 'companion', line),
  });
})() : null;
/** AttentionSampler over the helper; none with `--no-attention`. */
const attention = config && helper && agentdClient !== null ? shellAttention({
  argv: process.argv, helper, ...(sharedBlacklist && { blacklist: sharedBlacklist }), agentd: agentdClient, agentdStateDir: config.agentdStateDir,
  settings: () => readObject(configPath), plan,
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  userSpeaking: () => pushToTalk?.held ?? null,
  log: (line) => appendLog(config!.supportDir, 'companion', line),
  // The renderer's only pause for lock and sleep.
  onSystemPaused: (paused) => {
    hostLink?.setSystemPaused(paused);
    desktop?.source.setSystemPaused(paused);
  },
  onSample: (s) => {
    watchers?.sampled(s);
    recorders?.sampled(s);
    context?.sampled(s);
  },
  helperY: helperYFor(shellPlatform()),
  ownCaptureRecent: anyOwnCapture((): AmbientSampler | null => ambient, (): ShellContext | null => context),
  nearClicks: (): number | null => watchers?.nearClicks10s() ?? null,
}) : null;
/** The surfaces and giving way over the helper (src/main/attention/watchers.ts), whatever the plug-ins; none with
 *  `--no-attention`. */
const watchers = config && hostLink && helper ? shellWatchers({
  argv: process.argv, platform: shellPlatform(), helper, link: hostLink, saved: () => readSaved(configPath), plan,
  cursor: () => c3Cursor(cursorSpace ??= c3Space(screen), screen.getCursorScreenPoint()),
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  attention: () => attention,
  // Whole seconds of no input of any kind, not only key presses.
  keyIdle: () => powerMonitor.getSystemIdleTime(),
  avatarHidden: () => hostLink.hidden, setHidden: (hidden, reason) => { setAvatarHidden(hidden, reason); },
  // FocusVisibility's own hide is not the user's, so it does not go through setAvatarHidden.
  setFocusHidden: (hidden) => {
    hostLink.setVisible(!hidden);
    visibility.reason = hidden ? 'focus_overlap' : 'focus_clear';
    reports?.visibility(hidden, visibility.reason);
    runtimeChanged();
  },
  log: (line) => appendLog(config!.supportDir, 'companion', line),
  linkLog: (line) => appendLog(config!.supportDir, 'hostlink', line),
  // Turn toward the focused window.
  observation: () => observation?.state ?? null,
  mainHeight: () => screen.getPrimaryDisplay().bounds.height,
}) : null;
/** The activity and timeline recorders (src/main/attention/watchers.ts), each running while agentd runs with its subsystem in
 *  the plan; none with `--no-attention`. */
const recorders = config && helper && agentdClient !== null ? shellRecorders({
  argv: process.argv, helper, ...(axWatch && { axWatch }), ...(sharedBlacklist && { blacklist: sharedBlacklist }), agentd: agentdClient, agentdStateDir: config.agentdStateDir,
  saved: () => readSaved(configPath), ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]), plan,
  log: (line) => appendLog(config!.supportDir, 'companion', line),
}) : null;
/** Ambient colours from the helper (src/main/ambient/shell.ts); none with `--no-attention`. */
const ambient = config && hostLink && helper ? shellAmbient({
  argv: process.argv, platform: shellPlatform(), helper, link: hostLink, ...(sharedBlacklist && { blacklist: sharedBlacklist }), agentdStateDir: config.agentdStateDir,
  settings: () => readObject(configPath), attention: () => attention,
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  excludePids: () => (renderer?.pid === undefined ? [process.pid] : [process.pid, renderer.pid]),
  visual: () => c3Rect(placer?.anchorSample().visual ?? null),
  // HostLink.avatarFigureFrame: her visual rect, else her body's, else her window's.
  figure: () => {
    const s = placer?.anchorSample();
    const f = hostLink.avatarFrame;
    return c3Rect(s?.visual ?? s?.body ?? null) ?? (f && { x: f.x, y: f.y, width: f.w, height: f.h });
  },
  log: (line) => appendLog(config!.supportDir, 'companion', line),
}) : null;
/** ContextCapturer over the helper (src/main/context/shell.ts), running while agentd runs with `context` in the plan; none
 *  with `--no-attention`. */
const context = config && helper && agentdClient !== null ? shellContext({
  argv: process.argv, helper, ...(axWatch && { axWatch }), ...(sharedBlacklist && { blacklist: sharedBlacklist }), agentd: agentdClient, agentdStateDir: config.agentdStateDir,
  settings: () => readObject(configPath), attention: () => attention,
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  log: (line) => appendLog(config!.supportDir, 'companion', line),
  onLook: lookReceipt(() => desktop?.source ?? null),
}) : null;
// ContextCapturer.attach: agentd's `request`s come over the app's one `/feed` connection.
store?.subscribe((e) => context?.feed(e));
/** 按住 Option 把她拖到窗口上 (handover/window.ts); none with `--no-attention`. */
const windowHandover = config && helper ? shellWindowHandover({ argv: process.argv, helper, settings: () => readObject(configPath),
  helperY: helperYFor(shellPlatform()), mainHeight: () => screen.getPrimaryDisplay().bounds.height, desktop: () => desktop }) : null;
/** The computer control host over the helper (src/main/control/shell.ts), for agentd's desktop tools, whatever the plug-ins:
 *  it refuses requests while computer_use is off in config.json; none with `--no-attention`. */
const control = config && helper ? shellControl({
  argv: process.argv, helper, ...(sharedBlacklist && { blacklist: sharedBlacklist }), supportDir: config.supportDir, configPath, agentdStateDir: config.agentdStateDir,
  saved: (path) => loadConfig(path),
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  log: (line) => appendLog(config!.supportDir, 'companion', line),
  onState: (state, raise) => {
    desktop?.source.setComputerUse(state);
    desktop?.pushState();
    controlPanel?.present(state, raise);
  },
}) : null;
/** A placement space rect in C3 global points. */
function c3Rect(r: Rect | null): HelperRect | null {
  if (r === null) return null;
  const c = (cursorSpace ??= c3Space(screen)).rectToC3(r);
  return { x: c.x, y: c.y, width: c.w, height: c.h };
}
/** agentd's pause, meeting and quiet, for `desktop.onState`. */
const observation = agentdClient === null ? null : (() => {
  const client = agentdClient;
  return new ObservationControl({
    request: async (method, path, json) => {
      const reply = await client.request(method, path, json);
      return { status: reply.status, body: reply.body.toString('utf8') };
    },
    now: Date.now,
  });
})();
const diagStream = runtimePath === null ? null : new FeedClient(runtimePath, '/diag/stream');

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** The surface, document state and, for a desktop panel, its own ops of each web contents that has the bridge, by id. */
const pages = new Map<number, { surface: Surface; page: PageSession; ops?: ReadonlyMap<string, Handler<PageSession>> }>();
/** The desktop panels (desktop/assembly.ts); made once the app is ready with the web UI built. */
let desktop: DesktopAssembly | null = null;
let controlPanel: ControlPanel | null = null;
let mainWindow: BrowserWindow | null = null;
/** Held so the tray icon is not garbage collected. */
let tray: Tray | null = null;
/** null when web/dist is missing: the main window then shows `webMissingPage`. */
let serve: ((url: string) => UiResponse) | null = null;
let ops: ReadonlyMap<string, Handler<PageSession>> = new Map();
/** The main window's ops context, whose PlaylistHost the menus share. */
let mainCtx: OpsContext | null = null;
/** 屏幕识读, 显示 / 隐藏角色 and 读取选中文字; registered once the app is ready. */
let hotkeys: ShellHotkeys | null = null;
/** `settings.onChange`: config.json keys something other than a settings page changed. */
const settingsChanges = new SettingsChanges();
/** 录热键 for the settings page, from the main window's key events. */
const hotkeyRecorder = new HotkeyRecorder({ contents: () => mainWindow?.webContents ?? null, helper });
/** Her visibility reason and the hide that expires after 30 minutes. */
const visibility = new AvatarVisibility({
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  expired: () => { setAvatarHidden(false, 'hide_expired'); },
});
/** The pages' navigation, edit menu and error log guards. */
const webGuard: WebGuardPorts = {
  origin: ORIGIN,
  openExternal: (url) => { void shell.openExternal(url); },
  popUpMenu: (contents, items) => Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined }),
  logsDir: webLogsDir(config?.supportDir ?? supportDir, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR),
  ...(DEV_WEB !== null && { devLog: (line: string) => log(line) }),
  recordError: (e) => recordError(config?.supportDir ?? supportDir, e),
};
/** Clicks on her and the desktop actions that act on her (interaction/shell.ts). */
const interaction = config && agentdClient !== null ? (() => {
  const client = agentdClient;
  return interactionShell({
    request: async (method, path, json) => {
      const reply = await client.request(method, path, json);
      return { status: reply.status, body: reply.body.toString('utf8') };
    },
    settings: () => readObject(configPath), link: hostLink, desktop: () => desktop,
    saveSettings: async (changes) => (await settingsOps(opsContext('main'))['settings.save']!([changes], new PageSession(() => {}))) as { error?: string },
    openSessions: () => openMainAt(sessionsRoute()),
    // The wheel opens with its centre at the click.
    onContextMenu: (at, held) => {
      const p = (cursorSpace ??= c3Space(screen)).rectFromC3({ x: at.x, y: at.y, w: 0, h: 0 });
      if (desktop) desktop.openWheel({ x: p.x, y: p.y }, held);
      else appendLog(config!.supportDir, 'companion', 'wheel: no desktop panels to open it in');
    },
    onRingPointer: (phase, at) => {
      const p = (cursorSpace ??= c3Space(screen)).rectFromC3({ x: at.x, y: at.y, w: 0, h: 0 });
      desktop?.ringPointer(phase, { x: p.x, y: p.y });
    },
    clickThroughChanged: () => {
      runtimeChanged();
      desktop?.pushState();
    },
    log: (line) => appendLog(config!.supportDir, 'companion', line),
  });
})() : null;

const log = (line: string) => appendLog(supportDir, 'web-main', line);

/** A sandboxed page without the bridge that says the web UI has not been built. */
function webMissingPage(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Agentic Complex</title>
<body style="font: 15px system-ui; margin: 48px; color: #222">
<h2>界面资源缺失</h2>
<p>未找到 <code>${WEB_DIST.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code>。请先运行 <code>npm --prefix web run build</code>，再重新打开主窗口。</p>
<p>托盘菜单与后台服务仍在运行。</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const glassOnSystem = glassSupported(shellPlatform(), release());
/** The 外观 rows as config.json holds them; no glass while the system reduces transparency. */
const appearanceNow = () => appearanceOf(current(settingValues(readObject(configPath)), null, shellPlatform()).values,
  glassOnSystem && !nativeTheme.prefersReducedTransparency);
/** The first-run guide's window while it is open. */
let guideWindow: BrowserWindow | null = null;
/** The guide's ground and page; its zoom stays 1, its window being sized for the page at 1. */
const applyGuideAppearance = () => applyAppearance({ ...appearanceNow(), zoom: 1 }, shellPlatform(),
  { theme: nativeTheme, window: guideWindow && !guideWindow.isDestroyed() ? guideWindow : null });
/** The theme for every window, the main window's ground, page and zoom, and the guide's. */
const applyAppearanceNow = () => {
  applyAppearance(appearanceNow(), shellPlatform(), { theme: nativeTheme, window: mainWindow });
  applyGuideAppearance();
};

/** `activate: false` shows it without taking the front app. */
function openMain(activate = true): void {
  if (mainWindow) {
    // show() leaves a minimized window in the Dock (the Windows taskbar).
    if (activate && mainWindow.isMinimized()) mainWindow.restore();
    if (activate) mainWindow.show();
    else mainWindow.showInactive();
    return;
  }
  const win = new BrowserWindow({
    width: 1385, height: 770, minWidth: 900, minHeight: 600, show: false, title: 'Agentic Complex',
    // The page draws up to the window's top edge; the traffic lights sit in its command bar, which leaves --ef-chrome-left for them.
    ...(shellPlatform() === 'mac' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 17 } } : {}),
    // A glass ground while 外观 › 窗口背景 says 磨砂; the page then lays its own ground over it only in part.
    ...mainWindowGround(shellPlatform(), appearanceNow().glass),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const contents = win.webContents, id = contents.id;
  if (shellPlatform() === 'mac') contents.on('dom-ready', () => void contents.insertCSS(':root { --ef-chrome-left: 84px; }'));
  // Each document gets the 外观 rows again (its root attributes), and the window its zoom.
  contents.on('dom-ready', () => applyAppearanceNow());
  // Windows shows no menu bar to hold the app menu's page keys.
  contents.on('before-input-event', (e, input) => {
    const route = pageShortcut(shellPlatform(), input, supervisor?.plugins ?? DEFAULT_PLUGINS);
    if (route === null) return;
    e.preventDefault();
    openMainAt(route);
  });
  const page = new PageSession((sub, stream, kind, payload) => {
    if (!contents.isDestroyed()) contents.send('bridge:push', sub, stream, kind, payload);
  });
  if (serve) {
    pages.set(id, { surface: 'main', page });
    guardWebContents(contents, 'main', webGuard);
  }
  // Subscriptions end with the document that made them.
  contents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) page.end(); });
  contents.on('render-process-gone', () => page.end());
  win.on('closed', () => {
    page.end();
    pages.delete(id);
    mainWindow = null;
  });
  // A test instance (another support dir) must not take the focus from the user's app.
  win.once('ready-to-show', () => (supportDir === DEFAULT_SUPPORT_DIR && activate ? win.show() : win.showInactive()));
  void win.loadURL(serve ? `${ORIGIN}/main.html` : webMissingPage());
  mainWindow = win;
  camera?.mainWindow(win);
}

function trayIcon(icon: IconBitmap): NativeImage {
  const b = shellPlatform() === 'mac' ? icon : squareIcon(icon, nativeTheme.shouldUseDarkColors);
  return trayImage(nativeImage.createFromBitmap(Buffer.from(b.pixels), { width: b.width, height: b.height, scaleFactor: 2 }));
}

/** Asks on the main window; true to go on. */
async function confirm(text: string): Promise<boolean> {
  const options = { type: 'question' as const, message: text, buttons: ['取消', '确定'], defaultId: 1, cancelId: 0 };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1;
}

/** workspace.py READ_SUFFIXES: agentd reads no other type. */
const FOLDER_PROMPTS: Record<string, string> = { scope_root: '选择角色可以读取的文件夹', scope_output: '选择角色写入产物的文件夹',
  session_cwd: '选择会话的工作目录' };

async function pick(properties: ('openFile' | 'openDirectory')[], message: string, filters?: { name: string; extensions: string[] }[]) {
  const options = { properties, message, buttonLabel: '选择', filters };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function surfaceOps(surface: Surface): ReadonlyMap<string, Handler<PageSession>> {
  return registry(opsContext(surface));
}

/** Each overlay's `stack` ops, made at its first open, once what they read is up, and kept for the window it makes again at
 *  each open: a registry's feed source stays subscribed to the store. */
const overlayRegistries = new Map<string, ReadonlyMap<string, Handler<PageSession>>>();
function overlayOps(overlay: 'camera' | 'resize' | 'photo'): ReadonlyMap<string, Handler<PageSession>> {
  let ops = overlayRegistries.get(overlay);
  if (ops === undefined) overlayRegistries.set(overlay, ops = surfaceOps('stack'));
  return ops;
}

function opsContext(surface: Surface): OpsContext {
  const savedRender = liveSaved({
    link: hostLink, settings: () => readObject(configPath), restartAvatar: () => { void renderer?.restart(); },
    log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
  });
  return {
    surface, routes, platform: shellPlatform(), glassSupported: glassOnSystem,
    config: { path: configPath, supportDir: config?.supportDir ?? null, devResources: config?.devResources ?? null },
    agentd: agentdClient, store,
    diag: diagStream && new SharedSource((emit) => diagStream.start((e) => emit({ event: e.event, id: e.id ?? null, data: e.data })),
      () => diagStream.stop()),
    supervisor: supervisor && {
      state: () => supervisor.state, pid: () => supervisor.pid, restart: () => { void supervisor.restart(); restartServices('backend'); }, avatar: () => rendererState,
      restartAvatar: renderer ? restartAfterPackageChange : undefined, avatarPid: () => renderer?.pid,
    },
    services: services && {
      view: (id) => services.get(id)!.view, start: (id) => services.get(id)!.begin(), stop: (id) => services.get(id)!.end(),
      restart: (id) => services.get(id)!.again(),
      saved: (id) => {
        restartServices('services save', id);
        void supervisor?.restart();
      },
    },
    avatar: hostLink && linkAvatarHost(hostLink, (hidden) => setAvatarHidden(hidden), {
      captureDir: CAPTURE_DIR,
      captureSaved: notifyCaptureSaved,
      clickThroughChanged: () => {
        runtimeChanged();
        desktop?.pushState();
      },
    }),
    cpuSeconds, residentMB, processHistory,
    looks, switcher, mmdSync,
    placement: placer,
    preview,
    helper,
    pushToTalk: pushToTalk && pushToTalkEvents,
    dropped: drops && drops.dropped,
    // Only the main window's messages are marked.
    turnMarks: surface === 'main' ? turnMarks : null,
    dockOpen: () => desktop?.dockShown ?? false,
    library: config && {
      catalog: config.characterCatalog, launched,
      characterName: config.characters.find((c) => c.id === config!.character)?.name ?? '',
      hookCommand: hookCommand(config.python, config.agentdDir, config.supportDir,
        { port: config.agentdPort, stateDir: config.agentdStateDir }, shellPlatform(), PYTHON_FLAGS),
      validationHost: () => validationHost(config!.avatarExecutable, config!.avatarApp),
      runTool: (script, args, progress) => runAgentdTool(config!.python, PYTHON_FLAGS, config!.agentdDir, script, args, progress),
      // The renderer's supervisor, agentd's and the switch read `config.characters` and `config.character`; an import adds to them.
      rosterChanged: () => {
        try {
          refreshRoster(config!, loadConfig(configPath));
        } catch (e) {
          appendLog(config!.supportDir, 'companion', `roster not refreshed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    confirm,
    shell: {
      openExternal: (url) => shell.openExternal(url), openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
    clipboard: { writeText: (text) => clipboard.writeText(text) },
    dialog: {
      pickFile: (purpose) => purpose === 'scope_file'
        ? pick(['openFile'], '选择角色可以读取的文件（文本、Office 文档、图片）', [{ name: '文件', extensions: SCOPE_FILE_TYPES }])
        : pick(['openFile'], '选择角色运行时的可执行文件'),
      pickFolder: (purpose) => pick(['openDirectory'], FOLDER_PROMPTS[purpose] ?? '选择文件夹'),
      pickPackage: () => pick(['openFile', 'openDirectory'], '选择 .endfield-character 角色包或包含 character.json 的目录'),
      saveFile: async (data, suggestedName) => {
        const options = { defaultPath: suggestedName };
        const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return false;
        writeFileSync(result.filePath, data, { mode: 0o600 });
        return true;
      },
    },
    app: { version: app.getVersion(), os: `${osName()} ${process.getSystemVersion()}`, buildGit: typeof AAC_BUILD_GIT === 'string' ? AAC_BUILD_GIT : '',
      build: bundleBuild(CONTENTS, shellPlatform()) },
    loginItem: {
      // Only the installed app's instance owns the system login item.
      enabled: () => (config?.supportDir === DEFAULT_SUPPORT_DIR ? app.getLoginItemSettings().openAtLogin : null),
      set: (on) => app.setLoginItemSettings({ openAtLogin: on }),
    },
    testCard: desktop && ((kind) => desktop!.testCard(kind)),
    saved: {
      fps: () => { hostLink?.fpsSettingsChanged(); },
      hotkey: (key, name) => {
        if (key === 'voice_hotkey') pushToTalk?.hotkeySaved(name);
        hotkeys?.saved(key, name);
        desktop?.hotkeySaved(key, name);
      },
      appearance: applyAppearanceNow,
      weather: () => weather?.saved(),
      ...savedRender,
    },
    settingsChanges, settingsChanged: (keys) => settingsChanges.changed(keys),
    openOnboarding: () => guide.begin(),
    endOnboarding: (destination) => guide.end(destination),
    openQuickInput: config && (() => { desktop?.openQuickInput(); }),
    greet: config && hostLink && agentdClient !== null ? guideGreeting(hostLink, agentdClient, config.supportDir) : null,
    openMain: openMainAt,
    unregisteredHotkeys: () => unregisteredHotkeys(hotkeys, desktop?.quickInputFailed ?? null, pushToTalk?.failedHotkey ?? null),
    // Only the main window records.
    recordHotkey: surface !== 'stack' ? (rightOption) => hotkeyRecorder.record(rightOption) : null,
    runtime: { snapshot: () => runtimeJson(runtime.snapshot), events: runtimeEvents },
    // The main window asks agentd itself, the panels through the capturer.
    look: surface === 'main' ? (agentdClient === null ? null : agentdLook(agentdClient, log))
      : context && (() => context.look()),
    computerUse: control,
    log,
  };
}

/** The pages' server; made again at each dev deployment of the web, since it resolves `current` to the deployment's directory. */
function makeServe(): ((url: string) => UiResponse) | null {
  try {
    // A packaged app serves its web-ui component's pages, whose art is inside them.
    const packagedPages = bootstrapError === null ? webRoot(RESOURCES, packaged) : null;
    const { root, art } = pagesRoot({ devWeb: DEV_WEB, webSrc: WEB_SRC, packaged: packagedPages, webDist: WEB_DIST, uiArt: UI_ART,
      devResources: config?.devResources ?? null });
    const catalog = config?.characterCatalog ?? null;
    return uiServer(root, art, catalog === null ? null
      : { file: (id, kind) => characterArt(catalog, id, kind), image: (file) => nativeImage.createFromPath(file) });
  } catch (e) {
    log(`no built web UI at ${WEB_DIST} (${e instanceof Error ? e.message : String(e)}); showing the error page`);
    return null;
  }
}

/** The guide's end has her greet over the C3 link, its clip from agentd, and her opening line from agentd. */
function guideGreeting(link: HostLink, client: AgentdClient, dir: string): (destination: OnboardingDestination | null) => void {
  const note = (line: string) => appendLog(dir, 'companion', line);
  const text = async (method: 'GET' | 'POST', path: string, json?: unknown) => {
    const reply = await client.request(method, path, json);
    return { status: reply.status, body: reply.body.toString('utf8') };
  };
  return (destination) => void greetOnDesktop({
    character: () => link.currentCharacter,
    get: (path) => text('GET', path),
    post: (path, json) => text('POST', path, json),
    playChain: (character, start) => playToEnd(link, randomUUID(), character, start, note),
    log: note,
  }, destination).catch((e: unknown) => note(`ONBOARDING greeting failed: ${e instanceof Error ? e.message : String(e)}`));
}

/** The first-run guide's window (onboarding/window.ts). */
const guide = onboardingWindow({
  configPath,
  // The main window's ground; its page lays its own over the glass only in part.
  makeWindow: (options) => {
    const win = new BrowserWindow({ ...options, ...mainWindowGround(shellPlatform(), appearanceNow().glass),
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    guideWindow = win;
    win.on('closed', () => { if (guideWindow === win) guideWindow = null; });
    win.webContents.on('dom-ready', () => applyGuideAppearance());
    return win;
  },
  served: () => serve !== null,
  workArea: () => screen.getPrimaryDisplay().workAreaSize,
  // 在桌面上 on the last step reads the desktop panels' state.
  ops: () => (config ? new Map([...surfaceOps('onboarding'), ['desktop.onState', (args, page) => {
    if (!desktop) throw new BridgeFailure('unavailable', '桌面悬浮层尚未就绪');
    return watch('desktop.onState', desktop.stateSource)(args, page);
  }]]) : null),
  register: (contents, page, guideOps) => pages.set(contents.id, { surface: 'onboarding', page, ops: guideOps }),
  unregister: (id) => pages.delete(id),
  openMain: openMainAt,
  // A test instance (another support dir) must not take the focus from the user's app.
  activate: supportDir === DEFAULT_SUPPORT_DIR,
  guard: webGuard,
  log,
});

/** `desktop.onState` as far as this shell knows it. */
function desktopState(): Record<string, unknown> {
  const s = readObject(configPath);
  const id = currentCharacterOf(switcher, hostLink, launched);
  const name = (c: string) => config?.characters.find((x) => x.id === c)?.name ?? c;
  return {
    hidden: hostLink?.hidden ?? false, clickThroughAll: hostLink?.clickThroughAll ?? false, freeRoam: !['stay', 'bust'].includes(s.stay_mode as string),
    quietUntil: observation?.quietUntil() ?? null, hiddenUntil: hostLink?.hidden ? visibility.hiddenUntil : null,
    showPresence: s.desktop_presence !== false, showHoverHints: s.desktop_hover_hints !== false,
    character: id && { id, name: name(id) }, characters: (config?.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    screens: desktopScreens(placer?.currentScreen() ?? null, screen.getAllDisplays()), hotkeys: desktopHotkeys(s, shellPlatform()),
    pips: { agentd: processState(agentdState, supervisor?.pid), avatar: processState(rendererState, renderer?.pid),
      voice: pushToTalk?.voice ?? 'off', helper: helper ? processState(helperState, helper.pid) : null },
    computerUseActive: control ? computerUseState(control.state).active : false,
    plugins: enabledPlugins(supervisor?.plugins ?? DEFAULT_PLUGINS),
    playing: play.id, poses: camera ? desktopPoses(camera.poses) : null,
    capture: !!hostLink && hostLink.capabilities.includes('capture') && hostLink.companionCapabilities.includes('capture'),
  };
}

/** The processes and her visibility as this shell reads them; the character comes from the switch's `onChange`, agentd's stage and degraded from `onHealth`. This shell
 *  has no visibility reason or click-through-all. */
function runtimeChanged(): void {
  runtime.send({ kind: 'child', name: 'agentd', state: agentdState, pid: supervisor?.pid ?? null });
  runtime.send({ kind: 'child', name: 'avatar', state: rendererState, pid: renderer?.pid ?? null });
  for (const service of services?.values() ?? []) runtime.send({ kind: 'service', id: service.id, view: service.view });
  runtime.send({ kind: 'visibility', view: { hidden: hostLink?.hidden ?? false, reason: visibility.reason,
    fullscreenHidden: watchers?.fullscreenHidden ?? false, clickThroughAll: hostLink?.clickThroughAll ?? false } });
  menus.refreshIcon();
  // The desktop state goes out with the icon.
  desktop?.pushState();
}

/** Every way of showing or hiding her comes here. */
function setAvatarHidden(hidden: boolean, reason = 'user'): boolean {
  const sent = hostLink?.setVisible(!hidden) ?? false;
  visibility.set(hidden, reason);
  reports?.visibility(hidden, reason);
  // A hide or show by the user during fullscreen is theirs.
  if (reason !== 'fullscreen' && reason !== 'fullscreen_exit') watchers?.userSetHidden();
  runtimeChanged();
  return sent;
}

/** The stack panel's confirmation: an app-modal alert. */
async function confirmStack(text: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({ type: 'question', message: '确认', detail: text, buttons: ['确定', '取消'], defaultId: 0, cancelId: 1 });
  return response === 0;
}

/** Opens the main window at hash route `route` (a desktop panel's `window.openMain`). */
function openMainAt(route: string, activate = true): void {
  // The agent's entry leaves a focused main window on its page.
  if (!activate && mainWindow?.isFocused()) return;
  openMain(activate);
  if (mainWindow) pages.get(mainWindow.webContents.id)?.page.pushRoute(route.replace(/^#/, ''));
}

/** A click shows the file. */
function notifyCaptureSaved(file: string): void {
  const saved = new Notification({ title: '已保存截图', body: file });
  saved.on('click', () => shell.showItemInFolder(join(CAPTURE_DIR, file)));
  saved.show();
}

/** The menus' state and ports, read when a menu opens, and the menu bar icon, the Mac's only (menus/shell.ts). */
/** 最近播报 of the tray menu and the console. */
const recent = new RecentAnnouncements();
recent.onChange = () => desktop?.recentChanged();
const menus = shellMenus({
  recent,
  settings: () => readObject(configPath),
  characters: () => config && config.characters.map((c) => ({ id: c.id, name: c.name })),
  launched,
  processes: () => processStatus(config === null, agentdState, rendererState, [rendererState, agentdState,
    ...[...services?.values() ?? []].flatMap((s) => (s.supervised ? [s.state.kind === 'external' ? { kind: 'running' } as const : s.state] : []))]),
  link: hostLink, looks, switcher, observation, pushToTalk, interaction,
  desktop: () => desktop, placer: () => placer,
  restartChildren: () => {
    void supervisor?.restart();
    restartServices('children');
    void renderer?.restart();
  },
  openMain: openMainAt, quit: () => app.quit(),
  log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
  setIcon: (icon: IconBitmap) => tray?.setImage(trayIcon(icon)),
});

/** With the web panels: the loading card, under the character's name and the
 *  stage's title. */
function showAvatarLoading(loading: Loading): void {
  const name = (id: string) => config?.characters.find((c) => c.id === id)?.name ?? id;
  desktop?.source.setAvatarLoading(loading.kind === 'loading'
    ? { kind: 'loading', character: name(loading.character), title: AVATAR_STAGE_TITLES[loading.stage] ?? loading.stage }
    : loading.kind === 'recovering' ? { ...loading, character: name(loading.character) } : loading);
}

/** A test run's stand-in for the pointer resting on her: no synthetic input reaches the system. */
const simulateHover = process.argv.includes('--simulate-avatar-hover');
/** config.json `desktop_hover_hints`, read at most once a second. */
const hoverHints = { on: true, at: -Infinity };

function startDesktop(): void {
  if (!config || !serve || agentdClient === null) return;
  const client = agentdClient;
  const toDip = c3Dip(screen), space = c3Space(screen);
  desktop = new DesktopAssembly({
    makeWindow: (kind) => {
      const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      makeOverlay(win, kind, macAddon);
      return win;
    },
    url: (route) => `${ORIGIN}/stack.html#${route}`,
    toDip, screens: () => space.screens(),
    cursorDip: () => screen.getCursorScreenPoint(),
    mouse: () => {
      const p = screen.getCursorScreenPoint();
      const r = space.fromDip({ x: p.x, y: p.y, width: 0, height: 0 });
      return { x: r.x, y: r.y };
    },
    register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
    unregister: (id) => pages.delete(id),
    baseOps: surfaceOps('stack'),
    request: async (method, path, json, headers) => {
      const reply = await client.request(method, path, json, headers);
      return { status: reply.status, body: reply.body.toString('utf8') };
    },
    ...(turnMarks && { marks: turnMarks }),
    feed: store && new FeedSource(store),
    noteLine: () => hostLink?.noteLine(),
    mouseDowns: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
    // Read on each announcement.
    notify: () => notifySettings(readObject(configPath), (observation?.quietUntil() ?? null) !== null),
    notifier: new SystemNotifier({ supported: () => Notification.isSupported(), create: (c) => new Notification(c),
      notificationPath: (id) => desktop?.source.notificationPath(id) ?? null, openMain: openMainAt, recent }),
    sample: () => placer?.anchorSample() ?? { now: performance.now() / 1000, body: null, bodyAt: null, visual: null, placement: null, dragging: false },
    avatarHidden: () => hostLink?.hidden ?? false,
    frontFullscreen: () => watchers?.frontFullscreen ?? false,
    figure: () => (hostLink ? `${hostLink.currentCharacter ?? ''}/${hostLink.currentAppearance ?? ''}` : null),
    hover: () => {
      const p = screen.getCursorScreenPoint();
      const at = space.fromDip({ x: p.x, y: p.y, width: 0, height: 0 });
      const hidden = hostLink?.hidden ?? false;
      const near = (grow: number) => simulateHover || avatarHovered({
        ...(placer?.hoverSample({ x: at.x, y: at.y }, grow) ?? { hit: false, age: null, dragging: false }), hidden,
        clickThroughAll: hostLink?.clickThroughAll ?? false, switching: hostLink?.characterSwitching ?? false,
        buttonsDown: watchers?.buttonsDown ?? false, lastCursorHit: hostLink?.lastCursorHit ?? false });
      return {
        present: !!hostLink?.connected && !hidden && placer?.anchorSample().body != null,
        hovered: near(0),
        within: near,
        hints: (() => {
          const now = performance.now();
          if (now - hoverHints.at >= 1000) Object.assign(hoverHints, { on: readObject(configPath).desktop_hover_hints !== false, at: now });
          return hoverHints.on;
        })(),
      };
    },
    state: desktopState,
    actions: {
      ...interaction?.actions,
      ...(pushToTalk && { talk: (phase: 'start' | 'stop') => pushToTalk.talk(phase) }),
      look: () => { void context?.look(); },
      setHidden: (hidden) => { setAvatarHidden(hidden); },
      setQuiet: async (until) => {
        await observation?.setQuiet(until);
        menus.refreshIcon();
        desktop?.pushState();
      },
      switchCharacter: (id) => switcher?.select(id),
      placeOnScreen: (id) => { placer?.placeOnScreen(Number(id)); },
      resetPosition: () => placer?.resetPosition(),
      resize: () => { resizeOverlay?.begin(); },
      photo: () => { photoOverlay?.begin(); },
      restartAll: () => {
        void supervisor?.restart();
        void renderer?.restart();
      },
      quit: () => app.quit(),
      stopPlay: () => play.stop((m) => hostLink?.send(m) ?? false, hostLink?.capabilities ?? []),
      ...(camera && { pose: (id: string | null) => wheelPose(camera.poses, id) }),
    },
    playSound: () => playAlert(() => shell.beep()),
    confirm: confirmStack,
    openMain: openMainAt,
    present: (token, side, phase) => hostLink?.sendPresent(token, side, phase) ?? false,
    guard: webGuard,
    a11y: a11ySource(() => ({ reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
      reduceTransparency: nativeTheme.prefersReducedTransparency, increaseContrast: nativeTheme.shouldUseHighContrastColors }),
    (changed) => { nativeTheme.on('updated', changed); }),
    recent: { rows: () => recent.rows(), open: (id) => openAnnouncement(recent, openMainAt, id), markAllRead: () => recent.markAllRead() },
    dockChanged: () => reports?.dockChanged(),
    systemPaused: () => attention?.systemPaused ?? false,
    onTypingChanged: (typing) => hostLink?.setInteractionVisible(typing, false),
    log: (line) => appendLog(config!.supportDir, 'companion', line),
  });
  drops?.desktopReady();
  desktop.start();
  desktop.source.onCount = (n) => menus.pendingApprovalsChanged(n);
  if (agentdState.kind === 'running') desktop.agentd(true);
  // The renderer starts before the panels.
  if (renderer) showAvatarLoading(renderer.loading);
}

ipcMain.on('bridge:boot', (e) => {
  const entry = pages.get(e.sender.id);
  const helperOps = helper?.hello?.ops;
  e.returnValue = entry ? boot(entry.surface, shellPlatform(), Array.isArray(helperOps) ? helperOps as string[] : null,
    hostLink ? (hostLink.connected ? hostLink.capabilities : null) : [], hostLink != null) : null;
});

// Dropped and pasted files, from the preload only (src/main/ops/adopt.ts); the main frame's page gets handles back.
ipcMain.handle('files:adopt', (e, paths: unknown) => {
  const page = filePage(e, pages.get(e.sender.id));
  return page ? adoptPaths(paths, page.picked) : [];
});
ipcMain.handle('files:release', (e, handle: unknown) => {
  if (typeof handle === 'string') filePage(e, pages.get(e.sender.id))?.release(handle);
});
ipcMain.handle('files:paste', (e, items: unknown) => {
  const page = filePage(e, pages.get(e.sender.id));
  return page && config ? adoptPasted(items, page, join(config.supportDir, 'pasted')) : [];
});

ipcMain.handle('bridge:invoke', (e, message: unknown): Reply | Promise<Reply> => {
  const entry = pages.get(e.sender.id), frame = e.senderFrame;
  if (!entry || !frame) return { ok: false, error: { code: 'forbidden_frame', detail: 'no bridge surface' } };
  return handle(entry.surface, { mainFrame: frame === e.sender.mainFrame, origin: frame.origin }, message, entry.ops ?? ops, entry.page,
    (op, code) => recordError(config?.supportDir ?? supportDir, { component: 'bridge', code: 'op_failed', message: `${op} ${code}`, req: op }));
});

/** The Mac's app menu, its 前往 by the plug-ins agentd runs with; set again at each start of agentd. Windows gets none, not
 *  Electron's default menu bar: its page keys are the main window's `pageShortcut`. */
function setAppMenu(): void {
  if (shellPlatform() !== 'mac') return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({ openMain: openMainAt, quit: () => app.quit() }, supervisor?.plugins ?? DEFAULT_PLUGINS)));
}

// The tray keeps the app running with no window open.
app.on('window-all-closed', () => {});

let childrenStopped = false;
/** The first `will-quit` stops the children; a later one waits for that. */
let stopping = false;
let devReloader: { stop(): void } | null = null;
// The renderer (C3 quit first), then agentd; the platform helper last. A stop that fails holds up neither the others nor the quit.
app.on('will-quit', (e) => {
  if (childrenStopped) return;
  if (stopping) {
    e.preventDefault();
    return;
  }
  const stop = async (what: string, f: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      await f();
    } catch (err) {
      appendLog(supportDir, 'companion', `quit: ${what} stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  flushErrors();
  store?.stop();
  diagStream?.stop();
  desktop?.stop();
  hotkeys?.stop();
  hotkeyRecorder.cancel();
  camera?.stop();
  weather?.stop();
  cameraOverlay?.stop();
  resizeOverlay?.stop();
  photoOverlay?.stop();
  titleOverlay?.stop();
  placer?.stop();
  sharedBlacklist?.stop();
  watchers?.stop();
  recorders?.stop();
  ambient?.stop();
  context?.stop();
  // Its grant ends now; the helper stops after it.
  const controlStopped = stop('computer control', () => control?.stop());
  controlPanel?.stop();
  looks?.stop();
  devReloader?.stop();
  // Windows refuses to delete a file a scan still running has open.
  if (config) void stop('mmd scans', async () => dropMmdScans(mmdScanRoot(config!.supportDir)));
  if (!supervisor && !renderer && !helper && !services) return;
  e.preventDefault();
  stopping = true;
  void (async () => {
    await stop('renderer', () => renderer?.stop());
    hostLink?.stop();
    await stop('agentd', () => supervisor?.stop());
    await Promise.all([...services?.entries() ?? []].map(([id, s]) => stop(`service ${id}`, () => s.stop())));
    await controlStopped;
    await stop('helper', () => helper?.stop());
    childrenStopped = true;
    app.quit();
  })();
});

void app.whenReady().then(async () => {
  clearPasted(config?.supportDir ?? supportDir);
  // Left by a crash or a quit that could not delete them.
  try {
    if (config) dropMmdScans(mmdScanRoot(config.supportDir));
  } catch (e) {
    log(`mmd scans not deleted: ${e instanceof Error ? e.message : String(e)}`);
  }
  setNotificationId(app);
  hideFromDock(app);
  // Electron's own handlers, installed by now, quit once and then restore the default action (quit.ts).
  quitOnSignals({ on: (signal, listener) => { process.on(signal, listener); }, quit: () => app.quit() });
  powerMonitor.on('lock-screen', () => attention?.setSystemLock(true));
  powerMonitor.on('unlock-screen', () => attention?.setSystemLock(false));
  powerMonitor.on('suspend', () => attention?.setSystemSleep(true));
  powerMonitor.on('resume', () => attention?.setSystemSleep(false));
  setAppMenu();
  runtimeChanged();
  for (const service of services?.values() ?? []) service.start();
  supervisor?.start();
  helper?.start();
  if (config && hostLink) {
    const space = c3Space(screen);
    const p = placer = new AvatarPlacer({
      link: hostLink, supportDir: config.supportDir, space,
      stayInPlace: () => ['stay', 'bust'].includes(readObject(configPath).stay_mode as string),
      // Whole seconds of no input of any kind, not only key presses.
      keyIdle: () => powerMonitor.getSystemIdleTime(),
      // Electron has no occlusion state: a covered main window still counts as shown.
      mainWindow: () => (mainWindow && !mainWindow.isDestroyed()
        ? shownFrame(space.fromDip(mainWindow.getBounds()), mainWindow.isVisible(), mainWindow.isMinimized(), false) : null),
      keepClearSources: () => watchers?.keepClear((r) => space.rectFromC3(r)) ?? [],
      log: (line) => appendLog(config!.supportDir, 'hostlink', `HOSTLINK ${line}`),
    });
    p.start();
    resizeOverlay = new ResizeOverlayWindow({
      url: `${ORIGIN}/stack.html#/resize`,
      makeWindow: () => {
        const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        makeOverlay(win, 'resize', macAddon);
        guardWebContents(win.webContents, 'stack', webGuard);
        return win;
      },
      toDip: (r) => c3Dip(screen)(r), fromC3: (b) => space.rectFromC3(b), cursor: () => screen.getCursorScreenPoint(),
      presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
      register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
      unregister: (id) => pages.delete(id),
      get baseOps() { return overlayOps('resize'); },
      target: p,
    });
    photoOverlay = new PhotoOverlayWindow({
      url: `${ORIGIN}/stack.html#/photo`,
      makeWindow: () => {
        const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        // On 调整镜头's level.
        makeOverlay(win, 'camera', macAddon);
        guardWebContents(win.webContents, 'stack', webGuard);
        return win;
      },
      toDip: (r) => c3Dip(screen)(r), fromC3: (b) => space.rectFromC3(b), screens: () => space.screens(),
      cursor: () => screen.getCursorScreenPoint(),
      presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
      register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
      unregister: (id) => pages.delete(id),
      get baseOps() { return overlayOps('photo'); },
      // As 调整镜头's: her visual rect, else her body's, else her window's.
      figure: () => {
        const s = p.anchorSample(), r = c3Rect(s.visual ?? s.body ?? null);
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : hostLink.avatarFrame;
      },
      link: linkAvatarHost(hostLink, (hidden) => setAvatarHidden(hidden), { captureDir: CAPTURE_DIR, captureSaved: notifyCaptureSaved }),
    });
    screen.on('display-added', () => p.screensChanged());
    screen.on('display-removed', () => p.screensChanged());
    screen.on('display-metrics-changed', () => p.screensChanged());
  }
  await hostLink?.start();
  renderer?.start();
  serve = makeServe();
  if (DEV_WEB !== null) log(`DEV_WEB pages from ${DEV_WEB}`);
  else if (process.argv.includes(DEV_WEB_FLAG)) log(`DEV_WEB ignored: ${CONTENTS !== null ? 'a packaged app' : 'not a loopback http origin'}`);
  protocol.handle(SCHEME, async (request) => {
    const dev = DEV_WEB === null ? null : await devWebResponse(DEV_WEB, request, (url, init) => net.fetch(url, init), log);
    if (dev) return dev;
    const r = serve ? serve(request.url) : { status: 404, headers: {}, body: Buffer.alloc(0) };
    return new Response(new Uint8Array(r.body), { status: r.status, headers: r.headers });
  });
  // The panels' pages load from the scheme, and their ops are the main window's test cards' target.
  startDesktop();
  if (control && serve) {
    const space = c3Space(screen);
    controlPanel = new ControlPanel({
      host: control, url: `${ORIGIN}/stack.html#/computer`,
      makeWindow: () => {
        const win = new BrowserWindow({ ...overlayOptions(), ...CONTROL_PANEL_WINDOW,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        makeOverlay(win, 'control', macAddon);
        win.setIgnoreMouseEvents(false);
        guardWebContents(win.webContents, 'stack', webGuard);
        return win;
      },
      toDip: c3Dip(screen), body: () => placer?.anchorSample().body ?? null, screens: () => space.screens(),
      mouse: () => {
        const p = screen.getCursorScreenPoint();
        const r = space.fromDip({ x: p.x, y: p.y, width: 0, height: 0 });
        return { x: r.x, y: r.y };
      },
      webDesktop: () => desktop !== null,
      register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
      unregister: (id) => pages.delete(id),
      baseOps: surfaceOps('stack'),
    });
    controlPanel.start();
    screen.on('display-added', () => controlPanel?.place());
    screen.on('display-removed', () => controlPanel?.place());
    screen.on('display-metrics-changed', () => controlPanel?.place());
  }
  if (config) {
    hotkeys = shellHotkeys({
      argv: process.argv,
      shortcut: { register: (accelerator, pressed) => globalShortcut.register(accelerator, pressed),
        unregister: (accelerator) => globalShortcut.unregister(accelerator) },
      // Registered once: a plug-in turned on later brings these keys at the next launch.
      settings: () => readObject(configPath), context: plan().has('reading') ? context : null,
      avatarHidden: () => hostLink?.hidden ?? false, setHidden: (hidden, reason) => { setAvatarHidden(hidden, reason); },
      quickInput: () => desktop && ((first) => desktop!.openQuickInput(first)),
      clickThroughAll: hostLink && { on: () => hostLink.clickThroughAll, set: (on) => {
        hostLink.clickThroughAll = on;
        runtimeChanged();
        desktop?.pushState();
      } },
      commandRing: () => desktop,
      log: (line) => appendLog(config!.supportDir, 'companion', line),
    });
  }
  mainCtx = opsContext('main');
  ops = registry(mainCtx);
  devReloader = devReload({
    devResources: config?.devResources ?? null,
    reloadWeb: () => {
      serve = makeServe();
      for (const [id, p] of pages) if (p.surface !== 'onboarding') webContents.fromId(id)?.reload();
    },
    restartBackend: () => { void supervisor?.restart(); },
    log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
  });
  // agentd's `command` events are carried out as they come.
  store?.subscribe(feedCommands({ ctx: opsContext('main'), notice: (text) => desktop?.notice(text),
    log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line) }));
  // Her own outfit changes, carried out as the menu's and answered with a receipt.
  if (looks && hostLink && agentdClient !== null) {
    const client = agentdClient;
    store?.subscribe(looksCommands({ looks, link: hostLink, post: (path, body) => client.request('POST', path, body),
      log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line) }));
  }
  store?.subscribe((e) => recent.receive(e, Date.now()));
  tray = new Tray(trayIcon(iconBitmap('normal')));
  tray.setToolTip(statusTitle(config?.supportDir ?? supportDir, DEFAULT_SUPPORT_DIR));
  // Windows has no title beside the icon; the tooltip (statusTitle) says 测试 there.
  if (shellPlatform() === 'mac') tray.setTitle(trayTitle(config?.supportDir ?? null, DEFAULT_SUPPORT_DIR));
  const space = c3Space(screen);
  // No context menu on Windows either: with one set Electron shows it itself on a right click.
  const click = (right: boolean, keys: { altKey?: boolean }, bounds: Rectangle) => {
    trayClick(trayClickOf(shellPlatform(), right, keys, bounds), {
      desktop, toPlacement: (b) => space.fromDip(b),
      popUpMenu: () => tray?.popUpContextMenu(Menu.buildFromTemplate(trayContextMenu(shellPlatform(), menus.state(), menus.ports()))),
      log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
    });
  };
  tray.on('click', (e, bounds) => click(false, e, bounds));
  tray.on('right-click', (e, bounds) => click(true, e, bounds));
  // The Windows icon's colour follows the theme.
  if (shellPlatform() === 'windows') nativeTheme.on('updated', () => menus.refreshIcon());
  menus.refreshIcon();
  // The theme before any window opens; the main window's glass again when the system's reduce transparency changes.
  applyAppearanceNow();
  nativeTheme.on('updated', applyAppearanceNow);
  // The main window only for a config error or an empty roster; a first run gets the guide.
  const start = startupWindow({ configError: config === null, characters: config?.characters.length ?? 0,
    onboardingDone: config !== null && !guide.firstRun() });
  // A config error takes the front, an empty roster does not.
  if (start.open === 'main') openMainAt(start.route, config === null);
  else if (start.open === 'onboarding') guide.begin();
  started();
  // A test run records what came up, then quits as the tray's 退出 does.
  const quitAfter = quitAfterFromArgs(process.argv);
  if (quitAfter !== null) {
    setTimeout(() => {
      log(`QUIT_AFTER ${quitAfter}s main_window=${mainWindow?.isVisible() ? 'shown' : 'not shown'} url=${mainWindow?.webContents.getURL() ?? ''} tray=${tray !== null}`);
      app.quit();
    }, quitAfter * 1000);
  }
});
