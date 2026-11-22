// 经过: one turn's trace events and its run's tool items as steps, 收到 → 上下文 → 判断 → 想 (its tool calls and approvals
// under it) → 回复 → 语音 → 动作. Times are ms after the turn's start.
import { isoToMs, secToMs } from '../../domain';
import type { WireRunItem, WireTraceTurn } from '../../domain/wire';
import type { TiMem } from '../chat/turnTrace';
import { fmtMs } from '../chat/turnTrace';
import type { TextEvent } from './data';

export type StepSt = 'ok' | 'fail' | 'cut' | 'wait' | 'skip' | 'run';
export type StepIcon = 'in' | 'ctx' | 'judge' | 'kernel' | 'tool' | 'shield' | 'say' | 'voice' | 'motion';
/** A run of text: `d` dim, `m` code face, `b` bold. */
export type Part = { t: string; k?: 'd' | 'm' | 'b' };
export interface Raw {
  label: string;
  lines: string[];
  /** Open at once (an error's output). */
  open?: boolean;
}
export interface Step {
  id: string;
  icon: StepIcon;
  name: string;
  sub: boolean;
  t0: number;
  dur: number;
  st: StepSt;
  sum: Part[];
  kv: Array<[string, Part[]]>;
  mems?: Array<TiMem & { fresh?: boolean }>;
  judge?: Array<{ label: string; p: number; on: boolean }>;
  raw?: Raw;
  /** 首字, ms after the turn's start. */
  ttft?: number;
}

