// One turn as the inspector draws it (prototype `tiTrace` shape), built from `/trace/turns` and `/trace/turns/{id}`.
import { formatClock, formatMs, isoToMs } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';

/** `/trace/turns/{id}` event (trace_store.py `_emit`); only the fields the inspector reads. */
export interface TraceEvent {
  kind: string;
  status: string;
  t_wall: string;
  duration_ms?: number;
  attrs: Record<string, unknown>;
  producer?: string;
  producer_epoch?: number;
}

export type SpanId = 'input' | 'ctx' | 'mem' | 'obs' | 'judge' | 'model' | 'tool' | 'line' | 'tts' | 'play' | 'motion';

/** Chinese name and the event family of each span. */
export const TI_SPAN: Readonly<Record<SpanId, [string, string]>> = {
  input: ['输入', 'input'],
  ctx: ['上下文', 'context'],
  mem: ['召回记忆', 'memory'],
  obs: ['读取观察', 'observation'],
  judge: ['判断', 'judge'],
  model: ['模型', 'model'],
  tool: ['工具', 'tool'],
  line: ['台词', 'line'],
  tts: ['语音', 'speech'],
  play: ['播放', 'playback'],
  motion: ['动作', 'motion'],
};

const PARENT: Partial<Record<SpanId, SpanId>> = { mem: 'ctx', obs: 'ctx', tool: 'model', line: 'model', play: 'tts' };
const ORDER: SpanId[] = ['input', 'ctx', 'mem', 'obs', 'judge', 'model', 'tool', 'line', 'tts', 'play', 'motion'];
const FAMILY: Readonly<Record<string, SpanId>> = { gate: 'judge', cancel: 'play', behavior: 'motion' };

export interface TiSpan {
  id: SpanId;
  parent: SpanId | null;
  /** ms after the turn start. */
  t0: number;
  dur: number;
  st: 'ok' | 'fail' | 'cut';
}

export type TurnSource = 'user' | 'proactive' | 'desktop' | 'background';
export type TurnRes = '成功' | '失败' | '打断' | '跳过' | '进行中' | '待处理' | '仅生成文字' | '状态未知';
export interface TiMem {
  id: string;
  text: string;
}

export interface TurnTrace {
  /** Ordinal in its conversation. */
  no: number;
  /** trace_id. */
  id: string;
  turn_id: string;
  /** Start, HH:MM:SS. */
  t: string;
  src: TurnSource;
  res: TurnRes;
  turnState?: string;
  turnOutcome?: string;
  ms: number;
  ttft: number | null;
  spans: TiSpan[];
  /** Key of the chosen judge row; null without a judge or a choice. */
  pick: string | null;
  judge: Array<{ k: string; l: string; p: number }>;
  /** cache and cost are null until model.finished carries them. */
  model: { name: string; in: number; cache: number | null; out: number; cost: number | null } | null;
  mems: TiMem[];
  learned: TiMem[];
  obs: { app: string; title: string; at: string; shot: boolean } | null;
  motion: { name: string; ms: number | null } | null;
  behavior?: { name: string; phase: string | null; reason: string | null };
  events: Array<{ t: number; name: string; span: SpanId | 'turn'; d: string; status?: string; producer?: string }>;
}

export const TI_SRC: Readonly<Record<TurnSource, string>> = { user: '用户发起', proactive: '主动发起', desktop: '桌面输入', background: '后台任务' };
const RES: Readonly<Record<string, TurnRes>> = { ok: '成功', completed: '成功', failed: '失败', interrupted: '打断', skipped: '跳过', blocked: '跳过', open: '进行中', text_generated: '仅生成文字' };
export const TERMINAL_LABEL: Readonly<Record<string, string>> = { completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '被打断', waiting_user: '等待用户' };
export const OUTCOME_LABEL: Readonly<Record<string, string>> = { succeeded: '执行成功', failed: '执行失败', needs_review: '待复核' };
/** judge.decided answer ids (proactive.py, capture.py) and the prototype's three choices. */
const JUDGE_LABEL: Readonly<Record<string, string>> = { speak: '发言', wait: '等待', silent: '沉默', want_comment: '倾向发言', useful: '内容有用', need_image: '需要截图', next_check: '下次检查' };

