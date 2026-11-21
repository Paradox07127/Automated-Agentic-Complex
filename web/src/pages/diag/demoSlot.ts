import type { LineSeries } from '../../charts';
import type { NodeId, NodeStat } from './flow';
import type { UptimeSeg } from './Processes';
import type { ProcessKey } from './status';

// Filled by src/bridge/fake/demos/diag.ts; empty in the app.
export const demo: {
  /** The `full` demo's stage aggregate and process history. */
  full?: {
    hourly: Record<NodeId, NodeStat>;
    procHistory: { cpu: LineSeries[]; mem: LineSeries[] };
    procRows: { uptime: Partial<Record<ProcessKey, UptimeSeg[]>>; cpu: Partial<Record<ProcessKey, number[]>> };
  };
} = {};
