import type { CardHistory } from './board';

// Filled by src/bridge/fake/demos/tasks.ts; empty in the app.
export const demo: {
  /** The `full` demo's per-card state history. */
  history?: Record<string, CardHistory>;
  /** The card the `decidefail` demo opens. */
  decideFailId?: string;
} = {};
