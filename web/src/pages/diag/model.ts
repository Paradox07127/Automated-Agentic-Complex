// Diag view model: /trace/turns rows → the timeline, and the labels the panels share.
import type { Turn, TurnDot, WireTraceTurn } from '../../domain';
import { fromTraceTurn } from '../../domain/adapt';

/** `/trace/turns` limit cap (trace_store.py PAGE_MAX). */
export const TURN_LIMIT = 200;
const HOUR = 3_600_000;

export interface DiagTurns {
  start: number;
  end: number;
  dots: TurnDot[];
  /** One count per hour bin from `start`. */
  failures_per_hour: number[];
  /** The read hit the row limit, so older turns are missing. */
  truncated: boolean;
  /** Newest first, as agentd sends them. */
  turns: Turn[];
}

/** `/trace/turns` rows read since `start` at `end`; dots, hourly failures and truncation are derived here. */
export function turnsView(rows: readonly WireTraceTurn[], start: number, end: number, limit = TURN_LIMIT): DiagTurns {
  const turns = rows.map(fromTraceTurn);
  const dots = turns
    .map((t): TurnDot => ({ id: t.id, turn_id: t.turn_id, started_at: t.started_at, duration_ms: t.duration_ms, result: t.result, source: t.source }))
    .sort((a, b) => a.started_at - b.started_at);
  const bins = Array.from({ length: Math.max(1, Math.ceil((end - start) / HOUR)) }, () => 0);
  for (const d of dots) {
    if (d.result !== 'failed') continue;
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((d.started_at - start) / HOUR)));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  return { start, end, dots, failures_per_hour: bins, truncated: rows.length >= limit, turns };
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

/** Run states of /agent/runs and /memory/runs (runtime.py, memory_service.py). */
export const RUN_STATE: Readonly<Record<string, string>> = {
  running: '进行中',
  completed: '完成',
  succeeded: '完成',
  committed: '记忆已写入',
  no_new_knowledge: '无新增知识',
  rejected: '校验未通过',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被打断',
  waiting_user: '待处理',
};

export const SUM_KIND: Readonly<Record<string, string>> = {
  memory_extract: '记忆提炼',
  observation_interpret: '现场理解',
  observation_vision: '图片理解',
  user_vision: '图片理解（你发起）',
  proactive_decide: '主动决策',
  conversation: '角色主对话',
};
export const SUM_BACKEND: Readonly<Record<string, string>> = { claude_agent_sdk: 'Claude Agent SDK', codex: 'Codex', pi: 'Pi', acp: 'ACP', claude: 'Claude Code' };

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar day as `/summary/runs?date=` takes it. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

