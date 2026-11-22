import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MmdEntry, type MmdSyncState } from '../../bridge';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { Btn, Progress, Seg } from '../../ui';
import { useFeedback } from '../character/feedback';
import { PLAY_REFUSED, playRefusedSeverity } from '../character/labels';
import { MotionEditDialog, type MotionEdit } from '../character/MotionEditDialog';
import { DOWN } from '../character/Page';
import { Playlist } from '../character/Playlist';
import { Stage } from '../character/Stage';
import { TrainingRoom } from '../character/TrainingRoom';
import { importStageLabel, useImportState } from '../character/useImportState';
import { useLook } from '../character/useLook';
import { useMotionImport } from '../character/useMotionImport';
import { useMotionLibrary } from '../character/useMotionLibrary';
import { groupMotions } from '../character/useMotions';
import { Library, notBaked, stateOf } from './Library';
import styles from './Page.module.css';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const SYNC_IDLE: MmdSyncState = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };
const noop = () => {};

/** Native bakes the MMD library into her after a switch; when that ends her actions and the library's states may have changed. */
function useMmdSync(canAvatar: boolean): MmdSyncState {
  const qc = useQueryClient();
  const [sync, setSync] = useState<MmdSyncState>(SYNC_IDLE);
  useEffect(() => {
    if (!canAvatar) return;
    let running = false;
    let pushed = false;
    const apply = (s: MmdSyncState) => {
      if (running && !s.running) {
        void qc.invalidateQueries({ queryKey: ['character', 'motions'] });
        void qc.invalidateQueries({ queryKey: ['mmd', 'list'] });
      }
      running = s.running;
      setSync(s);
    };
    getBridge()
      .mmd.syncState()
      .then((s) => !pushed && apply(s), () => {});
    return getBridge().mmd.onSync((s) => {
      pushed = true;
      apply(s);
    });
  }, [canAvatar, qc]);
  return sync;
}

/** MMD：每个角色共用的舞曲库。左边是库，中间是当前角色的实时预览，右边是选中这支舞的操作、导入和她的 MMD 列表。 */
export function MmdPage() {
  const fb = useFeedback();
  const qc = useQueryClient();
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const canLoop = bridge.capabilities.actionLoop === true;
  const roster = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list(), enabled: canAvatar });
  const sup = useQuery({ queryKey: ['supervisor', 'state'], queryFn: () => getBridge().supervisor.state() });
  const motions = useQuery({ queryKey: ['character', 'motions'], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar });
  const list = useQuery({ queryKey: ['mmd', 'list'], queryFn: () => getBridge().mmd.list() });
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
  // Only a click on a baked dance plays it in the live preview; the page opens on her idle.
  const [preview, setPreview] = useState<{ character: string; id: string; request: number }>();
  const request = useRef(0);

  const ch = roster.data?.find((c) => c.active) ?? roster.data?.[0];
  const current = ch?.id ?? '';
  const appearances = ch?.appearances ?? [];
  const lookId = appearances.find((l) => l.id === look.id)?.id ?? appearances[0]?.id;
  const avatarState = sup.data?.avatar?.state;
  const offline = avatarState != null && DOWN.test(avatarState);
  const blocked = offline ? '角色未运行' : null;
  const editOff = blocked ?? (library.busy ? '上一个改动还没完成' : null);
  const playOff = blocked ?? (mmdImport.running || importing.running ? '导入中' : null);
  const entries = list.data?.ok ? list.data.entries : [];
  const picked = entries.find((e) => e.id === sel) ?? entries[0];
  const shown = preview?.character === current ? entries.find((e) => e.id === preview.id && notBaked(stateOf(e, current)) == null) : undefined;
  const rows = groupMotions((motions.data ?? []).filter((a) => a.id.startsWith('mmd_'))).flatMap((g) => g.rows);

  const pick = (e: MmdEntry) => {
    setSel(e.id);
    setPreview(notBaked(stateOf(e, current)) == null ? { character: current, id: e.id, request: ++request.current } : undefined);
  };
  const play = (id: string) =>
    void getBridge()
      .avatar.playAction(id, 1)
      .catch((e: unknown) => fb.toast(PLAY_REFUSED[codeOf(e) ?? ''] ?? '没有播放：桌面角色未确认播放，请检查角色是否显示、是否连上', { severity: playRefusedSeverity(codeOf(e) ?? '') }));
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
          loop={canLoop && loopPick}
        />
        <section className={styles.lib} data-theme="dark" aria-label="MMD 库">
          <Library data={list.data} error={list.isError && (codeOf(list.error) ?? null)} onRetry={() => void list.refetch()} current={current} sel={picked?.id} onPick={pick} />
        </section>
        <aside className={styles.side} data-theme="dark" aria-label="MMD 操作">
          {picked && (
            <section className={styles.grp} aria-label={picked.title} data-mmd-detail={picked.id}>
              <h3 className={styles.title}>{picked.title}</h3>
              {why != null && <span className={styles.why}>{why}</span>}
              {why == null && canLoop && (
                <Seg
                  size="sm"
                  label="播放方式"
                  value={loopPick ? 'loop' : 'once'}
                  onChange={(v) => setLoop(v === 'loop')}
                  options={[
                    { value: 'once', label: '播放一次' },
                    { value: 'loop', label: '循环' },
                  ]}
                />
              )}
              <div className={styles.ops}>
                {why == null && (
                  <Btn size="sm" variant="secondary" icon="play" disabled={playOff != null} disabledReason={playOff ?? ''} onClick={() => play(picked.id)}>
                    桌面预览
                  </Btn>
                )}
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
              <Btn size="sm" variant="secondary" loading={mmdImport.running} disabled={mmdImport.running || importing.running} onClick={mmdImport.run}>
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
          <Playlist rows={rows} character={current} blocked={playOff} toast={fb.toast} />
        </aside>
        {edit && <MotionEditDialog edit={edit} removeNote="每个角色都会删掉这个动作，角色会重新载入一次" onEdit={setEdit} library={library} />}
      </div>
    </div>
  );
}
