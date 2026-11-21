import { useState } from 'react';
import type { MotionImportResult } from '../../bridge';
import { motionFormatLabel, motionImportReason } from './labels';

export interface MotionImport {
  running: boolean;
  /** The last result line; null before the first import and after a cancelled one. */
  note: { ok: boolean; text: string } | null;
  run: () => void;
}

/** `character.importMotion` or `mmd.import` (`call`): one import at a time; `onImported` runs once the avatar is back with the new action. */
export function useMotionImport(call: () => Promise<MotionImportResult>, onImported: () => void): MotionImport {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<MotionImport['note']>(null);
  const run = () => {
    setRunning(true);
    call()
      .then(
        (r) => {
          setRunning(false);
          if (r.ok) {
            const n = r.action.warnings.length;
            setNote({ ok: true, text: `已导入「${r.action.title}」（${motionFormatLabel(r.action.format)}）${n ? `，有 ${n} 条提示` : ''}` });
            onImported();
          } else setNote(r.reason === 'cancelled' ? null : { ok: false, text: `导入没有完成：${motionImportReason(r.reason, r.detail)}` });
        },
        (e: unknown) => {
          setRunning(false);
          setNote({ ok: false, text: `导入没有完成：${(e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}` });
        },
      );
  };
  return { running, note, run };
}
