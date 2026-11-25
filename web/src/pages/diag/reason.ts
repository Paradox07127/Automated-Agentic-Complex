import { AgentdCallError } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';

/** One short reason for a failed read; only `offline` means agentd is gone. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'unknown_trace') return '该轮次未记录事件';
  if (e.code === 'no_trace') return '后台服务未启用事件记录库';
  if (e.code === 'no_memory' || e.code === 'no_memory_journal') return '后台服务未开启记忆功能';
  if (e.status === 0) return '未能发送请求';
  return `后台服务返回状态码 ${e.status}`;
}
