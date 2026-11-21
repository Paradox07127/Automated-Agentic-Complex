import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type ImportedMotionEntry, type MotionRemoveResult, type MotionRenameResult } from '../../bridge';
import { toast } from '../../shell/toast';
import { motionImportReason } from './labels';

export interface MotionLibrary {
  /** The current character's imported motions by action id; empty while loading or when the list failed. */
  byId: Record<string, ImportedMotionEntry>;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  /** A rename or remove is running. */
  busy: boolean;
  refetch: () => void;
}

const NONE: Record<string, ImportedMotionEntry> = {};

/** `character.listImportedMotions` with rename and remove; `onChanged` runs once the avatar is back with the change. */
export function useMotionLibrary({ onChanged }: { onChanged: () => void }): MotionLibrary {
  const enabled = getBridge().capabilities.avatar;
  const list = useQuery({ queryKey: ['character', 'importedMotions'], queryFn: () => getBridge().character.listImportedMotions(), enabled });
  const [busy, setBusy] = useState(false);
  const data = list.data;
  const byId = useMemo(() => (data?.ok ? Object.fromEntries(data.motions.map((m) => [m.id, m])) : NONE), [data]);
  const refetch = () => void list.refetch();

  const edit = (what: string, call: Promise<MotionRenameResult | MotionRemoveResult>) => {
    setBusy(true);
    call.then(
      (r) => {
        setBusy(false);
        if (r.ok) {
          refetch();
          onChanged();
        } else toast(`${what}没有完成：${motionImportReason(r.reason, r.detail)}`, { severity: 'danger' });
      },
      (e: unknown) => {
        setBusy(false);
        toast(`${what}没有完成：${(e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
      },
    );
  };

  return {
    byId,
    rename: (id, title) => edit('改名', getBridge().character.renameMotion(id, title)),
    remove: (id) => edit('删除', getBridge().character.removeMotion(id)),
    busy,
    refetch,
  };
}
