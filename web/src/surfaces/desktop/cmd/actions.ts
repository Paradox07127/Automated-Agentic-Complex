// Her wheel's action table: 8 direct actions, one step each, no sub-menus.
import type { AvatarAction, DesktopState } from '../../../bridge';
import type { NavTarget } from '../../../shell/nav';
import type { GameWheelItem } from '../../../ui/game/GameWheel';

export type CmdActionId = 'goChat' | 'pending' | 'quiet' | 'quietEnd' | 'pass' | 'home' | 'roam' | 'gift' | 'goCharacter';

export interface CmdItem extends GameWheelItem {
  id: CmdActionId;
  /** The main window page the item opens. */
  to?: NavTarget;
}

/** Her gift actions in order of preference, as the shell picks one (app/electron common/desktop-action.ts `GIFT_IDS`). */
const GIFT_IDS = ['receive_gift', 'library_interact_receive_gift', 'interact_receive_gift'];

/** Why 送礼物 cannot play with her action list, as the shell would refuse it; null when it can. */
export function giftOff(actions: readonly AvatarAction[]): string | null {
  const gift = GIFT_IDS.map((id) => actions.find((a) => a.id === id)).find((a) => a !== undefined);
  if (!gift || gift.missing) return gift?.missingReason || '当前角色包尚未导入原作收礼动作';
  return null;
}

/** The wheel's 8 slots clockwise from the top; the toggles follow the desktop state, 待处理 is greyed with nothing waiting
 *  and 送礼物 with `gift`, why it cannot play. */
export function wheelItems(s: DesktopState | null, pending: number, now = Date.now(), gift: string | null = null): CmdItem[] {
  const quiet = s?.quietUntil != null && s.quietUntil > now;
  const pass = s?.hotkeys.hk_pass;
  return [
    { id: 'goChat', label: '对话页', icon: 'file', desc: '主窗口打开对话', to: { page: 'chat' } },
    pending > 0
      ? { id: 'pending', label: '待处理', icon: 'bell', desc: `${pending} 项待处理`, count: pending, to: { page: 'overview', focus: 'pending' } }
      : { id: 'pending', label: '待处理', icon: 'bell', off: '没有待处理的事' },
    quiet
      ? { id: 'quietEnd', label: '结束免打扰', icon: 'moon', desc: '她又可以主动说话', on: true }
      : { id: 'quiet', label: '免打扰', icon: 'moon', desc: '30 分钟里她不主动说话' },
    { id: 'pass', label: '点穿', icon: 'hand', desc: pass ? `点击穿过她；${pass} 恢复` : '点击穿过她；在菜单栏恢复' },
    { id: 'home', label: '放回原位', icon: 'loc', desc: '她和浮窗回到默认位置' },
    { id: 'roam', label: '自由活动', icon: 'sync', desc: s?.freeRoam ? '开着：她会在屏幕上走动' : '让她在屏幕上走动', on: s?.freeRoam === true },
    { id: 'gift', label: '送礼物', icon: 'redeem', desc: '看她收礼的动作', ...(gift != null && { off: gift }) },
    { id: 'goCharacter', label: '角色页', icon: 'user', desc: '换角色、外观、姿态、镜头', to: { page: 'character' } },
  ];
}

/** 待处理 on the wheel: questions, approvals and results in agentd's `/desktop/presence`, counting the rows past the first 3. */
export function pendingCount(presence: unknown): number {
  const pending = (presence as { pending?: Record<string, unknown> } | null)?.pending;
  if (!pending || typeof pending !== 'object') return 0;
  let n = 0;
  for (const key of ['questions', 'approvals', 'results']) {
    const rows = pending[key];
    const more = pending[`${key}_more`];
    n += (Array.isArray(rows) ? rows.length : 0) + (typeof more === 'number' ? more : 0);
  }
  return n;
}
