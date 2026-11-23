import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgenticComplexBridge, PermissionKind, PermissionState } from '../../bridge';
import type { PermissionRow } from '../../domain';

/** A permission row; `loading` until the shell answers, `unread` when it could not. */
export type PermRow = Omit<PermissionRow, 'state'> & { state: PermissionState | 'loading' | 'unread' };

/** Every kind the shell reports, with what it unlocks. */
const PERM_INFO: Array<Omit<PermRow, 'state'>> = [
  { kind: 'screenRecording', label: '屏幕录制', purpose: '用于屏幕识读', features: ['屏幕识读', '附上截图', '今日截图额度'] },
  { kind: 'accessibility', label: '辅助功能', purpose: '读取窗口文字、操作电脑', features: ['读取窗口文字', '操作电脑'] },
  { kind: 'microphone', label: '麦克风与语音识别', purpose: '按住说话', features: ['按住说话'] },
  { kind: 'inputMonitoring', label: '输入监控', purpose: '按住说话的热键', features: ['按住说话'] },
  { kind: 'automation', label: '自动化（终端）', purpose: '控制「终端」，用于跳到终端里的编码会话', features: ['跳到终端'] },
  { kind: 'notifications', label: '通知', purpose: '系统通知', features: ['系统通知'] },
];

/** A permission row's ⓘ: what it lets the app do and what stops without it; the rest keep their purpose line. */
export const PERM_TIP: Partial<Record<PermissionKind, string>> = {
  screenRecording: '让应用截取屏幕画面。屏幕识读、识读附图、屏幕感知和操作电脑都要用它；没开时这些功能拿不到画面。',
  accessibility: '让应用读取别的应用窗口里的文字，并在窗口里点击和打字。没开时读不到窗口文字，也不能操作电脑。',
  microphone: '按住说话时用它录音并识别成文字。没开时不能按住说话，只能打字。',
  inputMonitoring: '按住说话设成右 Option 键时要用它，让应用在任何应用里都能收到这个键。没开时右 Option 按住说话不起作用；换成别的组合键不需要它。',
  automation: 'macOS 的自动化权限按目标应用分别授权。这里只查 Agentic Complex 能不能控制「终端」，用来跳到终端里的编码会话，终端开着时才读得到。系统设置里 Agentic Complex 下列出的其他应用（例如 Codex 内核自带的 Computer Use 程序）各自单独授权，和这一项无关。',
  notifications: '让应用发系统通知。打开「交流」里改走系统通知的那一项后，角色隐藏或前台全屏时提醒走系统通知；没有这项权限时这些通知不会出现。',
};

type Reading = { kind: 'loading' } | { kind: 'unread' } | { kind: 'read'; states: Partial<Record<PermissionKind, PermissionState>> };

/** The permission rows with the states the shell reports; a kind it leaves out is not shown once read. */
export function usePerms(bridge: AgenticComplexBridge) {
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    bridge.permissions.status().then(
      (s) => live && setReading({ kind: 'read', states: s }),
      () => live && setReading({ kind: 'unread' }),
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const perms = useMemo<PermRow[]>(() => {
    if (reading.kind !== 'read') return PERM_INFO.map((p) => ({ ...p, state: reading.kind }));
    return PERM_INFO.flatMap((p) => {
      const state = reading.states[p.kind];
      return state ? [{ ...p, state }] : [];
    });
  }, [reading]);
  const recheckPerms = useCallback(
    async (kind?: PermissionKind): Promise<PermissionState | null> => {
      try {
        const s = await bridge.permissions.status();
        setReading({ kind: 'read', states: s });
        return kind ? (s[kind] ?? null) : null;
      } catch {
        setReading({ kind: 'unread' });
        return null;
      }
    },
    [bridge],
  );
  return { perms, recheckPerms };
}
