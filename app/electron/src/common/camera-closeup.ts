// The conversation close-up: with `render_camera_auto_closeup` = `session` the shell asks for
// `camera.closeup` while the session panel stays shown and ends it once the panel stays hidden. Times are
// seconds on one monotonic clock.

export const CLOSEUP_TIMING = {
  enterDelay: 0.8,
  exitDelay: 3,
  /** How often the link and the setting are read again while a close-up is wanted or held. */
  poll: 1,
} as const;

export class CameraCloseupPolicy {
  private visible = false;
  private visibleChangedAt = -Infinity;
  /** The panel's visibility after the delays. */
  private wanted = false;
  /** The last value `link` took; a new link may still hold a `true` an earlier one took (same avatar process). */
  private sentOn = false;
  private sentLink: number | null = null;

  /** `setting` is the config value; `link` names the handshaken avatar connection, null without one; `capable` is both
   *  sides listing `camera_free`. Returns the `closeup` to send now, null for nothing; call `sent` once it is delivered. */
  update(setting: unknown, panelVisible: boolean, link: number | null, capable: boolean, now: number): boolean | null {
    if (panelVisible !== this.visible) {
      this.visible = panelVisible;
      this.visibleChangedAt = now;
    }
    const delay = this.visible ? CLOSEUP_TIMING.enterDelay : CLOSEUP_TIMING.exitDelay;
    if (this.visible !== this.wanted && now - this.visibleChangedAt >= delay) this.wanted = this.visible;
    if (link === null || !capable) return null;
    const target = setting === 'session' && this.wanted;
    if (target !== this.sentOn || (link !== this.sentLink && (target || this.sentOn))) return target;
    return null;
  }

  sent(on: boolean, link: number): void {
    this.sentOn = on;
    this.sentLink = link;
  }

  /** When to call `update` again; null while the panel is hidden and no close-up is wanted or held. */
  nextCheck(now: number): number | null {
    if (!this.visible && !this.wanted && !this.sentOn) return null;
    const next = now + CLOSEUP_TIMING.poll;
    if (this.visible === this.wanted) return next;
    return Math.min(next, this.visibleChangedAt + (this.visible ? CLOSEUP_TIMING.enterDelay : CLOSEUP_TIMING.exitDelay));
  }
}

/** The main window's hash route, null while it is not shown, is the sessions page when it is 今天 on its running
 *  sessions (`focus=running`) or on a selected session or task (`sel`). */
export function sessionsShown(route: string | null): boolean {
  if (route === null) return false;
  const i = route.indexOf('?'), path = i < 0 ? route : route.slice(0, i), q = new URLSearchParams(i < 0 ? '' : route.slice(i + 1));
  return path === '/overview' && (q.get('focus') === 'running' || (q.get('sel') ?? '') !== '');
}
