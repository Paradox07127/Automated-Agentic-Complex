// The page clock: the wall clock under the shell; the fake bridge pins it to its fixtures' "now".
let pinned: number | undefined;

/** Called by the fake bridge when it loads, so countdowns and readouts match its data. */
export function pinClock(at: number): void {
  pinned = at;
}

export function appNow(): number {
  return window.agenticComplex ? Date.now() : (pinned ?? Date.now());
}
