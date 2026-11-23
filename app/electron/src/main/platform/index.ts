// The only module that reads process.platform; the rest of the shell asks it.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { App, BrowserWindow, BrowserWindowConstructorOptions, NativeImage, Rectangle } from 'electron';
import { IDS, type ShellPlatform } from '../../common/config.ts';
import type { PanelKind } from '../../common/desktop-layout.ts';
import type { Rect } from '../../common/placement.ts';
import { isLocalPath } from '../../common/routes.ts';
import type { PreviewAddon } from '../preview/window.ts';
import { dipRect, type ElectronScreen, type PlacementSpace, placementSpace } from './screens.ts';

const mac = process.platform === 'darwin';

/** The platform the settings and the renderer's supervisor are told. */
export function shellPlatform(): ShellPlatform {
  return process.platform === 'win32' ? 'windows' : 'mac';
}

/**
 * The installed app's support dir, agentd's state dir and the page logs' dir: under ~/Library on macOS; on Windows the
 * roaming `%APPDATA%\Agentic Complex` and, outside it, the machine-local `%LOCALAPPDATA%\Agentic Complex\agentd` and
 * `\Logs`.
 */
export function defaultDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  home = homedir()): { supportDir: string; agentdStateDir: string; webLogsDir: string } {
  if (platform !== 'win32') {
    return { supportDir: posix.join(home, IDS.companionSupportDir), agentdStateDir: posix.join(home, IDS.agentdStateDir),
      webLogsDir: posix.join(home, IDS.webLogsDir) };
  }
  const local = win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'Agentic Complex');
  return { supportDir: win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'Agentic Complex'),
    agentdStateDir: win32.join(local, 'agentd'), webLogsDir: win32.join(local, 'Logs') };
}

/** The pids of lsof's `-Fp` output. */
export function lsofPids(stdout: string): number[] {
  return stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))).filter(Number.isInteger);
}

/** The pids of `netstat -a -n -o`'s TCP rows on local `port` without a remote port, the listening ones in any language. */
export function netstatListeners(stdout: string, port: number): number[] {
  const pids = stdout.split(/\r?\n/).map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s.*?(\d+)\s*$/i.exec(l))
    .filter((m) => m !== null && Number(m[1]) === port && m[2] === '0').map((m) => Number(m![3]));
  return [...new Set(pids)];
}

/** The command that lists who listens on a TCP port, and its output read as pids: lsof on macOS, netstat on Windows. */
export function portOwnersCommand(port: number, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env):
  { file: string; args: string[]; pids(stdout: string): number[] } {
  if (platform !== 'win32') return { file: '/usr/sbin/lsof', args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], pids: lsofPids };
  return { file: win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe'), args: ['-a', '-n', '-o'],
    pids: (stdout) => netstatListeners(stdout, port) };
}

/** No Dock icon on macOS. */
export function hideFromDock(app: App): void {
  if (mac) app.setActivationPolicy('accessory');
}

/** Windows shows a toast only for an app with an AppUserModelID, which the portable exe has no installer to set; macOS
 *  takes the bundle's id. Before the first `Notification`. */
export function setNotificationId(app: Pick<App, 'setAppUserModelId'>, platform: ShellPlatform = shellPlatform()): void {
  if (platform === 'windows') app.setAppUserModelId(IDS.appId);
}

/** `app.info`'s `os` without the version. */
export function osName(): string {
  return mac ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform;
}

/** macOS draws a template image in the menu bar's own colour. */
export function trayImage(image: NativeImage): NativeImage {
  if (mac) image.setTemplateImage(true);
  return image;
}

/** C3's transport: the Companion listens on a Unix socket on macOS; on Windows it connects to the renderer's named pipe. */
export function c3Transport(): 'unix' | 'pipe' {
  return process.platform === 'win32' ? 'pipe' : 'unix';
}

/** The macOS addon built to `path` (native/mac/preview.m); null on Windows, whose preview channel is not there yet. */
export function previewAddon(path: string): PreviewAddon | null {
  return mac ? createRequire(import.meta.url)(path) as PreviewAddon : null;
}

/** How the shell asks agentd to stop: SIGTERM on macOS; Windows has none, so closing agentd's stdin (agentd_launcher.py). */
export function agentdStopRequest(): 'sigterm' | 'stdin' {
  return process.platform === 'win32' ? 'stdin' : 'sigterm';
}

