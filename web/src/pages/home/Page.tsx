// 主页：手表菜单（watchpanel_pc）。中间是地图位置上要你批准的事和今日进度，左边四个大键是主要页面，右边两列方键是其余页面和动作，
// 左上是设置、提醒和待处理，右上时钟条和消息横幅，左下角色卡，底部两个黄槽是打开对话和每日简报。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type AgentdConnection } from '../../bridge';
import { get } from '../../bridge/agentd';
import { gameClips } from '../../design/gameClips.generated';
import { formatClock, fromGoal, sortPending, type WireGoal } from '../../domain';
import { useDemo } from '../../shell/demo';
import { look, openQuickInput, stopSpeech, useDesktopOff } from '../../shell/desktopOps';
import { OPEN_PALETTE } from '../../shell/Layout';
import { useGo, type PageId } from '../../shell/nav';
import { usePlugins, type PluginId } from '../../shell/plugins';
import { offReason, routeOff, useVisibleRoutes } from '../../shell/registry';
import { fxCalm, Stage3D, useGameClip, type IconName } from '../../ui';
import { CharCard, CloseKey, NewsBanner, PowerMark, PowerState, TopIcon, WatchKey, type NewsItem } from '../../ui/game';
import { nextReminder, reminderTime, runRows } from '../overview/briefModel';
import { useNow } from '../overview/nav';
import { isExpired } from '../overview/pending';
import { useOverview } from '../overview/useOverview';
import { useOverviewActions } from '../overview/useOverviewActions';
import { useLook } from '../character/useLook';
import { CreateDialog } from '../tasks/CreateDialog';
import { draftFor, type CreateDraft } from '../tasks/CreateForm';
import { useToast } from '../../shell/toast';
import { BottomBar, Counters, LiveCharMeta } from './Cards';
import { Disc, type RunItem } from './Disc';
import { BANNER, CARD, CLOSE, COUNTERS, leftTiles, rightTiles, STAGE, STATUS, TOP_ICONS } from './geometry';
import { Contours, Floor } from './Terrain';
import { Status, type Conn } from './Top';
import { Backdrop, Logo, Rings } from './Rings';
import { Group } from './Tiles';
import { useFit } from './useFit';
import { Sway, useAttended } from './watchMotion';
import styles from './Home.module.css';

/** Page keys with their routes' icons. A key shows while its page is offered (devOnly in 开发者模式); a page whose plug-in is off opens 已关闭. */
const LEFT: readonly string[] = ['character', 'chat', 'memory', 'tasks'];
/** The watch's CharInfo, Activity, Gacha and Purchase keys, top to bottom. */
const LEFT_G = ['charInfo', 'activity', 'gacha', 'purchase'] as const;
/** Developer pages, last in the grid. */
const DEV: readonly string[] = ['diag'];

/** An action key: shown while the page it lands on is offered; off, with its 已关闭 reason, while its plug-in is off. */
interface Act<Id extends string> {
  id: Id;
  icon: IconName;
  title: string;
  hotkey?: string;
  plugin?: PluginId;
  page?: PageId;
}
const ACTS: ReadonlyArray<Act<'dispatch' | 'search' | 'look' | 'quickInput' | 'stopSpeech'>> = [
  { id: 'dispatch', icon: 'plus', title: '派发任务', hotkey: '⌘N', plugin: 'personal_agent' },
  { id: 'search', icon: 'search', title: '搜索', hotkey: '⌘K' },
  { id: 'look', icon: 'look', title: '屏幕识读', plugin: 'screen_reading' },
  { id: 'quickInput', icon: 'bolt', title: '快速输入' },
  { id: 'stopSpeech', icon: 'stop', title: '停止说话' },
];

/** Run ends that do not count as done on the disc's report. */
const FAILED: ReadonlySet<string> = new Set(['failed', 'error', 'interrupted']);

/** Viewing distance for the watch's tilt, in stage px. */
const PERSPECTIVE = 1000;

/** Room kept clear round the stage: the tipped face and the slabs' walls and shadows reach about this far past it. */
const FIT_PAD = 28;

