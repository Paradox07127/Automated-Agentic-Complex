// 任务页（游戏任务面板）：页签 进行中 / 定时 / 已完成，左列表右详情，底栏放新建和对选中项的操作；地址里是 tab=、sel=、create=。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import { resumeOf, StopConfirm } from '../../features/task';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { useGo } from '../../shell/nav';
import { isPluginOff, usePlugins } from '../../shell/plugins';
import { useToast } from '../../shell/toast';
import { Btn, Dialog, Empty, SearchField, Skel, Tabs } from '../../ui';
import { PowerState } from '../../ui/game';
import { TasksLoadError } from '../../data/tasksBase';
import { useCharacters } from '../chat/useChatData';
import { failMessage } from './actions';
import { BottomBar, NewButton } from './Bottom';
import { offText } from './create';
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
import blank from './Empty.module.css';
import styles from './Page.module.css';

const TABS = [
  { id: 'run', label: '进行中', icon: 'sync' as const },
  { id: 'sched', label: '定时', icon: 'clock' as const },
  { id: 'done', label: '历史记录', icon: 'ok' as const },
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
  // An explicit `sel` that is not in the tab selects nothing; the detail says so. 已完成 knows it past the search and the page shown.
  const sel = params.sel ? (ids.includes(params.sel) || (tab === 'done' && ended.some((t) => t.id === params.sel)) ? params.sel : null) : (ids[0] ?? null);
  const task = tab !== 'sched' && sel ? (view?.tasks.find((t) => t.id === sel) ?? null) : null;
  const schedule = tab === 'sched' && sel ? (scheds.find((s) => s.schedule_id === sel) ?? null) : null;
  const waiting = view ? runGroups(view, desk.cards, who, now).some((g) => g.key === 'wait') : false;
  // 立即运行 waits only on what blocks it now: a scope no longer in force, not the last run's error.
  const scopeGone = !!schedule?.scope_id && !!opts.data && !opts.data.scopes.some((x) => x.id === schedule.scope_id);

  const readError = tab === 'sched' ? sched.error : desk.list.first.error;
  // agentd still has 个人代理 off: nothing to list and nothing to create.
  const off = isPluginOff(readError);
  const listError = off ? null : readError;
  const loading = state === 'loading' || (!listError && (tab === 'sched' ? sched.isPending : !desk.listReady));
  const errText = listError instanceof TasksLoadError ? listError.reason : listError ? (failMessage(listError) ?? listError.message) : null;
  // A failed approvals or questions read lists none of them; 进行中 says so. A part whose plug-in is off has nothing to list.
  const pendFail = tab === 'run' && !listError ? (desk.pend.error ?? desk.pend.data?.failed ?? null) : null;
  const pendText = pendFail && !isPluginOff(pendFail) ? (pendFail instanceof TasksLoadError ? pendFail.reason : pendFail.message) : null;
  const empty = !loading && !listError && !pendText && ids.length === 0 && (tab !== 'done' || !q.trim());

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
      else if (!h) push('未选择目录');
    } catch {
      push('当前客户端环境暂不支持选择目录', { severity: 'danger' });
    }
  };
  const submit = async () => {
    if (!draft || problem || busy) return;
    setBusy(true);
    try {
      if (draft.when === 'now') {
        const r = await sendNow(draft);
        push(`已派发：${r.label}`);
        close();
        void desk.reload();
        put({ tab: 'run', sel: r.select });
      } else {
        const body = schedulePayload(draft);
        const id = body ? await writes.save(draft.scheduleId, body) : null;
        if (id) {
          close();
          put({ tab: 'sched', sel: id });
        }
      }
    } catch (e) {
      const text = isPluginOff(e) ? offText(draft.type) : failMessage(e);
      if (text !== null) push(`派发失败：${text}`, { severity: 'danger' });
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
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && l.draft && !e.isComposing) {
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
  const emptyText = tab === 'run' ? '当前无运行中的任务' : tab === 'sched' ? '尚无定时任务' : '尚无历史任务记录';
  const plugins = usePlugins();
  // Coding sessions are one kind of row in 进行中 and 已完成; with 编码会话 off that kind says 已关闭 over the list.
  const codeOff =
    plugins.personal_agent && !plugins.coding_sessions && tab !== 'sched' ? (
      <PowerState state="off" mode="block" title="编码会话" reason="已在「设置 › 感知」中关闭「编码会话」，此处不显示 Claude Code 与 Codex 会话。" action={{ label: '前往开启', onClick: () => go({ page: 'settings', group: 'privacy', item: 'plugins.coding_sessions' }) }}>
        {null}
      </PowerState>
    ) : null;

  const listBody = loading ? (
    <div className={styles.scroll}>
      <Skel rows={3} height={66} />
    </div>
  ) : (
    <div className={styles.scroll} data-list="">
      {codeOff}
      {errText && (
        <div className={styles.tipsR} role="alert">
          <Warn />
          <span>
            <b>{tab === 'sched' ? '未能读取定时任务' : '未能读取任务列表'}</b>
            <small>{errText}</small>
          </span>
          <Btn size="sm" variant="ghost" onClick={() => void (tab === 'sched' ? sched.refetch() : desk.reload())}>
            重试
          </Btn>
        </div>
      )}
      {pendText && (
        <div className={styles.tipsR} role="alert">
          <Warn />
          <span>
            <b>待处理任务未能完整读取</b>
            <small>{pendText}</small>
          </span>
          <Btn size="sm" variant="ghost" onClick={() => void desk.reload()}>
            重试
          </Btn>
        </div>
      )}
      {groups.map((g, gi) => (
        <Group key={g.key} group={g} start={groups.slice(0, gi).reduce((n, x) => n + x.rows.length, 0)} selected={draft ? null : sel} onSelect={pick} />
      ))}
      {tab === 'done' && q.trim() && ids.length === 0 && (
        <Empty
          inline
          title={`未找到匹配「${q.trim()}」的任务`}
          action={
            <Btn size="sm" variant="text" onClick={() => setQ('')}>
              清除
            </Btn>
          }
        />
      )}
      {empty && <Empty inline title={emptyText} />}
      {tab === 'done' && !q.trim() && ended.length > limit && (
        <span className={styles.more}>
          <Btn size="sm" variant="text" onClick={() => setLimit(limit + PAGE)}>
            加载更多（{PAGE} 项）
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
      onOpenJob={(id) => put({ tab: undefined, sel: id })}
      onGoChat={(c) => go({ page: 'chat', conv: c })}
    />
  ) : (
    <div className={blank.empty} style={{ gridRow: '1 / -1' }}>
      <p>{loading ? '' : errText ? '—' : params.sel && !sel ? '未在当前列表中找到该项' : tab === 'sched' ? '请选择一个定时任务' : '请选择一个任务查看详情'}</p>
    </div>
  );

  return (
    <div className={styles.page} data-page="tasks">
      <PageHeaderSlot
        tabs={<Tabs label="任务页签" keys={false} value={tab} onChange={setTab} tabs={TABS.map((t) => (t.id === 'run' && waiting ? { ...t, mark: '存在待处理任务' } : t))} />}
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
            runOff={scopeGone ? '请先重新选择资料范围' : null}
            runBusy={!!schedule && writes.running(schedule.schedule_id)}
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
          {codeOff}
        </div>
      ) : (
        <>
          <section className={styles.list} aria-label="任务列表">
            <ListHead
              count={count}
              extra={
                tab === 'done' && (
                  // Esc that clears the search stops here, so it does not also leave the editor or the note.
                  <span className={styles.search} onKeyDown={(e) => e.key === 'Escape' && q && e.stopPropagation()}>
                    <SearchField value={q} label="搜索历史任务" placeholder="搜索标题或结果" onChange={setQ} />
                  </span>
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
      <Dialog
        open={delSched != null}
        title={`确认删除「${delSched?.title ?? ''}」？`}
        onClose={() => setDel(null)}
        footer={
          <>
            <Btn variant="secondary" kbd="esc" onClick={() => setDel(null)}>取消</Btn>
            <Btn variant="danger" onClick={() => { if (delSched) void writes.remove(delSched); setDel(null); }}>删除</Btn>
          </>
        }
      >
        <p>将一并删除关联的运行记录，且无法恢复。</p>
      </Dialog>
      <Dialog
        open={leave != null}
        title="确认放弃未保存的更改？"
        onClose={() => setLeave(null)}
        footer={
          <>
            <Btn variant="secondary" kbd="esc" onClick={() => setLeave(null)}>继续编辑</Btn>
            <Btn variant="primary" onClick={() => leave?.()}>放弃更改</Btn>
          </>
        }
      >
        <p>已填写的内容将不会被保存。</p>
      </Dialog>
    </div>
  );
}
