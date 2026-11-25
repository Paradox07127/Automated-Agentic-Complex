import type { AvatarDetails } from '../../bridge/protocol';
import type { Health } from '../../domain';
import { suspendedText } from './avatarDetails';

/** Why there is no frame chart to draw; a suspended host sends no frame data. */
export function renderWhy(available: boolean, avatar: Health['avatar'] | null, details: AvatarDetails | null = null): string {
  if (!available) return '当前窗口环境无法接收角色帧数据';
  if (avatar && avatar.child !== 'running') return '角色进程未运行 │ 宿主未上报帧数据';
  const suspended = details?.pipeline?.suspended;
  return suspended != null ? suspendedText(suspended) : '宿主未上报帧数据';
}
