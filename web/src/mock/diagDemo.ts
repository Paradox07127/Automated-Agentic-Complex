// Diag demo data beyond agentd's current endpoints: the `sparse` day and the `full` demo's stage aggregate and process history.
import type { LineSeries } from '../charts';
import type { NodeId, NodeStat } from '../pages/diag/flow';
import type { WireUsage } from '../domain';
import { at, MINUTE } from './fixtures/clock';

/** `demo=` of the page URL (`#/diag?demo=…`); real agentd never sees it. */
export const demoParam = () => new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '').get('demo');

export const use = (calls: number, input: number, cache: number, out: number, cost = 0, unpriced = 0): WireUsage => ({
  calls,
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: cache,
  output_tokens: out,
  cost_usd: cost,
  unpriced,
  incomplete: 0,
  failed: 0,
  cancelled: 0,
  local: 0,
  usage_missing: 0,
  pricing_unverified: 0,
});

/** Today's tokens by billing channel (usage.py by_channel). */
export const BY_CHANNEL: Record<string, WireUsage> = {
  anthropic_api: use(160, 92_000, 400_000, 48_000, 0.4),
  chatgpt_subscription: use(12, 60_000, 90_000, 10_000, 0, 12),
  deepseek_api: use(42, 30_000, 8000, 4000, 0.02),
};

/** `demo=sparse`: nine turns today, three in the last hour. */
export const SPARSE_TURNS: Array<[number, number, string, TurnRes, number]> = [
  [9, 12, 'text', 'completed', 2600],
  [10, 2, 'text', 'completed', 3100],
  [10, 48, 'proactive', 'completed', 1900],
  [11, 5, 'voice', 'completed', 2300],
  [11, 6, 'text', 'completed', 1700],
  [12, 30, 'proactive', 'completed', 900],
  [13, 44, 'text', 'completed', 2800],
  [14, 6, 'proactive', 'blocked', 420],
  [14, 21, 'text', 'failed', 3900],
];
type TurnRes = 'completed' | 'failed' | 'blocked';

export const SPARSE_BY_CALL: Record<string, WireUsage> = { mouth: use(6, 18_000, 50_000, 5000, 0.04), observe_summary: use(5, 4000, 12_000, 1000, 0.01), decision: use(3, 3000, 3000, 600, 0.01) };
export const SPARSE_BY_CHANNEL: Record<string, WireUsage> = { anthropic_api: use(11, 21_000, 64_000, 6000, 0.05), deepseek_api: use(3, 4000, 1000, 600, 0.01) };

/** Hourly stage aggregate (count, p50 ms, failures) the backend does not send yet. */
const H: Record<NodeId, [number, number, number]> = {
  obs: [58, 820, 0],
  interp: [41, 1240, 1],
  input: [12, 4, 0],
  ctx: [53, 38, 0],
  judge: [53, 410, 0],
  model: [18, 3120, 0],
  line: [18, 1120, 0],
  tts: [16, 640, 2],
  play: [14, 2400, 0],
  motion: [22, 1200, 0],
  memx: [6, 5400, 0],
  hook: [31, 12, 0],
  sess: [9, 180, 0],
  appr: [5, 22000, 0],
};

const PROC = ['Companion', '后台服务', '角色'];
const t = (i: number) => at(14, 2) + i * MINUTE;
const cpuAt = (k: number, i: number) => +(k === 0 ? 3 + Math.sin(i / 3) * 0.8 + (i === 24 ? 3 : 0) : k === 1 ? 2 + (i % 9 === 4 ? 6 : 0) + Math.cos(i / 4) * 0.5 : 11 + Math.sin(i / 5) + (i >= 19 && i <= 21 ? 7 : 0)).toFixed(1);
const memAt = (k: number, i: number) => Math.round(k === 0 ? 176 + i * 0.2 : k === 1 ? 238 + (i > 20 ? 8 : 0) : 404 + Math.sin(i / 6) * 6 + i * 0.3);
const series = (f: (k: number, i: number) => number): LineSeries[] => PROC.map((id, k) => ({ id, label: id, pts: Array.from({ length: 31 }, (_, i) => [t(i), f(k, i)] as [number, number]) }));

export const DIAG_FULL: {
  hourly: Record<NodeId, NodeStat>;
  procHistory: { cpu: LineSeries[]; mem: LineSeries[] };
} = {
  hourly: Object.fromEntries(Object.entries(H).map(([k, [count, p50, fail]]) => [k, { count, p50, fail }])) as Record<NodeId, NodeStat>,
  procHistory: { cpu: series(cpuAt), mem: series(memAt) },
};
