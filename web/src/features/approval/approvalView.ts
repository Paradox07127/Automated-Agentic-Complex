// One view of a stack approval, whether the broker (`/approvals`) or a role exact-call approval (`/agent/interactions` kind approval) asked.
import { AGENT_NAME, type Approval, type ApprovalDispatch, type ApprovalOutcome, type Question, type StackCard } from '../../domain';
import { CANCEL_RECEIPT, type CardAction } from '../../surfaces/stack/actions';

export type ApprovalVerdict = 'allow' | 'allow_session' | 'deny' | 'cancel';

/** A broker approval card, or a question card whose interaction is a role approval. */
export type ApprovalStackItem = Extract<StackCard, { kind: 'approval' }> | (Extract<StackCard, { kind: 'question' }> & { item: Question & { interaction_kind: 'approval' } });

export interface ApprovalView {
  id: string;
  source: 'broker' | 'exact_call';
  /** Empty for a role approval: its Tool line is hidden. */
  tool: string;
  /** "Codex · 修 HostLink 断线重连" style origin line. */
  origin: string;
  title: string;
  cmd: string | null;
  truncated: boolean;
  origLen: number | null;
  diff: string | null;
  cwd: string | null;
  /** Role approval's call preview, shown monospace. */
  previewText: string | null;
  dangerous: boolean;
  dangerRule: string | null;
  allowSession: boolean;
  sessionScope: { kind: string; detail: string } | null;
  dispatch: ApprovalDispatch | null;
  /** Null: no deadline. */
  windowS: number | null;
  /** Null: no countdown. */
  secondsLeft: number | null;
  since: number;
  outcome: ApprovalOutcome | null;
  /** What timing out means, after 「后果：」. */
  expiredNote: string;
  /** 会话 ↗ / 时间线 ↗ / 去终端. */
  links: boolean;
  /** Items of the ⋯ menu. */
  extra: Array<{ label: string; action: CardAction }>;
  /** Broker generation or interaction revision, whichever the decision must echo. */
  token: number;
  /** Null for a verdict this source does not offer. */
  action: (verdict: ApprovalVerdict, mode?: string) => CardAction | null;
}

export function isApprovalCard(card: StackCard): card is ApprovalStackItem {
  return card.kind === 'approval' || (card.kind === 'question' && card.item.interaction_kind === 'approval');
}

/** Receipts native and the stack write after a role approval; anything else is not an approval outcome. */
const RECEIPT_OUTCOME: Record<string, ApprovalOutcome['kind']> = {
  已允许: 'approved',
  已批准: 'approved',
  '已回答：允许': 'approved',
  '已回答：本对话都允许': 'approved',
  已拒绝: 'denied',
  '已回答：拒绝': 'denied',
  已取消这个请求: 'denied',
  [CANCEL_RECEIPT]: 'denied',
  已过期: 'expired',
  已在别处处理: 'elsewhere',
};

export function outcomeOfReceipt(receipt: string | undefined, at: number): ApprovalOutcome | null {
  const kind = receipt == null ? undefined : RECEIPT_OUTCOME[receipt];
  if (kind == null) return null;
  return kind === 'denied' || kind === 'elsewhere' ? { kind, at, text: receipt } : { kind, at };
}

/** Who a broker card's call came back to: a coding tool's own hook, a session agentd runs, or a dispatch agentd has not started. */
export type ApprovalOrigin = 'hook' | 'own' | 'dispatch';

export const approvalOrigin = (a: Pick<Approval, 'dispatch' | 'display_session'>): ApprovalOrigin =>
  a.dispatch ? 'dispatch' : a.display_session?.startsWith('own:') ? 'own' : 'hook';

/** What a broker card timing out means, after 「后果：」. */
export function expiredNote(origin: ApprovalOrigin, agent: string): string {
  if (origin === 'dispatch') return '任务没有派出，什么都没有开始';
  if (origin === 'own') return '这次调用没有执行，会话按「拒绝」继续';
  return `这次工具调用按「未批准」处理，${agent} 会停在这一步，待用户在终端处理`;
}

