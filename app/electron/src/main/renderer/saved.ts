// What a settings save sends the running renderer:
// OpsContext.saved's `touch` and `renderLive`.
import { liveRenderPayload } from '../../common/camera-model.ts';
import type { CommandResult } from './link.ts';

export interface LiveSavedPorts {
  /** HostLink; null without one. */
  link: {
    touchSettingsChanged(): boolean;
    sendSetRender(payload: Record<string, unknown>, onResult?: (r: CommandResult) => void): boolean;
  } | null;
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  restartAvatar(): void;
  /** The companion log. */
  log(line: string): void;
}

/** `settings`' live render values as one `set_render`; one that fails or is not sent restarts her. `keys`: for the log. */
export function sendLiveRender(link: Pick<NonNullable<LiveSavedPorts['link']>, 'sendSetRender'> | null, settings: Record<string, unknown>,
  keys: string[], restartAvatar: () => void, log: (line: string) => void): void {
  const fallback = (why: string) => {
    log(`render live fallback keys=${keys.join(',')} why=${why}`);
    restartAvatar();
  };
  const sent = link?.sendSetRender(liveRenderPayload(settings), (r) => { if (!r.ok) fallback(r.reason); }) ?? false;
  if (!sent) fallback('not_sent');
}

export function liveSaved(o: LiveSavedPorts) {
  return {
    /** The link reads the switches from config.json again. */
    touch: () => { o.link?.touchSettingsChanged(); },
    /** `keys`: the changed live render settings. */
    renderLive: (keys: string[]) => sendLiveRender(o.link, o.settings(), keys, () => o.restartAvatar(), (line) => o.log(line)),
  };
}