export const resultOf = (r: string, turnState?: string | null): TurnRes => turnState === 'waiting_user' ? '待处理' : RES[r] ?? '状态未知';
export const sourceOf = (s: string): TurnSource => (s === 'background' ? 'background' : s === 'proactive' || s === 'announce' || s === 'ritual' || s === 'tap' ? 'proactive' : s === 'desktop' || s === 'quick' ? 'desktop' : 'user');

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function familyOf(kind: string): SpanId | null {
  const head = kind.split('.')[0] ?? '';
  const hit = ORDER.find((id) => TI_SPAN[id][1] === head);
  return hit ?? FAMILY[head] ?? null;
}

function detailOf(e: TraceEvent): string {
  const a = e.attrs;
  switch (e.kind) {
    case 'input.received':
      return TI_SRC[sourceOf(str(a.source) ?? '')];
    case 'model.finished':
      return `${str(a.model) ?? ''} │ 入 ${num(a.input_tokens) ?? 0} 出 ${num(a.output_tokens) ?? 0}${e.status === 'failed' ? ` │ ${str(a.stop_reason) ?? ''}` : ''}`;
    case 'motion.started':
    case 'motion.ended':
      return str(a.clip) ?? '';
    case 'judge.decided':
      return Array.isArray(a.answers) ? (a.answers as Array<Record<string, unknown>>).map((x) => `${JUDGE_LABEL[String(x.id)] ?? String(x.id)} ${(num(x.prob) ?? 0).toFixed(2)}`).join('，') : '';
    case 'playback.interrupted':
      return str(a.reason) ?? '';
    case 'gate.decided':
      return str(a.reason) ?? '';
    case 'tool.started':
    case 'tool.settled':
      return [str(a.tool), str(a.outcome), str(a.error_code)].filter(Boolean).join(' │ ');
    case 'turn.settled':
      return [TERMINAL_LABEL[str(a.state) ?? ''], str(a.outcome), str(a.error_code)].filter(Boolean).join(' │ ');
    case 'behavior.dispatched':
    case 'behavior.receipt':
      return [str(a.behavior_type), str(a.phase), str(a.reason)].filter(Boolean).join(' │ ');
    default:
      return e.status === 'failed' ? (str(a.error) ?? str(a.reason) ?? '') : '';
  }
}

/** Spans from the events: a family runs from its `.started` (or end minus `duration_ms`, or the previous span's end) to its last event. */
function spansOf(evs: Array<TraceEvent & { at: number }>): TiSpan[] {
  const out: TiSpan[] = [];
  let prev = 0;
  for (const id of ORDER) {
    const fam = evs.filter((e) => familyOf(e.kind) === id);
    if (fam.length === 0) continue;
    const end = Math.max(...fam.map((e) => e.at));
    const started = fam.find((e) => e.kind.endsWith('.started') || e.kind.endsWith('.requested'));
    const timed = fam.find((e) => e.duration_ms != null);
    const first = id === 'line' ? evs.find((e) => e.kind === 'model.first_token') : undefined;
    let t0 = id === 'input' ? 0 : first ? first.at : started && started.at < end ? started.at : timed ? end - (timed.duration_ms ?? 0) : PARENT[id] ? (out.find((s) => s.id === PARENT[id])?.t0 ?? prev) : prev;
    t0 = Math.max(0, Math.min(t0, end));
    const st = fam.some((e) => e.status === 'failed') ? 'fail' : fam.some((e) => e.kind.endsWith('.interrupted') || e.status === 'cancelled') ? 'cut' : 'ok';
    out.push({ id, parent: PARENT[id] ?? null, t0, dur: Math.max(0, end - t0), st });
    if (!PARENT[id]) prev = end;
  }
  return out;
}

export interface TraceInput {
  no: number;
  row: WireTraceTurn;
  events: TraceEvent[];
  skew?: Record<string, number>;
  mems?: TiMem[];
  learned?: TiMem[];
}

