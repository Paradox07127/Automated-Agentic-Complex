import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type AvatarAction, type CharacterEntry, type MmdEntry, type MmdSyncState } from '../../bridge';
import { TitleBar, WhiteCapsule } from '../../ui/game';
import type { Toast } from '../character/feedback';
import { PLAY_REFUSED, playRefusedSeverity } from '../character/labels';
import { MotionEditDialog, type MotionEdit } from '../character/MotionEditDialog';
import type { Side } from '../character/Side';
import { importStageLabel, useImportState } from '../character/useImportState';
import { useMotionImport } from '../character/useMotionImport';
import { useMotionLibrary } from '../character/useMotionLibrary';
import { Detail } from './Detail';
import { AddKey, filtered, InList, Library, notBaked, stateOf, type MmdFilter } from './Library';
import { Setlist } from './Setlist';
import { Status, type StatusLine } from './Status';
import { useSetlist } from './useSetlist';
import styles from './Section.module.css';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export interface MmdSectionProps {
  /** The section is open: only then the library is read and her list polled. */
  on: boolean;
  roster: CharacterEntry[];
  /** Her roster entry; absent while there is none to name or write for. */
  ch: CharacterEntry | undefined;
  /** Her actions (`avatar.actions`); her `mmd_` ones are what her list may hold. */
  actions: AvatarAction[] | undefined;
  offline: boolean;
  switching: boolean;
  sync: MmdSyncState;
  toast: Toast;
}

