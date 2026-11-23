// 每日简报：页头是日期翻页和四个页签（总览 / 她 / 时间 / 明细），两者写在地址的 tab= 和 date= 里；统计读 GET /brief/day，各列表读原有接口，常用操作在外壳底部操作条。
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import { get } from '../../bridge/agentd';
import { formatClock, sortPending } from '../../domain';
import type { WireSchedule } from '../../domain/schedules';
import { IconBtn, Menu, Btn, PageIssues, Region, Tabs, type IconName, type MenuItem } from '../../ui';
import { PowerState } from '../../ui/game';
import { useDemo } from '../../shell/demo';
import { navRoute } from '../../shell/nav';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { usePlugins } from '../../shell/plugins';
import { useToast } from '../../shell/toast';
import { useTaskDesk } from '../tasks/useTaskDesk';
import { ActionBand } from './ActionBand';
import { readBriefDay } from './briefDay';
import { runRows } from './briefModel';
import { usePins, type BriefTab, type BriefTabProps } from './briefTabs';
import { EpisodeSheet } from './DayTimeline';
import { DetailTab } from './DetailTab';
import { HerTab } from './HerTab';
import { clock, dayOf } from './load';
import { loadBrief } from './loadBrief';
import { useGo, useNow } from './nav';
import { OverviewTab } from './OverviewTab';
import { PauseReadout } from './PauseReadout';
import { PendingSection } from './PendingSection';
import { Pip } from './Pip';
import { RunningSection } from './RunningSection';
import { parseTodayParams } from './today';
import { TimeTab } from './TimeTab';
import { useOverview } from './useOverview';
import { useOverviewActions } from './useOverviewActions';
import { useToday } from './useToday';
import styles from './Page.module.css';

const TABS: Array<{ id: BriefTab; label: string; icon: IconName }> = [
  { id: 'ov', label: '总览', icon: 'grid' },
  { id: 'her', label: '她', icon: 'user' },
  { id: 'tm', label: '时间', icon: 'clock' },
  { id: 'dt', label: '明细', icon: 'data' },
];
const WEEK = '日一二三四五六';
/** The pager reaches this many days before today. */
const BACK = 6;

/** `YYYY-MM-DD` moved by `n` local days. */
function shift(date: string, n: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n).getTime());
}

