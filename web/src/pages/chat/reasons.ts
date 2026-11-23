import { AgentdCallError, CONFLICT_CODES } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';

/** Short reasons for agentd's codes on this page; anything else says the request was refused. */
const REASONS: Record<string, string> = {
  busy: '角色正在执行，结束后再试',
  no_llm: '还没有可用的模型',
  no_history: '对话记录没有开启',
  archived: '对话已归档',
  conversation_not_active: '这不是当前对话',
  unknown_conversation: '对话已不存在',
  invalid_text: '内容为空或超过 8000 字',
  invalid_title: '标题要 1–80 个字',
  native_harness_required: '当前内核不能排成任务',
  character_runtime_unavailable: '角色内核没有启动',
  invalid_answers: '每个问题都要回答',
  invalid_approval: '审批只能选允许或拒绝',
  approval_expired: '审批已过期',
  not_implemented: '这台电脑暂不支持',
  no_reminder_time: '没听清时间或要提醒的事',
  // The say route's command refusals (turns.py say(), announce.py _remind()): nothing changed elsewhere.
  switching: '正在换角色，稍后再说',
  no_task: '现在没有在跑的任务',
  ambiguous_task: '有多个任务在跑，请在任务页选一个停下',
  no_cwd: '没有工作目录：先在会话里打开一个目录',
  no_memory_dispatch: '这一轮不记，不能派活',
  no_pending_approval: '没有待决的审批',
  ambiguous_approval: '有多张审批卡，请在卡片上选一张拒绝',
  scope_changed: '工作目录已变动或不可用',
  scope_revoked: '工作目录授权已撤销',
  scope_expired: '工作目录授权已过期',
  unknown_scope: '工作目录授权不存在',
  idempotency_conflict: '同一请求已用不同内容发过',
  character_not_present: '角色不在桌面上',
  switch_refused: '没能换角色出来',
  switch_timeout: '换角色超时，还没出来',
};

/** 409 codes that say what the request lacked, not that something changed elsewhere: no conflict text, no reload. */
const REFUSALS: ReadonlySet<string> = new Set([
  'switching', 'no_task', 'ambiguous_task', 'no_cwd', 'no_memory_dispatch', 'no_reminder_time', 'no_pending_approval',
  'ambiguous_approval', 'scope_changed', 'scope_revoked', 'scope_expired', 'unknown_scope', 'idempotency_conflict',
]);

export const conflict = (e: AgentdCallError) => !REFUSALS.has(e.code) && (e.status === 409 || CONFLICT_CODES.has(e.code));

export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return REASONS[(e as { code?: string } | null)?.code ?? ''] ?? '操作没有完成';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.status === 503 && (e.body as { runtime?: unknown } | null)?.runtime != null) return '角色内核未就绪';
  if (e.code !== 'busy' && conflict(e)) return '已在别处更新';
  return REASONS[e.code] ?? '后台拒绝了这次操作';
}
