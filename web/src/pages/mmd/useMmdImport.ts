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
  /** Adds music picked anywhere to the pending scan; its index in `pending.scan.audio`, null when none was added. */
  pickAudio: () => Promise<number | null>;
  setMedia: (id: string, media: { bgm: 'pick' | 'none'; bgmStartS: number | null }) => void;
}

const quoted = (actions: ImportedMotion[]) => actions.map((a) => `「${a.title}」`).join('');
const thrown = (e: unknown) => ((e as { code?: string } | null)?.code === 'not_implemented' ? '当前版本暂不支持' : '角色渲染进程无响应');
const hints = (actions: ImportedMotion[]) => {
  const n = actions.reduce((sum, a) => sum + a.warnings.length, 0);
  return n ? `，有 ${n} 条提示` : '';
};

/** `mmd.scan`, then `mmd.pickScanAudio`, `mmd.importScan` of the choices or `mmd.dropScan`; `mmd.setMedia`. One at a time; `onImported` runs once the
 *  avatar is back with a new dance. */
export function useMmdImport(onImported: () => void): MmdImport {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<MmdImport['note']>(null);
  const [pending, setPending] = useState<MmdImport['pending']>(null);
  const failed = (reason: string, head = '导入未完成') => setNote({ ok: false, text: `${head}：${reason}`, reason });

  const scan = (folder: boolean) => {
    setRunning(true);
    setNote(null);
    getBridge()
      .mmd.scan({ folder })
      .then(
        (r) => {
          setRunning(false);
          if (r.ok) setPending({ token: r.token, scan: r.scan });
          else if (r.reason !== 'cancelled') failed(motionImportReason(r.reason, r.detail), '未能解析此 MMD 工程');
        },
        (e: unknown) => {
          setRunning(false);
          failed(thrown(e), '未能解析此 MMD 工程');
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
            else setNote({ ok: false, text: `已导入${quoted(r.actions)}，「${stuck}」未完成：${reason}`, reason });
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

  const pickAudio = (): Promise<number | null> => {
    const was = pending;
    if (!was) return Promise.resolve(null);
    return getBridge()
      .mmd.pickScanAudio(was.token)
      .then(
        (r) => {
          if (r.ok) {
            setPending((p) => (p?.token === was.token ? { token: p.token, scan: r.scan } : p));
            return r.audio;
          }
          if (r.reason !== 'cancelled') failed(motionImportReason(r.reason, r.detail), '音频更换失败');
          return null;
        },
        (e: unknown) => {
          failed(thrown(e), '音频更换失败');
          return null;
        },
      );
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
            setNote({ ok: true, text: media.bgm === 'pick' ? `已为「${r.action.title}」更换音频` : `已移除「${r.action.title}」的音频` });
            onImported();
          } else if (r.reason !== 'cancelled') failed(motionImportReason(r.reason, r.detail), '音频更换失败');
        },
        (e: unknown) => {
          setRunning(false);
          failed(thrown(e), '音频更换失败');
        },
      );
  };

  return { running, note, pending, scan, confirm, cancel, pickAudio, setMedia };
}
