// The user's mouse presses anywhere: the helper's `input.watch` sends an `input.activity` of kind `mouse_down` for each press (C12 CONTRACT §7.3), which carries no position, so the pointer is read
// when it arrives. It reads presses of every button. A `mouse_up` for each release makes `buttonsDown`
// (HostLink.buttonsDown); a helper that has sent none (Windows for now) leaves it false.
import type { HelperAnswer } from '../../common/push-to-talk.ts';

export interface MouseDownPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer> };
  /** The pointer in C3 global points. */
  cursor(): { x: number; y: number };
  /** Seconds. */
  now(): number;
  log(line: string): void;
}

export class MouseDowns {
  private readonly ports: MouseDownPorts;
  private readonly listeners = new Set<(at: { x: number; y: number }, ts: number) => void>();
  /** `input.watch` answered; after a restart the supervisor asks for it again (C12 §6.4). */
  private watched = false;
  private failed: string | null = null;
  private held = false;
  /** This helper process has sent a `mouse_up`. */
  private releases = false;

  constructor(ports: MouseDownPorts) {
    this.ports = ports;
  }

  /** A mouse button is down now, as far as the helper's presses and releases tell. */
  get buttonsDown(): boolean { return this.releases && this.held; }

  /** The helper said hello (true) or went (false). */
  helper(running: boolean): void {
    if (!running) {
      this.held = false;
      this.releases = false;
    }
    if (!running || this.watched) return;
    void this.ports.helper.request('input.watch', { enabled: true }).then((r) => {
      if (r.ok) {
        this.watched = true;
        this.failed = null;
        return;
      }
      if (this.failed !== r.error.code) this.ports.log(`MOUSE input.watch failed code=${r.error.code}`);
      this.failed = r.error.code;
    });
  }

  /** A helper event; only `input.activity`'s `mouse_down` and `mouse_up` are read. */
  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'input.activity') return;
    if (data.kind === 'mouse_up') {
      this.held = false;
      this.releases = true;
    }
    if (data.kind !== 'mouse_down') return;
    this.held = true;
    const at = this.ports.cursor(), ts = this.ports.now();
    for (const l of this.listeners) l(at, ts);
  }

  /** `listener` hears each press until the returned function is called. */
  on(listener: (at: { x: number; y: number }, ts: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
