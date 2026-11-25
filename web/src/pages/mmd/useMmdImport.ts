import { useState } from 'react';
import { getBridge, type ImportedMotion, type MmdImportPlan, type MmdScan } from '../../bridge';
import type { MotionImport } from '../character/useMotionImport';
import { motionImportReason } from '../character/labels';

export interface MmdImport {
  /** Scanning, importing or changing a dance's music. */
  running: boolean;
  /** The last result line, gone once the next scan starts; null before the first and after a cancel. */
  note: MotionImport['note'];
  /** The scan waiting for the user's choices. */
  pending: { token: string; scan: MmdScan } | null;
  scan: (folder: boolean) => void;
  /** Imports the pending scan by `plan`. */
  confirm: (plan: MmdImportPlan) => void;
  /** Drops the pending scan. */
  cancel: () => void;
  setMedia: (id: string, media: { bgm: 'pick' | 'none'; bgmStartS: number | null }) => void;
}

const quoted = (actions: ImportedMotion[]) => actions.map((a) => `「${a.title}」`).join('');
const thrown = (e: unknown) => ((e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应');
const hints = (actions: ImportedMotion[]) => {
  const n = actions.reduce((sum, a) => sum + a.warnings.length, 0);
  return n ? `，有 ${n} 条提示` : '';
};

/** `mmd.scan`, then `mmd.importScan` of the choices or `mmd.dropScan`; `mmd.setMedia`. One at a time; `onImported` runs once the
 *  avatar is back with a new dance. */
export function useMmdImport(onImported: () => void): MmdImport {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<MmdImport['note']>(null);
  const [pending, setPending] = useState<MmdImport['pending']>(null);
  const failed = (reason: string, head = '导入没有完成') => setNote({ ok: false, text: `${head}：${reason}`, reason });

  const scan = (folder: boolean) => {
    setRunning(true);
    setNote(null);
    getBridge()
      .mmd.scan({ folder })
      .then(
        (r) => {
          setRunning(false);
          if (r.ok) setPending({ token: r.token, scan: r.scan });
          else if (r.reason !== 'cancelled') failed(motionImportReason(r.reason, r.detail), '没有读出这个 MMD 工程');
        },
        (e: unknown) => {
          setRunning(false);
          failed(thrown(e), '没有读出这个 MMD 工程');
        },
      );
  };

  const confirm = (plan: MmdImportPlan) => {
    setPending(null);
    setRunning(true);
    getBridge()
      .mmd.importScan(plan)
      .then(
        (r) => {
          setRunning(false);
          if (r.actions.length > 0) onImported();
          if (r.ok) setNote({ ok: true, text: `已导入${quoted(r.actions)}${hints(r.actions)}` });
          else {
            const reason = motionImportReason(r.reason, r.detail);
            const stuck = plan.items[r.actions.length]?.title;
            if (r.actions.length === 0) failed(reason);
            else setNote({ ok: false, text: `已导入${quoted(r.actions)}，「${stuck}」没有完成：${reason}`, reason });
          }
        },
        (e: unknown) => {
          setRunning(false);
          failed(thrown(e));
        },
      );
  };

  const cancel = () => {
    if (pending) void getBridge().mmd.dropScan(pending.token).catch(() => {});
    setPending(null);
  };

  const setMedia = (id: string, media: { bgm: 'pick' | 'none'; bgmStartS: number | null }) => {
    setRunning(true);
    setNote(null);
    getBridge()
      .mmd.setMedia(id, media)
      .then(
        (r) => {
          setRunning(false);
          if (r.ok) {
            setNote({ ok: true, text: media.bgm === 'pick' ? `「${r.action.title}」换了音源` : `「${r.action.title}」去掉了音源` });
            onImported();
          } else if (r.reason !== 'cancelled') failed(motionImportReason(r.reason, r.detail), '音源没有换成');
        },
        (e: unknown) => {
          setRunning(false);
          failed(thrown(e), '音源没有换成');
        },
      );
  };

  return { running, note, pending, scan, confirm, cancel, setMedia };
}
