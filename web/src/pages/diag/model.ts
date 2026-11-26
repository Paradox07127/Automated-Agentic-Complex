// Diag view model: /trace/turns rows → the timeline, and the labels the panels share.
import type { Turn, WireTraceTurn } from '../../domain';
import { fromTraceTurn } from '../../domain/adapt';

/** `/trace/turns` limit cap (trace_store.py PAGE_MAX). */
export const TURN_LIMIT = 200;
const HOUR = 3_600_000;

export interface DiagTurns {
  start: number;
  end: number;
  /** One count per hour bin from `start`. */
  failures_per_hour: number[];
  /** The read hit the row limit, so older turns are missing. */
  truncated: boolean;
  /** Newest first, as agentd sends them. */
  turns: Turn[];
}

/** `/trace/turns` rows read since `start` at `end`; hourly failures and truncation are derived here. */
export function turnsView(rows: readonly WireTraceTurn[], start: number, end: number, limit = TURN_LIMIT): DiagTurns {
  const turns = rows.map(fromTraceTurn);
  const bins = Array.from({ length: Math.max(1, Math.ceil((end - start) / HOUR)) }, () => 0);
  for (const d of turns) {
    if (d.result !== 'failed') continue;
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((d.started_at - start) / HOUR)));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  return { start, end, failures_per_hour: bins, truncated: rows.length >= limit, turns };
}

/** input.received sources (trace_format.py). */
const SOURCE_LABEL: Readonly<Record<string, string>> = { text: '对话', voice: '语音', proactive: '主动发言', announce: '播报', ritual: '仪式', gift: '礼物', background: '后台任务' };
export const sourceLabel = (source: string): string => SOURCE_LABEL[source] ?? source;

/** judge.decided `backend` (trace_format.py). */
export const JUDGE_BACKEND: Readonly<Record<string, string>> = {
  rules: '规则',
  haiku: 'Claude Haiku',
  'elephant-1': '决策服务',
  anthropic: 'Claude',
  chatgpt: 'ChatGPT',
  decision_router: '决策路由',
  character_agent: '角色内核',
};

/** behavior.ticked `chosen` and /diag/state body.activity (behavior.py ACTIVITIES). */
export const BEHAVIOR: Readonly<Record<string, string>> = {
  idle: '空闲',
  relax: '放松',
  fidget: '小动作',
  think: '思考',
  wait: '等待',
  react: '反应',
  yawn: '打哈欠',
  sleep: '睡觉',
  fly: '空中施术',
  guard: '戒备',
};
