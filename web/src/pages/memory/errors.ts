import { AgentdCallError, BRIDGE_REFUSED, CONFLICT_CODES } from '../../bridge/agentd';
import { codeText, serverFaultText } from '../../domain/errorText';

const REASON: Readonly<Record<string, string>> = {
  no_memory: '记忆功能未开启',
  unknown_fact: '该记忆条目已不存在',
  invalid_text: '内容为空或超过 500 字符',
  invalid_kind: '记忆类型无效',
  no_episodes: '活动记录未开启',
  unknown_episode: '该活动片段已不存在',
  invalid_title: '标题为空或过长',
  invalid_description: '描述为空或过长',
  page_text_off: '未开启读取窗口文字权限',
  source_permission_revoked: '来源授权已撤销',
  evidence_expired: '出处原文仅保留 48 小时，该片段已过期清理',
  task_understanding_unavailable: '任务理解功能未开启',
  task_hypothesis_changed: '该任务推断状态已变更',
  no_attention: '屏幕感知未开启',
};

/** A 409 or a code from CONFLICT_CODES: someone else changed the row first. */
export const isConflict = (e: unknown): boolean => e instanceof AgentdCallError && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** One short line for a failed request; never the raw JSON. */
export function errorText(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '操作未完成';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'switching') return codeText(e.code)!;
  if (isConflict(e)) return '已在其他位置更新';
  if (BRIDGE_REFUSED.has(e.code)) return '当前窗口无权发起该请求';
  return REASON[e.code] ?? `后台服务拒绝了该请求（${e.status}）`;
}
