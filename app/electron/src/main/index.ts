// Electron main process: serves web/dist (from the repo with `--dev-web-server`, the vite dev server's pages) at
// agentic-complex-ui://app/, opens the main window, keeps a tray icon.
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, screen,
  shell, systemPreferences, Tray, webContents,
  type NativeImage, type Rectangle,
} from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import routes from '../../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { a11ySource } from '../common/a11y.ts';
import { type ChildState } from '../common/agentd.ts';
import type { Rect as HelperRect } from '../common/attention.ts';
import { boot, handle, type Handler, type Reply, type Surface } from '../common/bridge.ts';
import { computerUseState } from '../common/computer-control.ts';
import { avatarHovered } from '../common/desktop-hover.ts';
import { AVATAR_STAGE_TITLES } from '../common/stack-source.ts';
import { shownFrame } from '../common/keepclear.ts';
import type { Rect } from '../common/placement.ts';
import { menuLines, rendererPreflight } from '../common/components.ts';
import { type Config, configLogLine, launchCharacter, statusTitle, webLogsDir } from '../common/config.ts';
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
import { agentdTts, RuntimeCoordinator, runtimeJson, type SlotState } from '../common/runtime.ts';
import { desktopHotkeys } from '../common/settings.ts';
import { CharacterSwitch } from '../common/switch.ts';
import { ORIGIN, SCHEME } from '../common/ui.ts';
import { AvatarVisibility } from '../common/visibility-reason.ts';
import { AgentdClient, FeedClient } from './agentd/client.ts';
import { agentdForwarding } from './agentd/forward.ts';
import { AgentStore } from './agentd/store.ts';
import { AgentdSupervisor } from './agentd/supervisor.ts';
import type { AmbientSampler } from './ambient/sampler.ts';
import { ambientOffers, shellAmbient } from './ambient/shell.ts';
import { shellAttention } from './attention/shell.ts';
import { helperYFor, shellRecorders, shellWatchers, surfaceLinkOptions } from './attention/watchers.ts';
import { CameraOverlayWindow } from './camera/overlay.ts';
import { CAMERA_OFFERS, shellCamera } from './camera/shell.ts';
import { feedCommands } from './commands/feed.ts';
import {
  configPathFromArgs, DEFAULT_AGENTD_STATE_DIR, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR, lastCharacter, loadConfig, quitAfterFromArgs, supportDirOf,
} from './config.ts';
import { agentdLook, anyOwnCapture, lookReceipt, shellContext, type ShellContext } from './context/shell.ts';
import { CONTROL_PANEL_WINDOW, ControlPanel } from './control/panel.ts';
import { shellControl } from './control/shell.ts';
import { DesktopAssembly } from './desktop/assembly.ts';
import { trayClick } from './desktop/tray.ts';
import { devReload } from './dev-reload.ts';
import { devWebResponse } from './dev-web.ts';
import { handClipboard } from './handover/clipboard.ts';
import { selectRegion } from './handover/region.ts';
import { RegionSelectWindow } from './handover/region-window.ts';
import { DropHandover, opsMotionImport } from './handover/drop.ts';
import { shellWindowHandover } from './handover/window.ts';
import { HotkeyRecorder } from './hotkeys/record.ts';
import { type ShellHotkeys, shellHotkeys, unregisteredHotkeys } from './hotkeys/shell.ts';
import { interactionShell } from './interaction/shell.ts';
import { appendLog } from './log.ts';
import { appMenu } from './menus/app.ts';
import { avatarMenu } from './menus/avatar.ts';
import { SettingsChanges } from './menus/items.ts';
import { characterMenuPopup } from './menus/popup.ts';
import type { IconBitmap } from './menus/icon.ts';
import { shellMenus } from './menus/shell.ts';
import { trayContextMenu, trayMenu as trayMenuItems } from './menus/tray.ts';
import { SystemNotifier } from './notify/system.ts';
import { onboardingWindow } from './onboarding/window.ts';
import { bundleBuild } from './ops/app.ts';
import { avatarPlaylist, psCpuSeconds } from './ops/avatar.ts';
import { characterArt, shellMmdSync } from './ops/character.ts';
import { reloadAvatar } from './ops/holding.ts';
import { type OpsContext, registry } from './ops/index.ts';
import { ObservationControl } from './ops/observation.ts';
import { sessionsRoute } from './ops/open.ts';
import { saveSettings } from './ops/settings.ts';
import { processState } from './ops/supervisor.ts';
import { runAgentdTool, validationHost } from './ops/tools.ts';
import { HelperSupervisor, helperMenuLine } from './helper/supervisor.ts';
import { type PackagedLaunch, packagedConfigPath, packagedContents, preparePackaged, webRoot } from './packaged.ts';
import { AvatarPlacer } from './placement/controller.ts';
import { ResizeOverlayWindow } from './placement/resize-overlay.ts';
import { nextTraceEpoch } from './placement/store.ts';
import {
  c3Dip, c3Space, c3Transport, helperExecutable, hideFromDock, makeOverlay, osName, overlayOptions, playAlert, previewAddon, pythonFlags,
  shellPlatform, trayImage,
} from './platform/index.ts';
import type { PlacementSpace } from './platform/screens.ts';
import { PreviewController } from './preview/controller.ts';
import { loadMotionLibrary } from './preview/library.ts';
import { WindowPreview } from './preview/window.ts';
import { CAPTURE_OFFERS, linkAvatarHost, MOTION_OFFERS, resendStoredOverrides } from './renderer/avatar-host.ts';
import { HostLink, hostPipePath, hostSocketPath } from './renderer/link.ts';
import { AvatarLooks, linkSwitchPorts, rememberedLooks } from './renderer/looks.ts';
import { quitOnSignals } from './quit.ts';
import { rendererReports } from './renderer/reports.ts';
import { liveSaved } from './renderer/saved.ts';
import { type Loading, RendererSupervisor } from './renderer/supervisor.ts';
import { singleInstance } from './single-instance.ts';
import { TunnelSupervisor } from './tunnel/supervisor.ts';
import { uiServer, type UiResponse } from './ui-scheme.ts';
import { guardWebContents, type WebGuardPorts } from './web-guard.ts';
import { c3Cursor, currentCharacterOf, handleNudge, helloBuild, notifySettings, pagesRoot, refreshRoster } from './wiring.ts';

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
/** Where the renderer writes `avatar.capture`'s files. */
const CAPTURE_DIR = join(homedir(), 'Pictures/Agentic Complex');
// Chromium's profile stays with the support dir, so a `--config` run touches nothing of the installed app.
app.setPath('userData', join(supportDir, 'electron'));
// One instance per support dir, taken before the packaged launch writes anything.
if (!singleInstance({ requestLock: () => app.requestSingleInstanceLock(), pid: process.pid, appPath: app.getAppPath(),
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
let tunnelState: SlotState = { kind: 'stopped' };
let helperState: ChildState = { kind: 'stopped' };
let rendererState: ChildState = (config && rendererPreflight(config)) ?? { kind: 'stopped' };
const launched = config ? launchCharacter(config, lastCharacter(config.supportDir)) : '';

/** A JSON object file as read; null when it is missing or not an object. */
function readSaved(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
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
/** The link's trace, behavior receipts and motion requests on their way to agentd. */
const forwarding = runtimePath === null ? null : (() => {
  const client = new AgentdClient(runtimePath);
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
const reports = config && runtimePath !== null ? rendererReports({
  agentd: new AgentdClient(runtimePath), agentdRunning: () => agentdState.kind === 'running', settings: () => readObject(configPath),
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
  ...(forwarding && { onTrace: forwarding.onTrace, onBehaviorReceipt: forwarding.onBehaviorReceipt, onMotionRequest: forwarding.onMotionRequest }),
  ...reports?.options,
  onClick: (e) => interaction?.click(e),
  onDrop: (d) => drops?.drop(d),
  onDragRelease: (at, excludedPids) => windowHandover?.(at, excludedPids),
  onPoseState: (s) => camera?.poses.state(s), onCameraGesture: (g) => camera?.camera.gesture(g),
  fps: () => {
    const s = readObject(configPath);
    return { idleLowFps: s.idle_low_fps !== false, userFps: [30, 45, 60].includes(Number(s.render_fps)) ? Number(s.render_fps) : 60,
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
      makeOverlay(win, 'camera', addon);
      guardWebContents(win.webContents, 'stack', webGuard);
      return win;
    },
    toDip: (r) => c3Dip(screen)(r), fromC3: (b) => (cursorSpace ??= c3Space(screen)).rectFromC3(b),
    screens: () => (cursorSpace ??= c3Space(screen)).screens(), cursor: () => screen.getCursorScreenPoint(),
    presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
    register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
    unregister: (id) => pages.delete(id),
    get baseOps() { return surfaceOps('stack'); },
    camera: target,
  }),
  log: (line) => appendLog(config!.supportDir, 'companion', line) });
/** Made once the app is ready: Electron's `screen` is not there before. */
let placer: AvatarPlacer | null = null;
/** 调整大小's window, kept to end it at quit. */
let resizeOverlay: ResizeOverlayWindow | null = null;
const renderer = config && new RendererSupervisor({
  config, reload: () => loadConfig(configPath), settings: () => readObject(configPath), state: () => readObject(join(config!.supportDir, 'state.json')),
  // The last character a switch remembered (rule 14), as at the app's launch.
  character: () => launchCharacter(config!, lastCharacter(config!.supportDir)),
  placement: (character) => placer?.launchPlacement(character) ?? null, link: hostLink,
  captureDir: CAPTURE_DIR, platform: shellPlatform(),
  onStatus: (state) => {
    rendererState = state;
    // The sampler runs while she does.
    if (state.kind === 'running') ambient?.start();
    else ambient?.stop();
    runtimeChanged();
    updateTrayMenu();
  },
  onLoading: (loading) => showAvatarLoading(loading),
});
// Rule 17: the watchdog's kill goes to the process whose hello it watched.
hostLink?.on((e) => { if (e.kind === 'watchdog' && e.pid === renderer?.pid) renderer.kill(e.reason); });
/** The TTS tunnel; it starts nothing without `tts_tunnel_host`. */
const tunnel = config && new TunnelSupervisor({
  config, watcherScript: WATCHER,
  onStatus: (state) => {
    tunnelState = state;
    runtimeChanged();
    updateTrayMenu();
  },
});
/** 重启后台 and 重启子进程 start the tunnel again with config.json read again. */
function restartTunnel(what: string): void {
  if (!tunnel) return;
  let fresh: Config;
  try {
    fresh = loadConfig(configPath);
  } catch (e) {
    appendLog(supportDir, 'companion', `restart ${what}: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  void tunnel.restart(fresh);
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
      store?.start();
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
    updateTrayMenu();
  },
  onHealth: (stage, degraded) => runtime.send({ kind: 'agentdHealth', stage, degraded }),
});
/** shellPlan of the plug-ins agentd runs with: a 重启后台 after a plug-in changed applies it to what starts with agentd. */
const plan = (): ReadonlySet<Subsystem> => shellPlan(supervisor?.plugins ?? DEFAULT_PLUGINS);
/** The macOS addon: the preview's XPC client and the desktop panels' `setPreventsActivation`. */
const addon = config ? previewAddon(join(import.meta.dirname, 'native/preview.node')) : null;
/** The character page's live preview; none on Windows yet or without a renderer link. */
const preview = (() => {
  if (!config || !hostLink || !addon) return null;
  const catalog = config.characterCatalog;
  return new PreviewController({
    view: new WindowPreview({ addon, window: () => mainWindow, log: (line) => log(line) }),
    avatar: () => ({ character: currentCharacterOf(switcher, hostLink, launched), appearance: hostLink.currentAppearance }),
    library: async (id) => (catalog ? loadMotionLibrary(catalog, id) : null),
    modSettings: (id) => looks?.modSettings(id) ?? {},
  });
})();
/** The character switch over the renderer link and agentd. */
const switcher = config && hostLink && (() => {
  const client = runtimePath === null ? null : new AgentdClient(runtimePath);
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
  reload: () => reloadAvatar({ switcher, supervisor: { restartAvatar: () => { void renderer?.restart(); } },
    log: (line) => appendLog(config!.supportDir, 'companion', line) }, hostLink),
  current: () => switcher.current,
  log: (line) => appendLog(config!.supportDir, 'companion', `AVATAR ${line}`),
}) : null;
if (switcher) {
  switcher.onChange = (view) => {
    runtime.send({ kind: 'character', view });
    void mmdSync?.sync.follow(view.current);
    pushToTalk?.agentd(agentdState.kind === 'running' && !view.switching && plan().has('pushToTalk'));
    menus.refreshIcon();
    desktop?.pushState();
  };
}
const store = runtimePath === null ? null : new AgentStore(runtimePath);
store?.subscribe((e) => {
  const tts = e.event === 'voice_state' ? agentdTts(runtime.snapshot.tts, e.data) : null;
  if (tts) runtime.send({ kind: 'tts', view: tts });
});
store?.subscribe((e) => turnMarks?.feed(e));
store?.subscribe((e) => void handleNudge(e, hostLink, helper, { helperY: helperYFor(shellPlatform()), mainHeight: () => screen.getPrimaryDisplay().bounds.height },
  (line) => appendLog(config!.supportDir, 'companion', line)));
/** The C12 platform helper; the ops reach it through `OpsContext.helper`. */
const helper = config && new HelperSupervisor({
  executable: helperExecutable(APP_DIR, undefined, CONTENTS), supportDir: config.supportDir, clientVersion: app.getVersion(),
  onStatus: (state) => {
    helperState = state;
    pushToTalk?.helper(state.kind === 'running');
    attention?.helper(state.kind === 'running');
    watchers?.helper(state.kind === 'running');
    recorders?.helper(state.kind === 'running');
    context?.helper(state.kind === 'running');
    control?.helper(state.kind === 'running');
    updateTrayMenu();
  },
  onEvent: (e) => {
    pushToTalk?.event(e.event, e.data);
    attention?.event(e.event, e.data);
    watchers?.event(e.event, e.data);
    recorders?.event(e.event, e.data);
    ambient?.event(e.event, e.data);
    context?.event(e.event, e.data);
    control?.event(e.event, e.data);
  },
});
/** A test run's switch: push-to-talk is left out, so the helper registers no key and opens no microphone. */
const noPushToTalk = process.argv.includes('--no-push-to-talk');
/** `voice.onPushToTalk`'s values; sent as they come, none replayed. */
const pushToTalkEvents = new PushSource('state', { replay: false });
/** `voice.onTrial`'s values for the guide's voice step. */
const voiceTrials = new PushSource('trial', { replay: false });
/** 按住说话 over the helper. */
const pushToTalk = config && helper && runtimePath !== null && !noPushToTalk ? (() => {
  const client = new AgentdClient(runtimePath);
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
const attention = config && helper && runtimePath !== null ? shellAttention({
  argv: process.argv, helper, agentd: new AgentdClient(runtimePath), agentdStateDir: config.agentdStateDir,
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
  // Rule 39's turn toward the focused window.
  observation: () => observation?.state ?? null,
  mainHeight: () => screen.getPrimaryDisplay().bounds.height,
}) : null;
/** The activity and timeline recorders (src/main/attention/watchers.ts), each running while agentd runs with its subsystem in
 *  the plan; none with `--no-attention`. */
const recorders = config && helper && runtimePath !== null ? shellRecorders({
  argv: process.argv, helper, agentd: new AgentdClient(runtimePath), agentdStateDir: config.agentdStateDir,
  saved: () => readSaved(configPath), ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]), plan,
  log: (line) => appendLog(config!.supportDir, 'companion', line),
}) : null;
/** Rule 44's colours over the helper (src/main/ambient/shell.ts); none with `--no-attention`. */
const ambient = config && hostLink && helper ? shellAmbient({
  argv: process.argv, platform: shellPlatform(), helper, link: hostLink, agentdStateDir: config.agentdStateDir,
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
const context = config && helper && runtimePath !== null ? shellContext({
  argv: process.argv, helper, agentd: new AgentdClient(runtimePath), agentdStateDir: config.agentdStateDir,
  settings: () => readObject(configPath),
  ownPids: () => (helper.pid === undefined ? [process.pid] : [process.pid, helper.pid]),
  log: (line) => appendLog(config!.supportDir, 'companion', line),
  onLook: lookReceipt(() => desktop?.source ?? null),
}) : null;
// ContextCapturer.attach: agentd's `request`s come over the app's one `/feed` connection.
store?.subscribe((e) => context?.feed(e));
// agentd's typing behavior may turn her.
store?.subscribe((e) => watchers?.feed(e));
/** 按住 Option 把她拖到窗口上 (handover/window.ts); none with `--no-attention`. */
const windowHandover = config && helper ? shellWindowHandover({ argv: process.argv, helper, settings: () => readObject(configPath),
  helperY: helperYFor(shellPlatform()), mainHeight: () => screen.getPrimaryDisplay().bounds.height, desktop: () => desktop }) : null;
/** 框选给她看…'s window (handover/region-window.ts); its BrowserWindow is made at each selection. */
const regionWindow = new RegionSelectWindow({
  url: `${ORIGIN}/stack.html#/region`,
  makeWindow: () => {
    const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    makeOverlay(win, 'region', addon);
    guardWebContents(win.webContents, 'stack', webGuard);
    return win;
  },
  get space() { return (cursorSpace ??= c3Space(screen)); },
  toDip: (r) => c3Dip(screen)(r), cursor: () => screen.getCursorScreenPoint(),
  presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
  register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
  unregister: (id) => pages.delete(id),
  get baseOps() { return surfaceOps('stack'); },
});
/** The computer control host over the helper (src/main/control/shell.ts), for agentd's desktop tools; none without `control`
 *  in the launch's plan or with `--no-attention`. */
const control = config && helper && plan().has('control') ? shellControl({
  argv: process.argv, helper, supportDir: config.supportDir, configPath, agentdStateDir: config.agentdStateDir,
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
const observation = runtimePath === null ? null : (() => {
  const client = new AgentdClient(runtimePath);
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
/** The bubble and hud panels; made once the app is ready with the web UI built. */
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
};
/** Clicks on her and the desktop actions that act on her (interaction/shell.ts). */
const interaction = config && runtimePath !== null ? (() => {
  const client = new AgentdClient(runtimePath);
  return interactionShell({
    request: async (method, path, json) => {
      const reply = await client.request(method, path, json);
      return { status: reply.status, body: reply.body.toString('utf8') };
    },
    settings: () => readObject(configPath), configPath, link: hostLink, desktop: () => desktop,
    openSessions: () => openMainAt(sessionsRoute()),
    // The menu comes up at the pointer.
    onContextMenu: (at) => {
      const space = (cursorSpace ??= c3Space(screen)), toDip = c3Dip(screen);
      const popup = characterMenuPopup(at, {
        toDip: (p) => toDip(space.rectFromC3({ x: p.x, y: p.y, w: 0, h: 0 })),
        display: (p) => screen.getDisplayNearestPoint(p).bounds,
        windows: () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
          .map((w) => ({ window: w, visible: w.isVisible(), content: w.getContentBounds() })),
      });
      if (popup) Menu.buildFromTemplate(avatarMenu(menus.state(), menus.ports())).popup(popup);
      else appendLog(config!.supportDir, 'companion', 'character menu: no window to pop it up over');
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
<h2>界面文件缺失</h2>
<p>找不到 <code>${WEB_DIST.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code>。先运行 <code>npm --prefix web run build</code>，再重新打开主窗口。</p>
<p>托盘和后台照常运行。</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** `activate: false` shows it without taking the front app. */
function openMain(activate = true): void {
  if (mainWindow) {
    if (activate) mainWindow.show();
    else mainWindow.showInactive();
    return;
  }
  const win = new BrowserWindow({
    width: 1385, height: 770, minWidth: 900, minHeight: 600, show: false, title: 'Agentic Complex',
    // The page draws up to the window's top edge; the traffic lights sit in its command bar, which leaves --ef-chrome-left for them.
    ...(shellPlatform() === 'mac' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 17 } } : {}),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const contents = win.webContents, id = contents.id;
  if (shellPlatform() === 'mac') contents.on('dom-ready', () => void contents.insertCSS(':root { --ef-chrome-left: 84px; }'));
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

/** A 16 pt ring. */
function ringImage(): NativeImage {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      if (d >= 9 && d <= 14) pixels.writeUInt32LE(0xff000000, (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
}

/** Asks on the main window; true to go on. */
async function confirm(text: string): Promise<boolean> {
  const options = { type: 'question' as const, message: text, buttons: ['取消', '确定'], defaultId: 1, cancelId: 0 };
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return response === 1;
}

/** workspace.py READ_SUFFIXES: agentd reads no other type. */
const SCOPE_FILE_TYPES = ['md', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
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

function opsContext(surface: Surface): OpsContext {
  return {
    surface, routes, platform: shellPlatform(),
    config: { path: configPath, supportDir: config?.supportDir ?? null, devResources: config?.devResources ?? null },
    agentd: runtimePath === null ? null : new AgentdClient(runtimePath), store,
    diag: diagStream && new SharedSource((emit) => diagStream.start((e) => emit({ event: e.event, id: e.id ?? null, data: e.data })),
      () => diagStream.stop()),
    supervisor: supervisor && {
      state: () => supervisor.state, pid: () => supervisor.pid, restart: () => { void supervisor.restart(); restartTunnel('backend'); }, avatar: () => rendererState,
      restartAvatar: renderer ? () => { void renderer.restart(); } : undefined, avatarPid: () => renderer?.pid,
      tunnel: () => (tunnel && tunnel.config.ttsTunnelHost !== '' ? tunnelState : null), tunnelPid: () => tunnel?.pid,
    },
    avatar: hostLink && linkAvatarHost(hostLink, (hidden) => setAvatarHidden(hidden), {
      captureDir: CAPTURE_DIR,
      captureSaved: notifyCaptureSaved,
      clickThroughChanged: () => {
        runtimeChanged();
        desktop?.pushState();
      },
    }),
    // `ps` is the Mac's; Windows leaves `cpuPercent` 0.
    cpuSeconds: shellPlatform() === 'mac' ? psCpuSeconds : null,
    looks, switcher, mmdSync,
    placement: placer,
    preview,
    helper,
    pushToTalk: pushToTalk && pushToTalkEvents,
    dropped: drops && drops.dropped,
    // Only the main window's messages are marked.
    turnMarks: surface === 'main' ? turnMarks : null,
    library: config && {
      catalog: config.characterCatalog, launched,
      characterName: config.characters.find((c) => c.id === config!.character)?.name ?? '',
      hookCommand: hookCommand(config.python, config.agentdDir, config.supportDir, shellPlatform(), PYTHON_FLAGS),
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
      ...liveSaved({
        link: hostLink, settings: () => readObject(configPath), restartAvatar: () => { void renderer?.restart(); },
        log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
      }),
    },
    settingsChanges,
    openOnboarding: () => guide.begin(),
    endOnboarding: (destination) => guide.end(destination),
    openQuickInput: config && (() => { desktop?.openQuickInput(); }),
    openMain: openMainAt,
    unregisteredHotkeys: () => unregisteredHotkeys(hotkeys, desktop?.quickInputFailed ?? null, pushToTalk?.failedHotkey ?? null),
    // Only the main window records.
    recordHotkey: surface === 'main' ? (rightOption) => hotkeyRecorder.record(rightOption) : null,
    runtime: { snapshot: () => runtimeJson(runtime.snapshot), events: runtimeEvents },
    // The main window asks agentd itself, the panels through the capturer.
    look: surface === 'main' ? (runtimePath === null ? null : agentdLook(new AgentdClient(runtimePath), log))
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

/** The first-run guide's window (onboarding/window.ts). */
const guide = onboardingWindow({
  configPath,
  makeWindow: (options) => new BrowserWindow({ ...options,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } }),
  served: () => serve !== null,
  workArea: () => screen.getPrimaryDisplay().workAreaSize,
  ops: () => (config ? surfaceOps('onboarding') : null),
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
    quietUntil: observation?.quietUntil() ?? null,
    avatarHovered: desktop?.avatarHovered ?? false, showPresence: s.desktop_presence !== false, showHoverHints: s.desktop_hover_hints !== false,
    character: id && { id, name: name(id) }, characters: (config?.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
    screens: desktopScreens(placer?.currentScreen() ?? null, screen.getAllDisplays()), hotkeys: desktopHotkeys(s, shellPlatform()),
    pips: { agentd: processState(agentdState, supervisor?.pid), avatar: processState(rendererState, renderer?.pid),
      voice: pushToTalk?.voice ?? 'off' },
    computerUseActive: control ? computerUseState(control.state).active : false,
    plugins: enabledPlugins(supervisor?.plugins ?? DEFAULT_PLUGINS),
  };
}

/** The processes and her visibility as this shell reads them; the character comes from the switch's `onChange`, agentd's stage and degraded from `onHealth`. This shell
 *  has no tunnel, no visibility reason or click-through-all. */
function runtimeChanged(): void {
  runtime.send({ kind: 'child', name: 'agentd', state: agentdState, pid: supervisor?.pid ?? null });
  runtime.send({ kind: 'child', name: 'avatar', state: rendererState, pid: renderer?.pid ?? null });
  runtime.send({ kind: 'child', name: 'tunnel', state: tunnelState, pid: tunnel?.pid ?? null });
  runtime.send({ kind: 'visibility', view: { hidden: hostLink?.hidden ?? false, reason: visibility.reason,
    fullscreenHidden: watchers?.fullscreenHidden ?? false, clickThroughAll: hostLink?.clickThroughAll ?? false } });
  menus.refreshIcon();
  updateTrayMenu();
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
/** 最近播报 of the tray menu. */
const recent = new RecentAnnouncements();
const menus = shellMenus({
  playlist: () => mainCtx && avatarPlaylist(mainCtx), recent,
  settings: () => readObject(configPath), plan,
  characters: () => config && config.characters.map((c) => ({ id: c.id, name: c.name })),
  launched,
  services: () => (config ? menuLines(tunnel?.config ?? config, rendererState, agentdState, tunnelState) : []),
  processes: () => processStatus(config === null, agentdState, rendererState, [rendererState, agentdState,
    ...(tunnel && tunnel.config.ttsTunnelHost !== '' ? [tunnelState.kind === 'external' ? { kind: 'running' } as const : tunnelState] : [])]),
  link: hostLink, looks, switcher, observation, camera, pushToTalk, context, interaction,
  desktop: () => desktop, placer: () => placer,
  capture: { dir: CAPTURE_DIR, saved: notifyCaptureSaved },
  setHidden: (hidden) => { setAvatarHidden(hidden); },
  restartChildren: () => {
    void supervisor?.restart();
    restartTunnel('children');
    void renderer?.restart();
  },
  openMain: openMainAt, quit: () => app.quit(), settingsChanged: (keys) => settingsChanges.changed(keys),
  log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
  handClipboard: helper && drops ? () => { void handClipboard({ helper, drops, desktop: () => desktop, log: (line) => appendLog(config!.supportDir, 'companion', line) }); } : undefined,
  selectRegion: config ? () => {
    void selectRegion({ select: () => regionWindow.select(), read: context ? (rect, excluding) => context.readRegion(rect, excluding) : null,
      excluded: () => (renderer?.pid === undefined ? [process.pid] : [process.pid, renderer.pid]), helperY: helperYFor(shellPlatform()),
      mainHeight: () => screen.getPrimaryDisplay().bounds.height, desktop: () => desktop,
      log: (line) => appendLog(config!.supportDir, 'companion', line) });
  } : undefined,
  ...(shellPlatform() === 'mac' && { setIcon: (b: IconBitmap) => tray?.setImage(trayImage(nativeImage.createFromBitmap(Buffer.from(b.pixels),
    { width: b.width, height: b.height, scaleFactor: 2 }))) }),
  trayChanged: () => updateTrayMenu(false),
});
// Her appearance and layer lists are in the tray icon's own menu.
hostLink?.on((e) => { if (e.kind === 'appearance' || e.kind === 'layers') updateTrayMenu(false); });

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
  if (!config || !serve || runtimePath === null) return;
  const client = new AgentdClient(runtimePath);
  const toDip = c3Dip(screen), space = c3Space(screen);
  desktop = new DesktopAssembly({
    makeWindow: (kind) => {
      const win = new BrowserWindow({ ...overlayOptions(), width: 100, height: 100,
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      makeOverlay(win, kind, addon);
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
      const s = placer?.hoverSample({ x: at.x, y: at.y }) ?? { hit: false, age: null, dragging: false };
      const hidden = hostLink?.hidden ?? false;
      return {
        present: !!hostLink?.connected && !hidden && placer?.anchorSample().body != null,
        hovered: simulateHover || avatarHovered({ ...s, hidden, clickThroughAll: hostLink?.clickThroughAll ?? false, switching: hostLink?.characterSwitching ?? false,
          buttonsDown: watchers?.buttonsDown ?? false, lastCursorHit: hostLink?.lastCursorHit ?? false }),
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
      restartAll: () => {
        void supervisor?.restart();
        void renderer?.restart();
      },
      quit: () => app.quit(),
    },
    playSound: () => playAlert(() => shell.beep()),
    confirm: confirmStack,
    openMain: openMainAt,
    present: (token, side, phase) => hostLink?.sendPresent(token, side, phase) ?? false,
    guard: webGuard,
    a11y: a11ySource(() => ({ reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
      reduceTransparency: nativeTheme.prefersReducedTransparency, increaseContrast: nativeTheme.shouldUseHighContrastColors }),
    (changed) => { nativeTheme.on('updated', changed); }),
    log: (line) => appendLog(config!.supportDir, 'companion', line),
  });
  drops?.desktopReady();
  desktop.start();
  desktop.source.onCount = (n) => menus.pendingApprovalsChanged(n);
  // A conversation the user types in keeps the interactive frame rate; the web panels never report her bubble.
  setInterval(() => hostLink?.setInteractionVisible(desktop?.typing ?? false, false), 250).unref();
  if (agentdState.kind === 'running') desktop.agentd(true);
  // The renderer starts before the panels.
  if (renderer) showAvatarLoading(renderer.loading);
}

ipcMain.on('bridge:boot', (e) => {
  const entry = pages.get(e.sender.id);
  e.returnValue = entry ? boot(entry.surface) : null;
});

ipcMain.handle('bridge:invoke', (e, message: unknown): Reply | Promise<Reply> => {
  const entry = pages.get(e.sender.id), frame = e.senderFrame;
  if (!entry || !frame) return { ok: false, error: { code: 'forbidden_frame', detail: 'no bridge surface' } };
  return handle(entry.surface, { mainFrame: frame === e.sender.mainFrame, origin: frame.origin }, message, entry.ops ?? ops, entry.page);
});

/** Off the Mac the tray's context menu, built again on each change it shows, `reread` asking agentd's quiet again; on macOS
 *  the menu comes up only on a right or option click (`trayClick`), so it is not the tray's context menu. */
function updateTrayMenu(reread = true): void {
  if (!tray) return;
  const items = trayContextMenu(shellPlatform(), () => menus.state({ diagnostics: false, reread }), menus.ports(), helperMenuLine(helperState));
  if (items) tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** The Mac's app menu, its 前往 by the plug-ins agentd runs with; set again at each start of agentd. */
function setAppMenu(): void {
  if (shellPlatform() !== 'mac') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu({ openMain: openMainAt, quit: () => app.quit() }, supervisor?.plugins ?? DEFAULT_PLUGINS)));
}

// The tray keeps the app running with no window open.
app.on('window-all-closed', () => {});

let childrenStopped = false;
let devReloader: { stop(): void } | null = null;
// The renderer (C3 quit first), then agentd; the platform helper last.
app.on('will-quit', (e) => {
  store?.stop();
  diagStream?.stop();
  desktop?.stop();
  hotkeys?.stop();
  hotkeyRecorder.cancel();
  camera?.stop();
  cameraOverlay?.stop();
  resizeOverlay?.stop();
  regionWindow.stop();
  placer?.stop();
  watchers?.stop();
  recorders?.stop();
  ambient?.stop();
  context?.stop();
  void control?.stop();
  controlPanel?.stop();
  looks?.stop();
  devReloader?.stop();
  if (childrenStopped || (!supervisor && !renderer && !helper && !tunnel)) return;
  e.preventDefault();
  void (async () => {
    await renderer?.stop();
    hostLink?.stop();
    await supervisor?.stop();
    await tunnel?.stop();
    await helper?.stop();
    childrenStopped = true;
    app.quit();
  })();
});

void app.whenReady().then(async () => {
  hideFromDock(app);
  // Electron's own handlers, installed by now, quit once and then restore the default action (quit.ts).
  quitOnSignals({ on: (signal, listener) => { process.on(signal, listener); }, quit: () => app.quit() });
  setAppMenu();
  runtimeChanged();
  tunnel?.start();
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
        makeOverlay(win, 'resize', addon);
        guardWebContents(win.webContents, 'stack', webGuard);
        return win;
      },
      toDip: (r) => c3Dip(screen)(r), fromC3: (b) => space.rectFromC3(b), cursor: () => screen.getCursorScreenPoint(),
      presses: (listener) => watchers?.onMouseDown(listener) ?? (() => {}),
      register: (contents, page, panelOps) => pages.set(contents.id, { surface: 'stack', page, ops: panelOps }),
      unregister: (id) => pages.delete(id),
      get baseOps() { return surfaceOps('stack'); },
      target: p,
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
        makeOverlay(win, 'control', addon);
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
  store?.subscribe((e) => {
    recent.receive(e, Date.now());
    if (e.event === 'announce') updateTrayMenu(false);
  });
  tray = new Tray(trayImage(ringImage()));
  tray.setToolTip(statusTitle(config?.supportDir ?? supportDir, DEFAULT_SUPPORT_DIR));
  if (shellPlatform() === 'mac') {
    tray.setTitle(trayTitle(config?.supportDir ?? null, DEFAULT_SUPPORT_DIR));
    const space = c3Space(screen);
    const click = (right: boolean, option: boolean, bounds: Rectangle) => trayClick({ right, option, bounds }, {
      desktop, toPlacement: (b) => space.fromDip(b),
      popUpMenu: () => tray?.popUpContextMenu(Menu.buildFromTemplate(trayMenuItems(menus.state({ diagnostics: option }), menus.ports()))),
      log: (line) => appendLog(config?.supportDir ?? supportDir, 'companion', line),
    });
    tray.on('click', (e, bounds) => click(false, e.altKey === true, bounds));
    tray.on('right-click', (e, bounds) => click(true, e.altKey === true, bounds));
  } else {
    // A right click opens the context menu (updateTrayMenu).
    tray.on('click', () => openMain());
  }
  updateTrayMenu();
  menus.refreshIcon();
  // The main window only for a config error or an empty roster; a first run gets the guide.
  const start = startupWindow({ configError: config === null, characters: config?.characters.length ?? 0,
    onboardingDone: config !== null && !guide.firstRun() });
  // A config error takes the front, an empty roster does not.
  if (start.open === 'main') openMainAt(start.route, config === null);
  else if (start.open === 'onboarding') guide.begin();
  // A test run records what came up, then quits as the tray's 退出 does.
  const quitAfter = quitAfterFromArgs(process.argv);
  if (quitAfter !== null) {
    setTimeout(() => {
      log(`QUIT_AFTER ${quitAfter}s main_window=${mainWindow?.isVisible() ? 'shown' : 'not shown'} url=${mainWindow?.webContents.getURL() ?? ''} tray=${tray !== null}`);
      app.quit();
    }, quitAfter * 1000);
  }
});
