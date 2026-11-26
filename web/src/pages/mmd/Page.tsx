import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type CharacterEntry, type MmdEntry, type PreviewControl } from '../../bridge';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { toast } from '../../shell/toast';
import { ErrBar, Menu } from '../../ui';
import { LoadBar, MicroLabel, TitleBar, TrainingRoom, WhiteCapsule } from '../../ui/game';
import { usePageParams } from '../../features/character/feedback';
import { PLAY_REFUSED, playRefusedSeverity } from '../../features/character/labels';
import { MotionEditDialog, type MotionEdit } from '../../features/character/MotionEditDialog';
import { useActionTransport } from '../../features/character/Transport';
import { currentOf, RUNTIME_DOWN, useHostCharacter, useMmdSync } from '../../features/character/useHostCharacter';
import { importStageLabel, useImportState } from '../../features/character/useImportState';
import { useMotionLibrary } from '../../features/character/useMotionLibrary';
import { useLivePreview } from '../../features/character/usePreview';
import { ImportDialog } from './ImportDialog';
import { Inspector } from './Inspector';
import { AddKey, filtered, InList, Library, notBaked, stateOf, type MmdFilter } from './Library';
import { MediaDialog } from './MediaDialog';
import { Setlist } from './Setlist';
import { Status, type StatusLine } from './Status';
import { Timeline } from './Timeline';
import { useMmdImport } from './useMmdImport';
import { useSetlist } from './useSetlist';
import styles from './Page.module.css';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const NO_ROSTER: CharacterEntry[] = [];

