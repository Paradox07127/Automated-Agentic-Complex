import type { WireSummaryRun } from '../../domain/wire';
import type { WireGateEvent } from './wire';

/** Filled by src/bridge/fake/demos/settings.ts; empty in the app. */
export const demo: {
  shotRuns?: (demo: string | null) => WireSummaryRun[];
  gateEvents?: (demo: string | null) => WireGateEvent[];
} = {};
