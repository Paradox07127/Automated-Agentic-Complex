import { useContext, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { getBridge, type BridgeError } from '../../bridge';
import type { Toast } from './feedback';
import { outfitImportReason, outfitImportWarning } from './labels';

export interface OutfitImport {
  state: 'idle' | 'busy' | 'done' | 'error';
  run: () => void;
  /** `character.removeOutfit` of an imported appearance; `name` is what the toast calls it. */
  remove: (id: string, name: string) => void;
  /** A remove is running. */
  removing: boolean;
  /** The last import's appearance and its warnings, until `dismiss`; null when it had none. */
  warned: { id: string; name: string; warnings: string[] } | null;
  dismiss: () => void;
}

/** `character.importOutfit` and `removeOutfit`: one at a time; on success the roster is read again so the appearance list shows the change, and `onImported` gets the new appearance. */
export function useOutfitImport(toast: Toast, onImported?: (appearance: { id: string; name: string }) => void): OutfitImport {
  // Read from the context, not useQueryClient: the operator view also renders without a query client.
  const qc = useContext(QueryClientContext);
  const [state, setState] = useState<OutfitImport['state']>('idle');
  const [removing, setRemoving] = useState(false);
  const [warned, setWarned] = useState<OutfitImport['warned']>(null);
  const why = (e: unknown) => {
    const err = e as Partial<BridgeError> | null;
    return err?.code === 'not_implemented' ? '这个版本还不支持' : err?.code ? outfitImportReason(err.code, err.detail) : '桌面角色没有回应';
  };
  const run = () => {
    setState('busy');
    getBridge()
      .character.importOutfit()
      .then(
        (r) => {
          setState('done');
          setWarned(r.warnings.length > 0 ? { ...r.appearance, warnings: r.warnings } : null);
          if (r.warnings.length === 0) toast(`已导入「${r.appearance.name}」`);
          else {
            const words = r.warnings.slice(0, 2).map(outfitImportWarning).join('；');
            toast(`已导入「${r.appearance.name}」，有 ${r.warnings.length} 处要留意：${words}`, { severity: 'warning' });
          }
          void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
          onImported?.(r.appearance);
        },
        (e: unknown) => {
          if ((e as Partial<BridgeError> | null)?.code === 'cancelled') {
            setState('idle');
            return;
          }
          setState('error');
          toast(`导入外观没有完成：${why(e)}`, { severity: 'danger' });
        },
      );
  };
  const remove = (id: string, name: string) => {
    setRemoving(true);
    getBridge()
      .character.removeOutfit(id)
      .then(
        () => {
          setRemoving(false);
          toast(`已删除「${name}」`);
          void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
        },
        (e: unknown) => {
          setRemoving(false);
          toast(`删除外观没有完成：${why(e)}`, { severity: 'danger' });
        },
      );
  };
  return { state, run, remove, removing, warned, dismiss: () => setWarned(null) };
}
