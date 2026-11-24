import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type ImportedMotionEntry, type MotionEditFailure, type MotionRemoveResult, type MotionRenameResult } from '../../bridge';
import { toast } from '../../shell/toast';
import { motionImportReason } from './labels';

export interface MotionLibrary {
  /** The character it lists and edits. */
  character: string;
  /** Her imported motions by action id; empty while loading or before a list succeeded. A failed reread keeps the last list. */
  byId: Record<string, ImportedMotionEntry>;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  /** A rename or remove is running. */
  busy: boolean;
  /** Why the last list read failed; null when it did not. */
  error: string | null;
  refetch: () => void;
}

const NONE: Record<string, ImportedMotionEntry> = {};

/** A list the host answered with `ok: false`: thrown, so the query keeps the last list. */
class ListFailure extends Error {
  readonly failure: MotionEditFailure;
  constructor(failure: MotionEditFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

const hostText = (e: unknown) => ((e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应');

/** `character.listImportedMotions` of `character` with rename and remove; `onChanged` runs once the avatar is back with the change. */
export function useMotionLibrary({ character, onChanged }: { character: string; onChanged: () => void }): MotionLibrary {
  const enabled = getBridge().capabilities.avatar && character !== '';
  const list = useQuery({
    queryKey: ['character', 'importedMotions', character],
    queryFn: async () => {
      const r = await getBridge().character.listImportedMotions(character);
      if (!r.ok) throw new ListFailure(r);
      return r.motions;
    },
    enabled,
  });
  const [busy, setBusy] = useState(false);
  const data = list.data;
  const byId = useMemo(() => (data ? Object.fromEntries(data.map((m) => [m.id, m])) : NONE), [data]);
  const refetch = () => void list.refetch();
  const error = !list.isError ? null : list.error instanceof ListFailure ? motionImportReason(list.error.failure.reason, list.error.failure.detail) : hostText(list.error);

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
        toast(`${what}没有完成：${hostText(e)}`, { severity: 'danger' });
      },
    );
  };

  return {
    character,
    byId,
    rename: (id, title) => edit('改名', getBridge().character.renameMotion(character, id, title)),
    remove: (id) => edit('删除', getBridge().character.removeMotion(character, id)),
    busy,
    error,
    refetch,
  };
}
