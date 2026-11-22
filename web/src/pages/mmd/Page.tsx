import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MmdEntry } from '../../bridge';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { artSrc } from '../../ui';
import { TitleBar, TrainingRoom, WhiteCapsule } from '../../ui/game';
import { useFeedback } from '../character/feedback';
import { PLAY_REFUSED, playRefusedSeverity } from '../character/labels';
import { MotionEditDialog, type MotionEdit } from '../character/MotionEditDialog';
import { DOWN } from '../character/Page';
import { currentOf, useHostCharacter, useMmdSync } from '../character/useHostCharacter';
import { importStageLabel, useImportState } from '../character/useImportState';
import { useLook } from '../character/useLook';
import { useMotionImport } from '../character/useMotionImport';
import { useMotionLibrary } from '../character/useMotionLibrary';
import { Detail } from './Detail';
import { AddKey, filtered, InList, Library, LibraryError, notBaked, stateOf, type MmdFilter } from './Library';
import { Setlist } from './Setlist';
import { MmdStage } from './Stage';
import { Status, type StatusLine } from './Status';
import { useSetlist } from './useSetlist';
import styles from './Page.module.css';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

/** MMD：每个角色共用的舞曲库。舞台在左，舞曲库在右，她的演出列表是舞台下的一条动作条。 */
export function MmdPage() {
  const fb = useFeedback();
  const qc = useQueryClient();
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const canLoop = bridge.capabilities.actionLoop === true;
  const host = useHostCharacter(canAvatar);
  const roster = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list(), enabled: canAvatar });
  // Undefined until the roster is read, when it failed or is empty: nothing here may name or write for a character then.
  const ch = currentOf(roster.data, host.current);
  const current = ch?.id ?? '';
  const sup = useQuery({ queryKey: ['supervisor', 'state'], queryFn: () => getBridge().supervisor.state() });
  const motions = useQuery({ queryKey: ['character', 'motions', current], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar && ch != null });
  const list = useQuery({ queryKey: ['mmd', 'list'], queryFn: () => getBridge().mmd.list(), enabled: canAvatar });
  const sync = useMmdSync(canAvatar);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
    void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
  };
  const mmdImport = useMotionImport(() => getBridge().mmd.import(), refresh);
  const importing = useImportState();
  const library = useMotionLibrary({ onChanged: refresh });
  const look = useLook();
  const [edit, setEdit] = useState<MotionEdit | null>(null);
  const [sel, setSel] = useState<string>();
  const [filter, setFilter] = useState<MmdFilter>('all');
  const [loopPick, setLoop] = useState(false);
  // The desktop loops a dance: 停止 takes the place of 桌面播放.
  const [looping, setLooping] = useState(false);
  // The import result shown last; picking another dance folds it away until the next import.
  const [seen, setSeen] = useState<typeof mmdImport.note>(null);
  // Only a click on a baked dance plays it in the live preview; the page opens on her idle.
  const [preview, setPreview] = useState<{ character: string; id: string; request: number }>();
  const request = useRef(0);
  // A stage preview belongs to the character it was asked for; coming back to her starts on her idle again.
  const [previewOf, setPreviewOf] = useState(current);
  if (previewOf !== current) {
    setPreviewOf(current);
    setPreview(undefined);
  }

  const appearances = ch?.appearances ?? [];
  const lookId = appearances.find((l) => l.id === look.id)?.id ?? appearances[0]?.id;
  const avatarState = sup.data?.avatar?.state;
  const offline = avatarState != null && DOWN.test(avatarState);
  const noCharacter = !canAvatar ? '桌面角色没有接入' : roster.data?.length === 0 ? '还没有角色' : null;
  const blocked =
    noCharacter ?? (roster.isError ? '读取角色目录失败' : !ch ? '正在读取角色' : offline ? '角色未运行' : host.switching ? '角色正在切换' : null);
  const editOff = blocked ?? (library.busy ? '上一个改动还没完成' : null);
  const playOff = blocked ?? (mmdImport.running || importing.running ? '导入中' : null);
  // A failed refetch keeps the old data; the library shows the failure, so nothing here acts on those entries.
  const entries = list.data?.ok && !list.isError ? list.data.entries : [];
  const visible = filtered(entries, current, filter);
  const picked = visible.find((e) => e.id === sel) ?? visible[0];
  const shown = preview?.character === current ? entries.find((e) => e.id === preview.id && notBaked(stateOf(e, current)) == null) : undefined;
  // Her MMD dances: only these can be in her list.
  const mine = ch ? (motions.data ?? []).filter((a) => a.id.startsWith('mmd_')) : [];
  const ids = mine.map((a) => a.id);
  const setlist = useSetlist(current, ids, fb.toast);

  const pick = (e: MmdEntry) => {
    setSel(e.id);
    setSeen(mmdImport.note);
    setPreview(notBaked(stateOf(e, current)) == null ? { character: current, id: e.id, request: ++request.current } : undefined);
  };
  const play = (id: string) => {
    const loop = canLoop && loopPick;
    void (loop ? getBridge().avatar.playAction(id, 1, { loop: true }) : getBridge().avatar.playAction(id, 1)).then(
      () => loop && setLooping(true),
      (e: unknown) => fb.toast(PLAY_REFUSED[codeOf(e) ?? ''] ?? '没有播放：桌面角色未确认播放，请检查角色是否显示、是否连上', { severity: playRefusedSeverity(codeOf(e) ?? '') }),
    );
  };
  const stop = () =>
    void getBridge()
      .avatar.stopAction()
      .then(
        () => setLooping(false),
        (e: unknown) => fb.toast(`没有停止：${codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
      );
  const restart = () => {
    void getBridge().supervisor.restart('avatar');
    fb.toast('正在重启角色…');
  };
  const add = (id: string) => setlist.put([...setlist.items, id]);
  const addable = (id: string) => ids.includes(id) && !setlist.items.includes(id);
  const onKey = (e: MmdEntry, key: string) => {
    if ((key === 'Enter' || key === '+') && addable(e.id) && playOff == null) add(e.id);
    else if (key === 'F2' && editOff == null) setEdit({ kind: 'rename', id: e.id, title: e.title });
    else if (key === 'Delete' && editOff == null) setEdit({ kind: 'remove', id: e.id });
    else return false;
    return true;
  };

  const syncWho = roster.data?.find((c) => c.id === sync.character)?.name ?? sync.character ?? '';
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

  return (
    <div className={styles.page} data-page="mmd">
      {fb.node}
      <PageHeaderSlot sub={ch?.name || undefined} />
      <div className={styles.body} data-band={band || undefined}>
        <TrainingRoom watermark={artSrc(ch?.id, 'charinfo-bg')} />
        <div className={styles.stageAt}>
          <MmdStage
            character={current}
            name={ch?.name}
            offline={offline}
            backoff={sup.data?.avatar?.backoff ?? null}
            onRestart={restart}
            action={shown?.id}
            request={shown ? preview?.request : undefined}
            appearance={lookId}
            loop={loopPick}
          />
        </div>
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
          {roster.isError ? (
            <LibraryError message="读取角色目录失败：角色目录不可用" onRetry={() => void roster.refetch()} />
          ) : noCharacter ? (
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
                    others={(roster.data ?? []).filter((c) => c.id !== current)}
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
    </div>
  );
}
