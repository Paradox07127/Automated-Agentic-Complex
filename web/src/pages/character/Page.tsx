import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type CharacterEntry } from '../../bridge';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as navTo } from '../../shell/nav';
import { artSrc, Btn, ErrBar, Menu, Spinner } from '../../ui';
import { TrainingRoom } from '../../ui/game';
import { useMmdSection } from '../mmd/Section';
import { failure, readRunningTasks, readState, resetState } from './api';
import { CharacterSettings } from './CharacterSettings';
import { demo as slot } from './demoSlot';
import { pageNow, useFeedback, usePageParams } from './feedback';
import { hostReason } from './labels';
import { MotionSettings } from './motions/MotionSettings';
import { isPane, Operator, OperatorSkel } from './Operator';
import { PhotoMode } from './PhotoMode';
import { CHAR_TABS, isCharTab } from './sections';
import { useCharSettings } from './settings';
import { presentTabs } from './SettingRows';
import { SWITCH_STAGES } from './tables';
import { currentOf, useHostCharacter, useMmdSync } from './useHostCharacter';
import { useMotionImport } from './useMotionImport';
import { useMotionLibrary } from './useMotionLibrary';
import { useSwitch, type SwitchState } from './useSwitch';
import styles from './Page.module.css';

type Roster = CharacterEntry[];

const NO_ROSTER: Roster = [];
/** Supervisor child states in which the avatar is not running. */
export const DOWN = /^(stopped|backoff|portInUse|gpuHold|failed)/;
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
/** The `ok` demo opens with two unsaved switches, as the prototype does. */
const OK_SEED = { stretch: false, watch: true };

function initialSwitch(demo: string | null, roster: Roster | undefined): SwitchState {
  const target = roster?.find((c) => c.id === (demo === 'switchfail' ? slot.switchReject?.id : 'voice_a'));
  if (!target) return { phase: 'idle' };
  if (demo === 'switching') return { phase: 'running', target };
  if (demo === 'switchfail') return { phase: 'failed', target, stage: SWITCH_STAGES.indexOf(slot.switchReject!.stage), reason: slot.switchReject!.reason };
  return { phase: 'idle' };
}

