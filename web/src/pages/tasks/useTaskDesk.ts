// Tasks data, local overrides and actions behind the task page's 进行中 and 已完成.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Delivery } from '../../domain';
import type { DecideFailCode } from '../../features/task';
import type { DemoState } from '../../shell/demo';
import { useToast } from '../../shell/toast';
import { joinTasks, PENDING_KEY, usePending, type PendingBase, type TasksList, type TasksListPage } from '../../data/tasksBase';
import { createTasksActions, NATIVE_OFF, type NativeOff } from './actions';
import { buildCards, sortCards, useBoard } from './board';
import { useClock, useReceipts } from './live';
import { deriveView, emptyLocal, withPlans, type TasksLocal } from './model';
import { useKernelName, useTasksFeed, useTasksList, type TaskExtras } from './useTasksData';

const EMPTY_LIST: TasksList = { tasks: [], deliveries: [], sessions: [], goals: [], activeRuns: {}, roleMissing: false };
const NO_PENDING: PendingBase = { approvals: [], questions: [] };

/** `selected` is the task the page shows; its run's live events refresh its steps. */
export function useTaskDesk(state: DemoState | null, demo: string | null, selected: string | null) {
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
  const [stopIds, setStopIds] = useState<string[] | null>(null);
  const [decideFail, setDecideFail] = useState<DecideFailCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [nativeOff, setNativeOff] = useState<NativeOff>({});
  const push = useToast();

  const view = useMemo(() => (data ? deriveView(data, local) : null), [data, local]);
  const cards = useMemo(() => (view ? sortCards(buildCards(view, live ? board.data : undefined, now)) : []), [view, live, board.data, now]);
  const order = cards.flatMap((c) => (c.taskId ? [c.taskId] : []));

  const actions = view
    ? createTasksActions({
        view,
        setLocal,
        push,
        order,
        // The selection stays on the task after a decision; the page moves it when the task leaves the tab.
        select: () => setDecideFail(null),
        failCode: null,
        setDecideFail,
        setBusy,
        askStop: setStopIds,
        retrySteps: () => setRetry((r) => r + 1),
        reload,
        now: () => now,
        nativeOff: (entry) => setNativeOff((o) => ({ ...o, [entry]: NATIVE_OFF[entry] })),
      })
    : null;

  const openT = view?.tasks.find((t) => t.id === selected) ?? null;
  selectedRun.current = (runId) =>
    openT != null &&
    (view?.activeRuns[openT.id]?.run_id === runId ||
      queryClient.getQueriesData<TaskExtras>({ queryKey: ['task-extras', openT.id] }).some(([, x]) => !!x && (x.steps.some((s) => s.run_id === runId) || x.runs.some((r) => r.run_id === runId))));

  return {
    loading,
    live,
    now,
    list,
    pend,
    kernel,
    view,
    listReady: listData != null,
    pendReady: pendData != null,
    reload,
    receipt,
    push,
    local,
    cards,
    actions,
    stopIds,
    setStopIds,
    decideFail,
    busy,
    retry,
    nativeOff,
  };
}

export type TaskDesk = ReturnType<typeof useTaskDesk>;
