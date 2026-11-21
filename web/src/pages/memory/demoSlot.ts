import type { Version } from './FactSheet';

// Filled by src/bridge/fake/demos/memory.ts; empty in the app.
export const demo: {
  /** The `full` demo's preview: earlier versions per fact, the locked facts and the ones marked 不再提及. */
  preview?: { versions: Record<string, Version[]>; locked: string[]; quiet: string[] };
} = {};
