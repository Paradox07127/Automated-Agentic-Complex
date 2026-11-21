// 主页：手表菜单（watchpanel_pc）。中间是地图位置上的今天读数，左边四个大键是主要页面，右边斜排的方键是工具页和两个动作，
// 左上是待处理和提醒，右上时钟，底部条是角色卡和打开对话。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { sortPending } from '../../domain';
import { useDemo } from '../../shell/demo';
import { look, openQuickInput, stopSpeech, useDesktopOff } from '../../shell/desktopOps';
import { OPEN_PALETTE } from '../../shell/Layout';
import { useGo, type PageId } from '../../shell/nav';
import { usePlugins, type PluginId } from '../../shell/plugins';
import { useVisibleRoutes } from '../../shell/registry';
import { Icon, Stage3D, useGameClip, type IconName } from '../../ui';
import { nextReminder, reminderTime, runRows } from '../overview/briefModel';
import { useNow } from '../overview/nav';
import { isExpired } from '../overview/pending';
import { useOverview } from '../overview/useOverview';
import { useOverviewActions } from '../overview/useOverviewActions';
import { useToast } from '../../shell/toast';
import { BottomBar, ClockCard, type Conn } from './Cards';
import { Disc } from './Disc';
import { CLOCK, FACE_W, leftTiles, rightTiles, sideIcons, STAGE, TOP_ICONS } from './geometry';
import { Backdrop, Logo, Rings } from './Rings';
import { Group, TopIcon, WatchKey } from './Tiles';
import { useFit } from './useFit';
import { Sway, useAttended } from './watchMotion';
import styles from './Home.module.css';

/** Same icons as the command bar's tabs. A page key shows while its page is offered (its plug-in on, devOnly in 开发者模式). */
const LEFT: ReadonlyArray<[string, IconName]> = [
  ['character', 'user'],
  ['chat', 'send'],
  ['memory', 'data'],
  ['schedules', 'bell'],
];
/** The watch's CharInfo, Activity, Gacha and Purchase keys, top to bottom. */
const LEFT_G = ['charInfo', 'activity', 'gacha', 'purchase'] as const;
const RIGHT: ReadonlyArray<[string, IconName]> = [
  ['settings', 'tune'],
  ['trace', 'history'],
];
/** Pages among the small icons right of the keys. */
const MORE: ReadonlyArray<[string, IconName]> = [
  ['diag', 'radio'],
  ['pipeline', 'hub'],
  ['tune', 'tool'],
];

/** An action key: shown while its plug-in is on and the page it lands on is offered. */
interface Act<Id extends string> {
  id: Id;
  icon: IconName;
  title: string;
  hotkey?: string;
  plugin?: PluginId;
  page?: PageId;
}
const RIGHT_ACTS: ReadonlyArray<Act<'dispatch' | 'search'>> = [
  { id: 'dispatch', icon: 'plus', title: '派发任务', hotkey: '⌘N', plugin: 'personal_agent', page: 'overview' },
  { id: 'search', icon: 'search', title: '搜索', hotkey: '⌘K' },
];
const SIDE_ACTS: ReadonlyArray<Act<'look' | 'quickInput' | 'stopSpeech'>> = [
  { id: 'look', icon: 'look', title: '屏幕识读', plugin: 'screen_reading' },
  { id: 'quickInput', icon: 'bolt', title: '快速输入' },
  { id: 'stopSpeech', icon: 'stop', title: '停止说话' },
];

/** The stage's smallest text is 12px; under this scale, with the tilted groups' foreshortening, it would render below 11px. */
const K_MIN = 0.925;

