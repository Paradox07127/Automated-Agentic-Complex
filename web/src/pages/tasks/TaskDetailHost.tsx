// Tasks data, local overrides and actions behind the task list and the detail sheet; the tasks page and 今天 share them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import type { Approval, Delivery, Question } from '../../domain';
import { DECIDE_FAIL, resumeOf, StopConfirm, type DecideFailCode } from '../../features/task';
import type { DemoState } from '../../shell/demo';
import { useToast } from '../../shell/toast';
import { joinTasks, PENDING_KEY, usePending, type PendingBase, type TasksList, type TasksListPage } from '../../data/tasksBase';
import { Select } from '../../ui';
import { createTasksActions, NATIVE_OFF, type NativeOff } from './actions';
import { buildCards, sortCards, useBoard, type CardHistory } from './board';
import { CreateDialog } from './CreateDialog';
import type { CreateDraft } from './CreateForm';
import { demo as slot } from './demoSlot';
import { CodeSections, DetailSheet, SessionHead } from './DetailSheet';
import { useClock, useReceipts } from './live';
import { deriveView, emptyLocal, withPlans, type TasksLocal } from './model';
import { navigate } from './params';
import { PendingDetail } from './PendingDetail';
import { SelectedTask } from './SelectedTask';
import { useKernelName, useTasksFeed, useTasksList, type TaskExtras } from './useTasksData';
import styles from './Page.module.css';

const EMPTY_LIST: TasksList = { tasks: [], deliveries: [], sessions: [], goals: [], activeRuns: {}, roleMissing: false };
const NO_PENDING: PendingBase = { approvals: [], questions: [] };