/** MMD：每个角色共用的舞曲库。左边舞台（页内预览）、时间线和她的演出列表，右边曲库和选中这支舞的检查器。 */
export function MmdPage() {
  const qc = useQueryClient();
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const canLoop = bridge.capabilities.actionLoop === true;
  const params = usePageParams();
  const host = useHostCharacter(canAvatar);
  const sync = useMmdSync(canAvatar);
  const rosterQ = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list(), enabled: canAvatar });
  const noCatalog = !canAvatar || codeOf(rosterQ.error) === 'not_implemented';
  const roster = noCatalog ? NO_ROSTER : rosterQ.data;
  const rosterError = !noCatalog && rosterQ.isError;
  const ch = currentOf(roster, host.current);
  const current = ch?.id ?? '';
  const motions = useQuery({ queryKey: ['character', 'motions', current], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar && roster != null });
  const offline = host.avatar?.state != null && RUNTIME_DOWN.has(host.avatar.state);
  const switching = host.switching;
  const list = useQuery({ queryKey: ['mmd', 'list'], queryFn: () => getBridge().mmd.list(), enabled: canAvatar });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
    // 换音源 keeps the id, so the inspector's music and loudness lane come only from a new read.
    void qc.invalidateQueries({ queryKey: ['mmd', 'detail'] });
    void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
  };
  const mmdImport = useMmdImport(refresh);
  const importing = useImportState();
  const library = useMotionLibrary({ character: current, onChanged: refresh });
  const [edit, setEdit] = useState<MotionEdit | null>(null);
  const [media, setMedia] = useState<MmdEntry | null>(null);
  // An open 改名, 删除 or 换音源 belongs to the character it was opened on.
  const [editOf, setEditOf] = useState(current);
  if (editOf !== current) {
    setEditOf(current);
    setEdit(null);
    setMedia(null);
  }
  // A link's dance (`?sel=`) is selected when the page opens and when a new link lands.
  const linked = params.get('sel') ?? undefined;
  const [sel, setSel] = useState(linked);
  const [landed, setLanded] = useState(linked);
  if (linked !== landed) {
    setLanded(linked);
    if (linked) setSel(linked);
  }
  const [filter, setFilter] = useState<MmdFilter>('all');
  const [query, setQuery] = useState('');
  const [loopPick, setLoop] = useState(false);
  // The dance the desktop loops for her: 停止桌面播放 takes the place of 桌面播放. A switch or her stopping ends the loop.
  const [looping, setLooping] = useState<{ character: string; id: string } | null>(null);
  if (looping && (looping.character !== current || offline)) setLooping(null);
  // The import result shown last; picking another dance folds it away until the next import.
  const [seen, setSeen] = useState<typeof mmdImport.note>(null);
  // Each click on a row plays its dance on the stage from the start.
  const [request, setRequest] = useState(0);

  const noCharacter = !canAvatar ? '未接入角色渲染进程' : roster?.length === 0 ? '当前无可用角色' : null;
  const blocked = noCharacter ?? (!ch ? '正在加载角色' : offline ? '角色进程未运行' : switching ? '角色切换中' : null);
  const editOff = blocked ?? (library.busy ? '上一项修改尚未完成' : null);
  const playOff = blocked ?? (mmdImport.running || importing.running ? '导入中' : null);
  // A failed refetch keeps the old data; the library shows the failure, so nothing here acts on those entries.
  const entries = ch && list.data?.ok && !list.isError ? list.data.entries : [];
  const visible = filtered(entries, current, filter, query);
  const picked = visible.find((e) => e.id === sel) ?? visible[0];
  const baked = picked != null && notBaked(stateOf(picked, current)) == null;
  // Her MMD dances: only these can be in her list.
  const mine = ch ? (motions.data ?? []).filter((a) => a.id.startsWith('mmd_')) : [];
  const ids = mine.map((a) => a.id);
  const setlist = useSetlist(current, ids, toast);
  const transport = useActionTransport(toast);
  const desk = picked != null && transport.progress?.id === picked.id ? transport.progress : null;
  const controlStage = (c: PreviewControl) => void getBridge().avatar.preview.control(c).catch(() => {});
  const onDesk = desk != null || (looping?.character === current && looping.id === picked?.id);
  // Read again once some character has it baked: before that it is `not_baked`. The face mapping is the current character's.
  const anyBaked = picked?.characters.some((c) => c.state === 'baked') ?? false;
  const detailQ = useQuery({
    queryKey: ['mmd', 'detail', picked?.id ?? '', current, anyBaked],
    queryFn: () => getBridge().mmd.detail(picked!.id),
    enabled: canAvatar && picked != null,
    // Each read runs motion_tool over the whole music file; refresh() reads it again after a change.
    staleTime: Infinity,
  });
  const detail = detailQ.data?.ok && detailQ.data.detail.id === picked?.id ? detailQ.data.detail : null;

  const pick = (e: MmdEntry) => {
    setSel(e.id);
    setSeen(mmdImport.note);
    setRequest((r) => r + 1);
  };
  const play = (id: string) => {
    const loop = canLoop && loopPick;
    const of = current;
    void (loop ? getBridge().avatar.playAction(id, 1, { loop: true }) : getBridge().avatar.playAction(id, 1)).then(
      () => setLooping(loop ? { character: of, id } : null),
      (e: unknown) => toast(PLAY_REFUSED[codeOf(e) ?? ''] ?? '播放失败：角色渲染进程未确认播放，请检查角色是否已显示且连接正常', { severity: playRefusedSeverity(codeOf(e) ?? '') }),
    );
  };
  const stop = () =>
    void getBridge()
      .avatar.stopAction()
      .then(
        () => setLooping(null),
        (e: unknown) => toast(`停止失败：${codeOf(e) === 'not_implemented' ? '当前版本暂不支持' : '角色渲染进程无响应'}`, { severity: 'danger' }),
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

  const syncWho = roster?.find((c) => c.id === sync.character)?.name ?? sync.character ?? '';
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

  const bar = rosterError && (
    <div className={styles.bars}>
      <ErrBar message={roster ? '读取角色列表失败：角色目录不可用，以下为上次缓存的数据' : '读取角色列表失败：角色目录不可用'} onRetry={() => void rosterQ.refetch()} />
    </div>
  );

  return (
    <div className={styles.page} data-page="mmd">
      <TrainingRoom />
      <PageHeaderSlot sub={ch?.name || undefined} />
      {bar}
      {(roster || !rosterError) && (
        <div className={styles.body}>
          <div className={styles.left}>
            <Stage
              character={current}
              action={baked && !desk ? picked.id : undefined}
              request={request}
              loop={loopPick}
              blocked={offline || switching}
              why={ch ? (offline ? '角色进程未运行' : switching ? '角色切换中' : null) : null}
              desk={desk != null}
            />
            {picked && (
              <div className={styles.tlAt} data-theme="dark">
                <Timeline
                  entry={picked}
                  detail={detail}
                  desk={desk}
                  onControl={transport.control}
                  previewing={canAvatar && baked && !desk}
                  onPreview={controlStage}
                  baked={baked}
                  canLoop={canLoop}
                  loop={loopPick}
                  onLoop={setLoop}
                  onDesk={onDesk}
                  playOff={playOff}
                  onPlay={() => play(picked.id)}
                  onStop={stop}
                />
              </div>
            )}
            {band && (
              <div className={styles.bandAt} data-theme="dark">
                <Setlist who={ch.name} cards={cards} list={setlist} blocked={playOff} />
              </div>
            )}
          </div>
          <div className={styles.side}>
            <section className={styles.lib} data-theme="dark" aria-label="MMD 舞蹈库">
              <TitleBar
                title="MMD 舞蹈库"
                micro="MMD LIBRARY / SHARED"
                count={entries.length > 0 ? entries.length : undefined}
                countAccent
                actions={
                  bridge.capabilities.filesOrFolderPicker || playOff != null ? (
                    <WhiteCapsule
                      label={mmdImport.running ? '导入中…' : '导入 MMD'}
                      icon="upload"
                      disabled={playOff != null}
                      disabledReason={playOff ?? ''}
                      onClick={() => mmdImport.scan(false)}
                    />
                  ) : (
                    <Menu
                      label="导入 MMD"
                      align="right"
                      items={[
                        { kind: 'item', label: '选择文件', icon: 'file', onSelect: () => mmdImport.scan(false) },
                        { kind: 'item', label: '选择文件夹', icon: 'folder', onSelect: () => mmdImport.scan(true) },
                      ]}
                    />
                  )
                }
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
                  query={query}
                  onQuery={setQuery}
                  slot={(e) => (!ids.includes(e.id) ? null : setlist.items.includes(e.id) ? <InList n={setlist.items.indexOf(e.id) + 1} /> : <AddKey off={playOff} onAdd={() => add(e.id)} />)}
                  onKey={onKey}
                />
              )}
            </section>
            {picked && (
              <Inspector
                entry={picked}
                detail={detail}
                roster={roster ?? NO_ROSTER}
                editOff={editOff}
                onMedia={() => setMedia(picked)}
                onRename={() => setEdit({ kind: 'rename', id: picked.id, title: picked.title })}
                onRemove={() => setEdit({ kind: 'remove', id: picked.id })}
              />
            )}
          </div>
        </div>
      )}
      {edit && <MotionEditDialog edit={edit} removeNote="将从所有角色中删除该舞蹈，完成后角色将重新加载" onEdit={setEdit} library={library} />}
      {mmdImport.pending && <ImportDialog token={mmdImport.pending.token} scan={mmdImport.pending.scan} onImport={mmdImport.confirm} onCancel={mmdImport.cancel} onPickAudio={mmdImport.pickAudio} />}
      {media && (
        <MediaDialog
          entry={media}
          onCancel={() => setMedia(null)}
          onSave={(m) => {
            setMedia(null);
            mmdImport.setMedia(media.id, m);
          }}
        />
      )}
    </div>
  );
}

