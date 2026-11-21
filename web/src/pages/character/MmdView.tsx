// 角色页「MMD」: the MMD library every character shares, her bake state of each dance, and her MMD 列表.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type AvatarAction, type MmdSyncState } from '../../bridge';
import { Btn, Dialog, ErrBar, Progress, Skel } from '../../ui';
import type { Toast } from './feedback';
import { motionImportReason, PLAY_REFUSED, playRefusedSeverity } from './labels';
import { Playlist } from './Playlist';
import { importStageLabel, useImportState } from './useImportState';
import { useMotionImport } from './useMotionImport';
import { useMotionLibrary, type MotionLibrary } from './useMotionLibrary';
import { groupMotions } from './useMotions';
import imp from './ImportPane.module.css';
import photo from './PhotoMode.module.css';
import modal from '../../ui/Modal.module.css';

export interface MmdViewProps {
  current: string;
  /** `avatar.actions()`; its `mmd_` actions fill the MMD 列表. */
  actions: AvatarAction[] | null;
  sync: MmdSyncState;
  /** Why nothing can change or play now; null when it can. */
  blocked: string | null;
  toast: Toast;
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

/** MMD：导入、同步进度和库里每支舞在她身上的状态，然后是她的 MMD 列表。 */
export function MmdView(p: MmdViewProps) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['mmd', 'list'], queryFn: () => getBridge().mmd.list() });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
    void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
  };
  const mmdImport = useMotionImport(() => getBridge().mmd.import(), refresh);
  const importing = useImportState();
  const library = useMotionLibrary({ onChanged: refresh });
  const [edit, setEdit] = useState<MotionEdit | null>(null);
  const editOff = p.blocked ?? (library.busy ? '上一个改动还没完成' : null);
  const rows = groupMotions((p.actions ?? []).filter((a) => a.id.startsWith('mmd_'))).flatMap((g) => g.rows);
  const play = (id: string) =>
    void getBridge()
      .avatar.playAction(id, 1)
      .catch((e: unknown) => p.toast(PLAY_REFUSED[codeOf(e) ?? ''] ?? '没有播放：桌面角色未确认播放，请检查角色是否显示、是否连上', { severity: playRefusedSeverity(codeOf(e) ?? '') }));
  const playOff = p.blocked ?? (mmdImport.running || importing.running ? '导入中' : null);

  const data = list.data;
  let entries;
  if (list.isError || data?.ok === false)
    entries = (
      <ErrBar
        message={`读取 MMD 库失败：${data?.ok === false ? motionImportReason(data.reason, data.detail) : codeOf(list.error) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`}
        onRetry={() => void list.refetch()}
      />
    );
  else if (!data) entries = <Skel rows={4} />;
  else
    entries = data.entries.length > 0 && (
      <ul className={imp.list} aria-label="MMD 舞蹈">
        {data.entries.map((e) => {
          const mine = e.characters.find((c) => c.id === p.current);
          const state = mine?.state ?? 'pending';
          return (
            <li key={e.id} className={imp.item} role="group" aria-label={e.title} data-mmd={e.id} data-state={state}>
              <span className={imp.nm}>{e.title}</span>
              <span className={imp.note}>{`${e.durationS.toFixed(1)} s`}</span>
              {e.hasBgm && <span className={imp.fmt}>BGM</span>}
              {e.hasCamera && <span className={imp.fmt}>相机</span>}
              {state === 'baked' ? (
                <Btn size="sm" variant="secondary" icon="play" disabled={playOff != null} disabledReason={playOff ?? ''} onClick={() => play(e.id)}>
                  播放
                </Btn>
              ) : (
                <span className={imp.note} data-tone={state === 'failed' ? 'danger' : undefined}>
                  {state === 'failed' ? motionImportReason(mine?.reason ?? '', undefined) : '待同步'}
                </span>
              )}
              <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setEdit({ kind: 'rename', id: e.id, title: e.title })}>
                改名
              </Btn>
              <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setEdit({ kind: 'remove', id: e.id })}>
                删除
              </Btn>
            </li>
          );
        })}
      </ul>
    );

  return (
    <div className={photo.photo} data-view="mmd">
      <section className={imp.grp} aria-label="MMD 库">
        <div className={photo.ctl}>
          <Btn size="sm" variant="secondary" loading={mmdImport.running} disabled={mmdImport.running || importing.running} onClick={mmdImport.run}>
            {mmdImport.running ? '导入中…' : '导入 MMD'}
          </Btn>
          {mmdImport.note && (
            <span className={imp.note} data-motion-import="" data-tone={mmdImport.note.ok ? undefined : 'danger'} role="status">
              {mmdImport.note.text}
            </span>
          )}
        </div>
        {importing.running && <Progress label={importStageLabel(importing.stage)} value={importing.fraction} />}
        {p.sync.running && (
          <div role="status" aria-label="MMD 同步">
            <Progress label={`${importStageLabel(p.sync.stage)}${p.sync.total > 0 ? ` ${p.sync.done}/${p.sync.total}` : ''}`} value={p.sync.fraction} />
          </div>
        )}
        {entries}
        {edit && <MotionEditDialog edit={edit} removeNote="每个角色都会删掉这个动作，角色会重新载入一次" onEdit={setEdit} library={library} />}
      </section>
      <Playlist rows={rows} character={p.current} blocked={playOff} toast={p.toast} />
    </div>
  );
}

/** motion_tool's title rule: 1–64 characters once trimmed. */
const titleOk = (t: string) => {
  const n = [...t.trim()].length;
  return n >= 1 && n <= 64;
};

export type MotionEdit = { kind: 'rename'; id: string; title: string } | { kind: 'remove'; id: string };

/** 改名 or 删除动作 of an imported motion; `removeNote` says what the delete takes away. */
export function MotionEditDialog({ edit, removeNote, onEdit, library }: { edit: MotionEdit; removeNote: string; onEdit: (e: MotionEdit | null) => void; library: MotionLibrary }) {
  const close = () => onEdit(null);
  const saveTitle = (title: string) => {
    if (!titleOk(title)) return;
    close();
    library.rename(edit.id, title.trim());
  };

  if (edit.kind === 'rename')
    return (
      <Dialog
        open
        title="改名"
        onClose={close}
        footer={
          <>
            <Btn variant="secondary" onClick={close}>
              取消
            </Btn>
            <Btn variant="primary" disabled={!titleOk(edit.title)} disabledReason="名字要 1–64 个字" onClick={() => saveTitle(edit.title)}>
              保存
            </Btn>
          </>
        }
      >
        <label className={modal.field}>
          动作名
          <input
            className={modal.input}
            value={edit.title}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onEdit({ ...edit, title: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle(edit.title);
            }}
          />
        </label>
      </Dialog>
    );
  return (
    <Dialog
      open
      title="删除动作"
      onClose={close}
      footer={
        <>
          <Btn variant="secondary" onClick={close}>
            取消
          </Btn>
          <Btn
            variant="danger"
            onClick={() => {
              close();
              library.remove(edit.id);
            }}
          >
            删除
          </Btn>
        </>
      }
    >
      <p>{removeNote}</p>
    </Dialog>
  );
}