/** MMD：每个角色共用的舞曲库，在角色区的右侧面板；她的演出列表是舞台下的一条动作条；选中的舞在角色区的舞台上预览。 */
export function useMmdSection(p: MmdSectionProps): Extract<Side, { of: 'mmd' }> {
  const qc = useQueryClient();
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const canLoop = bridge.capabilities.actionLoop === true;
  const ch = p.ch;
  const current = ch?.id ?? '';
  const list = useQuery({ queryKey: ['mmd', 'list'], queryFn: () => getBridge().mmd.list(), enabled: canAvatar && p.on });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
    void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
  };
  const mmdImport = useMotionImport(() => getBridge().mmd.import(), refresh);
  const importing = useImportState();
  const library = useMotionLibrary({ onChanged: refresh });
  const [edit, setEdit] = useState<MotionEdit | null>(null);
  const [sel, setSel] = useState<string>();
  const [filter, setFilter] = useState<MmdFilter>('all');
  const [loopPick, setLoop] = useState(false);
  // The desktop loops a dance: 停止 takes the place of 桌面播放.
  const [looping, setLooping] = useState(false);
  // The import result shown last; picking another dance folds it away until the next import.
  const [seen, setSeen] = useState<typeof mmdImport.note>(null);
  // Only a click on a baked dance plays it on the stage; the section opens on her idle.
  const [preview, setPreview] = useState<{ character: string; id: string; request: number }>();
  const request = useRef(0);
  // A stage preview belongs to the character it was asked for; coming back to her starts on her idle again.
  const [previewOf, setPreviewOf] = useState(current);
  if (previewOf !== current) {
    setPreviewOf(current);
    setPreview(undefined);
  }
  if (!p.on && preview) setPreview(undefined);

  const noCharacter = !canAvatar ? '桌面角色没有接入' : p.roster.length === 0 ? '还没有角色' : null;
  const blocked = noCharacter ?? (!ch ? '正在读取角色' : p.offline ? '角色未运行' : p.switching ? '角色正在切换' : null);
  const editOff = blocked ?? (library.busy ? '上一个改动还没完成' : null);
  const playOff = blocked ?? (mmdImport.running || importing.running ? '导入中' : null);
  // A failed refetch keeps the old data; the library shows the failure, so nothing here acts on those entries.
  const entries = list.data?.ok && !list.isError ? list.data.entries : [];
  const visible = filtered(entries, current, filter);
  const picked = visible.find((e) => e.id === sel) ?? visible[0];
  const shown = preview?.character === current ? entries.find((e) => e.id === preview.id && notBaked(stateOf(e, current)) == null) : undefined;
  // Her MMD dances: only these can be in her list.
  const mine = ch && p.on ? (p.actions ?? []).filter((a) => a.id.startsWith('mmd_')) : [];
  const ids = mine.map((a) => a.id);
  const setlist = useSetlist(current, ids, p.toast);

  const pick = (e: MmdEntry) => {
    setSel(e.id);
    setSeen(mmdImport.note);
    setPreview(notBaked(stateOf(e, current)) == null ? { character: current, id: e.id, request: ++request.current } : undefined);
  };
  const play = (id: string) => {
    const loop = canLoop && loopPick;
    void (loop ? getBridge().avatar.playAction(id, 1, { loop: true }) : getBridge().avatar.playAction(id, 1)).then(
      () => loop && setLooping(true),
      (e: unknown) => p.toast(PLAY_REFUSED[codeOf(e) ?? ''] ?? '没有播放：桌面角色未确认播放，请检查角色是否显示、是否连上', { severity: playRefusedSeverity(codeOf(e) ?? '') }),
    );
  };
  const stop = () =>
    void getBridge()
      .avatar.stopAction()
      .then(
        () => setLooping(false),
        (e: unknown) => p.toast(`没有停止：${codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
      );
  const add = (id: string) => setlist.put([...setlist.items, id]);
  const addable = (id: string) => ids.includes(id) && !setlist.items.includes(id);
  const onKey = (e: MmdEntry, key: string) => {
    if ((key === 'Enter' || key === '+') && addable(e.id) && playOff == null) add(e.id);
    else if (key === 'F2' && editOff == null) setEdit({ kind: 'rename', id: e.id, title: e.title });
    else if (key === 'Delete' && editOff == null) setEdit({ kind: 'remove', id: e.id });
    else return false;
    return true;
  };

  const sync = p.sync;
  const syncWho = p.roster.find((c) => c.id === sync.character)?.name ?? sync.character ?? '';
  const status: StatusLine | null =
    mmdImport.running || importing.running
      ? { kind: 'import', title: importing.title, stage: importStageLabel(importing.stage), fraction: importing.fraction }
      : sync.running
        ? { kind: 'sync', who: syncWho, stage: importStageLabel(sync.stage), done: sync.done, total: sync.total, fraction: sync.fraction }
        : mmdImport.note && mmdImport.note !== seen
          ? { kind: 'note', ...mmdImport.note }
          : null;
  const band = ch != null && ids.length > 0;
  const cards = setlist.items.map((id) => {
    const e = entries.find((x) => x.id === id);
    const a = mine.find((x) => x.id === id);
    return { id, title: e?.title ?? a?.label ?? id, durationS: e?.durationS ?? a?.durationS ?? null };
  });

  const node = (
    <div className={styles.at}>
      {band && (
        <div className={styles.bandAt} data-theme="dark">
          <Setlist who={ch.name} cards={cards} list={setlist} blocked={playOff} />
        </div>
      )}
      <section className={styles.lib} data-theme="dark" aria-label="MMD 库">
        <TitleBar
          title="舞曲库"
          micro="MMD LIBRARY / SHARED"
          count={entries.length > 0 ? entries.length : undefined}
          countAccent
          actions={<WhiteCapsule label={mmdImport.running ? '导入中…' : '导入 VMD'} icon="upload" disabled={playOff != null} disabledReason={playOff ?? ''} onClick={mmdImport.run} />}
        />
        {status && <Status line={status} />}
        {noCharacter ? (
          <p className={styles.why}>{noCharacter}</p>
        ) : (
          <Library
            data={ch ? list.data : undefined}
            error={list.isError && (codeOf(list.error) ?? null)}
            onRetry={() => void list.refetch()}
            current={current}
            sel={picked?.id}
            onPick={pick}
            filter={filter}
            onFilter={setFilter}
            slot={(e) => (!ids.includes(e.id) ? null : setlist.items.includes(e.id) ? <InList n={setlist.items.indexOf(e.id) + 1} /> : <AddKey off={playOff} onAdd={() => add(e.id)} />)}
            onKey={onKey}
            detail={
              picked && (
                <Detail
                  entry={picked}
                  baked={notBaked(stateOf(picked, current)) == null}
                  others={p.roster.filter((c) => c.id !== current)}
                  canLoop={canLoop}
                  loop={loopPick}
                  onLoop={setLoop}
                  looping={looping}
                  playOff={playOff}
                  editOff={editOff}
                  onPlay={() => play(picked.id)}
                  onStop={stop}
                  onRename={() => setEdit({ kind: 'rename', id: picked.id, title: picked.title })}
                  onRemove={() => setEdit({ kind: 'remove', id: picked.id })}
                />
              )
            }
          />
        )}
      </section>
      {edit && <MotionEditDialog edit={edit} removeNote="每个角色都会删掉这个动作，角色会重新载入一次" onEdit={setEdit} library={library} />}
    </div>
  );
  return { of: 'mmd', node, band, preview: { action: shown?.id, request: shown ? preview?.request : undefined, loop: loopPick } };
}