/** What 本对话都允许 lets through without asking again (approvals.py session_scope); null when agentd did not say. */
export function scopeLine(scope: { kind: string; detail: string | null } | null): string | null {
  if (!scope) return null;
  if (scope.kind === 'all_edits') return `之后不再问：本会话在工作区里的所有编辑和 mkdir/touch/rm/rmdir/mv/cp/sed${scope.detail ? `；另含 ${scope.detail}` : ''}`;
  if (!scope.detail) return null;
  if (scope.kind === 'same_files') return `之后不再问：对 ${scope.detail.split('\n').filter(Boolean).join('、')} 的改动`;
  return `之后不再问：${scope.detail}`;
}

/** ACP ToolKind, as the preview names the call. */
const CALL_KIND: Readonly<Record<string, string>> = { read: '读取', edit: '编辑', delete: '删除', move: '移动', search: '搜索', execute: '执行', think: '思考', fetch: '访问', switch_mode: '切换模式', other: '其他' };

/** A harness call's arguments: its command when it is one, else every argument it passes. */
function callArguments(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return String(raw);
  const command = (raw as { command?: unknown }).command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((c) => typeof c === 'string')) return command.join(' ');
  return Object.keys(raw).length > 0 ? JSON.stringify(raw, null, 2) : null;
}

/** integration.py _harness_permission preview: Claude Code, Codex, Pi or an ACP agent asking to run a tool; null for any other preview. */
function harnessPreview(text: string | undefined): { agent: string; title: string | null; call: string | null } | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as { source?: unknown; agent?: unknown; title?: unknown; kind?: unknown; locations?: unknown; raw_input?: unknown };
    if (!(p.source === 'claude' || p.source === 'codex' || p.source === 'pi' || p.source === 'acp_agent') || typeof p.agent !== 'string') return null;
    const locations = Array.isArray(p.locations) ? p.locations.filter((l): l is string => typeof l === 'string') : [];
    const kind = typeof p.kind === 'string' && p.kind ? `类型：${CALL_KIND[p.kind] ?? p.kind}` : null;
    const lines = [kind, callArguments(p.raw_input), ...locations].filter((l): l is string => !!l);
    return { agent: p.agent, title: typeof p.title === 'string' && p.title ? p.title : null, call: lines.join('\n') || null };
  } catch {
    return null;
  }
}

