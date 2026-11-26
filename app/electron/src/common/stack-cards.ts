// The agentd rows behind the desktop stack's question, review, delivery, coding review and reminder cards, and those cards
// as web `StackCard`s, with the voice hint and drop cards.
import type { VoiceHint } from './push-to-talk.ts';

type Json = Record<string, unknown>;

export interface Interaction {
  request_id: string; run_id?: string | null; conversation_id?: string | null; kind: string; state: string; revision: number;
  generation?: number | null; created_at?: number | null;
  /** Epoch seconds; 0 means no deadline. */
  expires_at?: number | null;
  data?: {
    questions?: { id: string; question: string; options?: { label: string; description?: string | null }[] | null }[] | null;
    preview_text?: string | null; job_id?: string | null;
    /** agentd's own single-use approvals carry `source: 'agentd'` and the action in words as `title`. */
    preview?: { source?: string | null; title?: string | null } | null;
    /** The policy's verdict on an exact-call approval; absent on rows written before agentd sent it. */
    dangerous?: boolean | null; danger_rule?: string | null;
  } | null;
}

interface Artifact {
  artifact_id?: string | null; path?: string | null; absolute_path?: string | null; sha256?: string | null; version?: number | null;
  self_checked?: boolean | null;
}

export interface Delivery {
  delivery_id: string; delivery_version?: number | null; revision: number; generation: number; state: string;
  produced_at?: number | null; presented_at?: number | null; viewed_at?: number | null; decided_at?: number | null;
  summary?: string | null; title?: string | null; outcome?: string | null; run_id?: string | null; job_id?: string | null;
  verification_source?: string | null; canonical_task_id?: string | null; artifacts?: Artifact[] | null; redacted?: boolean | null;
}

/** One `/agent/tasks` row. */
export interface TaskRow {
  canonical_task_id: string; task_id?: string | null; job_id?: string | null; run_id?: string | null; title?: string | null;
  verification_source?: string | null; state: string; delivery?: Delivery | null; redacted?: boolean | null;
}

/** One `/tasks` ledger row (coding work). */
export interface CodingTask {
  task_id: string; target: string; title?: string | null; state: string; updated_at?: number | null;
  result?: { reason?: string | null; output_tail?: string | null; run_id?: string | null; artifacts?: Artifact[] | null } | null;
}

export interface Commitment { id: string; text: string; due_at?: number | null; state: string }

export type DropItem = { kind: 'file'; path: string } | { kind: 'url'; url: string } | { kind: 'text'; text: string };
/** A drop as its card holds it: each file with the handle the shell issued for it (DropHandover.dropped). */
export type HandedItem = Exclude<DropItem, { kind: 'file' }> | { kind: 'file'; path: string; handle: string };

export const ms = (seconds: number) => Math.round(seconds * 1000);
export const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agentd: 'Agentic Complex' };
const agentName = (key: string) => AGENT_NAMES[key] ?? key;
const verification = (value: string | null | undefined) => (value === 'automatic_checks' ? 'auto' : 'unverified');

export const questionsOf = (q: Interaction) => q.data?.questions ?? [];
export const isDecided = (d: Delivery) => d.state === 'accepted' || d.state === 'rejected';
export const isHidden = (row: TaskRow) => row.redacted === true || row.delivery?.redacted === true;
/** agentd takes a decision only on an undecided delivery of a task that needs review or passed its checks. */
export function isDecidable(row: TaskRow): boolean {
  if (isHidden(row) || !row.delivery || isDecided(row.delivery)) return false;
  return row.state === 'needs_review' || row.state === 'succeeded';
}

/** Each value escaped as a URL query keeps it, less `&`, `=`, `+` and `#`. */
export function mainRoute(path: string, items: [string, string][]): string {
  const query = items.map(([name, value]) => `${name}=${[...value].map((c) => (/[A-Za-z0-9!$'()*,\-./:;?@_~]/.test(c) ? c
    : encodeURIComponent(c))).join('')}`);
  return query.length === 0 ? path : `${path}?${query.join('&')}`;
}

export function questionCard(q: Interaction, now: number): Json {
  const questions = questionsOf(q).map((question) => ({ id: question.id, question: question.question,
    options: (question.options ?? []).map((o) => (o.description != null ? { label: o.label, description: o.description } : { label: o.label })) }));
  const job = q.data?.job_id ?? null;
  const expires = q.expires_at ?? 0;
  const approval = q.kind === 'approval';
  const own = q.data?.preview?.source === 'agentd' ? q.data.preview.title ?? null : null;
  const item: Json = {
    id: q.request_id, kind: 'question', task_id: job !== null ? `job:${job}` : null, title: own || (questionsOf(q)[0]?.question ?? ''),
    source: approval ? '角色 │ 请求批准' : '角色', since: ms(q.created_at ?? 0), resolved: q.state !== 'pending', revision: q.revision,
    interaction_kind: approval ? 'approval' : 'question', state: q.state, questions, run_id: q.run_id ?? '', job_id: job,
    generation: q.generation ?? 0, expires_at: expires === 0 ? null : ms(expires), conversation_id: q.conversation_id ?? null,
    options: (questionsOf(q)[0]?.options ?? []).map((o) => o.label), seconds_left: expires === 0 ? null : Math.max(0, expires - now / 1000),
  };
  if (q.data?.preview_text != null) item.preview_text = q.data.preview_text;
  if (approval) {
    item.dangerous = q.data?.dangerous ?? false;
    if (q.data?.danger_rule != null) item.danger_rule = q.data.danger_rule;
  }
  return { id: q.request_id, kind: 'question', item };
}