export function HomePage() {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const plugins = usePlugins();
  const routes = useVisibleRoutes();
  const routeOf = (id: string) => routes.find((r) => r.id === id);
  // As the command bar's 工具 menu: 定时任务 is listed though it has no nav entry.
  const listed = (id: string) => {
    const r = routeOf(id);
    return r && (r.nav !== false || r.id === 'schedules') ? r : undefined;
  };
  const offered = (a: Act<string>) => (!a.plugin || plugins[a.plugin]) && (!a.page || !!listed(a.page));
  // 待处理, 提醒, the disc's items and the bottom card all land on the today page.
  const today = routeOf('overview');
  const [fit, k, room] = useFit<HTMLDivElement>(STAGE.w, STAGE.h, 12, K_MIN);
  // Too narrow for the face at K_MIN: the 快捷动作 column at the far right folds first.
  const narrow = room < FACE_W;
  const hud = useRef<HTMLDivElement>(null);
  const watchIn = useGameClip(gameClips.watchIn, hud, { autoplay: !still });
  const [entered, setEntered] = useState(false);
  const attended = useAttended();
  const tilt = useRef<HTMLDivElement>(null);
  const off = useDesktopOff();
  const { q, reads, data: snap, brief } = useOverview(demo, state);
  const now = useNow(snap.now, still);
  const toast = useToast();
  const act = useOverviewActions(snap, now, go, toast, () => void q.refetch());
  const pending = useMemo(
    () => sortPending(snap.pending.filter((p) => !p.resolved && !act.decided[p.id])).filter((p) => !isExpired(p, now, snap.now)),
    [snap, now, act.decided],
  );
  const run = useMemo(() => runRows(snap, brief?.convs ?? []), [snap, brief]);
  const offline = !!q.data && snap.connection !== 'connected';
  const conn: Conn = !q.data ? (q.isError ? 'failed' : 'loading') : offline ? (snap.connection === 'unauthorized' ? 'refused' : 'lost') : q.isError ? 'stale' : 'ok';
  const counts = { pending: q.data ? pending.length : null, running: reads.running.data ? run.rows.length : null };

  useEffect(() => {
    let alive = true;
    void watchIn.finished.then(() => alive && setEntered(true));
    return () => {
      alive = false;
    };
  }, [watchIn]);

  const pages = (keys: ReadonlyArray<[string, IconName]>) =>
    keys.flatMap(([id, icon]) => {
      const r = listed(id);
      return r ? [{ id, icon, title: r.title, hotkey: r.hotkey, off: undefined, onClick: () => go({ page: id as PageId }) }] : [];
    });
  const acts = {
    dispatch: () => go({ page: 'overview', create: 'role', focus: 'task-create' }),
    search: () => window.dispatchEvent(new Event(OPEN_PALETTE)),
    look: () => void look(),
    quickInput: () => void openQuickInput(),
    stopSpeech: () => void stopSpeech(),
  };
  const left = pages(LEFT);
  const right = [...pages(RIGHT), ...RIGHT_ACTS.filter(offered).map((a) => ({ ...a, onClick: acts[a.id] }))];
  const side = [...SIDE_ACTS.filter(offered).map((a) => ({ ...a, off: off[a.id], onClick: acts[a.id] })), ...pages(MORE)];
  const sideBoxes = sideIcons(side.length);
  const next = q.data ? nextReminder(snap.reminders, now) : null;
  // The face turns up to half a degree toward the pointer, like a watch held in the hand.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = tilt.current;
    if (!el || still) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width) * 2 - 1) * 0.5}deg`);
    el.style.setProperty('--rx', `${(((e.clientY - r.top) / r.height) * 2 - 1) * -0.35}deg`);
  };
  const onLeave = () => {
    tilt.current?.style.setProperty('--ry', '0deg');
    tilt.current?.style.setProperty('--rx', '0deg');
  };
  const leftBoxes = leftTiles(left.length);
  const rightBoxes = rightTiles(right.length);
  const groups = Array.from({ length: Math.ceil(right.length / 2) }, (_, i) => right.slice(i * 2, i * 2 + 2));
  const character = routeOf('character')?.title ?? '';
  const waiting = (counts.pending ?? 0) > 0;

  return (
    <div ref={fit} className={styles.page} data-page="home" onPointerMove={onMove} onPointerLeave={onLeave}>
      {next && today && (
        <button type="button" className={styles.notice} onClick={() => go({ page: 'overview', focus: 'reminders' })}>
          <Icon name="bell" size={14} />
          <span className="num">{reminderTime(next.due_at, now)}</span>
          <span className={styles.noticeText}>{next.title}</span>
        </button>
      )}
      <div className={styles.stage} style={{ '--k': k, width: STAGE.w, height: STAGE.h } as CSSProperties}>
        <Stage3D w={STAGE.w} h={STAGE.h}>
          <div ref={tilt} className={styles.tilt}>
          <div ref={hud} className={styles.hud} data-hud="" data-g="watch">
            <Backdrop />
            <div className={styles.map} data-g="map" aria-hidden="true" />
            <Rings />
            <Logo />
            {today && (
              <>
                <TopIcon
                  box={TOP_ICONS[0]}
                  icon="hand"
                  label={`待处理 ${counts.pending ?? '—'}`}
                  count={counts.pending}
                  dot={waiting ? (attended ? 'live' : 'still') : undefined}
                  g="topBtn1"
                  onClick={() => go({ page: 'overview', focus: 'pending' })}
                />
                <TopIcon box={TOP_ICONS[1]} icon="bell" label="提醒" g="topBtn3" onClick={() => go({ page: 'overview', focus: 'reminders' })} />
              </>
            )}
            <Disc title={character} snap={snap} urgent={today && q.data ? pending : []} act={act} go={go} />
            <div className={styles.layer} role="group" aria-label="主要页面">
              {left.map((t, i) => (
                <WatchKey key={t.id} shape={(i + 1) as 1 | 2 | 3 | 4} box={leftBoxes[i]!} icon={t.icon} title={t.title} hotkey={t.hotkey} g={LEFT_G[i]} onClick={t.onClick} />
              ))}
            </div>
            <div className={styles.layer} role="group" aria-label="工具">
              {groups.map((pair, gi) => (
                <Group key={pair[0]!.id} g={`group${gi + 1}`}>
                  {pair.map((t, j) => (
                    <WatchKey key={t.id} shape="sq" box={rightBoxes[gi * 2 + j]!} icon={t.icon} title={t.title} hotkey={t.hotkey} onClick={t.onClick} />
                  ))}
                </Group>
              ))}
            </div>
            {!narrow && (
              <div className={styles.layer} role="group" aria-label="快捷动作">
                {side.map((t, i) => (
                  <TopIcon key={t.id} box={sideBoxes[i]!} icon={t.icon} label={t.title} named off={t.off} g={`side${i + 1}`} onClick={t.onClick} />
                ))}
              </div>
            )}
            <BottomBar
              card={today && { label: today.title, counts, onClick: () => go({ page: 'overview' }) }}
              action={{ icon: 'send', title: '打开对话', onClick: () => go({ page: 'chat' }) }}
            />
            <ClockCard box={CLOCK} now={now} conn={conn} />
            {entered && attended && !still && <Sway root={hud} />}
          </div>
          </div>
        </Stage3D>
      </div>
    </div>
  );
}
