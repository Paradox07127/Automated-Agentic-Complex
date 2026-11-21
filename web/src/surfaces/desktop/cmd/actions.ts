// The command ring's action table: up to 8 direct actions, one step each, no sub-menus.
import type { DesktopState } from '../../../bridge';
import type { HotkeyId } from '../../../domain/hotkeys';
import type { NavTarget } from '../../../shell/nav';
import type { IconName } from '../../../ui';

/** The bridge interface an action ends in. */
export type CmdVia = 'app.look' | 'window.openMain' | 'desktop.action';

export type CmdActionId = 'input' | 'look' | 'openStack' | 'goChat' | 'quiet' | 'quietEnd' | 'pass' | 'hide' | 'show' | 'gift';

export interface CmdItem {
  id: CmdActionId;
  label: string;
  /** A line under the label, for an item whose name alone does not say what it does. */
  sub?: string;
  icon: IconName;
  via: CmdVia;
  /** The main window page `window.openMain` opens. */
  to?: NavTarget;
  /** The setting whose saved combo the item hints. */
  hotkey?: HotkeyId;
  /** The item shows the pending count. */
  pending?: boolean;
}

/** The ring items in key order, 屏幕识读 only while its plug-in is on; toggle labels follow the desktop state. */
export function ringItems(s: DesktopState | null, now = Date.now()): CmdItem[] {
  const quiet = s?.quietUntil != null && s.quietUntil > now;
  return [
    { id: 'input', label: '快速输入', icon: 'send', via: 'desktop.action', hotkey: 'hk_quick' },
    ...(s?.plugins.includes('screen_reading') ? [{ id: 'look', label: '屏幕识读', icon: 'look', via: 'app.look', hotkey: 'hk_look' } as const] : []),
    { id: 'openStack', label: '待处理', icon: 'bell', via: 'desktop.action', pending: true },
    { id: 'goChat', label: '打开对话', icon: 'ext', via: 'window.openMain', to: { page: 'chat' } },
    quiet
      ? { id: 'quietEnd', label: '结束免打扰', icon: 'moonz', via: 'desktop.action' }
      : { id: 'quiet', label: '免打扰 30 分', icon: 'moonz', via: 'desktop.action' },
    { id: 'pass', label: s?.clickThroughAll ? '结束点穿' : '让鼠标穿过她', icon: 'hand', via: 'desktop.action', hotkey: 'hk_pass' },
    s?.hidden
      ? { id: 'show', label: '显示角色', icon: 'eye', via: 'desktop.action', hotkey: 'hk_hide' }
      : { id: 'hide', label: '隐藏 30 分', icon: 'eye', via: 'desktop.action', hotkey: 'hk_hide' },
    { id: 'gift', label: '送礼物', sub: '看她收礼', icon: 'redeem', via: 'desktop.action' },
  ];
}

/** 待处理 on the ring: questions, approvals and results in agentd's `/desktop/presence`, counting the rows past the first 3. */
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
