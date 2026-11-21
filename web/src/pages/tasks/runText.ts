// Plain-text run output and the failure summary for the task detail, derived from step events and tool items.
import { formatClock, formatMs, type StepEvent, type ToolItem } from '../../domain';

const clock = (at: number) => formatClock(at, { seconds: true });

/** One line per step event and tool call, in time order: the 「运行输出」 behind the fold. */
export function runOutput(steps: readonly StepEvent[], tools: readonly ToolItem[]): string {
  const lines: Array<[number, string]> = [
    ...steps.map((s): [number, string] => [s.at, `${clock(s.at)}  第 ${s.generation} 次  ${s.phase}  ${s.name}`]),
    ...tools.map((t): [number, string] => [
      t.created_at,
      `${clock(t.created_at)}  工具  ${t.name}  ${t.status}${t.updated_at != null ? `  ${formatMs(t.updated_at - t.created_at)}` : ''}`,
    ]),
  ];
  return lines
    .sort((a, b) => a[0] - b[0])
    .map((l) => l[1])
    .join('\n');
}

/** Where and why it failed; names the run only when there was more than one (the meta line already has the times). */
export function failureSummary(reason: string, steps: readonly StepEvent[], stepName: string | null): string[] {
  const gen = steps.at(-1)?.generation ?? 1;
  const where = stepName ? `在「${stepName}」失败：${reason}` : `失败：${reason}`;
  return gen > 1 ? [where, `第 ${gen} 次运行`] : [where];
}
