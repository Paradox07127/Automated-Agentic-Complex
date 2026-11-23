// 角色页 动作 →「导入」: the motion import.
import { useState, type CSSProperties } from 'react';
import type { ImportedMotionEntry, ImportState } from '../../bridge';
import { Icon } from '../../ui';
import { DarkRow, Diamond, MicroLabel, TitleBar, WhiteCapsule } from '../../ui/game';
import { useCompact } from './compact';
import { motionFormatLabel } from './labels';
import { MotionEditDialog, type MotionEdit } from './MotionEditDialog';
import { importStageLabel, useImportState } from './useImportState';
import type { MotionImport } from './useMotionImport';
import type { MotionLibrary } from './useMotionLibrary';
import styles from './ImportPane.module.css';

export interface ImportPaneProps {
  /** `character.importPackage`; absent without an avatar. */
  onImportPackage?: () => void;
  /** Absent without an avatar. */
  motionImport?: MotionImport;
  library?: MotionLibrary;
  offline: boolean;
  /** A switch is running: input pauses. */
  lock: boolean;
}

export function ImportPane(p: ImportPaneProps) {
  return <MotionImportPane {...p} importing={useImportState()} />;
}

/** motion_tool's stages in order for a motion that is not a VMD (TAKE_STAGES), then the reload; a VMD inserts `sample` after `read`. */
const TAKE = ['read', 'retarget', 'write', 'validate', 'publish', 'reload'];
const VMD = ['read', 'sample', 'retarget', 'write', 'validate', 'publish', 'reload'];
/** app/electron/src/common/imports.ts MOTION_EXTENSIONS. */
const FORMATS = 'VMD / BVH / GLB / GLTF / VRMA / FBX';

/** `createdAt` as MM-DD HH:mm local time; null when the host has none or it does not parse. */
function when(at: string | null) {
  const d = at == null ? null : new Date(at);
  if (!d || Number.isNaN(d.getTime())) return null;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 动作 → 导入: the import key, the running import's stages, the last result, then the imported motions with 改名 and 删除. */
function MotionImportPane(p: ImportPaneProps & { importing: ImportState }) {
  const { importing, motionImport } = p;
  const [dialog, setDialog] = useState<MotionEdit | null>(null);
  // The stage chain learns it is a VMD once `sample` shows up, and keeps that cell until the import ends.
  const [vmd, setVmd] = useState(false);
  if (importing.stage === 'sample' && !vmd) setVmd(true);
  if (!importing.running && vmd) setVmd(false);
  const editOff = p.offline ? '角色未运行' : p.lock ? '切换中 │ 输入暂停' : p.library?.busy ? '上一个改动还没完成' : null;
  // VMD dances live in the shared MMD library.
  const motions: ImportedMotionEntry[] = Object.values(p.library?.byId ?? {}).filter((m) => m.format !== 'vmd');
  const running = importing.running && importing.kind !== 'outfit';
  const busy = motionImport?.running === true || importing.running;
  const stages = vmd ? VMD : TAKE;
  const now = importing.stage == null ? -1 : stages.indexOf(importing.stage);
  const pct = Math.round(Math.min(1, Math.max(0, importing.fraction)) * 100);
  const note = motionImport?.note;
  const compact = useCompact();

  return (
    <div className={styles.imp} data-import-pane="" data-of="motion">
      {p.onImportPackage && (
        <section className={styles.mgrp} aria-label="角色">
          <TitleBar title="角色" micro="Character package" actions={<WhiteCapsule label="导入角色" icon="upload" disabled={importing.running} onClick={p.onImportPackage} />} />
        </section>
      )}
      {motionImport && (
        <section className={styles.mgrp} aria-label="动作">
          <TitleBar title="动作" micro="Motion import" actions={<span className={styles.fm}>{FORMATS}</span>} />
          <button type="button" className={styles.ikey} aria-busy={busy || undefined} disabled={busy} title="也可以把动作文件拖到桌面上的角色身上" onClick={motionImport.run}>
            <span className={styles.ikIc}>
              <Icon name="upload" size={24} />
            </span>
            <span className={styles.ikTx}>
              <b>{motionImport.running ? '导入中…' : '导入动作…'}</b>
              <span>选动作文件，可再配一首背景音乐</span>
            </span>
            <span className={styles.ikHint}>
              也可以把动作文件拖到桌面上的角色身上
              <br />
              VMD 舞蹈导入后在右侧 MMD 里
            </span>
            <span className={styles.ikMicro}>
              <MicroLabel>Import / Motion</MicroLabel>
            </span>
            <span className={styles.ikDia}>
              <Diamond size={10} />
            </span>
          </button>
          {running && (
            <div className={styles.run} role="status" aria-label="导入进度">
              <div className={styles.runTop}>
                <b>{importing.title ?? '动作'}</b>
                <span className={styles.runK}>导入动作 │ {importStageLabel(importing.stage)}</span>
                <span className={styles.pct}>
                  {pct}
                  <small>%</small>
                </span>
              </div>
              <ol className={styles.chain} style={{ '--n': stages.length } as CSSProperties}>
                {stages.map((s, i) => (
                  <li key={s} data-s={now < 0 ? undefined : i < now ? 'done' : i === now ? 'now' : undefined}>
                    <span className={styles.chNo}>{String(i + 1).padStart(2, '0')}</span>
                    <span className={styles.chT}>{importStageLabel(s)}</span>
                  </li>
                ))}
              </ol>
              <span className={styles.pbar} aria-hidden="true">
                <i style={{ width: `${pct}%` }} />
              </span>
            </div>
          )}
          {note && (
            <div data-motion-import="" role="status">
              {note.ok ? (
                <DarkRow mark="ok" title={note.text} micro="Imported" compact={compact} />
              ) : (
                <DarkRow mark="warn" title="导入没有完成" sub={note.reason ?? note.text} micro={note.code ?? 'Failed'} compact={compact} />
              )}
            </div>
          )}
          {motions.length > 0 && (
            <>
              <TitleBar title="已导入的动作" micro="Library" count={motions.length} />
              <ul className={styles.mlist} aria-label="导入的动作">
                {motions.map((m) => (
                  <li key={m.id} className={styles.irow} role="group" aria-label={m.title} data-imported-motion={m.id}>
                    <span className={styles.irLead}>
                      <span className={styles.fmt}>{motionFormatLabel(m.format)}</span>
                    </span>
                    <span className={styles.irNm}>
                      <b>{m.title}</b>
                      {m.hasBgm && <span className={styles.media}>BGM</span>}
                    </span>
                    <span className={styles.irDu}>
                      {m.durationS.toFixed(1)}
                      <small>s</small>
                    </span>
                    <span className={styles.irWarn} title={m.warnings.join('\n') || undefined}>
                      {m.warnings.length > 0 && (
                        <>
                          <Icon name="warn" size={12} />
                          {m.warnings.length} 条
                        </>
                      )}
                    </span>
                    <span className={styles.irAt}>{when(m.createdAt)}</span>
                    <span className={styles.irActs}>
                      <button type="button" className={styles.mini} disabled={editOff != null} title={editOff ?? undefined} onClick={() => setDialog({ kind: 'rename', id: m.id, title: m.title })}>
                        改名
                      </button>
                      <button type="button" className={styles.mini} data-del="" disabled={editOff != null} title={editOff ?? undefined} onClick={() => setDialog({ kind: 'remove', id: m.id })}>
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {p.library && dialog && <MotionEditDialog edit={dialog} removeNote="删除后角色会重新载入一次" onEdit={setDialog} library={p.library} />}
        </section>
      )}
    </div>
  );
}
