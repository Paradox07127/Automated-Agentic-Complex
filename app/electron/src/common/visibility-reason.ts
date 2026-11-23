// Her visibility reason and the hide that expires.

export const HIDE_EXPIRY_MS = 30 * 60 * 1000;

export interface VisibilityPorts {
  /** Runs `fn` once after `ms`; returns its cancel. */
  after(ms: number, fn: () => void): () => void;
  /** The hide expired: the shell shows her with reason `hide_expired`, which comes back through `set`. */
  expired(): void;
  /** Epoch ms; Date.now without it. */
  now?(): number;
}

export class AvatarVisibility {
  /** `visibility.reason`; null before the first change. */
  reason: string | null = null;
  /** Epoch ms the running hide expires; null without one. */
  hiddenUntil: number | null = null;
  private readonly ports: VisibilityPorts;
  private cancel: (() => void) | null = null;

  constructor(ports: VisibilityPorts) {
    this.ports = ports;
  }

  /** Every show or hide: a hide for any reason but `fullscreen` expires after `HIDE_EXPIRY_MS`. */
  set(hidden: boolean, reason: string): void {
    this.reason = reason;
    this.cancel?.();
    const expires = hidden && reason !== 'fullscreen';
    this.cancel = expires ? this.ports.after(HIDE_EXPIRY_MS, () => this.ports.expired()) : null;
    this.hiddenUntil = expires ? (this.ports.now?.() ?? Date.now()) + HIDE_EXPIRY_MS : null;
  }
}