export interface Turn {
  steps: Step[];
  /** The turn's length on the time axis. */
  total: number;
  ttft: number | null;
  tokens: { in: number; out: number; cache: number | null } | null;
  cost: number | null;
  model: string | null;
  stop: string | null;
  /** turn.settled's error code, else the row's. */
  code: string | null;
  input: string | null;
  events: TextEvent[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const textOf = (e: TextEvent | undefined) => str(e?.text?.text);
const d = (t: string): Part => ({ t, k: 'd' });
const m = (t: string): Part => ({ t, k: 'm' });

const INPUT: Readonly<Record<string, string>> = { text: '文字', voice: '语音', desktop: '桌面输入', quick: '桌面输入', gift: '你递来的东西', proactive: '她自己起意',
  announce: '她自己起意', ritual: '她自己起意', tap: '你碰她', background: '后台任务' };
const JUDGE: Readonly<Record<string, string>> = { speak: '开口', wait: '等等', silent: '不说', want_comment: '想搭话', useful: '内容有用', need_image: '要截图', next_check: '下次再看' };
const TOOL: Readonly<Record<string, string>> = { exec_command: '跑命令', shell: '跑命令', bash: '跑命令', Bash: '跑命令', read_file: '读文件', Read: '读文件',
  list_dir: '列目录', write_file: '写文件', Write: '写文件', Edit: '改文件', apply_patch: '改文件', move_files: '移动文件', web_search: '搜网页', fetch: '读网页' };
const toolName = (t: string) => TOOL[t] ?? t;
const lines = (s: string) => s.replace(/\n$/, '').split('\n');

interface At {
  e: TextEvent;
  at: number;
}

function span(list: At[]): { t0: number; end: number } | null {
  if (list.length === 0) return null;
  const end = Math.max(...list.map((x) => x.at));
  const started = list.find((x) => /\.(started|requested|opened)$/.test(x.e.kind));
  const timed = list.find((x) => x.e.duration_ms != null);
  const t0 = started && started.at < end ? started.at : timed ? end - (timed.e.duration_ms ?? 0) : Math.min(...list.map((x) => x.at));
  return { t0: Math.max(0, Math.min(t0, end)), end };
}

/** Tool calls of the run ledger by name, oldest first, each with its result. */
function receipts(items: readonly WireRunItem[]) {
  const results = new Map(items.filter((i) => i.kind === 'tool_result' && i.parent_item_id).map((i) => [i.parent_item_id, i]));
  return items.filter((i) => i.kind === 'tool_call').map((call) => ({ call, result: results.get(call.item_id) }));
}

export interface TurnInput {
  row: WireTraceTurn;
  events: TextEvent[];
  skew?: Record<string, number>;
  items?: readonly WireRunItem[];
  mems?: TiMem[];
  learned?: TiMem[];
}

export function buildTurn({ row, events, skew = {}, items = [], mems = [], learned = [] }: TurnInput): Turn {
  const start = isoToMs(row.started_at);
  const evs: At[] = events.map((e) => ({ e, at: isoToMs(e.t_wall) - start + (skew[`${e.producer}/${e.producer_epoch}`] ?? 0) })).sort((a, b) => a.at - b.at);
  const of = (...kinds: string[]) => evs.filter((x) => kinds.some((k) => (k.endsWith('.') ? x.e.kind.startsWith(k) : x.e.kind === k)));
  const first = (kind: string) => evs.find((x) => x.e.kind === kind);
  const steps: Step[] = [];
  const open = row.result === 'open';

  const input = first('input.received');
  const inText = textOf(input?.e);
  const source = str(input?.e.attrs.source) ?? row.source;
  const len = num((input?.e.attrs.text as Record<string, unknown> | undefined)?.len) ?? row.len;
  steps.push({
    id: 'in', icon: 'in', name: '收到', sub: false, t0: 0, dur: 0, st: 'ok',
    sum: [{ t: INPUT[source] ?? source }, ...(len != null ? [d(` │ ${len} 字`)] : [])],
    kv: [],
    ...(inText ? { raw: { label: '收到的原文', lines: lines(inText) } } : {}),
  });

  const ctx = of('context.assembled', 'observation.');
  const ctxSpan = span(ctx);
  if (ctxSpan || mems.length > 0 || learned.length > 0) {
    const req = first('observation.requested');
    const seen = evs.findLast((x) => x.e.kind === 'observation.settled');
    const app = str(seen?.e.attrs.app);
    const title = str(seen?.e.attrs.title);
    const mode = str(req?.e.attrs.mode);
    const shot = seen?.e.attrs.shot === true || mode === 'image';
    const assembled = first('context.assembled');
    const ctxItems = Array.isArray(assembled?.e.attrs.items) ? (assembled.e.attrs.items as Array<Record<string, unknown>>) : [];
    const kinds = [...new Set(ctxItems.map((i) => str(i.type)).filter((t): t is string => t !== null))];
    const sum: Part[] = [];
    if (mems.length > 0) sum.push({ t: '引用记忆 ' }, { t: String(mems.length), k: 'b' }, { t: ' 条' });
    if (app) sum.push(...(sum.length ? [d(' │ ')] : []), { t: `看了 ${app}${title ? ` — ${title}` : ''}` }, d(shot ? ' │ 带截图' : ' │ 只读文字'));
    else if (sum.length === 0) sum.push(d(ctxItems.length ? `带进去 ${ctxItems.length} 项` : '没有观察'));
    else sum.push(d(' │ 没有观察'));
    const kv: Step['kv'] = [];
    if (seen) kv.push(['观察', [{ t: app ?? '—' }, ...(title ? [{ t: ` — ${title}` }] : []), d(` │ ${shot ? '文字 + 截图' : '只读文字'} │ ${str(seen.e.attrs.state) ?? ''}`)]]);
    if (ctxItems.length) kv.push(['带进去的', [{ t: `${ctxItems.length} 项` }, ...(kinds.length ? [d(` │ ${kinds.join('、')}`)] : [])]]);
    steps.push({
      id: 'ctx', icon: 'ctx', name: '上下文', sub: false, t0: ctxSpan?.t0 ?? 0, dur: ctxSpan ? ctxSpan.end - ctxSpan.t0 : 0, st: ctx.some((x) => x.e.status === 'failed') ? 'fail' : 'ok',
      sum, kv, mems: [...mems, ...learned.map((f) => ({ ...f, fresh: true }))],
    });
  }

  const judged = first('judge.decided');
  const gate = first('gate.decided');
  if (judged || gate) {
    const s = span(of('judge.decided', 'gate.decided'))!;
    const answers = Array.isArray(judged?.e.attrs.answers) ? (judged.e.attrs.answers as Array<Record<string, unknown>>) : [];
    const rows = answers.map((a) => ({ label: JUDGE[String(a.id)] ?? String(a.id), p: num(a.prob) ?? 0, on: a.value === true || a.value === 'yes' }));
    const pick = rows.find((r) => r.on);
    const sum: Part[] = pick ? [{ t: `${pick.label} ` }, { t: pick.p.toFixed(2), k: 'b' }, d(rows.filter((r) => r !== pick).map((r) => ` │ ${r.label} ${r.p.toFixed(2)}`).join(''))] : [];
    if (gate) sum.push(...(sum.length ? [d(' │ ')] : []), { t: gate.e.attrs.speak === false ? '门禁：不说' : '门禁：放行' }, ...(str(gate.e.attrs.reason) ? [d(` │ ${str(gate.e.attrs.reason)}`)] : []));
    steps.push({
      id: 'judge', icon: 'judge', name: '判断', sub: false, t0: s.t0, dur: s.end - s.t0, st: gate?.e.status === 'blocked' ? 'skip' : 'ok', sum,
      kv: [...(str(judged?.e.attrs.backend) ? [['判断用的', [{ t: String(judged!.e.attrs.backend) }]] as [string, Part[]]] : [])],
      ...(rows.length ? { judge: rows } : {}),
    });
  }

  // 想 and the tool calls and approvals in it.
  const fin = first('model.finished');
  const model = of('model.');
  const mSpan = span(model);
  const tools = of('tool.started', 'tool.settled');
  const asks = of('approval.opened', 'approval.decided', 'approval.retired');
  const ledger = receipts(items);
  const subs: Step[] = [];
  const calls = [...new Set(tools.map((x) => str(x.e.attrs.call_id) ?? ''))];
  // A call's ledger receipt: the n-th call of a tool takes that tool's n-th receipt.
  const seenTool = new Map<string, number>();
  calls.forEach((id, i) => {
    const mine = tools.filter((x) => (str(x.e.attrs.call_id) ?? '') === id);
    const s = span(mine)!;
    const settled = mine.find((x) => x.e.kind === 'tool.settled');
    const tool = str(mine[0]?.e.attrs.tool) ?? '工具';
    const outcome = str(settled?.e.attrs.outcome);
    const code = str(settled?.e.attrs.error_code);
    const nth = seenTool.get(tool) ?? 0;
    seenTool.set(tool, nth + 1);
    const rec = ledger.filter((r) => r.call.name === tool)[nth];
    const out = rec?.result?.text || rec?.result?.summary || '';
    const st: StepSt = outcome === 'failed' ? 'fail' : outcome === 'waiting_user' ? 'wait' : !settled ? (open ? 'run' : 'ok') : 'ok';
    subs.push({
      id: `tool-${id || i}`, icon: 'tool', name: toolName(tool), sub: true, t0: s.t0, dur: s.end - s.t0, st,
      sum: [m(tool), ...(rec?.call.summary ? [d(` │ ${rec.call.summary}`)] : []), ...(code ? [d(' │ '), m(code)] : !settled && open ? [d(' │ 还在跑')] : [])],
      kv: code ? [['错误', [m(code)]]] : [],
      ...(out ? { raw: { label: st === 'fail' ? '工具输出（出错）' : '工具输出', lines: lines(out), ...(st === 'fail' ? { open: true } : {}) } } : {}),
    });
  });
  if (tools.length === 0) {
    for (const { call, result } of ledger) {
      const t0 = secToMs(call.created_at) - start;
      const failed = /\bfailed\b/i.test(result?.summary ?? '') || result?.status === 'failed' || call.status === 'failed';
      const running = call.status === 'started' || call.status === 'in_progress';
      const out = result?.text || result?.summary || '';
      subs.push({
        id: `item-${call.item_id}`, icon: 'tool', name: toolName(call.name ?? '工具'), sub: true, t0: Math.max(0, t0), dur: running ? 0 : Math.max(0, secToMs(call.updated_at - call.created_at)),
        st: failed ? 'fail' : running ? 'run' : 'ok',
        sum: [m(call.name ?? '工具'), ...(call.summary ? [d(` │ ${call.summary}`)] : [])], kv: [],
        ...(out ? { raw: { label: '工具输出', lines: lines(out), ...(failed ? { open: true } : {}) } } : {}),
      });
    }
  }
  const asked = [...new Set(asks.map((x) => str(x.e.attrs.request_id) ?? ''))];
  for (const id of asked) {
    const mine = asks.filter((x) => (str(x.e.attrs.request_id) ?? '') === id);
    const opened = mine.find((x) => x.e.kind === 'approval.opened');
    const done = mine.find((x) => x.e.kind !== 'approval.opened');
    const t0 = opened?.at ?? done!.at;
    const wait = done ? done.at - t0 : open ? Math.max(0, row.duration_ms - t0) : 0;
    const tool = str(mine[0]?.e.attrs.tool);
    const decision = str(done?.e.attrs.decision) ?? str(done?.e.attrs.reason);
    const by = str(done?.e.attrs.by);
    subs.push({
      id: `ask-${id}`, icon: 'shield', name: '待批准', sub: true, t0, dur: wait, st: 'wait',
      sum: [...(tool ? [m(tool)] : [{ t: '一次操作' }]), d(done ? ` │ ${decision === 'allow' ? '你点了「允许」' : decision === 'deny' ? '你点了「拒绝」' : decision ?? '收回了'}` : ' │ 还没批')],
      kv: [['判定', [{ t: decision ?? '还没定' }]], ...(by ? [['谁批的', [{ t: by === 'card' ? '你，在桌面审批卡上' : '你，在系统弹窗上' }]] as [string, Part[]]] : []), ['等了', [{ t: fmtMs(wait) }]]],
    });
  }
  subs.sort((a, b) => a.t0 - b.t0);
  if (mSpan || subs.length) {
    const t0 = mSpan?.t0 ?? subs[0]!.t0;
    const end = Math.max(mSpan?.end ?? 0, ...subs.map((s) => s.t0 + s.dur), open && !fin ? row.duration_ms : 0);
    const firstTok = first('model.first_token');
    const failed = model.some((x) => x.e.status === 'failed');
    const stop = str(fin?.e.attrs.stop_reason);
    const name = str(fin?.e.attrs.model) ?? str(first('model.started')?.e.attrs.model);
    const toolN = subs.filter((s) => s.icon === 'tool').length;
    const askN = subs.filter((s) => s.icon === 'shield').length;
    const sum: Part[] = failed
      ? [{ t: '模型没给出回答' }, ...(stop ? [d(' │ '), m(stop)] : [])]
      : open && !fin
        ? [{ t: '还在想' }, ...(toolN ? [d(` │ 已调 ${toolN} 次工具`)] : [])]
        : [{ t: toolN ? `调了 ${toolN} 次工具` : '写了回复' }, ...(askN ? [d(` │ ${askN} 次要你批准`)] : toolN ? [] : [d(' │ 没调工具')]), ...(stop ? [d(' │ 停在 '), m(stop)] : [])];
    const tin = num(fin?.e.attrs.input_tokens), tout = num(fin?.e.attrs.output_tokens);
    const cache = num(fin?.e.attrs.cache_read_tokens) ?? num(fin?.e.attrs.cached_tokens);
    const cost = num(fin?.e.attrs.cost_usd);
    const kv: Step['kv'] = [];
    if (name) kv.push(['模型', [{ t: name }]]);
    if (tin != null) kv.push(['token', [{ t: `入 ${tin.toLocaleString('en-US')} │ 出 ${(tout ?? 0).toLocaleString('en-US')}` }, ...(cache != null ? [d(` │ 缓存 ${cache.toLocaleString('en-US')}`)] : [])]]);
    if (stop) kv.push(['停在', [m(stop)]]);
    if (firstTok) kv.push(['首字', [{ t: fmtMs(firstTok.at) }]]);
    kv.push(['花费', [{ t: cost == null ? '—' : `$${cost.toFixed(3)}` }]]);
    steps.push({
      id: 'model', icon: 'kernel', name: '想', sub: false, t0, dur: Math.max(0, end - t0), st: failed ? 'fail' : open && !fin ? 'run' : 'ok', sum, kv,
      ...(firstTok ? { ttft: firstTok.at } : {}),
    });
    steps.push(...subs);
  }

  const said = of('line.parsed', 'ui.first_text');
  if (said.length) {
    const s = span(said)!;
    const text = said.map((x) => textOf(x.e)).find((t) => t !== null) ?? null;
    steps.push({
      id: 'line', icon: 'say', name: '回复', sub: false, t0: s.t0, dur: s.end - s.t0, st: 'ok',
      sum: text ? [{ t: lines(text)[0] ?? '' }] : [d('她回了话（原文没有留下）')], kv: [],
      ...(text ? { raw: { label: '回复全文', lines: lines(text) } } : {}),
    });
  }

  const voice = of('speech.', 'playback.');
  if (voice.length) {
    const s = span(voice)!;
    const req = first('speech.requested');
    const audio = first('speech.first_audio');
    const cut = first('playback.interrupted');
    const degraded = first('playback.degraded');
    const ended = first('playback.ended');
    const failed = voice.some((x) => x.e.status === 'failed');
    steps.push({
      id: 'tts', icon: 'voice', name: '语音', sub: false, t0: s.t0, dur: s.end - s.t0, st: failed ? 'fail' : cut ? 'cut' : 'ok',
      sum: [
        ...(audio && req ? [{ t: '首段音频 ' }, { t: fmtMs(audio.at - req.at), k: 'b' as const }] : [{ t: '请求了语音' }]),
        d(cut ? ` │ 播到一半被打断：${str(cut.e.attrs.reason) ?? ''}` : ended ? ' │ 播完' : open ? ' │ 在播' : ' │ 没收到播完的回执'),
        ...(degraded ? [d(` │ ${str(degraded.e.attrs.reason) ?? '降级'}`)] : []),
      ],
      kv: [],
    });
  }

  const moved = of('motion.', 'behavior.');
  if (moved.length) {
    const s = span(moved)!;
    const clip = moved.map((x) => str(x.e.attrs.clip)).find((c) => c !== null) ?? null;
    const kind = moved.map((x) => str(x.e.attrs.behavior_type)).find((c) => c !== null) ?? null;
    const receipt = evs.findLast((x) => x.e.kind === 'behavior.receipt');
    const phase = str(receipt?.e.attrs.phase);
    const bad = phase === 'rejected' || phase === 'blocked' || moved.some((x) => x.e.status === 'failed');
    steps.push({
      id: 'motion', icon: 'motion', name: '动作', sub: false, t0: s.t0, dur: s.end - s.t0, st: bad ? 'fail' : phase === 'cancelled' || phase === 'interrupted' ? 'cut' : 'ok',
      sum: [...(clip ? [m(clip)] : kind ? [m(kind)] : [{ t: '动作' }]), ...(phase ? [d(` │ ${PHASE[phase] ?? phase}`)] : []), ...(str(receipt?.e.attrs.reason) ? [d(` │ ${str(receipt!.e.attrs.reason)}`)] : [])],
      kv: [],
    });
  }

  const settled = evs.findLast((x) => x.e.kind === 'turn.settled');
  const total = Math.max(row.duration_ms, ...steps.map((s) => s.t0 + s.dur), 1);
  return {
    steps,
    total,
    ttft: steps.find((s) => s.ttft != null)?.ttft ?? null,
    tokens: num(fin?.e.attrs.input_tokens) != null ? { in: num(fin!.e.attrs.input_tokens)!, out: num(fin!.e.attrs.output_tokens) ?? 0, cache: num(fin!.e.attrs.cache_read_tokens) ?? num(fin!.e.attrs.cached_tokens) } : null,
    cost: num(fin?.e.attrs.cost_usd),
    model: str(fin?.e.attrs.model) ?? row.model ?? null,
    stop: str(fin?.e.attrs.stop_reason),
    code: str(settled?.e.attrs.error_code) ?? row.error_code ?? null,
    input: inText,
    events,
  };
}

const PHASE: Readonly<Record<string, string>> = { accepted: '宿主已接受', running: '在做', completed: '宿主已完成', cancelled: '取消了', interrupted: '被打断', rejected: '宿主拒绝', blocked: '做不了' };

/** The longest top-level step that did not fail (not 收到): drawn in the accent colour. */
export const longestOf = (steps: readonly Step[]) => steps.filter((s) => !s.sub && s.st !== 'fail' && s.id !== 'in').reduce<Step | null>((a, s) => (!a || s.dur > a.dur ? s : a), null);
