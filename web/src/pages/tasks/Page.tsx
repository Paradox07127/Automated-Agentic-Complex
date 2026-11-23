// 任务页（游戏任务面板）：页签 进行中 / 定时 / 已完成，左列表右详情，底栏放新建和对选中项的操作；地址里是 tab=、sel=、create=。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import { resumeOf, StopConfirm } from '../../features/task';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { useGo } from '../../shell/nav';
import { isPluginOff } from '../../shell/plugins';
import { useToast } from '../../shell/toast';
import { Btn, Icon, Modal, Tabs } from '../../ui';
import { TasksLoadError } from '../../data/tasksBase';
import { useCharacters } from '../chat/useChatData';
import { failMessage } from './actions';
import { BottomBar, NewButton } from './Bottom';
import { draftFromSchedule, newDraft, problemOf, schedulePayload, sendNow, type EditDraft } from './draft';
import { Editor } from './Editor';
import { Logo, TypeIcon, Warn } from './Glyphs';
import { Group, ListHead } from './List';
import { parseTasksParams, type CreateKind, type TasksTab } from './params';
import { doneGroups, endedTasks, matches, runGroups, schedGroups, type RowGroup } from './rows';
import { ScheduleDetail } from './ScheduleDetail';
import { useContextOptions, useSchedules, useScheduleWrites } from './schedules';
import { TaskDetail } from './TaskDetail';
import { useTaskDesk } from './useTaskDesk';
import detail from './Detail.module.css';
import blank from './Empty.module.css';
import styles from './Page.module.css';

const TABS = [
  { id: 'run', label: '进行中', icon: 'sync' as const },
  { id: 'sched', label: '定时', icon: 'clock' as const },
  { id: 'done', label: '已完成', icon: 'ok' as const },
];
const ORDER: TasksTab[] = ['run', 'sched', 'done'];
/** 已完成 shows this many more per 再往前. */
const PAGE = 20;
const TYPING = 'input, textarea, select, [contenteditable="true"]';

