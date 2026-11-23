import type { LineSeries } from '../../charts';
import type { NodeId, NodeStat } from './flow';

// Filled by src/bridge/fake/demos/diag.ts; empty in the app.
export const demo: {
  /** The `full` demo's stage aggregate and process history. */
  full?: {
    hourly: Record<NodeId, NodeStat>;
    procHistory: { cpu: LineSeries[]; mem: LineSeries[] };
  };
} = {};
