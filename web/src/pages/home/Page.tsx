// 主页：手表菜单（watchpanel_pc）。中间是地图位置上要你批准的事和今日进度，左边四个大键是主要页面，右边两列方键是动作和各页的分页（上下滚动），
// 左上是设置、提醒和待处理，右上时钟条和消息横幅，左下角色卡，底部两个黄槽是打开对话和每日简报。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type UIEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type AgentdConnection } from '../../bridge';
import { get } from '../../bridge/agentd';
import { gameClips } from '../../design/gameClips.generated';
import { formatClock, fromGoal, sortPending, type WireGoal } from '../../domain';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { look, openQuickInput, stopSpeech, useDesktopOff } from '../../shell/desktopOps';
import { OPEN_PALETTE } from '../../shell/Layout';
import { useGo, type PageId } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { offReason, routeOff, useVisibleRoutes } from '../../shell/registry';
import { fxCalm, Stage3D, useGameClip } from '../../ui';
import { CharCard, CloseKey, NewsBanner, PowerMark, PowerState, TopIcon, WatchKey, type NewsItem } from '../../ui/game';
import { nextReminder, reminderTime, runRows } from '../overview/briefModel';
import { useNow } from '../overview/nav';
import { isExpired } from '../overview/pending';
import { useOverview } from '../overview/useOverview';
import { useOverviewActions } from '../overview/useOverviewActions';
import { useLook } from '../character/useLook';
import { pageNow } from '../memory/api';
import { isCandidate } from '../memory/model';
import { factsKey, readMemory } from '../memory/useFacts';
import { CreateDialog } from '../tasks/CreateDialog';
import { draftFor, type CreateDraft } from '../tasks/CreateForm';
import { useToast } from '../../shell/toast';
import { BottomBar, Counters, LiveCharMeta } from './Cards';
import { Disc, type RunItem } from './Disc';
import { BANNER, CARD, CLOSE, COUNTERS, leftTiles, STAGE, STATUS, TOP_ICONS } from './geometry';
import { RightList, type ListKey } from './RightList';
import { RIGHT, type ActId } from './rightKeys';
import { Contours, Floor } from './Terrain';
import { Status, type Conn } from './Top';
import { Backdrop, Logo, Rings } from './Rings';
import { useFit } from './useFit';
import { Sway, useAttended } from './watchMotion';
import styles from './Home.module.css';

/** Page keys with their routes' icons. A key shows while its page is offered (devOnly in 开发者模式); a page whose plug-in is off opens 已关闭. */
const LEFT: readonly string[] = ['character', 'chat', 'memory', 'tasks'];
/** The watch's CharInfo, Activity, Gacha and Purchase keys, top to bottom. */
const LEFT_G = ['charInfo', 'activity', 'gacha', 'purchase'] as const;

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
  // 待处理, 提醒, the disc's items and the bottom card all land on the today page.
  const today = routeOf('overview');
  const [fit, k] = useFit<HTMLDivElement>(STAGE.w, STAGE.h, FIT_PAD, K_MIN);
  const hud = useRef<HTMLDivElement>(null);
  const watchIn = useGameClip(gameClips.watchIn, hud, { autoplay: !still });
  const [entered, setEntered] = useState(false);
  const attended = useAttended();
  const tilt = useRef<HTMLDivElement>(null);
  const off = useDesktopOff();
  const dev = useDevMode();
  // 待处理, 在做 and the today card are 日报与简报's; without it the clock reads /health.
  const todayOn = plugins.daily_brief;
  const { q, reads, data: snap, brief } = useOverview(demo, state, todayOn);
  const health = useQuery({ queryKey: ['home', 'health'], queryFn: readHealth, enabled: !todayOn && state !== 'loading', retry: false, refetchInterval: 60_000 });
  const now = useNow(snap.now, still);
  const toast = useToast();
  const act = useOverviewActions(snap, now, go, toast, () => void q.refetch());
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  // 档案's 待确认 count: the memory page's own read, so either page fills the other's cache.
  const facts = useQuery({ queryKey: factsKey(null), queryFn: () => readMemory(pageNow()), enabled: plugins.light_ai && state !== 'loading', retry: false });
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
  const acts: Record<ActId, () => void> = {
    dispatch: () => setDraft(draftFor('role')),
    search: () => window.dispatchEvent(new Event(OPEN_PALETTE)),
    look: () => void look(),
    quickInput: () => void openQuickInput(),
    stopSpeech: () => void stopSpeech(),
  };
  const left = pages(LEFT);
  const asks = facts.data?.facts.filter(isCandidate).length ?? 0;
  const right: ListKey[] = RIGHT.flatMap((k): ListKey[] => {
    const { to } = k;
    if ((k.dev && !dev) || (to && !listed(to.page)) || (k.id === 'time' && !plugins.screen_awareness)) return [];
    const closed = k.plugin && !plugins[k.plugin] ? offReason(k.plugin) : undefined;
    const base = { id: k.id, icon: k.icon, title: k.title, hotkey: k.hotkey };
    if (k.act) return [{ ...base, off: closed ?? (k.act in off ? off[k.act as keyof typeof off] : undefined), onClick: acts[k.act] }];
    return [{ ...base, mark: closed ? <PowerMark state="off" compact reason={closed} /> : undefined, dot: k.id === 'facts' && asks > 0 ? `${asks} 条待处理` : undefined, onClick: () => to && go(to) }];
  });
  const next = q.data ? nextReminder(snap.reminders, now) : null;
  const t0 = new Date(now).setHours(0, 0, 0, 0);
  const delivered = q.data ? snap.deliveries.filter((d) => !d.redacted && d.produced_at >= t0).sort((a, b) => b.produced_at - a.produced_at)[0] : undefined;
  const news: NewsItem[] = [
    ...(next ? [{ kind: '提醒', title: next.title, at: reminderTime(next.due_at, now), go: () => go({ page: 'overview', focus: 'reminders' }) }] : []),
    ...(delivered ? [{ kind: '交付', title: delivered.title, at: formatClock(delivered.produced_at), go: () => go({ page: 'overview', sel: delivered.task_id }) }] : []),
  ];
  // A key taking focus out of the window would scroll the page itself; the list scrolls it in.
  const keepPut = (e: UIEvent<HTMLDivElement>) => e.currentTarget.scrollTo(0, 0);
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
  const doing = [snap.role?.app ? `当前应用：${snap.role.app}` : null, snap.role?.doing].filter(Boolean).join(' │ ');

  return (
    <div ref={fit} className={styles.page} data-page="home" onPointerMove={onMove} onPointerLeave={onLeave} onScroll={keepPut}>
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
              title="待处理"
              urgent={today && q.data ? pending : []}
              report={report}
              running={runItems}
              act={act}
              go={go}
              off={
                !todayOn && (
                  <PowerState state="off" mode="block" title="每日简报" reason="「待处理」、「进行中」与「今日任务」均依赖「每日简报」，该功能当前已在设置中关闭。" action={{ label: '前往开启', onClick: () => go({ page: 'settings', group: 'privacy', item: 'plugins.daily_brief' }) }}>
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
            <RightList keys={right} scale={k} style={z(40)} />
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
                en={false}
                head={snap.character.head ?? null}
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
