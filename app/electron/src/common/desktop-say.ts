// `desktop.say`: 快速输入's send as agentd's
// `POST /say`. A refusal the role runtime causes is `kernel` with its fix; another refusal is `rejected` with what the bar
// shows; no answer is `agentd`.
import { BridgeFailure } from './bridge.ts';
import { markNow, type TurnMarks } from './turn-marks.ts';

export interface SayRequest {
  text: string; attachWindow: boolean; noMemory: boolean; scopeId?: string; surface?: string;
  quote?: { text: string; app: string | null }; replyTo?: { kind: string; id: string }; lookWindow?: { windowId: number; pid: number };
}

export type SayResult = { ok: true } | { ok: false; reason: 'agentd' | 'kernel' | 'rejected'; detail?: string };

const SURFACES = new Set(['quick_input', 'bubble_reply', 'thought_offer', 'chat']);
const ARGS = '{text, attachWindow, noMemory, scopeId?, surface?, quote?, replyTo?, lookWindow?}';

/** agentd's `/say` takes 1–2000 characters once its surrounding whitespace is off (`say_text`). */
const sayable = (t: unknown): t is string => typeof t === 'string' && t.trim() !== '' && [...t.trim()].length <= 2000;
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

export function parseSay(arg: unknown): SayRequest {
  const r = obj(arg);
  const bad = () => new BridgeFailure('invalid_args', ARGS);
  if (!r || !sayable(r.text) || typeof r.attachWindow !== 'boolean' || typeof r.noMemory !== 'boolean') throw bad();
  const out: SayRequest = { text: r.text, attachWindow: r.attachWindow, noMemory: r.noMemory };
  if (r.scopeId != null) {
    if (typeof r.scopeId !== 'string' || r.scopeId.length < 1 || r.scopeId.length > 128) throw bad();
    out.scopeId = r.scopeId;
  }
  if (r.surface != null) {
    if (typeof r.surface !== 'string' || !SURFACES.has(r.surface)) throw bad();
    out.surface = r.surface;
  }
  if (r.quote != null) {
    const q = obj(r.quote);
    if (!q || !sayable(q.text) || !(q.app == null || typeof q.app === 'string')) throw bad();
    out.quote = { text: q.text, app: typeof q.app === 'string' ? q.app : null };
  }
  if (r.replyTo != null) {
    const t = obj(r.replyTo);
    if (!t || (t.kind !== 'line' && t.kind !== 'thought') || typeof t.id !== 'string' || t.id === '') throw bad();
    out.replyTo = { kind: t.kind, id: t.id };
  }
  if (r.lookWindow != null) {
    const w = obj(r.lookWindow);
    if (!w || !whole(w.windowId, 0xffff_ffff) || !whole(w.pid, 0x7fff_ffff)) throw bad();
    out.lookWindow = { windowId: w.windowId, pid: w.pid };
  }
  return out;
}

/** ErrorText.recovery: the step that fixes a refusal the role runtime causes; null for the others. */
export function recovery(code: string, backend: string | null): string | null {
  if (code === 'native_login_required' && backend === 'codex') return '在终端运行 codex login，完成后到 设置 › 内核 点「重新检测」再发';
  if (code === 'native_login_required' && backend === 'claude') return '在终端运行 claude auth login，完成后到 设置 › 内核 点「重新检测」再发';
  if (code === 'local_runtime_missing' || code === 'bundled_runtime_missing') {
    return '没找到可用的 Codex CLI 或 ACP agent。安装并登录其中一个后到 设置 › 内核 点「重新检测」';
  }
  if (code === 'runtime_protocol_unavailable' || code === 'runtime_version_not_verified') {
    return '内核缺少需要的协议能力，请更新 CLI 后到 设置 › 内核 点「重新检测」';
  }
  return null;
}

const REJECTED: Record<string, string> = {
  no_cwd: '不知道该在哪个项目里派活',
  no_memory_dispatch: '这一轮不记时不能派活：内容会留在 Claude/Codex 的会话里',
  no_reminder_time: '没听出提醒的时间或内容',
  no_commitments: '提醒现在用不了',
  switching: '正在换角色，这条没收下',
  no_llm: '角色运行环境尚未准备好。',
  invalid_text: '这条太长了，最多 2000 个字',
  no_pending_approval: '现在没有等你批准的卡，没什么可拒绝的',
  ambiguous_approval: '有好几张审批卡在等，不知道要拒绝哪张',
  no_task: '现在没有在跑的任务，没什么可停的',
  ambiguous_task: '有好几个任务在跑，不知道要停哪个',
  shutting_down: 'agentd 正在退出，这条没收下',
  resetting: '正在删除所有本地数据，这条没收下',
};

/** AgentdClient.say's body. */
export function sayBody(r: SayRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { text: r.text, source: 'text' };
  if (r.noMemory) body.no_memory = true;
  if (r.lookWindow) body.look_window = { window_id: r.lookWindow.windowId, pid: r.lookWindow.pid };
  else if (r.attachWindow) body.look = true;
  if (r.scopeId !== undefined) body.scope_id = r.scopeId;
  if (r.surface !== undefined) body.surface = r.surface;
  if (r.quote) body.quote = { text: r.quote.text, app: r.quote.app };
  if (r.replyTo) body.reply_to = { kind: r.replyTo.kind, id: r.replyTo.id };
  return body;
}

/** agentd's API with request headers; `body` is the reply's text. Throws when agentd cannot be reached. */
export type HeaderRequest = (method: string, path: string, json: unknown, headers: Record<string, string>) =>
  Promise<{ status: number; body: string }>;

/** AgentdClient.say's send: one Idempotency-Key per say and one retry with it after a dropped connection, so agentd
 *  takes the line at most once. Status 0 when agentd could not be reached twice. */
export async function postSay(request: HeaderRequest, body: Record<string, unknown>):
  Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers = { 'Idempotency-Key': crypto.randomUUID() };
  let reply: { status: number; body: string };
  try {
    try {
      reply = await request('POST', '/say', body, headers);
    } catch {
      reply = await request('POST', '/say', body, headers);
    }
  } catch {
    return { status: 0, body: null };
  }
  try {
    return { status: reply.status, body: obj(JSON.parse(reply.body)) };
  } catch {
    return { status: reply.status, body: null };
  }
}

/** Sends `r`; `log` gets the `QUICKINPUT web say` line, `marks` the line agentd took. */
export async function say(r: SayRequest, request: HeaderRequest, log: (line: string) => void, marks?: TurnMarks): Promise<SayResult> {
  const submitted = markNow();
  const { status, body } = await postSay(request, sayBody(r));
  marks?.acceptedBody(status, body, submitted);
  log(`QUICKINPUT web say chars=${[...r.text].length} attach=${r.attachWindow} no_memory=${r.noMemory} status=${status}`);
  if (status === 0) return { ok: false, reason: 'agentd' };
  if ((status === 202 && typeof body?.line_id === 'string') || ((status === 200 || status === 202) && typeof body?.command === 'string')) {
    return { ok: true };
  }
  const error = typeof body?.error === 'string' ? body.error : '';
  const fix = recovery(error, typeof body?.runtime === 'string' ? body.runtime : null);
  if (fix !== null) return { ok: false, reason: 'kernel', detail: fix };
  return { ok: false, reason: 'rejected', detail: REJECTED[error] ?? `agentd 没收下这条（${status} ${error}）` };
}