/** 角色：训练场上的实机舞台。默认（`?pane=overview`）是总览；`?pane=motion|chain|look|import` 是外观、动作的详情，`?tab=behavior|render|scene` 是「设定」，`?view=photo` 是拍照面板，`?view=mmd` 是 MMD；状态曲线和完整动作表在调参页。 */
export function CharacterPage() {
  const { state, demo } = useDemo();
  const fb = useFeedback();
  const params = usePageParams();
  const tab = params.get('tab');
  const row = params.get('row');
  const pane = params.get('pane');
  const photo = !isCharTab(tab) && params.get('view') === 'photo';
  const mmdView = !isCharTab(tab) && params.get('view') === 'mmd';
  const qc = useQueryClient();
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const host = useHostCharacter(canAvatar);
  const sync = useMmdSync(canAvatar);

  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list(), enabled: canAvatar });
  // Page clock of the last state read: where the curves stop when agentd goes away.
  const [readAt, setReadAt] = useState<number>();
  const cs = useQuery({
    queryKey: ['character', 'state'],
    queryFn: async () => {
      const s = await readState();
      setReadAt(pageNow());
      return s;
    },
  });
  const conn = useQuery({ queryKey: ['agentd', 'connection'], queryFn: () => getBridge().agentd.connection() });
  const sup = useQuery({ queryKey: ['supervisor', 'state'], queryFn: () => getBridge().supervisor.state() });
  // No catalog when the shell has no avatar or does not implement the op.
  const noCatalog = !canAvatar || codeOf(list.error) === 'not_implemented';
  const roster = noCatalog ? NO_ROSTER : list.data;
  const cur = currentOf(roster, host.current)?.id ?? '';
  const name = roster?.find((c) => c.id === cur)?.name ?? '';
  const motions = useQuery({ queryKey: ['character', 'motions', cur], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar && roster != null });
  const library = useMotionLibrary({ onChanged: () => void motions.refetch() });
  // importMotion resolves once the restarted avatar is back, so its list has the new action.
  const motionImport = useMotionImport(() => getBridge().character.importMotion(), () => {
    void motions.refetch();
    library.refetch();
  });
  const sw = useSwitch({
    initial: { phase: 'idle' },
    runningTasks: readRunningTasks,
    ask: fb.ask,
    onDone: (c) => {
      host.confirm(c.id);
      fb.toast(`已切换到 ${c.name}`);
    },
  });
  const seeded = useSwitchDemo(sw, demo, roster);

  const avatarState = demo === 'offline' ? 'stopped' : sup.data?.avatar?.state;
  const offline = avatarState != null && DOWN.test(avatarState);
  const backoff = demo === 'offline' ? null : (sup.data?.avatar?.backoff ?? null);
  const mmd = useMmdSection({ on: mmdView, roster: roster ?? NO_ROSTER, ch: currentOf(roster, host.current), actions: motions.data, offline, switching: host.switching, sync, toast: fb.toast });
  const disconnected = conn.data === 'offline' || (cs.error != null && failure(cs.error).kind === 'offline');
  const stateError = state === 'error' || (cs.isError && !disconnected);
  // A library without characters; its only way on is an import, and there is no character state to report on.
  const empty = !noCatalog && list.data?.length === 0;
  const listError = !noCatalog && list.isError;
  const loading = state === 'loading' || (!noCatalog && list.isPending) || !seeded;
  const none = state === 'empty' || cs.data === null;
  const restart = () => {
    void getBridge().supervisor.restart('avatar');
    fb.toast('正在重启角色…');
  };
  const importPackage = () =>
    void getBridge()
      .character.importPackage()
      .then(
        (r) => {
          if (r.ok) {
            void list.refetch();
            fb.toast('已导入角色');
          } else if (r.reason === 'cancelled') fb.toast('已取消导入');
          else fb.toast(`导入没有完成：${hostReason(r.reason)}`, { severity: 'danger', persistent: true });
        },
        (e: unknown) => fb.toast(`导入没有完成：${codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
      );
  const reset = () => {
    const s = cs.data;
    if (!s) return;
    resetState(s).then(
      (fresh) => {
        qc.setQueryData(['character', 'state'], fresh);
        void qc.invalidateQueries({ queryKey: ['character', 'history'] });
        fb.toast('已重置状态');
      },
      (e: unknown) => {
        const f = failure(e);
        if (f.kind === 'conflict') void cs.refetch();
        fb.toast(f.kind === 'other' ? `重置没有完成：${f.text}` : f.text, { severity: 'danger' });
      },
    );
  };
  // 设定's tab bar has the tabs CharacterSettings draws rows for, and lights the one it falls back to.
  const dev = useDevMode();
  const setN = useCharSettings(isCharTab(tab)).q.data;
  const setTabs = setN ? presentTabs(setN, dev) : CHAR_TABS.map((t) => t.id);
  const motionsError = !canAvatar ? '桌面角色没有接入' : motions.isError ? (codeOf(motions.error) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应') : null;

  let body;
  if (loading) body = <OperatorSkel />;
  else if (listError || !roster) body = <ErrBar message="读取角色目录失败：角色目录不可用" onRetry={() => void list.refetch()} />;
  else if (empty)
    body = (
      <section className={styles.empty} aria-label="还没有角色" data-character-empty="">
        <Btn size="sm" variant="secondary" onClick={importPackage}>
          导入角色
        </Btn>
      </section>
    );
  else
    body = (
      <div className={styles.sw}>
        <Operator
          roster={roster}
          current={cur}
          sw={{ state: sw.state, request: (c) => sw.request(c, cur, name), retry: sw.retry, dismiss: sw.dismiss }}
          offline={offline}
          backoff={backoff}
          onRestart={restart}
          actions={motions.data ?? null}
          motionsError={motionsError}
          onRetryMotions={() => void motions.refetch()}
          {...(canAvatar ? { motionImport, library, onImportPackage: importPackage, chains: <MotionSettings offline={offline} toast={fb.toast} /> } : {})}
          pane={isPane(pane) ? pane : 'overview'}
          charState={none ? null : (cs.data ?? null)}
          {...(demo === 'ok' ? { seed: OK_SEED } : {})}
          playing={demo === 'playing' ? 'nod' : null}
          toast={fb.toast}
          {...(isCharTab(tab)
            ? { side: { of: 'set' as const, tab: setTabs.includes(tab) ? tab : (setTabs[0] ?? tab), tabs: setTabs, node: <CharacterSettings tab={tab} row={row ?? undefined} offline={offline} avatar={canAvatar} onTab={(t) => navTo({ page: 'character', tab: t })} menu={false} toast={fb.toast} /> } }
            : photo
              ? { side: { of: 'photo' as const, node: <PhotoMode avatar={canAvatar} offline={offline} toast={fb.toast} /> } }
              : mmdView
                ? { side: mmd }
                : {})}
        />
      </div>
    );

  // Where the stage stands, for the room's floor and rings (Stage.module.css): 总览 is the room's default span.
  const stage = isCharTab(tab) ? 'set' : photo ? 'photo' : mmdView ? (mmd.band ? 'band' : 'set') : isPane(pane) && pane !== 'overview' ? (pane === 'motion' ? 'deck' : 'wide') : undefined;
  return (
    <div className={styles.page} data-page="character" data-stage-span={stage}>
      <TrainingRoom watermark={artSrc(cur, 'charinfo-bg')} />
      {/* The shell draws the live preview in here: over the room, under every part of the page (usePreview.ts). */}
      <div className={styles.layer} data-preview-layer="" aria-hidden="true" />
      {fb.node}
      <PageHeaderSlot
        sub={name || undefined}
        right={
          <>
            {loading && (
              <span className={styles.loading} role="status">
                <Spinner label="读取中" />
                读取中
              </span>
            )}
            <Menu
              label="更多"
              icon="more"
              align="right"
              items={[
                ...(noCatalog
                  ? []
                  : [
                      {
                        kind: 'item' as const,
                        label: '重新读取角色目录',
                        onSelect: () => void list.refetch().then((r) => {
                          if (r.isError) fb.toast('角色目录没有刷新，请重试', { severity: 'danger' });
                          else fb.toast(`已重新读取 │ ${r.data?.length ?? 0} 个角色`);
                        }),
                      },
                      { kind: 'sep' as const },
                    ]),
                {
                  kind: 'item',
                  label: '重置角色状态…',
                  danger: true,
                  disabled: !cs.data || none,
                  reason: '还没有状态可以重置',
                  onSelect: () =>
                    fb.ask({
                      title: `重置${name || '角色'}的状态？`,
                      note: '精神和心情回到默认值，变化原因和状态历史都会删除。记忆不受影响。',
                      danger: true,
                      confirmLabel: '重置',
                      onConfirm: reset,
                    }),
                },
              ]}
            />
          </>
        }
      />
      {(stateError || disconnected) && !loading && !empty && (
        <div className={styles.bars}>
          {stateError && (
            <ErrBar message={`读取角色状态失败：${cs.error ? failure(cs.error).text : '桌面角色没有回应'}`} {...(readAt != null ? { staleAt: readAt } : {})} onRetry={() => void cs.refetch().then(() => fb.toast('正在重新读取…'))} />
          )}
          {disconnected && (
            <ErrBar
              message="后台已断开 │ 角色状态和读数停在断开前"
              tone="warning"
              {...(readAt != null ? { staleAt: readAt } : {})}
              onRetry={() => void getBridge().supervisor.restart('agentd').then(() => fb.toast('正在重新连接后台服务…'))}
            />
          )}
        </div>
      )}
      <div className={styles.body}>{body}</div>
    </div>
  );
}

/** Puts URL demos (switching, switchfail, switch-confirm) into the switch flow once the roster is known. */
function useSwitchDemo(sw: ReturnType<typeof useSwitch>, demo: string | null, roster: Roster | undefined): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !roster) return;
    setDone(true);
    const init = initialSwitch(demo, roster);
    if (init.phase !== 'idle') sw.set(init);
    const target = roster.find((c) => c.id === 'voice_a');
    const active = roster.find((c) => c.active);
    if (demo === 'switch-confirm' && target) sw.request(target, active?.id ?? '', active?.name);
  }, [roster, demo, done, sw]);
  return done || !roster;
}