export function TasksPage() {
  const { state, demo } = useDemo();
  const go = useGo();
  const push = useToast();
  const dev = useDevMode();
  const navigate = useNavigate();
  // A jump elsewhere keeps this page on screen under the new URL until the next page loads; only its own path's query counts.
  const [path] = useState(useRouterState({ select: (s) => s.location.pathname }));
  const search = useRouterState({ select: (s) => (s.location.pathname === path ? s.location.searchStr : '') });
  const params = useMemo(() => parseTasksParams(search), [search]);
  const put = (next: { tab?: TasksTab | undefined; sel?: string | undefined; create?: undefined }) =>
    void navigate({ to: path, search: (prev: Record<string, unknown>) => ({ ...prev, ...next }), replace: true });

  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [base, setBase] = useState<string>('');
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [note, setNote] = useState(false);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<string | null>(null);

  const chars = useCharacters();
  const who = (chars.data?.shown && chars.data.names[chars.data.shown]) || '角色';
  const desk = useTaskDesk(state, demo, params.sel);
  const sched = useSchedules(state, true);
  const writes = useScheduleWrites(push);
  const opts = useContextOptions(state !== 'loading');
  const convTitle = (id: string) => opts.data?.conversations.find((c) => c.id === id)?.label ?? null;
  const view = desk.view;
  const now = desk.now;

  const ended = useMemo(() => (view ? endedTasks(view) : []), [view]);
  const scheds = sched.data ?? [];
  // A bare `sel` picks the tab it belongs to.
  const tab: TasksTab = params.tab ?? (params.sel && scheds.some((s) => s.schedule_id === params.sel) ? 'sched' : params.sel && ended.some((t) => t.id === params.sel) ? 'done' : 'run');
  const groups: RowGroup[] = useMemo(() => {
    if (tab === 'sched') return schedGroups(scheds, now);
    if (!view) return [];
    if (tab === 'run') return runGroups(view, desk.cards, who, now);
    return doneGroups(ended.filter((t) => matches(t, q.trim())).slice(0, limit), view, who, now);
  }, [tab, scheds, view, desk.cards, ended, q, limit, who, now]);
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
  const sel = params.sel && ids.includes(params.sel) ? params.sel : (ids[0] ?? null);
  const task = tab !== 'sched' && sel ? (view?.tasks.find((t) => t.id === sel) ?? null) : null;
  const schedule = tab === 'sched' && sel ? (scheds.find((s) => s.schedule_id === sel) ?? null) : null;
  const waiting = view ? runGroups(view, desk.cards, who, now).some((g) => g.key === 'wait') : false;

  const readError = tab === 'sched' ? sched.error : desk.list.first.error;
  // agentd still has 个人代理 off: nothing to list and nothing to create.
  const off = isPluginOff(readError);
  const listError = off ? null : readError;
  const loading = state === 'loading' || (!listError && (tab === 'sched' ? sched.isPending : !desk.listReady));
  const errText = listError instanceof TasksLoadError ? listError.reason : listError ? (failMessage(listError) ?? listError.message) : null;
  const empty = !loading && !listError && ids.length === 0 && (tab !== 'done' || !q.trim());

  const canPick = getBridge().capabilities.nativeFilePicker;
  const problem = draft ? problemOf(draft, canPick) : null;
  const dirty = draft != null && JSON.stringify(draft) !== base;
  const open = (d: EditDraft) => {
    setDraft(d);
    setBase(JSON.stringify(d));
    setNote(false);
  };
  const close = () => {
    setDraft(null);
    setLeave(null);
  };
  const openNew = (kind: CreateKind, title?: string) => open(newDraft(kind, title));
  const pickFolder = async () => {
    try {
      const h = await getBridge().files.pickFolder({ purpose: 'session_cwd' });
      if (h && draft) setDraft({ ...draft, cwd: h });
      else if (!h) push('没有选择目录');
    } catch {
      push('这台电脑的外壳暂不支持选择目录', { severity: 'danger' });
    }
  };
  const submit = async () => {
    if (!draft || problem || busy) return;
    setBusy(true);
    try {
      if (draft.when === 'now') {
        const r = await sendNow(draft);
        push(`已交派：${r.label}`);
        close();
        void desk.reload();
        put({ tab: 'run', sel: r.select ?? undefined });
      } else {
        const body = schedulePayload(draft);
        const id = body ? await writes.save(draft.scheduleId, body) : null;
        if (id) {
          close();
          put({ tab: 'sched', sel: id });
        }
      }
    } catch (e) {
      const text = failMessage(e);
      if (text !== null) push(`交派失败：${text}`, { severity: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // `create=` opens the editor once, then leaves the address.
  useEffect(() => {
    if (!params.create) return;
    open(newDraft(params.create));
    put({ create: undefined });
  }, [params.create]);

  const latest = useRef({ draft, dirty, note, ids, sel, tab, submit, openNew });
  latest.current = { draft, dirty, note, ids, sel, tab, submit, openNew };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current;
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const typing = e.target instanceof Element && e.target.closest(TYPING);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        l.openNew(l.tab === 'sched' ? 'sched' : 'role');
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && l.draft) {
        e.preventDefault();
        void l.submit();
      } else if (e.key === 'Escape' && (l.draft || l.note)) {
        // Esc leaves the editor (asking first when it was changed) or the note before it goes home; it never denies an approval.
        e.preventDefault();
        if (l.note) setNote(false);
        else if (l.dirty) setLeave(() => close);
        else close();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && l.ids.length > 0) {
        e.preventDefault();
        const i = l.sel ? l.ids.indexOf(l.sel) : -1;
        const next = l.ids[Math.max(0, Math.min(l.ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) {
          setDraft(null);
          put({ sel: next });
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"]`)?.focus());
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pick = (id: string) => {
    setDraft(null);
    setNote(false);
    put({ tab, sel: id });
  };
  const setTab = (t: string) => {
    setDraft(null);
    setNote(false);
    put({ tab: t as TasksTab, sel: undefined });
  };
  const stopTasks = view && desk.stopIds ? view.tasks.filter((t) => desk.stopIds?.includes(t.id)) : [];
  const delSched = del ? scheds.find((s) => s.schedule_id === del) : undefined;
  const newKind: CreateKind = tab === 'sched' ? 'sched' : 'role';
  const newLabel = tab === 'sched' ? '新建定时任务' : '派发任务';
  const emptyText = tab === 'run' ? '她现在没有在做的任务' : tab === 'sched' ? '还没有定时任务' : '还没有做完的任务';

  const listBody = loading ? (
    <section className={styles.scroll} aria-label="读取中">
      {[1, 0.7, 0.45].map((o) => (
        <div key={o} className={styles.skel} style={{ opacity: o }} />
      ))}
    </section>
  ) : (
    <div className={styles.scroll} data-list="">
      {errText && (
        <div className={styles.tipsR} role="alert">
          <Warn />
          <span>
            <b>{tab === 'sched' ? '定时任务没读到' : '任务列表没读到'}</b>
            <small>{errText}</small>
          </span>
          <Btn size="sm" variant="ghost" onClick={() => void (tab === 'sched' ? sched.refetch() : desk.reload())}>
            重试
          </Btn>
        </div>
      )}
      {groups.map((g, gi) => (
        <Group key={g.key} group={g} start={groups.slice(0, gi).reduce((n, x) => n + x.rows.length, 0)} selected={draft ? null : sel} onSelect={pick} />
      ))}
      {tab === 'done' && q.trim() && ids.length === 0 && (
        <p className={styles.none}>
          没找到「{q.trim()}」{' '}
          <Btn size="sm" variant="text" onClick={() => setQ('')}>
            清除
          </Btn>
        </p>
      )}
      {empty && <p className={styles.none}>{emptyText}</p>}
      {tab === 'done' && !q.trim() && ended.length > limit && (
        <span className={styles.more}>
          <Btn size="sm" variant="text" onClick={() => setLimit(limit + PAGE)}>
            再往前 {PAGE} 个
          </Btn>
        </span>
      )}
    </div>
  );

  const count = tab === 'sched' ? (sched.data ? scheds.length : null) : !view ? null : tab === 'run' ? ids.length : ended.length;
  const detailBody = draft ? (
    <Editor draft={draft} onChange={setDraft} who={who} scopes={opts.data?.scopes ?? null} conversations={opts.data?.conversations ?? null} canPick={canPick} onPickFolder={() => void pickFolder()} problem={problem} now={now} />
  ) : task && view && desk.actions ? (
    <TaskDetail key={task.id} task={task} desk={desk} who={who} convTitle={convTitle} onGoChat={(c) => go({ page: 'chat', conv: c })} note={note} onNote={setNote} />
  ) : schedule ? (
    <ScheduleDetail
      key={schedule.schedule_id}
      s={schedule}
      now={now}
      scopes={opts.data?.scopes ?? null}
      convTitle={convTitle}
      onToggle={(on) => void writes.toggle(schedule, on)}
      onEdit={() => open(draftFromSchedule(schedule))}
      onDecline={() => setDel(schedule.schedule_id)}
      onOpenJob={(id) => put({ tab: 'done', sel: id })}
      onGoChat={(c) => go({ page: 'chat', conv: c })}
    />
  ) : (
    <div className={blank.empty} style={{ gridRow: '1 / -1' }}>
      <p>{loading ? '' : errText ? '—' : tab === 'sched' ? '选一个定时任务' : '选一个任务看详情'}</p>
    </div>
  );

  return (
    <div className={styles.page} data-page="tasks" data-nav-target="page">
      <PageHeaderSlot
        tabs={<Tabs label="任务页签" keys={false} value={tab} onChange={setTab} tabs={TABS.map((t) => (t.id === 'run' && waiting ? { ...t, mark: '有要你处理的任务' } : t))} />}
        bottom={
          <BottomBar
            tab={tab}
            empty={(empty || off) && !draft}
            newLabel={newLabel}
            onNew={() => openNew(newKind)}
            draft={draft}
            problem={problem}
            busy={busy}
            onCancel={() => (dirty ? setLeave(() => close) : close())}
            onSubmit={() => void submit()}
            task={task}
            desk={desk}
            dev={dev}
            schedule={schedule}
            onNote={() => setNote(true)}
            onAgain={() => task && openNew(task.source === 'code' ? 'code' : 'role', task.source === 'code' ? '' : task.title)}
            onGoChat={(c) => go({ page: 'chat', conv: c })}
            onEdit={() => schedule && open(draftFromSchedule(schedule))}
            onRunNow={() => schedule && void writes.runNow(schedule)}
            onDelete={() => schedule && setDel(schedule.schedule_id)}
          />
        }
      />
      <Logo className={styles.logo} />
      {empty && !draft && !errText ? (
        <div className={`${blank.empty} ${blank.whole}`}>
          <span className={blank.big}>
            <TypeIcon kind={tab === 'sched' ? 'sched' : 'role'} />
          </span>
          <b>{emptyText}</b>
          <span className={blank.shade} aria-hidden="true" />
          {!off && <NewButton label={newLabel} onClick={() => openNew(newKind)} />}
        </div>
      ) : (
        <>
          <section className={styles.list} aria-label="任务列表">
            <ListHead
              count={count}
              extra={
                tab === 'done' && (
                  <label className={`${detail.field} ${styles.search}`} data-search="">
                    <Icon name="search" size={14} />
                    <input aria-label="搜索已完成的任务" placeholder="搜标题和结果" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), e.preventDefault(), setQ(''))} />
                  </label>
                )
              }
            />
            {listBody}
          </section>
          <div className={styles.vdiv} aria-hidden="true" />
          <section key={draft ? 'edit' : `${tab}:${sel ?? ''}`} className={styles.detail} data-anim="" aria-label="详情">
            {detailBody}
          </section>
        </>
      )}
      <StopConfirm
        open={stopTasks.length > 0}
        target={stopTasks.length === 1 ? (stopTasks[0]?.title ?? '') : stopTasks.length}
        resume={resumeOf(stopTasks)}
        onCancel={() => desk.setStopIds(null)}
        onConfirm={() => {
          const stop = stopTasks.filter((t) => t.source !== 'ext').map((t) => t.id);
          desk.setStopIds(null);
          void desk.actions?.stopNow(stop);
        }}
      />
      <Modal
        open={delSched != null}
        danger
        title={`删除「${delSched?.title ?? ''}」？`}
        note="连同它的运行记录一起删，不能恢复。"
        confirmLabel="删除"
        cancelLabel="算了"
        onCancel={() => setDel(null)}
        onConfirm={() => {
          if (delSched) void writes.remove(delSched);
          setDel(null);
        }}
      />
      <Modal open={leave != null} title="放弃这次改动？" note="填的内容不会保存。" confirmLabel="放弃" cancelLabel="接着改" onCancel={() => setLeave(null)} onConfirm={() => leave?.()} />
    </div>
  );
}
