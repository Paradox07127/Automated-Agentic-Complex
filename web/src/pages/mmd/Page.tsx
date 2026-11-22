import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MmdEntry } from '../../bridge';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { Btn, ErrBar, Progress, Seg } from '../../ui';
import { TrainingRoom } from '../../ui/game';
import { useFeedback } from '../character/feedback';
import { PLAY_REFUSED, playRefusedSeverity } from '../character/labels';
import { MotionEditDialog, type MotionEdit } from '../character/MotionEditDialog';
import { DOWN } from '../character/Page';
import { Playlist } from '../character/Playlist';
import { Stage } from '../character/Stage';
import { currentOf, useHostCharacter, useMmdSync } from '../character/useHostCharacter';
import { importStageLabel, useImportState } from '../character/useImportState';
import { useLook } from '../character/useLook';
import { useMotionImport } from '../character/useMotionImport';
import { useMotionLibrary } from '../character/useMotionLibrary';
import { groupMotions } from '../character/useMotions';
import { Library, notBaked, stateOf } from './Library';
import styles from './Page.module.css';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const noop = () => {};

/** MMD：每个角色共用的舞曲库。左边是库，中间是当前角色的实时预览，右边是选中这支舞的操作、导入和她的 MMD 列表。 */
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
  const [loopPick, setLoop] = useState(false);
  // The desktop loops a dance: 停止 takes the place of 桌面预览.
  const [looping, setLooping] = useState(false);
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
  const picked = entries.find((e) => e.id === sel) ?? entries[0];
  const shown = preview?.character === current ? entries.find((e) => e.id === preview.id && notBaked(stateOf(e, current)) == null) : undefined;
  const rows = groupMotions((motions.data ?? []).filter((a) => a.id.startsWith('mmd_'))).flatMap((g) => g.rows);

  const pick = (e: MmdEntry) => {
    setSel(e.id);
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
  const why = picked ? notBaked(stateOf(picked, current)) : null;

  return (
    <div className={styles.page} data-page="mmd">
      <TrainingRoom />
      {fb.node}
      <PageHeaderSlot sub={ch?.name || undefined} />
      <div className={styles.body} data-view="mmd" data-theme="light">
        <Stage
          motion={undefined}
          section=""
          name={ch?.name ?? ''}
          en={ch?.en}
          head={ch?.head}
          portrait={ch?.portrait}
          activity={null}
          scale={look.scale}
          offline={offline}
          backoff={sup.data?.avatar?.backoff ?? null}
          onRestart={restart}
          sw={{ phase: 'idle' }}
          currentName={ch?.name ?? ''}
          onRetry={noop}
          onDismiss={noop}
          play={null}
          characterId={current}
          previewAction={shown?.id}
          previewRequest={shown ? preview?.request : undefined}
          previewAppearance={lookId}
          loop={loopPick}
        />
        <section className={styles.lib} data-theme="dark" aria-label="MMD 库">
          {roster.isError ? (
            <ErrBar message="读取角色目录失败：角色目录不可用" onRetry={() => void roster.refetch()} />
          ) : noCharacter ? (
            <span className={styles.why}>{noCharacter}</span>
          ) : (
            <Library data={ch ? list.data : undefined} error={list.isError && (codeOf(list.error) ?? null)} onRetry={() => void list.refetch()} current={current} sel={picked?.id} onPick={pick} />
          )}
        </section>
        <aside className={styles.side} data-theme="dark" aria-label="MMD 操作">
          {picked && (
            <section className={styles.grp} aria-label={picked.title} data-mmd-detail={picked.id}>
              <h3 className={styles.title}>{picked.title}</h3>
              {why != null && (
                <span className={styles.why} data-tone={stateOf(picked, current).state === 'failed' ? 'danger' : undefined}>
                  {why}
                </span>
              )}
              {why == null && (
                <Seg
                  size="sm"
                  // Her live preview loops on any renderer; 桌面预览 only where the avatar can.
                  label={canLoop ? '播放方式' : '舞台播放方式'}
                  value={loopPick ? 'loop' : 'once'}
                  onChange={(v) => setLoop(v === 'loop')}
                  options={[
                    { value: 'once', label: '播放一次' },
                    { value: 'loop', label: '循环' },
                  ]}
                />
              )}
              <div className={styles.ops}>
                {why == null &&
                  (looping ? (
                    <Btn size="sm" variant="secondary" icon="stop" onClick={stop}>
                      停止
                    </Btn>
                  ) : (
                    <Btn size="sm" variant="secondary" icon="play" disabled={playOff != null} disabledReason={playOff ?? ''} onClick={() => play(picked.id)}>
                      桌面预览
                    </Btn>
                  ))}
                <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setEdit({ kind: 'rename', id: picked.id, title: picked.title })}>
                  改名
                </Btn>
                <Btn size="sm" variant="quiet" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={() => setEdit({ kind: 'remove', id: picked.id })}>
                  删除
                </Btn>
              </div>
            </section>
          )}
          <section className={styles.grp} aria-label="导入 MMD">
            <div className={styles.ops}>
              <Btn size="sm" variant="secondary" loading={mmdImport.running} disabled={playOff != null} disabledReason={playOff ?? ''} onClick={mmdImport.run}>
                {mmdImport.running ? '导入中…' : '导入 MMD'}
              </Btn>
              {mmdImport.note && (
                <span className={styles.why} data-motion-import="" data-tone={mmdImport.note.ok ? undefined : 'danger'} role="status">
                  {mmdImport.note.text}
                </span>
              )}
            </div>
            {importing.running && <Progress label={importStageLabel(importing.stage)} value={importing.fraction} />}
            {sync.running && (
              <div role="status" aria-label="MMD 同步">
                <Progress label={`${importStageLabel(sync.stage)}${sync.total > 0 ? ` ${sync.done}/${sync.total}` : ''}`} value={sync.fraction} />
              </div>
            )}
          </section>
          {ch && <Playlist rows={rows} character={ch.id} blocked={playOff} toast={fb.toast} />}
        </aside>
        {edit && <MotionEditDialog edit={edit} removeNote="每个角色都会删掉这个动作，角色会重新载入一次" onEdit={setEdit} library={library} />}
      </div>
    </div>
  );
}