interface StageProps {
  character: string;
  /** The dance to preview; absent plays her idle. */
  action: string | undefined;
  request: number;
  loop: boolean;
  /** She is not running or a switch runs: no preview. */
  blocked: boolean;
  why: string | null;
  /** The desktop plays the selected dance: the preview stops. */
  desk: boolean;
}

/** 舞台：外壳把页内预览按这支舞的镜头和音乐画在这个矩形里，停在第 0 帧等时间线的播放键；里面不放可点的东西。 */
function Stage(p: StageProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const preview = useLivePreview(p.character ? el : null, { character: p.character, action: p.action, request: p.request, loop: p.loop, stage: true, blocked: p.blocked || p.desk });
  const failed = !p.why && preview.phase === 'failed' ? preview.message : null;
  return (
    <div ref={setEl} className={styles.stage} data-preview-stage="" data-live={preview.phase === 'live' || undefined}>
      <span className={styles.ticks} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      {preview.progress != null && (
        <div className={styles.load}>
          <LoadBar fraction={preview.progress} />
        </div>
      )}
      {p.desk && !p.blocked && (
        <div className={styles.desk} role="status">
          <MicroLabel>ON DESKTOP</MicroLabel>
          <b>正在桌面端播放</b>
        </div>
      )}
      {(p.why ?? failed) && (
        <span className={styles.tag} role="status">
          {p.why ?? failed}
          {failed && (
            <button type="button" className={styles.retry} onClick={preview.retry}>
              重试预览
            </button>
          )}
        </span>
      )}
    </div>
  );
}
