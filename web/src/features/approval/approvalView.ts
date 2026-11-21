// One view of a stack approval, whether the broker (`/approvals`) or a role exact-call approval (`/agent/interactions` kind approval) asked.
import { AGENT_NAME, type ApprovalDispatch, type ApprovalOutcome, type Question, type StackCard } from '../../domain';
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

/** integration.py _harness_permission preview: Claude Code, Codex, Pi or an ACP agent asking to run a tool; null for any other preview. */
function harnessPreview(text: string | undefined): { agent: string; title: string | null; locations: string[] } | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as { source?: unknown; agent?: unknown; title?: unknown; locations?: unknown };
    if (!(p.source === 'claude' || p.source === 'codex' || p.source === 'pi' || p.source === 'acp_agent') || typeof p.agent !== 'string') return null;
    const locations = Array.isArray(p.locations) ? p.locations.filter((l): l is string => typeof l === 'string') : [];
    return { agent: p.agent, title: typeof p.title === 'string' && p.title ? p.title : null, locations };
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
      expiredNote: `这次工具调用按「未批准」处理，${agent} 会停在这一步，待用户在终端处理`,
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
  const answer = (label: '允许' | '拒绝' | 'allow_session'): CardAction => ({
    type: 'answer',
    id: card.id,
    expected_version: item.revision,
    answers: Object.fromEntries(item.questions.map((q) => [q.id, [label]])),
    text: label === 'allow_session' ? '本对话都允许' : label,
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
    previewText: harness ? harness.locations.join('\n') || null : (item.preview_text ?? null),
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
    action: (verdict) => (verdict === 'allow' ? answer('允许') : verdict === 'deny' ? answer('拒绝') : verdict === 'cancel' ? cancel : verdict === 'allow_session' && allowSession ? answer('allow_session') : null),
  };
}
