// In the window viewport she hides, rather than fades, while the front app's window covers her
// (`covered`) and shows again once it no longer does. Any manual show or hide cancels the pending change.

/** Seconds. */
export const FOCUS_VISIBILITY = { enterDelay: 1.2, leaveDelay: 0.8, minimumHidden: 3, manualGrace: 3 } as const;

export class FocusVisibility {
  private _hidden = false;
  private overlapSince: number | null = null;
  private clearSince: number | null = null;
  private hiddenAt = -Infinity;
  private manualUntil = -Infinity;

  get hidden(): boolean { return this._hidden; }

  /** A show or hide by anything else; `now` in seconds. */
  manual(now: number): void {
    this._hidden = false;
    this.overlapSince = null;
    this.clearSince = null;
    this.manualUntil = now + FOCUS_VISIBILITY.manualGrace;
  }

  /** The new visibility (true: shown) only when it changes. `interacting`: the user drags, presses or rests on her. */
  update(overlap: boolean, now: number, interacting: boolean): boolean | null {
    if (interacting) {
      this.overlapSince = null;
      this.manualUntil = now + FOCUS_VISIBILITY.manualGrace;
      return null;
    }
    if (now < this.manualUntil) return null;
    if (overlap) {
      this.clearSince = null;
      this.overlapSince ??= now;
      if (!this._hidden && now - this.overlapSince >= FOCUS_VISIBILITY.enterDelay) {
        this._hidden = true;
        this.hiddenAt = now;
        return false;
      }
    } else {
      this.overlapSince = null;
      this.clearSince ??= now;
      if (this._hidden && now - this.clearSince >= FOCUS_VISIBILITY.leaveDelay && now - this.hiddenAt >= FOCUS_VISIBILITY.minimumHidden) {
        this._hidden = false;
        return true;
      }
    }
    return null;
  }
}
