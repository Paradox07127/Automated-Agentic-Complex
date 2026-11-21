import { AgentdCallError, BRIDGE_REFUSED, CONFLICT_CODES } from '../../bridge/agentd';
import { codeText, serverFaultText } from '../../domain/errorText';

const REASON: Readonly<Record<string, string>> = {
  no_memory: '记忆没有开启',
  unknown_fact: '这一条已经不在了',
  invalid_text: '内容为空或超过 500 字',
  invalid_kind: '种类不对',
  no_episodes: '活动记录没有开启',
  unknown_episode: '这一段已经不在了',
  invalid_title: '标题为空或太长',
  invalid_description: '描述为空或太长',
  page_text_off: '没有允许读取页面文字',
  source_permission_revoked: '来源权限已撤回',
  evidence_expired: '出处只保留 48 小时，这一段的已经清理',
  task_understanding_unavailable: '任务猜测没有开启',
  task_hypothesis_changed: '这条猜测已经变了',
  no_attention: '观察没有开启',
};

/** A 409 or a code from CONFLICT_CODES: someone else changed the row first. */
export const isConflict = (e: unknown): boolean => e instanceof AgentdCallError && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** One short line for a failed request; never the raw JSON. */
export function errorText(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '没有完成';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'switching') return codeText(e.code)!;
  if (isConflict(e)) return '已在别处更新';
  if (BRIDGE_REFUSED.has(e.code)) return '这个窗口不能发这个请求';
  return REASON[e.code] ?? `后台没有接受（${e.status}）`;
}
