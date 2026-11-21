// The conversation close-up's loop: the session panel's visibility and
// `render_camera_auto_closeup` go to CameraCloseupPolicy, its `closeup` out over the host link.
import { CameraCloseupPolicy, sessionsShown } from '../../common/camera-closeup.ts';

export interface CloseupPorts {
  /** config.json `render_camera_auto_closeup`, read at each step. */
  setting(): unknown;
  link: { readonly connected: boolean; readonly capabilities: string[]; sendCloseup(on: boolean): boolean } | null;
  /** Tells one avatar process's connections from the next's. */
  avatarPid(): number | null | undefined;
  /** Seconds on a monotonic clock. */
  now?(): number;
  /** Runs `fire` after `seconds`; returns its cancel. */
  schedule?(seconds: number, fire: () => void): () => void;
}

const monotonic = () => performance.now() / 1000;
const timer = (seconds: number, fire: () => void) => {
  const t = setTimeout(fire, seconds * 1000);
  return () => clearTimeout(t);
};

export class CameraCloseupDriver {
  private readonly policy = new CameraCloseupPolicy();
  private visible = false;
  private cancel: (() => void) | null = null;
  private readonly ports: CloseupPorts;

  constructor(ports: CloseupPorts) {
    this.ports = ports;
  }

  panel(visible: boolean): void {
    this.visible = visible;
    this.step();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private step(): void {
    this.stop();
    const now = (this.ports.now ?? monotonic)(), link = this.ports.link;
    const id = link?.connected ? (this.ports.avatarPid() ?? 0) : null;
    const capable = link?.capabilities.includes('camera_free') ?? false;
    const on = this.policy.update(this.ports.setting(), this.visible, id, capable, now);
    if (on !== null && id !== null && link!.sendCloseup(on)) this.policy.sent(on, id);
    const next = this.policy.nextCheck(now);
    if (next === null) return;
    this.cancel = (this.ports.schedule ?? timer)(Math.max(0, next - now), () => this.step());
  }
}

/** What of a BrowserWindow the sessions watch reads. */
export interface SessionsWindow {
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: 'show' | 'hide' | 'minimize' | 'restore' | 'closed', listener: () => void): unknown;
  webContents: { getURL(): string; on(event: 'did-navigate' | 'did-navigate-in-page', listener: () => void): unknown };
}

/** For one main window: `shown` gets whether
 *  the sessions page is shown each time that changes; a closed window is not shown. */
export function watchSessionsShown(win: SessionsWindow, shown: (visible: boolean) => void): void {
  let last = false;
  const report = (closed: boolean) => {
    const hash = closed || !win.isVisible() || win.isMinimized() ? '' : new URL(win.webContents.getURL()).hash;
    const now = sessionsShown(hash === '' ? null : hash.slice(1));
    if (now === last) return;
    last = now;
    shown(now);
  };
  for (const event of ['show', 'hide', 'minimize', 'restore'] as const) win.on(event, () => report(false));
  win.on('closed', () => report(true));
  for (const event of ['did-navigate', 'did-navigate-in-page'] as const) win.webContents.on(event, () => report(false));
}