export function buildTurnTrace({ no, row, events, skew = {}, mems = [], learned = [] }: TraceInput): TurnTrace {
  const start = isoToMs(row.started_at);
  const evs = events.map((e) => ({ ...e, at: isoToMs(e.t_wall) - start + (skew[`${e.producer}/${e.producer_epoch}`] ?? 0) })).sort((a, b) => a.at - b.at);
  const spans = spansOf(evs);
  const first = evs.find((e) => e.kind === 'model.first_token');
  const fin = evs.find((e) => e.kind === 'model.finished');
  const judged = evs.find((e) => e.kind === 'judge.decided');
  const answers = Array.isArray(judged?.attrs.answers) ? (judged.attrs.answers as Array<Record<string, unknown>>) : [];
  const judge = answers.map((x) => ({ k: String(x.id), l: JUDGE_LABEL[String(x.id)] ?? String(x.id), p: num(x.prob) ?? 0 }));
  const chosen = answers.find((x) => x.value === true || x.value === 'yes');
  const settled = evs.find((e) => e.kind === 'observation.settled' && str(e.attrs.app) != null);
  const moved = evs.find((e) => e.kind === 'motion.started');
  const moveEnd = evs.find((e) => e.kind === 'motion.ended');
  const dispatched = evs.findLast((e) => e.kind === 'behavior.dispatched');
  const receipt = evs.findLast((e) => e.kind === 'behavior.receipt' && (!dispatched || e.attrs.behavior_id === dispatched.attrs.behavior_id));
  const behavior = str((dispatched ?? receipt)?.attrs.behavior_type);
  const input = evs.find((e) => e.kind === 'input.received');
  const terminal = evs.findLast((e) => e.kind === 'turn.settled')?.attrs;
  const turnState = row.turn_state ?? str(terminal?.state);
  const turnOutcome = row.turn_outcome ?? str(terminal?.outcome);
  const ms = evs.length > 0 ? Math.max(0, ...evs.map((e) => e.at)) : row.duration_ms;
  return {
    no,
    id: row.trace_id,
    turn_id: row.turn_id,
    t: formatClock(start, { seconds: true }),
    src: sourceOf(str(input?.attrs.source) ?? row.source),
    res: resultOf(row.result, turnState),
    ...(turnState ? { turnState } : {}),
    ...(turnOutcome ? { turnOutcome } : {}),
    ms,
    ttft: first ? first.at : null,
    spans,
    pick: chosen ? String(chosen.id) : null,
    judge,
    model: fin
      ? { name: str(fin.attrs.model) ?? '', in: num(fin.attrs.input_tokens) ?? 0, cache: num(fin.attrs.cache_read_tokens) ?? num(fin.attrs.cached_tokens), out: num(fin.attrs.output_tokens) ?? 0, cost: num(fin.attrs.cost_usd) }
      : null,
    mems,
    learned,
    obs: settled ? { app: str(settled.attrs.app) ?? '', title: str(settled.attrs.title) ?? '', at: formatClock(start + settled.at, { seconds: true }), shot: settled.attrs.shot === true } : null,
    motion: moved ? { name: str(moved.attrs.clip) ?? '', ms: num(moved.attrs.duration_ms) ?? (moveEnd ? moveEnd.at - moved.at : null) } : null,
    ...(behavior ? { behavior: { name: behavior, phase: str(receipt?.attrs.phase), reason: str(receipt?.attrs.reason) } } : {}),
    events: evs.map((e) => ({ t: Math.round(e.at), name: e.kind, span: familyOf(e.kind) ?? 'turn', d: detailOf(e), status: e.status, ...(e.producer ? { producer: e.producer } : {}) })),
  };
}

/** The longest top-level span that did not fail: the one the waterfall draws in the accent colour. */
export const critOf = (tr: TurnTrace): TiSpan | null => tr.spans.filter((s) => !s.parent && s.st !== 'fail').reduce<TiSpan | null>((a, s) => (!a || s.dur > a.dur ? s : a), null);

export const fmtMs = formatMs;
