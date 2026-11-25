// The 天气 rows' loop: config.json `render_weather` and `render_weather_intensity` go to the desktop renderer as
// C3 `set_presentation.weather` on each hello, after each character switch and after each save, and again before
// `valid_for_seconds` runs out (the renderer turns clear when it does).
import { current, settingValues } from '../../common/settings.ts';
import type { HostLink } from './link.ts';

export const WEATHER_TIMING = {
  /** `valid_for_seconds`: C3's maximum. */
  hold: 3600,
  /** Seconds after a send that it is sent again, inside `hold`. */
  renew: 3000,
} as const;

export interface WeatherPorts {
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  link: Pick<HostLink, 'connected' | 'currentCharacter' | 'sendSetPresentation' | 'on'>;
  log(line: string): void;
  /** Runs `fire` after `seconds`; returns its cancel. */
  schedule?(seconds: number, fire: () => void): () => void;
}

const timer = (seconds: number, fire: () => void) => {
  const t = setTimeout(fire, seconds * 1000);
  return () => clearTimeout(t);
};

export class WeatherDriver {
  private readonly ports: WeatherPorts;
  private req = 0;
  private cancel: (() => void) | null = null;
  /** The last weather the renderer took is clear; each character starts clear. */
  private clear = true;

  constructor(ports: WeatherPorts) {
    this.ports = ports;
    ports.link.on((e) => {
      if (e.kind === 'lost') this.stop();
      else if (e.kind === 'character' && e.event.kind !== 'failed') this.send();
    });
  }

  /** A save changed the rows. */
  saved(): void {
    this.send();
  }

  /** The link's onPresentationState. */
  state(s: Record<string, unknown>): void {
    if (s.phase === 'rejected') this.ports.log(`weather rejected req=${String(s.req)} character=${String(s.character)} reason=${String(s.reason)}`);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private send(): void {
    this.stop();
    const link = this.ports.link, character = link.currentCharacter;
    if (!link.connected || character === null) return;
    const values = current(settingValues(this.ports.settings()), null).values;
    const condition = values.render_weather as 'clear' | 'rain' | 'snow';
    if (condition === 'clear' && this.clear) return;
    const weather = { condition, intensity: condition === 'clear' ? 0 : values.render_weather_intensity as number };
    if (!link.sendSetPresentation(this.req, character, { weather, valid_for_seconds: WEATHER_TIMING.hold })) return;
    this.req += 1;
    this.clear = condition === 'clear';
    if (!this.clear) this.cancel = (this.ports.schedule ?? timer)(WEATHER_TIMING.renew, () => this.send());
  }
}
