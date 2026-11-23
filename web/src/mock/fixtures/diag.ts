import type {
  Budget,
  Cooldown,
  Health,
  Pipeline,
  ProcessRow,
  RenderSample,
  StageStatus,
  Turn,
  TurnDot,
  TurnNow,
  TurnResult,
} from '../../domain';
import { fromCooldowns, fromDiagBudget, fromTurnNow } from '../../domain/adapt';
import { isoToMsOrNull } from '../../domain/units';
import { at, DAY, NOW, seeded, SECOND } from './clock';
import { WIRE_DIAG_BUDGET, WIRE_DIAG_GATE, WIRE_DIAG_HOOKS, WIRE_DIAG_TURN } from './wire/system';

/** Link health; options switch the three branches for demos. Defaults match PROCESSES uptime. */
export function healthOf(opts: { agentdDown?: boolean; kernelBad?: boolean; backoff?: number } = {}): Health {
  return {
    agentd: { up: !opts.agentdDown, started_at: at(13, 20) },
    runtime: { ready: !opts.kernelBad, name: 'Codex', error: opts.kernelBad ? 'not_authenticated' : null },
    avatar: { child: opts.backoff ? { backoff: opts.backoff } : 'running', fps: opts.backoff ? null : 60 },
    voice: { state: 'unreachable', retryAfterS: null },
  };
}

export const HEALTH: Health = healthOf();

/** 60 one-second samples ending 14:31:59; gpu is ms. A stall at 22–23 s, suspended 46–50 s. */
export const RENDER_STATS: RenderSample[] = Array.from({ length: 60 }, (_, i) => {
  const t = at(14, 31) + i * SECOND;
  const spike = i === 22 ? 1 : i === 23 ? 0.5 : 0;
  if (i >= 46 && i <= 50) return { at: t, fps: null, p95_ms: null, gpu_ms: null, suspended: true };
  if (i === 59) return { at: t, fps: 59, p95_ms: 15.6, gpu_ms: 6.1 };
  return {
    at: t,
    fps: Math.round(59 + Math.sin(i / 3) - 15 * spike),
    p95_ms: Math.round((15.4 + 0.4 * Math.sin(i / 4) + 9.2 * spike) * 10) / 10,
    gpu_ms: Math.round((6.1 + 0.3 * Math.cos(i / 5) + 5.7 * spike) * 10) / 10,
  };
});

export const PIPELINE: Pipeline = { fps_target: 60, suspended: false, gpu_allocated_mb: 412 };

/** Current turn (`/diag/state` turn block). */
export const TURN_NOW: TurnNow = (() => {
  const t = fromTurnNow(WIRE_DIAG_TURN);
  if (!t) throw new Error('WIRE_DIAG_TURN has no turn');
  return t;
})();

type StageRow = [string, number, number, StageStatus?];
const turn = (
  id: string,
  t: [number, number, number],
  source: string,
  result: TurnResult,
  duration_ms: number,
  stages: StageRow[],
  marks: Turn['marks'] = [],
): Turn => ({
  id,
  turn_id: `turn-${id}`,
  started_at: at(...t),
  source,
  result,
  duration_ms,
  stages: stages.map(([name, start_ms, d, status]) => ({ name, start_ms, duration_ms: d, status: status ?? 'done' })),
  marks,
});

/** Trace turns. tr6 was cut by push-to-talk: its last stage is interrupted, not failed; marks name their reference. */
export const TURNS: Turn[] = [
  turn('tr0', [14, 32, 4], '对话', 'running', 2600, [['接收输入', 0, 40], ['读取上下文', 40, 260], ['模型调用', 300, 2300, 'current']]),
  turn(
    'tr1',
    [14, 31, 58],
    '对话 · 旁路',
    'ok',
    1800,
    [['接收输入', 0, 40], ['读取上下文', 40, 220], ['动作决策', 260, 180], ['模型调用', 440, 1120], ['工具：git log', 1560, 140], ['写回记忆', 1700, 60], ['播报', 1760, 40]],
    [{ at_ms: 1020, label: '首字 1.02 s（模型后 0.58 s）' }],
  ),
  turn('tr2', [14, 31, 2], '主动发言 · 久坐', 'skipped', 400, [['接收观察', 0, 30], ['动作决策', 30, 340], ['门控：免打扰外但刚说过话', 370, 30]]),
  turn(
    'tr3',
    [14, 29, 40],
    '对话',
    'ok',
    6200,
    [['接收输入', 0, 50], ['读取上下文', 50, 400], ['模型调用', 450, 5300], ['写回记忆', 5750, 450]],
    [{ at_ms: 1570, label: '首字 1.57 s（模型后 1.12 s）' }],
  ),
  turn(
    'tr6',
    [14, 28, 15],
    '语音 · 按住说话',
    'interrupted',
    3100,
    [['接收输入', 0, 80], ['读取上下文', 80, 300], ['模型调用', 380, 2400], ['播报', 2780, 320, 'interrupted']],
    [
      { at_ms: 1240, label: '首字 1.24 s（模型后 0.86 s）' },
      { at_ms: 3100, label: '打断 · ptt' },
    ],
  ),
  turn('tr4', [14, 26, 11], '角色运行 · 周报 v2', 'ok', 42_000, [['计划', 0, 3000], ['工具：读文件', 3000, 6000], ['模型调用', 9000, 28_000], ['写入产物', 37_000, 5000]]),
  turn(
    'tr7',
    [14, 25, 51],
    '对话',
    'ok',
    9000,
    [['接收输入', 0, 40], ['读取上下文', 40, 300], ['模型调用', 340, 8200], ['写回记忆', 8540, 460]],
    [{ at_ms: 1100, label: '首字 1.10 s（模型后 0.76 s）' }],
  ),
  turn('tr5', [14, 24, 3], '观察摘要', 'failed', 900, [['读取窗口文字', 0, 300], ['模型调用', 300, 600, 'failed']]),
  turn(
    'tr8',
    [14, 14, 0],
    '对话',
    'ok',
    12_000,
    [['接收输入', 0, 40], ['读取上下文', 40, 360], ['模型调用', 400, 11_200], ['写回记忆', 11_600, 400]],
    [{ at_ms: 1800, label: '首字 1.80 s（模型后 1.40 s）' }],
  ),
];

