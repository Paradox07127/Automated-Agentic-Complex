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

export function liveSaved(o: LiveSavedPorts) {
  return {
    /** The link reads the switches from config.json again. */
    touch: () => { o.link?.touchSettingsChanged(); },
    /** `keys`: the changed live render settings, for the log; a `set_render` that fails or is not sent restarts her. */
    renderLive: (keys: string[]) => {
      const fallback = (why: string) => {
        o.log(`render live fallback keys=${keys.join(',')} why=${why}`);
        o.restartAvatar();
      };
      const sent = o.link?.sendSetRender(liveRenderPayload(o.settings()), (r) => { if (!r.ok) fallback(r.reason); }) ?? false;
      if (!sent) fallback('not_sent');
    },
  };
}
