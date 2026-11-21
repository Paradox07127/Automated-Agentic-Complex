// 角色页「导入」: the character package, imported appearances with the last import's warnings, imported motions.
import { useState } from 'react';
import { getBridge, type CharacterAppearance } from '../../bridge';
import { Btn, Dialog, IconBtn, Progress } from '../../ui';
import { motionFormatLabel, outfitImportWarning } from './labels';
import { MotionEditDialog, type MotionEdit } from './MmdView';
import { importStageLabel, useImportState } from './useImportState';
import type { MotionImport } from './useMotionImport';
import type { MotionLibrary } from './useMotionLibrary';
import type { OutfitImport } from './useOutfitImport';
import styles from './ImportPane.module.css';

export interface ImportPaneProps {
  /** `character.importPackage`; absent without an avatar. */
  onImportPackage?: () => void;
  outfit: OutfitImport;
  /** The current character's imported appearances. */
  looks: CharacterAppearance[];
  /** Absent without an avatar. */
  motionImport?: MotionImport;
  library?: MotionLibrary;
  offline: boolean;
  /** A switch is running: input pauses. */
  lock: boolean;
}

export function ImportPane(p: ImportPaneProps) {
  const { outfit } = p;
  const [removeLook, setRemoveLook] = useState<CharacterAppearance | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<MotionEdit | null>(null);
  const importing = useImportState();
  const ro = p.offline || p.lock;
  const outfitBusy = outfit.state === 'busy' || outfit.removing;
  const editOff = p.offline ? '角色未运行' : p.lock ? '切换中 │ 输入暂停' : p.library?.busy ? '上一个改动还没完成' : null;
  // VMD dances live in the shared MMD library.
  const motions = Object.values(p.library?.byId ?? {}).filter((m) => m.format !== 'vmd');
  // Under the outfit button for an outfit, else under the motion button where there is one.
  const barIn = importing.running && (importing.kind === 'outfit' || !p.motionImport ? 'outfit' : 'motion');
  const bar = <Progress label={importStageLabel(importing.stage)} value={importing.fraction} />;

  return (
    <div className={styles.imp} data-import-pane="">
      {p.onImportPackage && (
        <section className={styles.grp} aria-label="角色">
          <h3>角色</h3>
          <Btn size="sm" variant="secondary" disabled={importing.running} onClick={p.onImportPackage}>
            导入角色
          </Btn>
        </section>
      )}
      <section className={styles.grp} aria-label="外观与 mod">
        <h3>外观与 mod</h3>
        {getBridge().capabilities.nativeFilePicker && (
          <Btn size="sm" variant="secondary" loading={outfit.state === 'busy'} disabled={ro || outfitBusy || importing.running} onClick={outfit.run}>
            {outfit.state === 'busy' ? '导入中…' : '导入外观…'}
          </Btn>
        )}
        {barIn === 'outfit' && bar}
        {p.looks.length > 0 && (
          <ul className={styles.list} aria-label="导入的外观">
            {p.looks.map((l) => (
              <li key={l.id} className={styles.item} role="group" aria-label={l.name}>
                <span className={styles.nm}>{l.name}</span>
                <Btn size="sm" variant="quiet" loading={outfit.removing && removingId === l.id} disabled={ro || outfitBusy} onClick={() => setRemoveLook(l)}>
                  {outfit.removing && removingId === l.id ? '删除中…' : '删除…'}
                </Btn>
                {outfit.warned?.id === l.id && (
                  <div className={styles.warn}>
                    <ul aria-label={`「${l.name}」导入提示`}>
                      {outfit.warned.warnings.map((w, i) => (
                        <li key={i}>{outfitImportWarning(w)}</li>
                      ))}
                    </ul>
                    <IconBtn size="sm" icon="close" label="关闭提示" onClick={outfit.dismiss} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {removeLook && (
          <Dialog
            open
            title={`删除「${removeLook.name}」`}
            onClose={() => setRemoveLook(null)}
            footer={
              <>
                <Btn variant="secondary" onClick={() => setRemoveLook(null)}>
                  取消
                </Btn>
                <Btn
                  variant="danger"
                  onClick={() => {
                    setRemoveLook(null);
                    setRemovingId(removeLook.id);
                    outfit.remove(removeLook.id, removeLook.name);
                  }}
                >
                  删除
                </Btn>
              </>
            }
          >
            <p>这个外观和它的模组设置都会删掉，角色包恢复成导入前的样子；角色会重新载入一次</p>
          </Dialog>
        )}
      </section>
      {p.motionImport && (
        <section className={styles.grp} aria-label="动作">
          <h3>动作</h3>
          <Btn size="sm" variant="secondary" loading={p.motionImport.running} disabled={p.motionImport.running || importing.running} onClick={p.motionImport.run}>
            {p.motionImport.running ? '导入中…' : '导入动作'}
          </Btn>
          {barIn === 'motion' && bar}
          {p.motionImport.note && (
            <span className={styles.note} data-motion-import="" data-tone={p.motionImport.note.ok ? undefined : 'danger'} role="status">
              {p.motionImport.note.text}
            </span>
          )}
          {motions.length > 0 && (
            <ul className={styles.list} aria-label="导入的动作">
              {motions.map((m) => (
                <li key={m.id} className={styles.item} role="group" aria-label={m.title} data-imported-motion={m.id}>
                  <span className={styles.nm}>{m.title}</span>
                  <span className={styles.fmt}>{motionFormatLabel(m.format)}</span>
                  <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setDialog({ kind: 'rename', id: m.id, title: m.title })}>
                    改名
                  </Btn>
                  <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setDialog({ kind: 'remove', id: m.id })}>
                    删除
                  </Btn>
                </li>
              ))}
            </ul>
          )}
          {p.library && dialog && <MotionEditDialog edit={dialog} removeNote="删除后角色会重新载入一次" onEdit={setDialog} library={p.library} />}
        </section>
      )}
    </div>
  );
}
