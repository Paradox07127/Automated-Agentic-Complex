import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type CharacterEntry } from '../../bridge';
import { formatClock } from '../../domain';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as navTo } from '../../shell/nav';
import { Btn, ErrBar, Menu, Spinner } from '../../ui';
import { PowerState, TrainingRoom } from '../../ui/game';
import { failure, readRunningTasks, readState } from './api';
import { CharacterSettings } from './CharacterSettings';
import { demo as slot } from './demoSlot';
import { pageNow, useFeedback, usePageParams } from '../../features/character/feedback';
import { hostReason } from '../../features/character/labels';
import { MotionSettings } from './motions/MotionSettings';
import { isPane, Operator, OperatorSkel } from './Operator';
import type { SceneReport } from './operatorScene';
import { CHAR_TABS, isCharTab } from './sections';
import { useCharSettings } from './settings';
import { presentTabs } from './SettingRows';
import { SWITCH_STAGES } from '../../features/character/tables';
import { currentOf, RUNTIME_DOWN, useHostCharacter, useMmdSync } from '../../features/character/useHostCharacter';
import { useMotionImport } from './useMotionImport';
import { useMotionLibrary } from '../../features/character/useMotionLibrary';
import { useSwitch, type SwitchState } from './useSwitch';
import styles from './Page.module.css';

type Roster = CharacterEntry[];

const NO_ROSTER: Roster = [];
/** Supervisor child states in which the avatar is not running. */
export const DOWN = /^(stopped|backoff|portInUse|failed)/;
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

