import type { ObsSegment, ObsShot } from './model';

// Filled by src/bridge/fake/demos/observe.ts; empty in the app.
export const demo: {
  /** Foreground window title per app (the screenshot hover card). */
  titles?: Readonly<Record<string, string>>;
  /** What the observation events would give in the `full` and `paused` demos. */
  b11?: {
    segments: ObsSegment[];
    shots: (segs: ReadonlyArray<ObsSegment>, n: number) => ObsShot[];
    blocked: Array<{ t: number; why: string }>;
    pause: { from: number; until: number };
  };
} = {};
