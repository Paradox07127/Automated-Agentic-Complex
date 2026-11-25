// Run waterfall adapter: `/agent/tasks/{id}/steps` events plus tool items → Waterfall rows, ticks and marks.
import type { Delivery, StageStatus, StepEvent, StepPhase, ToolItem } from '../../domain';
import type { WaterfallProps, WaterfallRow } from '../../charts';

export const PHASE_LABEL: Record<StepPhase, string> = {
  prepare: '准备',
  execute: '执行',
  verify: '验证',
  awaiting: '待处理',
  suspended: '后台挂起',
  end: '结束',
};

/** One drawn segment, in time order across all generations. */
export interface RunSegment {
  row: string;
  index: number;
  generation: number;
  runId: string;
  phase: StepPhase;
  name: string;
  start: number;
  end: number;
  status: StageStatus;
}

export interface RunLanes {
  t0: number;
  t1: number;
  rows: WaterfallRow[];
  segments: RunSegment[];
  ticks: NonNullable<WaterfallProps['ticks']>;
  marks: NonNullable<WaterfallProps['marks']>;
  terminal: 'ok' | 'failed' | null;
  generations: Array<{ generation: number; runId: string; outcome: 'ok' | 'failed' | 'running' }>;
}

/** Tool family for tool distribution grouping and highlight: "Bash · git log" → "Bash". */
export const toolFamily = (name: string) => name.split(/ · /)[0] ?? name;

export function buildLanes(steps: readonly StepEvent[], tools: readonly ToolItem[], deliveries: readonly Delivery[], now: number): RunLanes | null {
  if (steps.length === 0) return null;
  const gens = [...new Set(steps.map((s) => s.generation))].sort((a, b) => a - b);
  const segments: RunSegment[] = [];
  const generations: RunLanes['generations'] = [];
  const windows: Array<{ row: string; start: number; end: number }> = [];
  for (const g of gens) {
    const evs = steps.filter((s) => s.generation === g).sort((a, b) => a.at - b.at);
    const endEv = evs.find((e) => e.phase === 'end');
    const outcome = endEv ? (endEv.status === 'failed' ? 'failed' : 'ok') : 'running';
    const row = `g${g}`;
    const body = evs.filter((e) => e.phase !== 'end');
    body.forEach((e, i) => {
      const next = body[i + 1]?.at ?? endEv?.at ?? now;
      const last = i === body.length - 1;
      const status: StageStatus = !last ? 'done' : outcome === 'running' ? 'current' : outcome === 'failed' ? 'failed' : 'done';
      segments.push({ row, index: i, generation: g, runId: e.run_id ?? '', phase: e.phase, name: e.name ?? e.summary ?? '', start: e.at, end: next, status });
    });
    generations.push({ generation: g, runId: evs[0]?.run_id ?? '', outcome });
    windows.push({ row, start: evs[0]?.at ?? now, end: endEv?.at ?? now });
  }
  const t0 = Math.min(...segments.map((s) => s.start));
  const t1 = Math.max(...segments.map((s) => s.end));
  const rows: WaterfallRow[] = gens.map((g, index) => ({
    id: `g${g}`,
    // Generation is an isolation token, not the task's display ordinal.
    label: `第 ${index + 1} 次`,
    terminal: outcomeTerminal(generations.find((x) => x.generation === g)?.outcome),
    stages: segments
      .filter((s) => s.generation === g)
      .map((s) => ({ name: `${PHASE_LABEL[s.phase]} │ ${s.name}`, start_ms: s.start - t0, duration_ms: s.end - s.start, status: s.status })),
  }));
  const ticks = tools.flatMap((it) => {
    const w = windows.find((x) => it.created_at >= x.start && it.created_at <= x.end) ?? windows.at(-1);
    if (!w) return [];
    return [{ row: w.row, atMs: it.created_at - t0, durationMs: (it.updated_at ?? now) - it.created_at, label: it.name }];
  });
  const marks: RunLanes['marks'] = [];
  for (const d of deliveries) {
    if (d.produced_at >= t0 && d.produced_at <= t1 && d.version > 1) marks.push({ atMs: d.produced_at - t0, label: `交付 v${d.version}` });
    if (d.state === 'rejected' && d.decided_at != null && d.decided_at >= t0 && d.decided_at <= t1) marks.push({ atMs: d.decided_at - t0, label: `v${d.version} 已驳回` });
  }
  const lastGen = generations.at(-1);
  const terminal = lastGen?.outcome === 'running' ? null : (lastGen?.outcome ?? null);
  return { t0, t1, rows, segments, ticks, marks, terminal, generations };
}

function outcomeTerminal(o: 'ok' | 'failed' | 'running' | undefined): 'ok' | 'failed' | null {
  return o === 'ok' || o === 'failed' ? o : null;
}

/** Segment that starts selected: the current one, else the last one. */
export function defaultSegment(segments: readonly RunSegment[]): number {
  const cur = segments.findIndex((s) => s.status === 'current');
  return cur >= 0 ? cur : segments.length - 1;
}

/** Tool calls that started inside a segment. */
export function toolsIn(seg: RunSegment, tools: readonly ToolItem[]): number {
  return tools.filter((t) => t.created_at >= seg.start && t.created_at < seg.end).length;
}
