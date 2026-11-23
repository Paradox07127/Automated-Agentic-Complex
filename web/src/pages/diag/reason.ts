import { AgentdCallError } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';

/** One short reason for a failed read; only `offline` means agentd is gone. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'unknown_trace') return '这一轮没有留下事件';
  if (e.code === 'no_trace') return '后台没有事件记录库';
  if (e.code === 'no_memory' || e.code === 'no_memory_journal') return '后台没有开启记忆';
  if (e.status === 0) return '请求没有发出';
  return `后台返回 ${e.status}`;
}
