import { useContext, useEffect, useRef, useState } from 'react';
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
  /** The last import's appearance and its warnings, until `dismiss`. */
  landed: { id: string; name: string; warnings: string[] } | null;
  /** `landed` when it has warnings. */
  warned: { id: string; name: string; warnings: string[] } | null;
  dismiss: () => void;
}

/**
 * `character.importOutfit` and `removeOutfit` of `character`: one at a time; on success the roster is read again so the appearance list shows the change,
 * then `onImported` gets the new appearance while the page and `character` that started it are still there (`owns` says whether they still are); the import is done when what it returns settles.
 */
export function useOutfitImport(
  toast: Toast,
  character: string,
  onImported?: (appearance: { id: string; name: string }, owns: () => boolean) => Promise<unknown> | void,
): OutfitImport {
  // Read from the context, not useQueryClient: the operator view also renders without a query client.
  const qc = useContext(QueryClientContext);
  const [state, setState] = useState<OutfitImport['state']>('idle');
  const now = useRef({ character, onImported, live: true });
  now.current = { ...now.current, character, onImported };
  useEffect(() => {
    now.current.live = true;
    return () => void (now.current.live = false);
  }, []);
  const [removing, setRemoving] = useState(false);
  const [landed, setLanded] = useState<OutfitImport['landed']>(null);
  // The banner is the character's who imported it.
  const [landedOf, setLandedOf] = useState(character);
  if (landedOf !== character) {
    setLandedOf(character);
    setLanded(null);
  }
  const why = (e: unknown) => {
    const err = e as Partial<BridgeError> | null;
    return err?.code === 'not_implemented' ? '这个版本还不支持' : err?.code ? outfitImportReason(err.code, err.detail) : '桌面角色没有回应';
  };
  const run = () => {
    const of = character;
    const owns = () => now.current.live && now.current.character === of;
    setState('busy');
    getBridge()
      .character.importOutfit()
      .then(
        (r) => {
          if (owns()) setLanded({ ...r.appearance, warnings: r.warnings });
          if (r.warnings.length === 0) toast(`已导入「${r.appearance.name}」`);
          else {
            const words = r.warnings.slice(0, 2).map(outfitImportWarning).join('；');
            toast(`已导入「${r.appearance.name}」，有 ${r.warnings.length} 处要留意：${words}`, { severity: 'warning' });
          }
          void Promise.resolve(qc?.invalidateQueries({ queryKey: ['character', 'list'] }))
            .then(() => (owns() ? now.current.onImported?.(r.appearance, owns) : undefined))
            .finally(() => setState('done'));
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
      .character.removeOutfit(character, id)
      .then(
        () => {
          setRemoving(false);
          setLanded((l) => (l?.id === id ? null : l));
          toast(`已删除「${name}」`);
          void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
        },
        (e: unknown) => {
          setRemoving(false);
          toast(`删除外观没有完成：${why(e)}`, { severity: 'danger' });
        },
      );
  };
  return { state, run, remove, removing, landed, warned: landed && landed.warnings.length > 0 ? landed : null, dismiss: () => setLanded(null) };
}
