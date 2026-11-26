import { useEffect, useState } from 'react';
import { getBridge, type ImportState } from '../../bridge';

const STAGE: Record<string, string> = {
  read: '读取文件',
  sample: '插值关键帧',
  retarget: '重定向骨骼',
  compose: '合成外观',
  write: '写入角色包',
  validate: '校验',
  publish: '发布',
  reload: '载入角色',
};

/** A progress stage in words; 准备中 before the first one. */
export const importStageLabel = (stage: string | null) => (stage == null ? '准备中' : (STAGE[stage] ?? stage));

const IDLE: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };

/** `character.importState`, then each `character.onImport`; stays idle when the read fails. */
export function useImportState(): ImportState {
  const [state, setState] = useState<ImportState>(IDLE);
  useEffect(() => {
    const ops = getBridge().character;
    let pushed = false;
    let live = true;
    ops.importState().then((s) => live && !pushed && setState(s), () => {});
    const off = ops.onImport((s) => {
      pushed = true;
      setState(s);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}