/** `tools` highlights the Write tool in the open task's tool chart. */
export function useTaskDesk(state: DemoState | null, demo: string | null, tools: boolean) {
  const fake = typeof window !== 'undefined' && !window.agenticComplex;
  const loading = state === 'loading';
  const roleFail = state === 'error';
  const live = !loading && state !== 'empty';
  const list = useTasksList(roleFail, live, demo);
  const pend = usePending(live);
  const queryClient = useQueryClient();
  const now = useClock();
  const board = useBoard(now, live);
  const kernel = useKernelName();
  // The rest of the pages are read after the first, from the first's cursors.
  const { key } = list;
  const reload = useCallback(() => {
    return Promise.all([
      queryClient.refetchQueries({ queryKey: key, exact: true }).then(() => queryClient.refetchQueries({ queryKey: [...key, 'rest'], exact: true })),
      queryClient.refetchQueries({ queryKey: PENDING_KEY }),
      queryClient.invalidateQueries({ queryKey: ['task-extras'] }),
      queryClient.invalidateQueries({ queryKey: ['session-lines'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks-board'] }),
    ]);
  }, [queryClient, key]);
  const selectedRun = useRef<(runId: string) => boolean>(() => false);
  const plans = useTasksFeed((what) => (what === 'base' ? reload() : queryClient.invalidateQueries({ queryKey: ['task-extras'] })), (runId) => selectedRun.current(runId));
  useEffect(() => {
    // Task events can arrive while another page owns the window. Read again after reconnecting the feed.
    if (live && queryClient.getQueryData(key)) void reload();
  }, [key, live, queryClient, reload]);
  const listData = loading ? undefined : state === 'empty' ? EMPTY_LIST : list.data;
  const pendData = loading ? undefined : state === 'empty' ? NO_PENDING : pend.data;
  const listReady = listData != null;
  const pendReady = pendData != null;
  const data = useMemo(() => (listData || pendData ? withPlans(joinTasks(listData ?? EMPTY_LIST, pendData ?? NO_PENDING), plans) : null), [listData, pendData, plans]);
  // A receipt's reply carries the delivery's next revision; put it where the next decision reads it.
  const patchDelivery = useCallback(
    (d: Delivery) =>
      queryClient.setQueriesData<TasksListPage>({ queryKey: ['tasks-page', roleFail, demo] }, (b) =>
        b ? { ...b, deliveries: b.deliveries.map((x) => (x.id === d.id ? d : x)), tasks: b.tasks.map((t) => (t.delivery?.id === d.id ? { ...t, delivery: d, revision: d.revision } : t)) } : b,
      ),
    [queryClient, roleFail, demo],
  );
  const receipt = useReceipts(data?.deliveries ?? [], patchDelivery, reload);
  const [local, setLocal] = useState<TasksLocal>(emptyLocal);
  const [open, setOpen] = useState<string | null>(null);
  const [stopIds, setStopIds] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [failCode, setFailCode] = useState<DecideFailCode>('delivery_superseded');
  const [decideFail, setDecideFail] = useState<DecideFailCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [nativeOff, setNativeOff] = useState<NativeOff>({});
  const push = useToast();

  const view = useMemo(() => (data ? deriveView(data, local) : null), [data, local]);
  const sparse = fake && demo === 'sparse';
  const history = (id: string): CardHistory | undefined => (fake && demo === 'full' ? slot.history?.[id] : undefined);
  const all = useMemo(() => (view ? sortCards(buildCards(view, live ? board.data : undefined, now)) : []), [view, live, board.data, now]);
  const cards = sparse ? all.filter((c) => c.status === 'tool').slice(0, 1) : all;
  const pending = view && !sparse ? view.pending : [];
  const resolveCard = (id: string) => cards.find((c) => c.id === id || c.taskId === id) ?? null;

  const pendingIds = pending.map((p) => p.id);
  const actions = view
    ? createTasksActions({
        view,
        setLocal,
        push,
        order: pendingIds,
        select: (id, _tab, focus) => {
          setDecideFail(null);
          if (focus) setOpen((o) => (o && pendingIds.includes(o) ? null : o));
          else if (id) setOpen(view.pending.find((p) => p.id === id && p.kind === 'review')?.task_id ?? id);
        },
        failCode: demo === 'decidefail' ? failCode : null,
        setDecideFail,
        setBusy,
        askStop: setStopIds,
        retrySteps: () => setRetry((r) => r + 1),
        reload,
        now: () => now,
        nativeOff: (entry) => setNativeOff((o) => ({ ...o, [entry]: NATIVE_OFF[entry] })),
      })
    : null;

  // Detail sheet: a pending approval or question, else a card or task.
  const openP = view?.pending.find((p): p is Approval | Question => p.id === open && p.kind !== 'review') ?? null;
  const openC = open ? (resolveCard(open) ?? all.find((c) => c.id === open) ?? null) : null;
  const openT = view?.tasks.find((t) => t.id === (openC ? openC.taskId : open)) ?? null;
  selectedRun.current = (runId) =>
    openT != null &&
    (view?.activeRuns[openT.id]?.run_id === runId ||
      queryClient.getQueriesData<TaskExtras>({ queryKey: ['task-extras', openT.id] }).some(([, x]) => !!x && (x.steps.some((s) => s.run_id === runId) || x.runs.some((r) => r.run_id === runId))));

  return {
    demo,
    tools,
    loading,
    live,
    now,
    list,
    pend,
    kernel,
    data,
    view,
    listReady,
    pendReady,
    reload,
    receipt,
    push,
    local,
    all,
    cards,
    pending,
    resolveCard,
    history,
    actions,
    open,
    setOpen,
    stopIds,
    setStopIds,
    draft,
    setDraft,
    failCode,
    setFailCode,
    decideFail,
    setDecideFail,
    busy,
    retry,
    nativeOff,
    openP,
    openC,
    openT,
  };
}

export type TaskDesk = ReturnType<typeof useTaskDesk>;

/** The open item's detail sheet, the stop confirmation and the 新建 dialog. */
export function TaskDetailHost({ desk }: { desk: TaskDesk }) {
  const { demo, view, actions, now, local, openP, openC, openT, setOpen, push } = desk;
  let detail = null;
  if (view && actions && openP)
    detail = (
      <PendingDetail
        key={openP.id}
        item={openP}
        pending={view.pending}
        now={now}
        onApprove={(ids, d, mode, reason) => void actions.approve(ids, d, mode, reason)}
        onAnswer={(q, a) => void actions.answer(q, a)}
        onCancelQuestion={(q) => void actions.cancelQuestion(q)}
        onOpenSession={(a) => {
          const own = view.tasks.find((t) => t.id === a.task_id);
          if (own?.source === 'code') setOpen(own.id);
          else void actions.jump(a.session_id);
        }}
        sessionOff={openP.kind === 'approval' && view.tasks.find((t) => t.id === openP.task_id)?.source !== 'code' ? desk.nativeOff.jump : undefined}
        onOpenChat={(c) => navigate({ page: 'chat', conv: c })}
        onMouseOnly={() => push('危险操作只能用鼠标点「批准」；回车不会批准')}
      />
    );
  else if (view && actions && (openC || openT))
    detail = (
      <>
        {demo === 'decidefail' && (
          <div className={styles.demo}>
            演示失败码
            <Select
              label="演示失败码"
              width={220}
              value={desk.failCode}
              onChange={(v) => {
                desk.setFailCode(v as DecideFailCode);
                desk.setDecideFail(v as DecideFailCode);
              }}
              options={Object.entries(DECIDE_FAIL).map(([k, v]) => ({ value: k, label: v.text }))}
            />
          </div>
        )}
        {openT ? (
          <SelectedTask
            key={openT.id}
            task={openC && openT.source === 'ext' ? { ...openT, title: openC.title } : openT}
            view={view}
            now={now}
            stoppedAt={local.stopped[openT.id] ?? null}
            stepsFail={demo === 'steps-404'}
            retry={desk.retry}
            toolFocus={desk.tools ? 'Write' : null}
            decideFail={desk.decideFail}
            busy={desk.busy}
            kernelName={desk.kernel.data ?? undefined}
            canReveal={getBridge().capabilities.revealInFinder}
            nativeOff={desk.nativeOff}
            onReceipt={desk.receipt}
            onAction={actions.onTask(openT)}
            onReview={(verdict) => void actions.review(openT, verdict)}
          />
        ) : (
          openC && <SessionHead card={openC} now={now} />
        )}
        {openC && openC.tool !== 'role' && <CodeSections card={openC} history={desk.history(openC.id)} now={now} />}
      </>
    );
  const stopIds = desk.stopIds;
  const stopTasks = view && stopIds ? view.tasks.filter((t) => stopIds.includes(t.id)) : [];

  return (
    <>
      {detail && (openC || openT || openP) && (
        <DetailSheet title={openP?.title ?? openC?.title ?? openT?.title ?? ''} tool={openP ? null : (openC?.tool ?? (openT?.source === 'role' ? 'role' : null))} onClose={() => setOpen(null)}>
          {detail}
        </DetailSheet>
      )}
      <StopConfirm
        open={stopTasks.length > 0}
        target={stopTasks.length === 1 ? (stopTasks[0]?.title ?? '') : stopTasks.length}
        resume={resumeOf(stopTasks)}
        onCancel={() => desk.setStopIds(null)}
        onConfirm={() => {
          const ids = stopTasks.filter((t) => t.source !== 'ext').map((t) => t.id);
          desk.setStopIds(null);
          void actions?.stopNow(ids);
        }}
      />
      <CreateDialog
        draft={desk.draft}
        setDraft={desk.setDraft}
        goals={view?.goals ?? []}
        push={push}
        onCreated={(id) => {
          void desk.reload();
          if (id) setOpen(id);
        }}
      />
    </>
  );
}
