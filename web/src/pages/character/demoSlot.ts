import type { SWITCH_STAGES } from './tables';

/** Filled by src/bridge/fake/demos/character.ts; empty in the app. */
export const demo: {
  /** The rejection the `switchfail` demo opens on. */
  switchReject?: { id: string; stage: (typeof SWITCH_STAGES)[number]; reason: string };
} = {};