const DOT_SOURCES = ['对话', '主动发言', '观察摘要', '角色运行', '语音'];

/** Turns of the last 24 h (`/trace/turns?since`). Today's only failure is tr5; earlier failures fall before midnight. */
export const TURN_DOTS: TurnDot[] = (() => {
  const rnd = seeded(11);
  const out: TurnDot[] = TURNS.map((x) => ({ id: x.id, turn_id: x.turn_id, started_at: x.started_at, duration_ms: x.duration_ms, result: x.result, source: x.source }));
  for (let i = 0; i < 150; i++) {
    const t = NOW - DAY + Math.round(rnd() * DAY);
    const h = new Date(t).getHours();
    const r = rnd();
    const fast = rnd();
    if ((h < 8 && rnd() < 0.85) || t > at(14, 23)) continue;
    let result: TurnResult = r < 0.05 ? 'failed' : r < 0.08 ? 'interrupted' : r < 0.2 ? 'skipped' : 'ok';
    if (result === 'failed' && t >= at(0, 0)) result = 'ok';
    const duration_ms = Math.round(10 ** (2.3 + fast * 2.2 - (result === 'skipped' ? 0.6 : 0)));
    out.push({ id: `x${i}`, started_at: t, duration_ms, result, source: DOT_SOURCES[Math.floor(rnd() * 5)] ?? '对话' });
  }
  return out.sort((a, b) => a.started_at - b.started_at);
})();

/** Process table (CPU, uptime). Totals: 840 MB, CPU 16 % on the last sample. */
export const PROCESSES: ProcessRow[] = [
  { name: 'Companion', cpu: [3, 3, 4, 2, 3, 5, 3, 3, 2, 3, 4, 3, 3, 6, 4, 3, 3, 2, 3, 3], memory_mb: 210, uptime: [{ start: at(13, 20), end: null }] },
  {
    name: '后台服务',
    cpu: [2, 2, 3, 2, 2, 8, 4, 2, 2, 2, 3, 2, 2, 2, 5, 2, 2, 2, 3, 2],
    memory_mb: 180,
    uptime: [
      { start: NOW - DAY, end: at(13, 19) },
      { start: at(13, 20), end: null },
    ],
  },
  {
    name: '角色',
    cpu: [11, 12, 11, 10, 11, 18, 14, 11, 11, 12, 11, 10, 11, 11, 13, 11, 12, 11, 11, 11],
    memory_mb: 450,
    uptime: [
      { start: NOW - DAY, end: at(13, 33) },
      { start: at(13, 34), end: null },
    ],
  },
  { name: '语音', cpu: [], memory_mb: 0, uptime: [] },
];

/** Diag budget (`/diag/state` budget + gate blocks). by_call tokens sum to 1.24 M; character runs are unpriced. */
export const BUDGET: Budget = fromDiagBudget(WIRE_DIAG_BUDGET, WIRE_DIAG_GATE);

const MODEL = BUDGET.model ?? { by_call: {}, cost_usd: 0, unpriced: 0 };
const SHOTS_USED = BUDGET.screenshots?.used ?? 0;

/** Today's total tokens in millions, from by_call. */
export const TOKENS_TODAY_M =
  Object.values(MODEL.by_call).reduce((n, c) => n + c.input_tokens + c.cache_tokens + c.output_tokens, 0) / 1e6;

/** Screenshots per hour today; sums to BUDGET.screenshots.used. */
export const SHOTS_BY_HOUR: number[] = Array.from({ length: 24 }, (_, h) => ({ 9: 4, 10: 6, 11: 5, 12: 3, 13: 2, 14: 17 })[h] ?? 0);

/** Screenshots per day, last point is today. */
export const SHOTS_7D: number[] = [41, 28, 52, 33, 47, 12, SHOTS_USED];

/** Background semantic calls. */
export const BG_CALLS = { hour: 5, hour_limit: 12, day: 31, day_limit: 48 };

/** Gate cooldowns and 7-day trend; the last day is today's count. */
export const GATE: { cooldowns: Cooldown[]; d7: number[] } = {
  cooldowns: fromCooldowns(WIRE_DIAG_GATE),
  d7: [9, 12, 7, 11, 12, 4, BUDGET.gate.today],
};

/** Observation requests. */
export const OBSERVATION = {
  pending: { kind: 'window_text', since: at(14, 31, 58) },
  recent: ['ok', 'ok', 'fail', 'ok', 'skip'] as Array<'ok' | 'fail' | 'skip'>,
};

/** Coding-tool hooks (`/diag/state hooks.*`), last_at in ms. */
export const HOOKS = {
  claude: { installed: WIRE_DIAG_HOOKS.claude.installed === true, last_at: isoToMsOrNull(WIRE_DIAG_HOOKS.claude.last_at) },
  codex: { installed: WIRE_DIAG_HOOKS.codex.installed === true, last_at: isoToMsOrNull(WIRE_DIAG_HOOKS.codex.last_at) },
};