/** A layer `px` toward the viewer: the game's node depth ×−0.5 (keys −80, top icons −114, card −86.4, bar and map −24). */
const z = (px: number): CSSProperties => ({ transform: `translateZ(${px}px)` });

/** The fit's lower bound: at this scale the keys' 12px names, the stage's smallest text, render about 11px on the tipped face. */
const K_MIN = 0.925;

/** `/health`, which no plug-in owns, and the connection it was read at. */
async function readHealth(): Promise<AgentdConnection> {
  const connection = await getBridge().agentd.connection();
  await get('/health');
  return connection;
}

/** What a read and the connection it carries say of 后台, for the status row. */
function connOf(connection: AgentdConnection | undefined, isError: boolean): Conn {
  if (!connection) return isError ? 'failed' : 'loading';
  if (connection !== 'connected') return connection === 'unauthorized' ? 'refused' : 'lost';
  return isError ? 'stale' : 'ok';
}

export function HomePage() {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const plugins = usePlugins();
  const routes = useVisibleRoutes();
  const routeOf = (id: string) => routes.find((r) => r.id === id);
  // As the command bar's page menu: 任务 is listed though it has no nav entry.
  const listed = (id: string) => {
    const r = routeOf(id);
    return r && (r.nav !== false || r.id === 'tasks') ? r : undefined;
  };
  const offered = (a: Act<string>) => !a.page || !!listed(a.page);
  // 待处理, 提醒, the disc's items and the bottom card all land on the today page.
  const today = routeOf('overview');
  const [fit, k] = useFit<HTMLDivElement>(STAGE.w, STAGE.h, FIT_PAD, K_MIN);
  const hud = useRef<HTMLDivElement>(null);
  const watchIn = useGameClip(gameClips.watchIn, hud, { autoplay: !still });
  const [entered, setEntered] = useState(false);
  const attended = useAttended();
  const tilt = useRef<HTMLDivElement>(null);
  const off = useDesktopOff();
  // 待处理, 在做 and the today card are 日报与简报's; without it the clock reads /health.
  const todayOn = plugins.daily_brief;
  const { q, reads, data: snap, brief } = useOverview(demo, state, todayOn);
  const health = useQuery({ queryKey: ['home', 'health'], queryFn: readHealth, enabled: !todayOn && state !== 'loading', retry: false, refetchInterval: 60_000 });
  const now = useNow(snap.now, still);
  const toast = useToast();
  const act = useOverviewActions(snap, now, go, toast, () => void q.refetch());
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const goals = useQuery({
    queryKey: ['home', 'goals'],
    queryFn: async () => (await get<{ goals: WireGoal[] }>('/agent/goals')).goals.map((g) => fromGoal(g, [])),
    enabled: draft != null,
    retry: false,
  });
  const pending = useMemo(
    () => sortPending(snap.pending.filter((p) => !p.resolved && !act.decided[p.id])).filter((p) => !isExpired(p, now, snap.now)),
    [snap, now, act.decided],
  );
  const run = useMemo(() => runRows(snap, brief?.convs ?? []), [snap, brief]);
  const conn = todayOn ? connOf(q.data && snap.connection, q.isError) : connOf(health.data, health.isError);
  // 在做 counts 编码会话's sessions and 个人代理's runs.
  const counts = { pending: q.data ? pending.length : null, ...((plugins.coding_sessions || plugins.personal_agent) && { running: reads.running.data ? run.rows.length : null }) };

  useEffect(() => {
    let alive = true;
    void watchIn.finished.then(() => {
      if (!alive) return;
      // A finished clip still holds each node's opacity, and Chromium flattens the 3D under a held opacity: the keys'
      // raised faces would drop onto their plates.
      watchIn.settle();
      setEntered(true);
    });
    return () => {
      alive = false;
    };
  }, [watchIn]);

  const pages = (keys: readonly string[]) =>
    keys.flatMap((id) => {
      const r = listed(id);
      const closed = r && routeOff(r, plugins);
      return r?.icon ? [{ id, icon: r.icon, title: r.title, hotkey: r.hotkey, off: undefined, mark: closed ? <PowerMark state="off" compact reason={closed} /> : undefined, onClick: () => go({ page: id as PageId }) }] : [];
    });
  const acts = {
    dispatch: () => setDraft(draftFor('role')),
    search: () => window.dispatchEvent(new Event(OPEN_PALETTE)),
    look: () => void look(),
    quickInput: () => void openQuickInput(),
    stopSpeech: () => void stopSpeech(),
  };
  const left = pages(LEFT);
  const right = [
    ...ACTS.filter(offered).map((a) => ({ ...a, off: a.plugin && !plugins[a.plugin] ? offReason(a.plugin) : a.id in off ? off[a.id as keyof typeof off] : undefined, onClick: acts[a.id] })),
    ...pages(DEV),
  ];
  const next = q.data ? nextReminder(snap.reminders, now) : null;
  const t0 = new Date(now).setHours(0, 0, 0, 0);
  const delivered = q.data ? snap.deliveries.filter((d) => !d.redacted && d.produced_at >= t0).sort((a, b) => b.produced_at - a.produced_at)[0] : undefined;
  const news: NewsItem[] = [
    ...(next ? [{ kind: '提醒', title: next.title, at: reminderTime(next.due_at, now), go: () => go({ page: 'overview', focus: 'reminders' }) }] : []),
    ...(delivered ? [{ kind: '交付', title: delivered.title, at: formatClock(delivered.produced_at), go: () => go({ page: 'overview', sel: delivered.task_id }) }] : []),
  ];
  // The face turns up to a degree toward the pointer, like a watch held in the hand.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = tilt.current;
    if (!el || fxCalm()) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.dataset.follow = '';
    el.style.setProperty('--tilt-y', `${((e.clientX - r.left) / r.width) * 2 - 1}deg`);
    el.style.setProperty('--tilt-x', `${(((e.clientY - r.top) / r.height) * 2 - 1) * -0.7}deg`);
  };
  const onLeave = () => {
    const el = tilt.current;
    if (!el) return;
    delete el.dataset.follow;
    el.style.setProperty('--tilt-y', '0deg');
    el.style.setProperty('--tilt-x', '0deg');
  };
  const leftKeys = leftTiles(left.length);
  const rightBoxes = rightTiles(right.length);
  const groups = Array.from({ length: Math.ceil(right.length / 2) }, (_, i) => right.slice(i * 2, i * 2 + 2));
  const character = routeOf('character');
  const worn = useLook().id;
  const roster = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list(), enabled: getBridge().capabilities.avatar, retry: false });
  const outfit = roster.data?.find((c) => c.active)?.appearances.find((a) => a.id === worn)?.name ?? null;
  const settings = routeOf('settings');
  const waiting = (counts.pending ?? 0) > 0;
  const runs = snap.day.runs;
  // Today's runs come from the running read (个人代理's /agent/runs); without that plug-in there are none to wait for.
  const runsRead = !plugins.personal_agent || reads.running.data != null;
  const done = runs.filter((r) => r.ended_at != null && !FAILED.has(r.state)).length;
  const report = todayOn && q.data && runsRead ? { done, total: runs.length, running: counts.running } : null;
  const runItems: RunItem[] | null =
    (plugins.coding_sessions || plugins.personal_agent) && reads.running.data
      ? run.rows.map((r): RunItem =>
          r.k === 'conv'
            ? { id: r.id, kind: '对话', title: r.conv.title, sub: null, go: () => go({ page: 'chat', conv: r.id }) }
            : r.k === 'task'
              ? { id: r.id, kind: '任务', title: r.task.title, sub: r.task.agent ?? null, go: () => go({ page: 'overview', sel: r.id }) }
              : { id: r.id, kind: '编码', title: r.session.title, sub: r.session.agent, go: () => go({ page: 'overview', sel: r.session.task_id ?? r.id }) },
        )
      : null;
  const doing = [snap.role?.app ? `正在看 ${snap.role.app}` : null, snap.role?.doing].filter(Boolean).join(' │ ');

  return (
    <div ref={fit} className={styles.page} data-page="home" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div className={styles.stage} style={{ '--k': k, width: STAGE.w, height: STAGE.h } as CSSProperties}>
        <Stage3D w={STAGE.w} h={STAGE.h} perspective={PERSPECTIVE}>
          <div ref={tilt} className={styles.tilt}>
          <div ref={hud} className={styles.hud} data-hud="" data-g="watch">
            <Floor />
            <Backdrop />
            <div className={styles.map} data-g="map" aria-hidden="true">
              <Contours />
            </div>
            <Rings />
            <Logo />
            <div className={styles.layer} style={z(57)}>
            {settings && <TopIcon box={TOP_ICONS[0]} icon="settings" label={settings.title} named g="topBtn1" onClick={() => go({ page: 'settings' })} />}
            {today && (
              <>
                <TopIcon box={TOP_ICONS[1]} icon="bell" label="提醒" named g="topBtn3" onClick={() => go({ page: 'overview', focus: 'reminders' })} />
                <TopIcon
                  box={TOP_ICONS[2]}
                  icon="warn"
                  label={todayOn ? `待处理 ${counts.pending ?? '—'}` : '待处理 已关闭'}
                  named
                  dot={waiting ? (attended ? 'live' : 'still') : undefined}
                  g="topBtn4"
                  onClick={() => go({ page: 'overview', focus: 'pending' })}
                />
              </>
            )}
            </div>
            <div className={styles.layer} style={z(12)}>
            <Disc
              title="待批准"
              urgent={today && q.data ? pending : []}
              report={report}
              running={runItems}
              act={act}
              go={go}
              off={
                !todayOn && (
                  <PowerState state="off" mode="block" title="每日简报" reason="待批准、在做和今日任务都从每日简报读，它在设置里关着。" action={{ label: '前往设置打开', onClick: () => go({ page: 'settings', group: 'privacy', item: 'plugins.daily_brief' }) }}>
                    {null}
                  </PowerState>
                )
              }
            />
            </div>
            <div className={styles.layer} style={z(40)} role="group" aria-label="主要页面">
              {left.map((t, i) => {
                const k = leftKeys[i]!;
                return <WatchKey key={t.id} box={k.box} pts={k.pts} mid={k.mid} big icon={t.icon} title={t.title} hotkey={t.hotkey} mark={t.mark} g={LEFT_G[i]} onClick={t.onClick} />;
              })}
            </div>
            <div className={styles.layer} style={z(40)} role="group" aria-label="工具">
              {groups.map((pair, gi) => (
                <Group key={pair[0]!.id} g={`group${gi + 1}`}>
                  {pair.map((t, j) => (
                    <WatchKey key={t.id} box={rightBoxes[gi * 2 + j]!} icon={t.icon} title={t.title} hotkey={t.hotkey} off={t.off} onClick={t.onClick} />
                  ))}
                </Group>
              ))}
            </div>
            {today && todayOn && (
              <div className={styles.layer} style={z(40)}>
                <NewsBanner box={BANNER} items={news} still={still} />
              </div>
            )}
            {character && (
              <div className={styles.layer} style={z(43)}>
              <CharCard
                box={CARD}
                name={snap.character.name ?? character.title}
                en={snap.character.en ?? null}
                head={snap.character.head ?? null}
                id={snap.character.id ?? null}
                doing={doing}
                meta={<LiveCharMeta outfit={outfit} />}
                onClick={() => go({ page: 'character' })}
              />
              </div>
            )}
            <div className={styles.layer} style={z(12)}>
            <BottomBar
              left={{ icon: 'send', title: '打开对话', onClick: () => go({ page: 'chat' }) }}
              right={today && { icon: 'grid', title: today.title, onClick: () => go({ page: 'overview' }) }}
            />
            </div>
            <Counters box={COUNTERS} now={now} />
            <CloseKey box={CLOSE} />
            <Status box={STATUS} conn={conn} />
            {entered && !still && <Sway root={hud} on={attended} />}
          </div>
          </div>
        </Stage3D>
      </div>
      <CreateDialog draft={draft} setDraft={setDraft} goals={goals.data ?? []} push={toast} onCreated={() => {}} />
    </div>
  );
}