function artifactsJson(artifacts: Artifact[] | null | undefined): Json[] {
  return (artifacts ?? []).map((a) => {
    const path = a.path ?? '';
    return { artifact_id: a.artifact_id ?? '', name: path.split('/').filter((s) => s !== '').at(-1) ?? path, path,
      absolute_path: a.absolute_path ?? '', version: a.version ?? 1, sha256: a.sha256 ?? '', self_checked: a.self_checked ?? false };
  });
}

export function deliveryTitle(row: TaskRow, d: Delivery): string {
  return row.title ? row.title : d.title ?? '';
}

function deliveryJson(row: TaskRow, d: Delivery): Json {
  return {
    id: d.delivery_id, task_id: d.canonical_task_id ?? row.canonical_task_id, version: d.delivery_version ?? 1, revision: d.revision,
    generation: d.generation, run_id: d.run_id ?? row.run_id ?? '', job_id: d.job_id ?? row.job_id ?? null, title: deliveryTitle(row, d),
    summary: d.summary ?? '', outcome: d.outcome ?? '', redacted: d.redacted ?? false, state: d.state,
    verification_source: verification(d.verification_source ?? row.verification_source), produced_at: ms(d.produced_at ?? 0),
    presented_at: d.presented_at != null ? ms(d.presented_at) : null, viewed_at: d.viewed_at != null ? ms(d.viewed_at) : null,
    decided_at: d.decided_at != null ? ms(d.decided_at) : null, artifacts: artifactsJson(d.artifacts),
  };
}

export function reviewCard(row: TaskRow, d: Delivery): Json {
  const title = deliveryTitle(row, d), id = `r-${d.delivery_id}`;
  const item: Json = {
    id, kind: 'review', task_id: d.canonical_task_id ?? row.canonical_task_id, delivery_id: d.delivery_id,
    title: `${title} v${d.delivery_version ?? 1}`, source: `角色任务 │ ${title}`, since: ms(d.presented_at ?? d.produced_at ?? 0),
    revision: d.revision, generation: d.generation, verification_source: verification(d.verification_source ?? row.verification_source),
  };
  return { id, kind: 'review', source: 'delivery', item, delivery: deliveryJson(row, d), summary: d.summary ?? '', lifeS: 60, lifeTotalS: 60 };
}

export function deliveryCard(row: TaskRow, d: Delivery): Json {
  return { id: `d-${d.delivery_id}`, kind: 'delivery', delivery: deliveryJson(row, d), title: deliveryTitle(row, d), summary: d.summary ?? '',
    lifeS: 20, lifeTotalS: 20 };
}

/** ErrorText.text of the reasons a `/tasks` result carries (agentd sessions/tasks.py and own.py). */
const CODING_REASONS: Record<string, string> = {
  timeout: '请求超时，请重试。', restart: '后台服务已重启，任务已中断，可继续处理。', cancelled: '本轮已取消。',
  no_verify_cmd: '未配置校验命令，请人工复核结果。', not_started: '校验命令无法启动，请检查命令与工作目录。',
  invalid_verify_cmd: '校验命令未通过安全检查，请改用只读或安全命令。',
};
/** An unknown status. */
const UNKNOWN_REASON = '执行异常，请查看详情';

/** A coding task waiting for 验收: no delivery record, so the delivery fields are placeholders the page does not send back. */
export function codingCard(t: CodingTask): Json {
  const id = `c-${t.task_id}`, task = `task:${t.task_id}`, title = t.title ?? '', since = ms(t.updated_at ?? 0);
  const reason = t.result?.reason;
  const summary = reason != null ? CODING_REASONS[reason] ?? UNKNOWN_REASON : t.result?.output_tail ?? '';
  const item: Json = { id, kind: 'review', task_id: task, delivery_id: '', title, source: `${agentName(t.target)} │ ${title}`, since,
    revision: 0, generation: 0, verification_source: 'unverified' };
  const delivery: Json = {
    id: '', task_id: task, version: 1, revision: 0, generation: 0, run_id: t.result?.run_id ?? '', job_id: null, title, summary, outcome: '',
    redacted: false, state: 'produced', verification_source: 'unverified', produced_at: since, presented_at: null, viewed_at: null,
    decided_at: null, artifacts: artifactsJson(t.result?.artifacts),
  };
  return { id, kind: 'review', source: 'coding', item, delivery, summary, lifeS: 60, lifeTotalS: 60 };
}

export const VOICE_HINT_ID = 'voice-hint';

export function voiceCard(hint: VoiceHint): Json {
  const card: Json = { id: VOICE_HINT_ID, kind: 'notice', variant: 'voice' };
  if (hint.kind === 'listening') Object.assign(card, { phase: 'listening', title: '正在录音', text: hint.text, elapsed_s: Math.trunc(hint.elapsed) });
  else if (hint.kind === 'sent') Object.assign(card, { phase: 'sent', title: '已发送', text: hint.text });
  else if (hint.kind === 'discarded') Object.assign(card, { phase: 'discarded', title: '未发送', text: hint.reason });
  else if (hint.kind === 'downloading') Object.assign(card, { phase: 'downloading', title: '首次使用需下载语音识别模型', fraction: hint.fraction,
    received_mb: hint.receivedMB, total_mb: hint.totalMB });
  else Object.assign(card, { phase: 'mic_denied', title: '未授予麦克风权限', text: 'Agentic Complex 尚未获得麦克风权限，无法使用按住语音输入' });
  return card;
}

export function dropItems(items: HandedItem[]): Record<string, string>[] {
  return items.map((i): Record<string, string> => (i.kind === 'file' ? { kind: 'file', path: i.path, name: i.path.split(/[\\/]/).filter((s) => s !== '').at(-1) ?? i.path,
    handle: i.handle }
    : i.kind === 'url' ? { kind: 'url', url: i.url } : { kind: 'text', text: i.text }));
}
