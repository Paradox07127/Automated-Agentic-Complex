// The MMD playlist player: one `play_action` at a
// time, following the `action_played` of its own play ids. config.json `motion_playlists` is character.ts `decodePlaylists`.
import type { Playlist } from './character.ts';

export type PlaylistState = { kind: 'idle' } | { kind: 'playing'; index: number; playId: string };

export interface PlaylistPorts {
  /** Sends `play_action`; the play id, or null when nothing was sent. */
  send(id: string, speed: number, loop: boolean): string | null;
  stop(playId: string): void;
  /** The avatar lists `action_loop`. */
  supportsLoop(): boolean;
}

export class PlaylistPlayer {
  private _state: PlaylistState = { kind: 'idle' };
  /** The reason of the `rejected` or `interrupted` receipt that stopped the list. */
  private _lastReason: string | null = null;
  private config: Playlist = { items: [], loop: 'off', speed: 1 };
  private readonly ports: PlaylistPorts;

  constructor(ports: PlaylistPorts) {
    this.ports = ports;
  }

  get state(): PlaylistState { return this._state; }
  get lastReason(): string | null { return this._lastReason; }

  start(config: Playlist, index: number): void {
    this.config = config;
    this._lastReason = null;
    this.play(index);
  }

  stop(): void {
    if (this._state.kind === 'playing' && this.ports.supportsLoop()) this.ports.stop(this._state.playId);
    this._state = { kind: 'idle' };
  }

  received(playId: string, phase: string, reason: string | null): void {
    const s = this._state;
    if (s.kind !== 'playing' || s.playId !== playId) return;
    switch (phase) {
      case 'completed':
        if (this.config.loop === 'off') {
          if (s.index + 1 < this.config.items.length) this.play(s.index + 1);
          else this._state = { kind: 'idle' };
        } else {
          this.play(this.config.loop === 'all' ? (s.index + 1) % this.config.items.length : s.index);
        }
        break;
      case 'rejected': case 'interrupted':
        // Any interruption, including a behavior taking the body, ends the list.
        this._state = { kind: 'idle' };
        this._lastReason = reason;
        break;
    }
  }

  characterChanged(): void {
    this._state = { kind: 'idle' };
  }

  /** The item playing now and its index in `saved`; the index is null when a single slot plays an action `saved` lacks. */
  position(saved: string[]): { index: number | null; id: string } | null {
    const s = this._state;
    if (s.kind !== 'playing' || s.index < 0 || s.index >= this.config.items.length) return null;
    const id = this.config.items[s.index]!;
    if (this.config.items.length === saved.length && this.config.items.every((x, i) => x === saved[i])) return { index: s.index, id };
    const at = saved.indexOf(id);
    return { index: at < 0 ? null : at, id };
  }

  private play(index: number): void {
    const id = this.config.items[index];
    const playId = id === undefined ? null
      : this.ports.send(id, this.config.speed, this.config.loop === 'one' && this.ports.supportsLoop());
    this._state = playId === null ? { kind: 'idle' } : { kind: 'playing', index, playId };
  }
}
