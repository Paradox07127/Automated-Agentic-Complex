// 今天（任务面板）：左列待处理的任务行，右列她的名片、进行中和今日时间线，下面整宽今日简报；今天的计数在页头字段行里只说一次，常用操作在外壳底部操作条。
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { get } from '../../bridge/agentd';
import { sortPending } from '../../domain';
import type { WireSchedule } from '../../domain/schedules';
import { Empty, ErrBar, Menu, Btn, PageIssues, type MenuItem } from '../../ui';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { useToast } from '../../shell/toast';
import { draftFor } from '../tasks/CreateForm';
import { TaskDetailHost, useTaskDesk } from '../tasks/TaskDetailHost';
import { ActionBand } from './ActionBand';
import { Brief } from './Brief';
import { codeCounts, nextReminder, reminderTime, runRows } from './briefModel';
import { DayLine } from './DayLine';
import { EpisodeSheet } from './DayTimeline';
import { useGo, useNow } from './nav';
import { PauseReadout } from './PauseReadout';
import { isExpired } from './pending';
import { PendingSection } from './PendingSection';
import { Pip } from './Pip';
import { Panel } from './MissionFx';
import { joined } from './regions';
import { RunningSection } from './RunningSection';
import { parseTodayParams } from './today';
import { TaskRecords } from './TaskRecords';
import { useOverview } from './useOverview';
import { useOverviewActions } from './useOverviewActions';
import { useToday } from './useToday';
import styles from './Page.module.css';