/** 角色：训练场上的实机舞台。默认（`?pane=overview`）是总览；`?pane=motion|chain|look|import` 是外观、动作的详情，`?tab=behavior|render|scene` 是「设定」；她的状态曲线在诊断 › 行为决策。 */
export function CharacterPage() {
  const { state, demo } = useDemo();
  const fb = useFeedback();
  const params = usePageParams();
  const tab = params.get('tab');
  const row = params.get('row');
  const pane = params.get('pane');
  const bridge = getBridge();
  const canAvatar = bridge.capabilities.avatar;
  const host = useHostCharacter(canAvatar);
  // A finished MMD sync changes her actions.
  useMmdSync(canAvatar);

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
  // No catalog when the shell has no avatar or does not implement the op.
  const noCatalog = !canAvatar || codeOf(list.error) === 'not_implemented';
  const roster = noCatalog ? NO_ROSTER : list.data;
  const her = currentOf(roster, host.current);
  const cur = her?.id ?? '';
  const name = roster?.find((c) => c.id === cur)?.name ?? '';
  const motions = useQuery({ queryKey: ['character', 'motions', cur], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar && roster != null });
  const library = useMotionLibrary({ character: cur, onChanged: () => void motions.refetch() });
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

  const avatarState = demo === 'offline' ? 'stopped' : host.avatar?.state;
  const offline = avatarState != null && RUNTIME_DOWN.has(avatarState);
  const backoff = demo === 'offline' ? null : (host.avatar?.backoff ?? null);
  // A switch from the tray or menu bar runs on the host only.
  const switching = host.switching || sw.state.phase === 'running';
  const [scene, setScene] = useState<SceneReport>({ deck: false, compact: false });
  const disconnected = conn.data === 'offline' || (cs.error != null && failure(cs.error).kind === 'offline');
  const stateError = state === 'error' || (cs.isError && !disconnected);
  // A library without characters; its only way on is an import, and there is no character state to report on.
  const empty = !noCatalog && list.data?.length === 0;
  const listError = !noCatalog && list.isError;
  const loading = state === 'loading' || (!noCatalog && list.isPending) || !seeded;
  const none = state === 'empty' || cs.data === null;
  const restart = () =>
    void getBridge()
      .supervisor.restart('avatar')
      .then(
        () => fb.toast('正在重启角色进程…'),
        () => fb.toast('未能重启角色进程：角色渲染进程无响应', { severity: 'danger' }),
      );
  const importPackage = () =>
    void getBridge()
      .character.importPackage()
      .then(
        (r) => {
          if (r.ok) {
            void list.refetch();
            fb.toast('已导入角色');
          } else if (r.reason === 'cancelled') fb.toast('已取消导入');
          else fb.toast(`导入未完成：${hostReason(r.reason)}`, { severity: 'danger', persistent: true });
        },
        (e: unknown) => fb.toast(`导入未完成：${codeOf(e) === 'not_implemented' ? '当前版本暂不支持该功能' : '角色渲染进程无响应'}`, { severity: 'danger' }),
      );
  // 设定's tab bar has the tabs CharacterSettings draws rows for, and lights the one it falls back to.
  const setN = useCharSettings(isCharTab(tab)).q.data;
  const setTabs = setN ? presentTabs(setN) : CHAR_TABS.map((t) => t.id);
  const motionsError = motions.isError ? (codeOf(motions.error) === 'not_implemented' ? '当前版本暂不支持该功能' : '角色渲染进程无响应') : null;

  let body;
  if (loading) body = <OperatorSkel />;
  // A failed reread keeps the roster it had, and the drafts with it.
  else if (!roster) body = <ErrBar message="读取角色列表失败：角色目录不可用" onRetry={() => void list.refetch()} />;
  else if (empty)
    body = (
      <section className={styles.empty} aria-label="当前无可用角色" data-character-empty="">
        <Btn size="sm" variant="secondary" onClick={importPackage}>
          导入角色
        </Btn>
      </section>
    );
  else
    body = (
      <div className={styles.sw}>
        {listError && <ErrBar message="读取角色列表失败：角色目录不可用，以下为上次缓存的数据" onRetry={() => void list.refetch()} />}
        <Operator
          roster={roster}
          current={cur}
          sw={{ state: sw.state, request: (c) => sw.request(c, cur, name), retry: sw.retry, dismiss: sw.dismiss }}
          switching={switching}
          onScene={setScene}
          offline={offline}
          backoff={backoff}
          onRestart={restart}
          actions={canAvatar ? (motions.data ?? null) : []}
          motionsError={motionsError}
          onRetryMotions={() => void motions.refetch()}
          motionImport={motionImport}
          library={library}
          onImportPackage={importPackage}
          chains={<MotionSettings character={cur} switching={switching} offline={offline} toast={fb.toast} />}
          pane={isPane(pane) ? pane : 'overview'}
          {...(row && pane === 'motion' ? { motionRow: row } : {})}
          // agentd's state of the character before a switch is not hers.
          charState={none || cs.data?.character_id !== cur ? null : (cs.data ?? null)}
          {...(demo === 'ok' ? { seed: OK_SEED } : {})}
          playing={demo === 'playing' ? 'nod' : null}
          toast={fb.toast}
          {...(isCharTab(tab)
            ? { side: { of: 'set' as const, tab: setTabs.includes(tab) ? tab : (setTabs[0] ?? tab), tabs: setTabs, node: <CharacterSettings tab={tab} row={row ?? undefined} offline={offline} onRestart={restart} avatar={canAvatar} onTab={(t) => navTo({ page: 'character', tab: t })} menu={false} toast={fb.toast} /> } }
            : {})}
        />
      </div>
    );

  // Where the stage stands, for the room's floor and rings (Stage.module.css): 总览 is the room's default span; the deck is the one the stage stands on.
  const stage = isCharTab(tab) ? 'set' : isPane(pane) && pane !== 'overview' ? (scene.deck ? 'deck' : 'wide') : undefined;
  return (
    <div className={styles.page} data-page="character" data-stage-span={stage} data-compact={scene.compact || undefined}>
      <TrainingRoom watermark={her?.background} />
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
            {!noCatalog && (
              <Menu
                label="更多"
                icon="more"
                align="right"
                items={[
                  {
                    kind: 'item',
                    label: '重新读取角色目录',
                    onSelect: () => void list.refetch().then((r) => {
                      if (r.isError) fb.toast('角色列表刷新失败，请重试', { severity: 'danger' });
                      else fb.toast(`已重新读取 │ ${r.data?.length ?? 0} 个角色`);
                    }),
                  },
                ]}
              />
            )}
          </>
        }
      />
      {(stateError || disconnected) && !loading && !empty && (
        <div className={styles.bars}>
          {stateError && (
            <ErrBar message={`读取角色状态失败：${cs.error ? failure(cs.error).text : '角色渲染进程无响应'}`} {...(readAt != null ? { staleAt: readAt } : {})} onRetry={() => void cs.refetch().then(() => fb.toast('正在重新读取…'))} />
          )}
          {disconnected && (
            <PowerState
              state="unlinked"
              mode="block"
              title="后台服务"
              reason={`后台服务已断开，当前显示断开前的角色状态与参数${readAt != null ? `（记录时间：${formatClock(readAt)}）` : ''}`}
              action={{ label: '重启后台服务', onClick: () => void getBridge().supervisor.restart('agentd').then(() => fb.toast('正在重新连接后台服务…')) }}
            >
              {null}
            </PowerState>
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
