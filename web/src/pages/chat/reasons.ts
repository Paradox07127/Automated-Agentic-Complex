import { AgentdCallError, CONFLICT_CODES } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';

/** Short reasons for agentd's codes on this page; anything else says the request was refused. */
const REASONS: Record<string, string> = {
  busy: '角色正在执行，请在结束后重试',
  no_llm: '尚无可用模型',
  no_history: '对话记录未开启',
  archived: '对话已归档',
  conversation_not_active: '非当前活跃对话',
  unknown_conversation: '对话已不存在',
  invalid_text: '内容为空或超过 8000 字符',
  invalid_title: '标题长度须为 1–80 个字符',
  native_harness_required: '当前执行内核不支持排入后台任务',
  character_runtime_unavailable: '执行内核未启动',
  invalid_answers: '每个问题均须作答',
  invalid_approval: '审批仅支持允许或拒绝',
  approval_expired: '审批已过期',
  not_implemented: '当前平台暂不支持',
  no_reminder_time: '未能识别提醒时间或提醒事项',
  // The say route's command refusals (turns.py say(), announce.py _remind()): nothing changed elsewhere.
  switching: '正在切换角色，请稍后重试',
  no_task: '当前无运行中的任务',
  ambiguous_task: '当前有多个运行中的任务，请在任务页选择指定任务停止',
  no_cwd: '缺少工作目录：请先在对话或授权范围中指定目录',
  no_memory_dispatch: '开启「此轮不记录」时无法派发任务',
  no_pending_approval: '当前无待处理的审批',
  ambiguous_approval: '当前存在多张待处理审批卡片，请在对应卡片上拒绝',
  scope_changed: '工作目录已变动或不可用',
  scope_revoked: '工作目录授权已撤销',
  scope_expired: '工作目录授权已过期',
  unknown_scope: '工作目录授权不存在',
  idempotency_conflict: '相同请求已使用不同内容提交',
  character_not_present: '角色当前未在桌面显示',
  switch_refused: '未能切换角色出场',
  switch_timeout: '切换角色超时，尚未完成加载',
  not_stopped: '后台服务未停止该任务：任务状态可能已变更',
};

/** 409 codes that say what the request lacked, not that something changed elsewhere: no conflict text, no reload. */
const REFUSALS: ReadonlySet<string> = new Set([
  'switching', 'no_task', 'ambiguous_task', 'no_cwd', 'no_memory_dispatch', 'no_reminder_time', 'no_pending_approval',
  'ambiguous_approval', 'scope_changed', 'scope_revoked', 'scope_expired', 'unknown_scope', 'idempotency_conflict',
]);

export const conflict = (e: AgentdCallError) => !REFUSALS.has(e.code) && (e.status === 409 || CONFLICT_CODES.has(e.code));

export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return REASONS[(e as { code?: string } | null)?.code ?? ''] ?? '操作未完成';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.status === 503 && (e.body as { runtime?: unknown } | null)?.runtime != null) return '执行内核未就绪';
  if (e.code !== 'busy' && conflict(e)) return '已在其他位置更新';
  return REASONS[e.code] ?? '后台服务拒绝了该请求';
}
