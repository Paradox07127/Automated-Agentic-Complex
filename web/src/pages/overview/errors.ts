import { AgentdCallError, BRIDGE_REFUSED, CONFLICT_CODES } from '../../bridge/agentd';
import { codeText, serverFaultText } from '../../domain/errorText';
import { isPluginOff } from '../../shell/plugins';

/** Someone else settled the row first: say so and read again. */
export const isConflict = (e: unknown): boolean => e instanceof AgentdCallError && !isPluginOff(e) && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** A read of a route whose plug-in agentd does not run (yet) answers `none`: the page shows nothing for it. */
export const orNone = <T>(read: Promise<T>, none: T): Promise<T> =>
  read.catch((e: unknown) => {
    if (isPluginOff(e)) return none;
    throw e;
  });

/** Short Chinese reason for a failed call; never the raw reply. */
export function errText(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '客户端未完成该操作';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'switching') return codeText(e.code)!;
  if (isConflict(e)) return '已在其他位置更新';
  if (e.status === 0) return BRIDGE_REFUSED.has(e.code) ? '客户端拒绝了该请求' : '客户端未完成该请求';
  if (e.status === 401) return '后台服务拒绝访问';
  if (e.status === 404) return '后台服务未找到该资源';
  if (e.status === 400) return '后台服务不接受该请求';
  if (e.status === 503) return '后台服务该模块暂不可用';
  return `后台服务异常（${e.status}）`;
}