/**
 * The C12 platform helper: in a packaged app (`contents`, from packaged.ts `packagedContents`) `MacOS/ac-helper` in the
 * macOS app's `Contents`, `ac-helper.exe` in the Windows portable directory; otherwise the build output under `appDir`
 * (the repo's app/): `swift build -c release` in app/helpers/mac on macOS, app\helpers\windows\build.bat on Windows.
 */
export function helperExecutable(appDir: string, platform: NodeJS.Platform = process.platform, contents: string | null = null): string {
  if (platform === 'win32') {
    return contents === null ? win32.join(appDir, '..', '.local', 'build', 'helper-windows', 'ac-helper.exe') : win32.join(contents, 'ac-helper.exe');
  }
  return contents === null ? posix.join(appDir, 'helpers/mac/.build/release/ac-helper') : posix.join(contents, 'MacOS/ac-helper');
}

/** The flags before the script for the component Python: a packaged Windows app's is a plain python.exe, while the macOS
 *  `runtime.python` entrypoint is a wrapper that adds `-I -B` itself. */
export function pythonFlags(packaged: boolean, platform: ShellPlatform = shellPlatform()): string[] {
  return packaged && platform === 'windows' ? ['-I', '-B'] : [];
}

/**
 * A local absolute path as `open.*` takes it: `isLocalPath` on macOS; on Windows drive-absolute (`C:\…`), at most 4096
 * UTF-8 bytes, without control characters or `..` components.
 */
export function localPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return isLocalPath(path);
  // eslint-disable-next-line no-control-regex
  return /^[A-Za-z]:\\/.test(path) && new TextEncoder().encode(path).length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(path)
    && !path.split(/[\\/]/).includes('..');
}

/** The placement space and C3's coordinates over Electron's `screen` (screens.ts). */
export function c3Space(screen: ElectronScreen): PlacementSpace {
  return placementSpace(screen, process.platform === 'win32' ? 'windows' : 'mac');
}

/** `dipRect` for this platform: a placement space rect as an Electron DIP rect. */
export function c3Dip(screen: ElectronScreen): (r: Rect) => Rectangle {
  return dipRect(screen, process.platform === 'win32' ? 'windows' : 'mac');
}

/**
 * A desktop panel's window: transparent, borderless, without a shadow; on macOS a non-activating panel, on Windows
 * unfocusable (`WS_EX_NOACTIVATE`), so a click in it activates nothing. A panel that takes typing turns focusable only
 * while it does (DesktopPanel's `makeKey`); every overlay shows with `showInactive`.
 */
export function overlayOptions(platform: ShellPlatform = shellPlatform()): BrowserWindowConstructorOptions {
  return {
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, enableLargerThanScreen: true,
    ...(platform === 'mac' ? { type: 'panel', roundedCorners: false } : { focusable: false }),
  };
}

/** Each overlay window: the desktop panels, 调整大小, 调整镜头, the computer control approval and 雷霆大字. */
export type Overlay = PanelKind | 'resize' | 'camera' | 'control' | 'title';

/**
 * The overlays' stacking, lowest first, as levels over the avatar window's status level (25): bubble, chip and 雷霆大字, her
 * hover buttons, the full-screen 调整大小 and 调整镜头 frames over those while they edit, the command layer and the console
 * at NSPopUpMenuWindowLevel (101), and the computer control approval over all of them. macOS keeps a higher level in
 * front. Windows has no levels: every overlay is topmost alike and the one shown last is in front of the others.
 */
export const OVERLAY_LEVELS: Readonly<Record<Overlay, number>> = {
  bubble: 1, chip: 1, title: 1, dock: 2, resize: 4, camera: 4, cmd: 76, console: 76, control: 77,
};

/**
 * `overlay`'s place in OVERLAY_LEVELS, on every Space and over fullscreen apps, clicks
 * passing through until the pointer reaches an interactive region, and on macOS clicks in it never activating the app
 * (`_setPreventsActivation:`; on Windows `overlayOptions` already made it unfocusable); `addon` is the macOS one, null
 * elsewhere.
 */
export function makeOverlay(win: BrowserWindow, overlay: Overlay, addon: Pick<PreviewAddon, 'setPreventsActivation'> | null): void {
  win.setAlwaysOnTop(true, 'status', OVERLAY_LEVELS[overlay]);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  if (mac) win.setHiddenInMissionControl(true);
  if (mac && addon) addon.setPreventsActivation(win.getNativeWindowHandle());
}

/** StackSource's sound for a new approval or a `sound` announcement: NSSound Glass on macOS, `beep` (Electron's) elsewhere. */
export function playAlert(beep: () => void): void {
  if (mac) execFile('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], { windowsHide: true }, () => {});
  else beep();
}