const WEEK = '日一二三四五六';
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
  const desk = useTaskDesk(state, demo, false);
  const { setOpen, setDraft } = desk;
  const [target, setTarget] = useState<string | null>(null);
  const [ep, setEp] = useState<string | null>(null);
  const [showRecords, setShowRecords] = useState(false);
  useEffect(() => {
    setOpen(params.open);
    setTarget(params.sel);
    setEp(params.ep);
    setDraft(params.create ? draftFor(params.create) : null);
  }, [params, setOpen, setDraft]);
  const today = useToday(ov, demo, state, params.day, now);
  // `sel` waits for the tasks data: a card or a task opens its detail; a pending id only lands (`focus=item-…`).
  useEffect(() => {
    if (!target || !desk.view || !desk.listReady || !desk.pendReady) return;
    const c = desk.resolveCard(target);
    if (c) setOpen(c.id);
    else if (desk.view.tasks.some((t) => t.id === target)) setOpen(target);
    setTarget(null);
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
  const schedQ = useQuery({
    queryKey: ['overview', demo, 'schedules'],
    queryFn: () => get<{ schedules: WireSchedule[] }>('/schedules'),
    enabled: state !== 'loading',
    retry: false,
    staleTime: 30_000,
  });
  const schedulesCount = state === 'empty' ? 0 : (schedQ.data?.schedules ?? []).filter((s) => s.enabled).length;
  const briefQ = joined([reads.brief, q], [reads.day, reads.running, reads.turns, reads.role]);
  // Nothing waiting, running or recorded today: one centred line instead of three empty sections.
  const quietDay =
    !!q.data &&
    !!reads.running.data &&
    !!brief &&
    pending.length === 0 &&
    run.rows.length === 0 &&
    snap.reminders.length === 0 &&
    snap.day.segments.length === 0 &&
    snap.day.runs.length === 0 &&
    !brief.episodes?.length &&
    !brief.convs?.length &&
    !brief.spoke?.length;

  const dnd: MenuItem[] = [
    { kind: 'item', label: '30 分钟', onSelect: () => a.onPause('quiet', 30) },
    { kind: 'item', label: '1 小时', onSelect: () => a.onPause('quiet', 60) },
    { kind: 'item', label: '到明早 7 点', onSelect: () => a.onPause('quiet', null) },
    { kind: 'item', label: '开会', checked: a.pause.meeting, onSelect: () => a.onPause('meeting', null) },
    { kind: 'sep' },
    { kind: 'item', label: '暂停观察 1 小时', hint: '立即', onSelect: () => a.onPause('observe', 60) },
  ];
  const paused = a.pause.paused_until != null || a.pause.quiet_until != null || a.pause.meeting;
  const code = codeCounts(snap);
  const next = nextReminder(snap.reminders, now);

  return (
    <div className={styles.page} data-page="overview">
      <PageHeaderSlot
        right={
          <>
            <span className={styles.facts}>
              {q.data && brief && (
                <>
                  <span>
                    对话 <span className="num">{brief.convs?.length ?? 0}</span>
                  </span>
                  <span>
                    编码会话 <span className="num">{code.total}</span>
                  </span>
                  {next && (
                    <span>
                      提醒 <span className="num">{reminderTime(next.due_at, now)}</span>
                    </span>
                  )}
                </>
              )}
              <DayLine line={today.dayLine} day={today.daySummary} />
            </span>
            <span className={styles.conn}>{loading ? <Pip tone="idle" label="读取中" /> : offline ? <Pip tone="failed" label={lostText} /> : stale ? <Pip tone="failed" label="刷新失败" /> : <Pip tone="ok" label="已连接" />}</span>
            <span data-nav-target="tasks"><Btn size="sm" onClick={() => setShowRecords(true)}>任务记录</Btn></span>
            <Menu label="免打扰" align="right" items={dnd} />
          </>
        }
        bottom={<ActionBand go={go} />}
      />
      <div className={styles.ov}>
        <PageIssues offline={offline} at={snap.now}>
          {offline && (
            <ErrBar
              message={`${lostText}，显示上次读到的数据`}
              staleAt={snap.now}
              onRetry={() => void q.refetch().then((result) => {
                if (result.isSuccess && result.data.connection === 'connected') toast('已重新读取');
                else toast('后台仍未连接，保留上次读到的数据', { severity: 'warning' });
              })}
              extra={
                <Btn variant="ghost" size="sm" onClick={() => go({ page: 'diag', item: 'agentd', focus: 'proc-agentd' })}>
                  查看诊断
                </Btn>
              }
            />
          )}
          {paused && (
            <div className={styles.pauses}>
              {a.pause.paused_until != null && <PauseReadout kind="观察暂停" until={a.pause.paused_until} now={now} onResume={() => a.onResume('observe')} />}
              {a.pause.quiet_until != null && <PauseReadout kind="免打扰" until={a.pause.quiet_until} now={now} onResume={() => a.onResume('quiet')} />}
              {a.pause.meeting && <PauseReadout kind="免打扰 │ 开会" until={null} now={now} onResume={() => a.onResume('meeting')} />}
            </div>
          )}
          {quietDay ? (
            <div className={styles.quiet}>
              <Empty title="今天还没有待处理和进行中的事" desc="派发的任务、编码会话和对话会出现在这里。" />
            </div>
          ) : (
            <>
              <Panel still={still} className={styles.row}>
                <div className={styles.list} data-g="list">
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
                </div>
                <div className={styles.detail} data-g="detail">
                  <span className={styles.detailLine} data-g="detailLine" aria-hidden="true" />
                  <div data-nav-target="running" data-g="body">
                    <RunningSection q={reads.running} rows={run.rows} convs={run.convs} code={run.code} activeRuns={activeRuns} now={now} lost={lost} go={go} schedules={schedulesCount} onJumpSession={a.onJumpSession} />
                  </div>
                </div>
              </Panel>
              <Brief q={briefQ} snap={snap} brief={brief} now={now} go={go} />
            </>
          )}
        </PageIssues>
      </div>
      <TaskDetailHost desk={desk} />
      {showRecords && <TaskRecords desk={desk} onClose={() => setShowRecords(false)} onSelect={(id) => { setShowRecords(false); setOpen(id); }} />}
      {ep && <EpisodeSheet ep={ep} onClose={() => setEp(null)} />}
    </div>
  );
}
