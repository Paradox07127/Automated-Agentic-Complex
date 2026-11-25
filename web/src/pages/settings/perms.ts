import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgenticComplexBridge, PermissionKind, PermissionState } from '../../bridge';
import type { PermissionRow } from '../../domain';

/** A permission row; `loading` until the shell answers, `unread` when it could not. */
export type PermRow = Omit<PermissionRow, 'state'> & { state: PermissionState | 'loading' | 'unread' };

/** Every kind the shell reports, with what it unlocks. */
const PERM_INFO: Array<Omit<PermRow, 'state'>> = [
  { kind: 'screenRecording', label: '屏幕录制', purpose: '用于屏幕识读、屏幕感知与电脑操作', features: ['屏幕识读', '屏幕感知', '电脑操作'] },
  { kind: 'accessibility', label: '辅助功能', purpose: '用于读取窗口文本及执行电脑操作', features: ['允许读取窗口文本', '电脑操作'] },
  { kind: 'microphone', label: '麦克风与语音识别', purpose: '用于按住语音输入', features: ['按住语音输入'] },
  { kind: 'inputMonitoring', label: '输入监控', purpose: '用于按住语音输入全局快捷键', features: ['按住语音输入'] },
  { kind: 'automation', label: '自动化（终端）', purpose: '用于控制「终端」以跳转至编码会话', features: ['跳转至终端'] },
  { kind: 'notifications', label: '通知', purpose: '用于发送系统通知', features: ['系统通知'] },
];

/** A permission row's ⓘ: what it lets the app do and what stops without it; the rest keep their purpose line. */
export const PERM_TIP: Partial<Record<PermissionKind, string>> = {
  screenRecording: '允许应用获取屏幕画面。屏幕识读、识读附图、屏幕感知与电脑操作均依赖此权限；未授予时相关功能无法采集屏幕内容。',
  accessibility: '允许应用读取窗口控件文本并在授权窗口中执行点击与输入操作；未授予时无法读取窗口文本或执行电脑操作。',
  microphone: '按住语音输入时用于录制音频并转写为文字；未授予时仅支持键盘输入。',
  inputMonitoring: '当按住语音输入设置为右 Option 键时，需此权限以在后台全局响应按键；改用常规组合快捷键时无需此权限。',
  automation: 'macOS 的自动化权限按目标应用分别授予。此处仅检测 Agentic Complex 是否具备控制「终端」的权限（仅在终端运行中时可检测）。系统设置中其他关联应用的权限相互独立。',
  notifications: '允许应用发送系统通知。当「设置 › 交流」中开启系统通知且角色隐藏或应用全屏时，提醒将由系统通知中心送达。',
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
