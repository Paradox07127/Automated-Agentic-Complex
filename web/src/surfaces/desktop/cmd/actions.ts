// Her wheel's action table: 8 slots a level. 动作 opens her setlist's level in place and its 姿态 the poses'; the rest run at once.
import type { AvatarAction, DesktopState } from '../../../bridge';
import { formatElapsed } from '../../../domain';
import type { NavTarget } from '../../../shell/nav';
import type { GameWheelItem } from '../../../ui/game/GameWheel';

export type CmdActionId =
  | 'goChat' | 'pending' | 'quiet' | 'quietEnd' | 'pass' | 'home' | 'roam' | 'actions' | 'stop' | 'goCharacter'
  | 'dance' | 'poses' | 'gift' | 'pose';

/** The levels under the first, named as the slot that opens each. */
export type CmdLevel = Extract<CmdActionId, 'actions' | 'poses'>;

export interface CmdItem extends GameWheelItem {
  id: CmdActionId;
  /** The main window page the item opens. */
  to?: NavTarget;
  /** A dance: its index in her saved setlist, from which the list plays. */
  start?: number;
  /** A pose: its row's action id, null for 自动. */
  pose?: string | null;
}

/** How many of her setlist's dances 动作's level holds. */
const DANCES = 6;
/** The shell's reason for a renderer that lists no `poses` (app/electron camera/pose.ts `FAILURES.unsupported`). */
const NO_POSES = '这个版本的角色不支持姿态';

/** Her gift actions in order of preference, as the shell picks one (app/electron common/desktop-action.ts `GIFT_IDS`). */
const GIFT_IDS = ['receive_gift', 'library_interact_receive_gift', 'interact_receive_gift'];

/** Why 送礼物 cannot play with her action list, as the shell would refuse it; null when it can. */
export function giftOff(actions: readonly AvatarAction[]): string | null {
  const gift = GIFT_IDS.map((id) => actions.find((a) => a.id === id)).find((a) => a !== undefined);
  if (!gift || gift.missing) return gift?.missingReason || '当前角色包尚未导入原作收礼动作';
  return null;
}

/** The wheel's 8 slots clockwise from the top; the toggles follow the desktop state, 待处理 is greyed with nothing waiting,
 *  and 动作 is 停止 while she plays, named from her `actions`. */
export function wheelItems(s: DesktopState | null, pending: number, now = Date.now(), actions: readonly AvatarAction[] = []): CmdItem[] {
  const quiet = s?.quietUntil != null && s.quietUntil > now;
  const pass = s?.hotkeys.hk_pass;
  return [
    { id: 'goChat', label: '对话页', icon: 'file', desc: '主窗口打开对话', to: { page: 'chat' } },
    pending > 0
      ? { id: 'pending', label: '待处理', icon: 'bell', desc: `${pending} 项待处理`, count: pending, to: { page: 'overview', focus: 'pending' } }
      : { id: 'pending', label: '待处理', icon: 'bell', off: '没有待处理的事' },
    quiet
      ? { id: 'quietEnd', label: '结束免打扰', icon: 'moon', desc: '又可以主动说话', on: true }
      : { id: 'quiet', label: '免打扰', icon: 'moon', desc: '30 分钟里不主动说话' },
    { id: 'pass', label: '点穿', icon: 'hand', desc: pass ? `点击穿过角色；${pass} 恢复` : '点击穿过角色；在菜单栏恢复' },
    { id: 'home', label: '放回原位', icon: 'loc', desc: '角色和浮窗回到默认位置' },
    { id: 'roam', label: '自由活动', icon: 'sync', desc: s?.freeRoam ? '开着：角色会在屏幕上走动' : '让角色在屏幕上走动', on: s?.freeRoam === true },
    s?.playing != null
      ? { id: 'stop', label: '停止', icon: 'stop', desc: actions.find((a) => a.id === s.playing)?.label ?? s.playing, on: true }
      : { id: 'actions', label: '动作', icon: 'play', deeper: true },
    { id: 'goCharacter', label: '角色页', icon: 'user', desc: '换角色、外观、姿态、镜头', to: { page: 'character' } },
  ];
}

/** 动作's level: the first 6 dances of her setlist in its order, the one playing marked, a shorter list leaving its slots
 *  empty; 姿态 at 07, greyed while her renderer has no poses, and 送礼物 at 08, greyed with `gift`, why it cannot play. */
export function actionItems(s: DesktopState | null, setlist: readonly string[], actions: readonly AvatarAction[], gift: string | null = null): (CmdItem | null)[] {
  // As her MMD page lists it: the `mmd_` ids she has, each keeping its place in the saved list.
  const dances = setlist
    .flatMap((id, start) => {
      const a = id.startsWith('mmd_') ? actions.find((x) => x.id === id) : undefined;
      return a ? [{ a, start }] : [];
    })
    .slice(0, DANCES);
  return [
    ...Array.from({ length: DANCES }, (_, i): CmdItem | null => {
      const d = dances[i];
      return d
        ? { id: 'dance', label: d.a.label, icon: 'play', desc: d.a.durationS != null ? formatElapsed(d.a.durationS * 1000) : '', start: d.start, on: s?.playing === d.a.id }
        : null;
    }),
    s?.poses ? { id: 'poses', label: '姿态', icon: 'pin', deeper: true } : { id: 'poses', label: '姿态', icon: 'pin', off: NO_POSES },
    { id: 'gift', label: '送礼物', icon: 'redeem', desc: '看角色收礼的动作', ...(gift != null && { off: gift }) },
  ];
}

/** 姿态's level: 自动, then her pose slots in menu order; the held one is marked, 自动 while none is, and one she cannot take is
 *  greyed with why. */
export function poseItems(s: DesktopState | null): CmdItem[] {
  const poses = s?.poses;
  if (!poses) return [];
  return [
    { id: 'pose', label: '自动', icon: 'refresh', pose: null, on: poses.current === null },
    ...poses.slots.map((p): CmdItem => ({
      id: 'pose',
      label: p.title,
      icon: 'pin',
      pose: p.id,
      on: p.id !== null && p.id === poses.current,
      ...(p.reason !== null && { off: p.reason }),
    })),
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