export function OverviewPage() {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const toast = useToast();
  const ov = useOverview(demo, state);
  const { q, reads, data: snap, brief, activeRuns, lost } = ov;
  const now = useNow(snap.now, still);
  const a = useOverviewActions(snap, now, go, toast, () => void q.refetch());
  const loading = !q.data;
  const offline = !!q.data && snap.connection !== 'connected';
  // A failed refresh keeps the last data; its section tags the time it was read.
  const stale = !!q.data && (q.isError || offline);
  const lostText = snap.connection === 'unauthorized' ? '后台拒绝访问' : '后台无响应';
  // A jump elsewhere keeps this page on screen under the new URL until the next page loads; only its own path's query counts.
  const [path] = useState(useRouterState({ select: (s) => s.location.pathname }));
  const search = useRouterState({ select: (s) => (s.location.pathname === path ? s.location.searchStr : '') });
  const params = useMemo(() => parseTodayParams(search), [search]);
  const desk = useTaskDesk(state, demo, null);
  const [ep, setEp] = useState<string | null>(null);
  useEffect(() => setEp(params.ep), [params]);
  // A task or a new task asked of this page opens on the tasks page; a pending id only lands here (`focus=item-…`).
  const landing = new URLSearchParams(search).get('focus') ?? '';
  const forward = landing.startsWith('item-') ? null : (params.open ?? params.sel);
  const { history } = useRouter();
  useEffect(() => {
    if (forward || params.create) history.replace(navRoute({ page: 'tasks', sel: forward ?? undefined, create: params.create ?? undefined }));
  }, [forward, params.create, history]);

  const url = new URLSearchParams(search);
  const today = dayOf(clock());
  const asked = url.get('date');
  const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked >= shift(today, -BACK) && asked <= today ? asked : today;
  const isToday = date === today;
  const navigate = useNavigate();
  const put = (next: { tab?: BriefTab; date?: string }) =>
    void navigate({ to: path, search: (prev: Record<string, unknown>) => ({ ...prev, ...next }), replace: true });
  const dayQ = useQuery({ queryKey: ['brief', 'day', date], queryFn: () => readBriefDay(date), enabled: state !== 'loading', retry: false });
  const [pins, setPins] = usePins();
  const timeOn = dayQ.data?.focus.enabled ?? true;
  const tabs = TABS.filter((t) => t.id !== 'tm' || timeOn);
  const tab = tabs.find((t) => t.id === url.get('tab'))?.id ?? 'ov';

  const todayReads = useToday(ov, demo, state, date, now);
  // Another day's conversations; the same query useToday reads for that day.
  const pastQ = useQuery({
    queryKey: ['today', demo, 'brief', date],
    queryFn: () => loadBrief(new Date(`${date}T12:00:00`).getTime()),
    enabled: state !== 'loading' && !isToday,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const pending = useMemo(() => sortPending(snap.pending.filter((p) => !p.resolved && !a.decided[p.id])), [snap, a.decided]);
  const { setDecided, setLast } = a;
  useEffect(() => {
    // `decided` demo: the focus approval was just approved here, so the next item is in focus.
    if (demo !== 'decided' || !q.data) return;
    const first = sortPending(snap.pending)[0];
    if (!first) return;
    const r = { id: first.id, title: first.title, text: '已批准', at: snap.now };
    setDecided({ [first.id]: r });
    setLast(r);
  }, [demo, q.data, snap, setDecided, setLast]);
  const run = useMemo(() => runRows(snap, brief?.convs ?? []), [snap, brief]);
  const plugins = usePlugins();
  // 在做 lists 个人代理's role tasks and 编码会话's sessions; with both off it shows 已关闭.
  const runningOn = plugins.personal_agent || plugins.coding_sessions;
  const schedQ = useQuery({
    queryKey: ['overview', demo, 'schedules'],
    queryFn: () => get<{ schedules: WireSchedule[] }>('/schedules'),
    enabled: state !== 'loading' && plugins.personal_agent,
    retry: false,
    staleTime: 30_000,
  });
  const schedulesCount = state === 'empty' ? 0 : (schedQ.data?.schedules ?? []).filter((s) => s.enabled).length;

  const dnd: MenuItem[] = [
    { kind: 'item', label: '30 分钟', onSelect: () => a.onPause('quiet', 30) },
    { kind: 'item', label: '1 小时', onSelect: () => a.onPause('quiet', 60) },
    { kind: 'item', label: '到明早 7 点', onSelect: () => a.onPause('quiet', null) },
    { kind: 'item', label: '开会', checked: a.pause.meeting, onSelect: () => a.onPause('meeting', null) },
    { kind: 'sep' },
    { kind: 'item', label: '暂停观察 1 小时', hint: '立即', onSelect: () => a.onPause('observe', 60) },
  ];
  const paused = a.pause.paused_until != null || a.pause.quiet_until != null || a.pause.meeting;
  const [, mm = 0, dd = 0] = date.split('-').map(Number);
  const day0 = new Date(`${date}T00:00:00`).getTime();
  const day1 = new Date(`${shift(date, 1)}T00:00:00`).getTime();
  const inDay = (t: number) => t >= day0 && t < day1;

  const tabProps = (d: BriefTabProps['day']): BriefTabProps => ({ day: d, pins, onPins: setPins, go: (t) => put({ tab: t }) });
  const body = (d: BriefTabProps['day']) => {
    if (tab === 'her') return <HerTab {...tabProps(d)} />;
    if (tab === 'tm') return <TimeTab {...tabProps(d)} />;
    if (tab === 'dt') return <DetailTab {...tabProps(d)} />;
    return (
      <OverviewTab
        {...tabProps(d)}
        isToday={isToday}
        line={todayReads.dayLine}
        pending={
          <PendingSection
            q={q}
            items={pending}
            now={now}
            at={snap.now}
            sessions={snap.sessions}
            receipt={a.last && a.decided[a.last.id] ? a.last : null}
            go={go}
            onApprove={a.onApprove}
            onAnswer={a.onAnswer}
            onReply={a.onReply}
            onJumpSession={a.onJumpSession}
          />
        }
        running={
          runningOn ? (
            <RunningSection
              q={reads.running}
              rows={run.rows}
              convs={run.convs}
              code={plugins.coding_sessions ? run.code : undefined}
              activeRuns={activeRuns}
              now={now}
              lost={lost}
              go={go}
              schedules={plugins.personal_agent ? schedulesCount : undefined}
              onJumpSession={a.onJumpSession}
            />
          ) : (
            <PowerState
              state="off"
              mode="block"
              title="进行中"
              reason="设置里关着「派发任务和定时任务」和「编码会话」，这里不列她在做的任务、编码会话和定时任务。"
              action={{ label: '前往设置打开', onClick: () => go({ page: 'settings', group: 'perm', item: 'plugins.personal_agent' }) }}
              more={
                <Btn variant="ghost" size="sm" onClick={() => go({ page: 'settings', group: 'privacy', item: 'plugins.coding_sessions' })}>
                  编码会话
                </Btn>
              }
            >
              {null}
            </PowerState>
          )
        }
        done={desk.listReady && desk.view ? desk.view.tasks.filter((t) => t.source !== 'ext' && inDay(t.updated_at) && ['done', 'failed'].includes(desk.view?.effective[t.id] ?? '')).sort((x, y) => y.updated_at - x.updated_at).map((t) => ({ task: t, failed: desk.view?.effective[t.id] === 'failed' })) : undefined}
        convs={isToday ? brief?.convs : pastQ.data?.convs}
        reminders={snap.reminders.filter((r) => inDay(r.due_at)).sort((x, y) => x.due_at - y.due_at)}
        onTask={(id) => go({ page: 'tasks', sel: id })}
        goPage={go}
      />
    );
  };

  const content = (
    <>
      {paused && (
        <div className={styles.pauses}>
          {a.pause.paused_until != null && <PauseReadout kind="观察暂停" until={a.pause.paused_until} now={now} onResume={() => a.onResume('observe')} />}
          {a.pause.quiet_until != null && <PauseReadout kind="免打扰" until={a.pause.quiet_until} now={now} onResume={() => a.onResume('quiet')} />}
          {a.pause.meeting && <PauseReadout kind="免打扰 │ 开会" until={null} now={now} onResume={() => a.onResume('meeting')} />}
        </div>
      )}
      <Region q={dayQ} what="每日简报" reserve={{ height: 480 }} skel="cards">
        {body}
      </Region>
    </>
  );
  const reread = () =>
    void q.refetch().then((result) => {
      if (result.isSuccess && result.data.connection === 'connected') toast('已重新读取');
      else toast('后台仍未连接，保留上次读到的数据', { severity: 'warning' });
    });
  const restart = () =>
    void getBridge().supervisor.restart('agentd').then(
      () => toast('正在重启后台…'),
      () => toast('后台没有重启，请重启应用', { severity: 'danger' }),
    );

  return (
    <div className={styles.page} data-page="overview">
      <PageHeaderSlot
        tabs={<Tabs label="简报页签" keys={false} value={tab} onChange={(id) => put({ tab: id as BriefTab })} tabs={tabs} />}
        right={
          <>
            <span className={styles.date}>
              <IconBtn icon="chevl" label="前一天" size="sm" disabled={date <= shift(today, -BACK)} disabledReason={`最多往回看 ${BACK} 天`} onClick={() => put({ date: shift(date, -1) })} />
              <span className="num" data-date={date}>
                {mm}.{dd}
                <span data-fold="1"> 周{WEEK[new Date(day0).getDay()]}</span>
                {isToday && <i>今天</i>}
              </span>
              <IconBtn icon="chev" label="后一天" size="sm" disabled={isToday} disabledReason="已经是今天" onClick={() => put({ date: shift(date, 1) })} />
            </span>
            {/* The top bar says 已连接. */}
            {(loading || (stale && !offline)) && <span className={styles.conn}>{loading ? <Pip tone="idle" label="读取中" /> : <Pip tone="failed" label="刷新失败" />}</span>}
            <Menu label="免打扰" align="right" items={dnd} />
          </>
        }
        bottom={<ActionBand go={go} />}
      />
      <div className={styles.ov}>
        <PageIssues offline={offline} at={snap.now}>
          {offline ? (
            <PowerState
              state="unlinked"
              mode="block"
              title="后台"
              reason={`${lostText}，下面是 ${formatClock(snap.now)} 读到的数据`}
              action={{ label: '重启后台', onClick: restart }}
              more={
                <Btn variant="ghost" size="sm" icon="refresh" onClick={reread}>
                  重新读取
                </Btn>
              }
            >
              {content}
            </PowerState>
          ) : (
            content
          )}
        </PageIssues>
      </div>
      {ep && <EpisodeSheet ep={ep} onClose={() => setEp(null)} />}
    </div>
  );
}
