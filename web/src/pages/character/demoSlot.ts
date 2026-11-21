import type { SWITCH_STAGES } from './tables';

/** Mood baseline and behavior multipliers (agentd does not send them). */
export interface StateScales {
  baseline: number;
  walk_scale: number;
  comment_scale: number;
}

/** Filled by src/bridge/fake/demos/character.ts; empty in the app. */
export const demo: {
  /** The rejection the `switchfail` demo opens on. */
  switchReject?: { id: string; stage: (typeof SWITCH_STAGES)[number]; reason: string };
  motionHours?: Record<string, number[]>;
  motionHoursSparse?: Record<string, number[]>;
  stateScales?: StateScales;
} = {};
