import type { AvatarDetails } from '../../bridge/protocol';
import type { Health } from '../../domain';
import { suspendedText } from './avatarDetails';

/** Why there is no frame chart to draw; a suspended host sends no frame data. */
export function renderWhy(available: boolean, avatar: Health['avatar'] | null, details: AvatarDetails | null = null): string {
  if (!available) return '这个窗口收不到角色的帧数据';
  if (avatar && avatar.child !== 'running') return '角色未运行 │ 宿主没有上报帧数据';
  const suspended = details?.pipeline?.suspended;
  return suspended != null ? suspendedText(suspended) : '宿主没有上报帧数据';
}
