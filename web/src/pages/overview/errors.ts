import { AgentdCallError, BRIDGE_REFUSED, CONFLICT_CODES } from '../../bridge/agentd';
import { codeText, serverFaultText } from '../../domain/errorText';

/** Someone else settled the row first: say so and read again. */
export const isConflict = (e: unknown): boolean => e instanceof AgentdCallError && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** Short Chinese reason for a failed call; never the raw reply. */
export function errText(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '桌面端没有完成这个操作';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'switching') return codeText(e.code)!;
  if (isConflict(e)) return '已在别处更新';
  if (e.status === 0) return BRIDGE_REFUSED.has(e.code) ? '桌面端拒绝了这个请求' : '桌面端没有完成这个请求';
  if (e.status === 401) return '后台拒绝访问';
  if (e.status === 404) return '后台没有这一项';
  if (e.status === 400) return '后台不接受这个请求';
  if (e.status === 503) return '后台这部分暂不可用';
  return `后台出错（${e.status}）`;
}