export function approvalView(card: ApprovalStackItem): ApprovalView {
  if (card.kind === 'approval') {
    const { item } = card;
    const agent = AGENT_NAME[item.agent] ?? (item.agent || '会话');
    return {
      id: item.id,
      source: 'broker',
      tool: item.tool,
      origin: item.source,
      title: item.title,
      cmd: item.cmd ?? null,
      truncated: item.summary_truncated === true,
      origLen: item.orig_len ?? null,
      diff: item.content_preview ?? null,
      cwd: item.cwd,
      previewText: null,
      dangerous: item.dangerous,
      dangerRule: item.danger_rule ?? null,
      allowSession: item.scope_ok === true && !item.dangerous,
      sessionScope: item.session_scope,
      dispatch: item.dispatch,
      windowS: item.window_s,
      secondsLeft: item.seconds_left,
      since: item.since,
      outcome: card.outcome ?? null,
      expiredNote: expiredNote(approvalOrigin(item), agent),
      links: true,
      extra: [],
      token: item.generation,
      action: (verdict, mode) =>
        verdict === 'cancel' ? null : { type: 'decide', id: card.id, decision: verdict, generation: item.generation, ...(mode ? { mode } : {}) },
    };
  }
  const { item } = card;
  // The current native stack projection preserves option labels but drops new data fields.
  const offered = item.approval_answers?.includes('allow_session') ?? item.questions.some((q) => q.options.some((o) => o.label === '本对话都允许'));
  const allowSession = offered && !item.dangerous && !item.danger_rule;
  const answer = (label: '允许' | '拒绝' | '本对话都允许'): CardAction => ({
    type: 'answer',
    id: card.id,
    expected_version: item.revision,
    answers: Object.fromEntries(item.questions.map((q) => [q.id, [label]])),
    text: label,
  });
  const cancel: CardAction = { type: 'cancel-question', id: card.id, expected_version: item.revision };
  const harness = harnessPreview(item.preview_text);
  return {
    id: item.id,
    source: 'exact_call',
    tool: '',
    origin: harness ? `${harness.agent} │ 请求批准` : item.source,
    // The first question, as native and fromInteraction set it.
    title: harness?.title || item.title || '这一次操作需要审批',
    cmd: null,
    truncated: false,
    origLen: null,
    diff: null,
    cwd: null,
    previewText: harness ? harness.call : (item.preview_text ?? null),
    // No verdict: not dangerous.
    dangerous: item.dangerous ?? false,
    dangerRule: item.danger_rule ?? null,
    allowSession,
    sessionScope: null,
    dispatch: null,
    windowS: item.expires_at == null ? null : (item.expires_at - item.since) / 1000,
    secondsLeft: item.seconds_left,
    since: item.since,
    // A receipt carries no decision time; the card's arrival stands in.
    outcome: card.outcome ?? outcomeOfReceipt(card.receipt, card.at),
    expiredNote: '这次调用没有执行',
    links: false,
    extra: [
      { label: '稍后', action: { type: 'collapse', id: card.id } },
      { label: '取消这个请求', action: cancel },
    ],
    token: item.revision,
    action: (verdict) => (verdict === 'allow' ? answer('允许') : verdict === 'deny' ? answer('拒绝') : verdict === 'cancel' ? cancel : verdict === 'allow_session' && allowSession ? answer('本对话都允许') : null),
  };
}

/** The Approval fields the card reads; windows may be null for a role approval. */
export type Fields = Pick<Approval, 'id' | 'title' | 'tool' | 'source' | 'cmd' | 'content_preview' | 'summary_truncated' | 'orig_len' | 'cwd' | 'dangerous' | 'danger_rule' | 'dispatch' | 'scope_ok' | 'session_scope' | 'since' | 'agent' | 'display_session'> & {
  window_s: number | null;
  seconds_left: number | null;
};

export const fieldsOf = (v: ApprovalView): Fields => ({
  id: v.id,
  title: v.title,
  tool: v.tool,
  source: v.origin,
  cmd: v.cmd ?? undefined,
  content_preview: v.diff ?? undefined,
  summary_truncated: v.truncated,
  orig_len: v.origLen ?? undefined,
  cwd: v.cwd,
  dangerous: v.dangerous,
  danger_rule: v.dangerRule ?? undefined,
  dispatch: v.dispatch,
  scope_ok: v.allowSession,
  session_scope: v.sessionScope,
  since: v.since,
  agent: '',
  display_session: null,
  window_s: v.windowS,
  seconds_left: v.secondsLeft,
});

/** Where a dispatch's directory came from (cwd_from), as the card states it. */
export function cwdFrom(d: ApprovalDispatch): string | null {
  const f = d.cwd_from;
  if (!f) return null;
  if (f.source === 'explicit') return '指定的目录';
  if (f.source === 'focus') return `取自焦点会话 ${f.display_session}（${f.state}）`;
  return f.matched === 'project' ? `按项目 ${f.project} 找到` : AGENT_CWD[f.matched];
}

/** dispatch_tool.py _resolve_cwd: the directory the character gave, the focused session's, or the workspace. */
const AGENT_CWD = { cwd: '角色给的目录', focus: '取自焦点会话', workspace: '默认工作区' } as const;
