// The ambient sampler over the platform helper (`capture.ambient`): each second while she runs, the colours behind
// her (`render_ambient` "screen") or of the wallpaper go to the renderer as C3 `ambient_sample`. Keeps no image;
// only the five colours leave this module.
import { AMBIENT, type AmbientColors, ambientChanged, ambientMode, ambientWire, reduceAmbient } from '../../common/ambient.ts';
import { type CaptureWindow, captureBlockReason } from '../../common/capture-rules.ts';
import { type BlacklistRules, decodeRect, type HelperY, type Rect, toAppKit } from '../../common/attention.ts';
import type { HelperAnswer } from '../../common/push-to-talk.ts';

export interface AmbientPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  link: { readonly capabilities: readonly string[]; sendAmbientSample(source: string, colors: AmbientColors): boolean };
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** The front window as the attention sampler last saw it; null keeps the screen closed. */
  front(): CaptureWindow | null;
  blacklist(): BlacklistRules;
  /** This shell's processes, hidden by the blacklist check. */
  ownPids(): readonly number[];
  /** The processes whose windows a screen sample leaves out: this shell's and the renderer's. */
  excludePids(): readonly number[];
  /** HostLink.avatarVisualRect: the `visual` of the latest global `hit_capsules`, in C3 global points; null without one. */
  visual(): Rect | null;
  /** HostLink.avatarFigureFrame in C3 global points; null without one. */
  figure(): Rect | null;
  /** C3's y of the helper's coordinates. */
  helperY: HelperY;
  /** Monotonic milliseconds. */
  now(): number;
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

interface HelperScreen { id: number; frame: Rect; primary: boolean }

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export class AmbientSampler {
  private readonly ports: AmbientPorts;
  private stopTimer: (() => void) | null = null;
  private last: AmbientColors | null = null;
  private lastSource: string | null = null;
  private wallpaperAt = -Infinity;
  private sampling = false;
  /** The last failure logged, so a lasting one is logged once. */
  private failed: string | null = null;
  /** Screen captures running, and when one last started or ended. */
  private capturing = 0;
  private captureAt = -Infinity;

  constructor(ports: AmbientPorts) {
    this.ports = ports;
  }

  /** Our capture lights the capture indicator until about 1 s after it ends. */
  get ownCaptureRecent(): boolean {
    return this.capturing > 0 || this.ports.now() - this.captureAt < 3000;
  }

  start(): void {
    this.stopTimer ??= this.ports.every(AMBIENT.intervalMs, () => this.tick());
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    // The next avatar gets a sample at once.
    this.last = null;
    this.lastSource = null;
    this.wallpaperAt = -Infinity;
  }

  /** A helper event; a desktop space change samples the wallpaper again at once. */
  event(name: string, data: Record<string, unknown>): void {
    if (this.stopTimer === null || name !== 'workspace.changed' || data.reason !== 'space') return;
    this.wallpaperAt = -Infinity;
    this.tick();
  }

  private tick(): void {
    const mode = ambientMode(this.ports.settings());
    if (mode === 'off' || !this.ports.link.capabilities.includes('ambient') || this.sampling) return;
    this.sampling = true;
    void this.sample(mode).finally(() => { this.sampling = false; });
  }

  private async sample(mode: string): Promise<void> {
    const p = this.ports;
    const front = mode === 'screen' ? p.front() : null;
    const visual = p.visual();
    if (front !== null && captureBlockReason(front, p.blacklist(), p.ownPids()) === null && visual !== null) {
      const screens = await this.screens();
      const main = screens?.find((s) => s.primary);
      if (main) {
        this.capturing += 1;
        this.captureAt = p.now();
        const r = await p.helper.request('capture.ambient', { source: 'screen', side: AMBIENT.side,
          rect: toAppKit(visual, main.frame.height, p.helperY), exclude_pids: [...p.excludePids()] });
        this.capturing -= 1;
        this.captureAt = p.now();
        // CGPreflightScreenCaptureAccess false: the wallpaper, as if the screen were closed.
        if (r.ok || r.error.code !== 'permission_denied') {
          // A fall back to the wallpaper samples it at once.
          this.wallpaperAt = -Infinity;
          this.deliver(r, 'screen');
          return;
        }
      }
    }
    if (p.now() - this.wallpaperAt < AMBIENT.wallpaperMs) return;
    this.wallpaperAt = p.now();
    const screens = await this.screens();
    if (screens === null) return;
    const figure = p.figure();
    const at = figure && screens.length > 0 ? toAppKit(figure, screens.find((s) => s.primary)?.frame.height ?? 0, p.helperY) : null;
    const screen = screens.find((s) => at !== null && overlaps(s.frame, at)) ?? screens.find((s) => s.primary);
    if (!screen) return;
    this.deliver(await p.helper.request('capture.ambient', { source: 'wallpaper', side: AMBIENT.side, display_id: screen.id }), 'wallpaper');
  }

  /** `screens.list` with the display ids; null when the helper did not answer. */
  private async screens(): Promise<HelperScreen[] | null> {
    const r = await this.ports.helper.request('screens.list', {});
    if (!r.ok || !Array.isArray(r.result.screens)) return null;
    return (r.result.screens as Record<string, unknown>[]).flatMap((s) => {
      const frame = decodeRect(s?.frame);
      return frame !== null && Number.isInteger(s.display_id) ? [{ id: s.display_id as number, frame, primary: s.primary === true }] : [];
    });
  }

  private deliver(r: HelperAnswer, source: string): void {
    if (!r.ok) {
      if (this.failed !== `${source} ${r.error.code}`) this.ports.log(`AMBIENT ${source} failed code=${r.error.code}`);
      this.failed = `${source} ${r.error.code}`;
      return;
    }
    this.failed = null;
    const { width, height, rgba } = r.result;
    const pixels = typeof rgba === 'string' ? new Uint8Array(Buffer.from(rgba, 'base64')) : null;
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1
      || pixels === null || pixels.length !== (width as number) * (height as number) * 4) {
      this.ports.log(`AMBIENT ${source} bad image`);
      return;
    }
    const colors = reduceAmbient(pixels, width as number, height as number);
    if (source === this.lastSource && !ambientChanged(this.last, colors)) return;
    if (!this.ports.link.sendAmbientSample(source, ambientWire(colors))) return;
    this.last = colors;
    this.lastSource = source;
  }
}
