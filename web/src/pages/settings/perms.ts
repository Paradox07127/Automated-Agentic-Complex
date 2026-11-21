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
  { kind: 'automation', label: '自动化', purpose: '检测「终端」授权，用于跳转终端会话。Safari 和 Chrome 的授权独立。', features: ['跳到终端'] },
  { kind: 'notifications', label: '通知', purpose: '系统通知', features: ['系统通知'] },
];

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
