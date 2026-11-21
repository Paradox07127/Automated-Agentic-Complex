import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import type { ActiveRun, Conversation, Question, Task, WireTurn } from '../../domain';
import { resumeOf, StopConfirm, TaskDrawer } from '../../features/task';
import { useToast } from '../../shell/toast';
import { useDemo } from '../../shell/demo';
import { Btn, Dialog, Empty, ErrBar, Skel } from '../../ui';
import { emptyLocal, type TasksLocal } from '../tasks/model';
import { navigate } from '../../shell/nav';
import { createChatActions } from './actions';
import { AllLines, useHistory } from './AllLines';
import { ChatBar } from './ChatBar';
import { ChatReadBanner } from './ChatReadBanner';
import { ChatTrack } from './ChatTrack';
import { Composer, type SendOptions } from './Composer';
import { ConvList, whenOf } from './ConvList';
import { DeleteDialog, RenameDialog } from './ConvDialogs';
import { DlgHead } from './DlgHead';
import { LiveTail } from './LiveTail';
import { manageItems } from './manage';
import { MessageList } from './MessageList';
import { ChatEmpty, useChatMotion } from './motion';
import { initialRp, RightPanel, type Rp } from './RightPanel';
import { RunItems } from './RunItems';
import { chatStream, runEndLabel } from './stream';
import { TurnInspector } from './TurnInspector';
import { resultOf } from './turnTrace';
import { clock, demoQuery, kernelState, useChatTasks, useConversations, useLookOff, useRole, useRuntime, useTurns } from './useChatData';
import { useChatFeed } from './useChatFeed';
import { useChatReceipts, useChatTaskView } from './useChatTaskView';
import { demoSource, hourlyOf, learnedOf, useTraceRow, useTraceRows, useTurnFacts, useTurnTrace } from './useTurnData';
import styles from './Chat.module.css';
import { useBottomPin } from './useBottomPin';


export function ChatPage() {
  const { state, demo, still } = useDemo();
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const q = useMemo(() => new URLSearchParams(search), [search]);
  const off = state === 'loading' || state === 'empty';
  const live = !off && state !== 'error';
  const src = demoSource(demo);
  const now = clock();
  const convs = useConversations(state === 'error', !off, demoQuery(demo === 'sparse', '?demo=sparse'));
  const role = useRole();
  const [picked, setPicked] = useState<string | null>(q.get('conv'));
  const list = state === 'empty' ? [] : (convs.data?.conversations ?? []);
  const archived = convs.data?.archived ?? [];
  const current = (picked ? [...list, ...archived].find((c) => c.id === picked) : undefined) ?? list.find((c) => c.active) ?? list[0] ?? null;
  const conv = current?.id ?? null;
  const history = current != null && !current.active;
  const turns = useTurns(live ? conv : null);
  const { query: tasksQ, refetch: refetchTasks } = useChatTasks(conv, live);
  const { query: runtime, recheck: recheckRuntime } = useRuntime(demo === 'kernel', live);
  const lookOff = useLookOff(live);
  const traceRows = useTraceRows(live, src);
  const facts = useTurnFacts(live, src);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { hist, turns: historyTurns } = useHistory(live && historyOpen, src);
  const [local, setLocal] = useState<TasksLocal>(emptyLocal);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [cancelled, setCancelled] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<{ text: string; reason: string; code?: string; options?: SendOptions } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busyDecide, setBusyDecide] = useState(false);
  const [rp, setRp] = useState<Rp>(() => initialRp(demo, q.get('turn')));
  const [stopAsk, setStopAsk] = useState<{ run: Pick<ActiveRun, 'run_id' | 'generation'>; task: Task | null; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState<{ text: string } | null>(null);
  const push = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const motion = useChatMotion(conv, still);

  const feed = useChatFeed(conv, {
    turns: () => {
      void turns.query.refetch();
      void traceRows.refetch();
      void convs.refetch();
      if (historyOpen) void hist.refetch();
    },
    tasks: () => refetchTasks(),
    reload: () => {
      void convs.refetch();
      void turns.query.refetch();
      refetchTasks();
      void traceRows.refetch();
      if (historyOpen) void hist.refetch();
    },
  });

  useEffect(() => {
    setPicked(q.get('conv'));
    setLocal(emptyLocal());
    setFailed(demo === 'sendfail' ? { text: 'HostLink 断线那次提交，能把 diff 发我看看吗？', reason: '后台服务无响应' } : null);
    setAnswered({});
    setCancelled({});
    setStopAsk(null);
    setRp(initialRp(demo, q.get('turn')));
  }, [q, demo]);

  // A failed line and the notice belong to the conversation they were sent in; null → id is the first line opening one.
  const shownConv = useRef(conv);
  useEffect(() => {
    if (shownConv.current != null && shownConv.current !== conv) {
      setFailed(null);
      setNotice(null);
    }
    shownConv.current = conv;
  }, [conv]);

  const { view, convTasks, task, run, livePlan, headerRun, defaultTask } = useChatTaskView(tasksQ.data, local, conv, feed.plans, rp?.taskId ?? null);
  const activeTurn = tasksQ.data?.activeTurn;
  const stopTarget = activeTurn ?? headerRun;
  const stopTask = stopTarget?.run_id === headerRun?.run_id ? defaultTask : null;
  const receipt = useChatReceipts(tasksQ.data, conv, () => refetchTasks());
  const topBusy = convs.data?.busy ?? false;
  const owner = tasksQ.data?.runConversation ?? {};
  const requests: Question[] = (tasksQ.data?.base.questions ?? []).filter((r) => (r.conversation_id ?? owner[r.run_id ?? '']) === conv);
  const messages = chatStream(turns.messages, convTasks, requests, feed.allowedTools);
  const replies = feed.replies.filter((r) => r.conversation_id === conv && !turns.turnIds.has(r.line_id));
  const { selected, kernel, alternative } = kernelState(runtime.data);
  const findRequest = (id: string) => requests.find((r) => r.id === id);

  // Turn ordinals: the loaded turns are the newest of `turn_count`.
  const wire: WireTurn[] = [...(turns.query.data?.pages ?? [])].reverse().flatMap((p) => p.turns);
  const total = Math.max(current?.turn_count ?? 0, wire.length);
  const ordinal = (turnId: string) => {
    const index = wire.findIndex((w) => w.turn_id === turnId);
    return index < 0 ? 0 : total - (wire.length - 1 - index);
  };
  const rowOf = (turnId: string | null | undefined) => (turnId ? (traceRows.data?.get(turnId) ?? null) : null);
  const memsOf = (turnId: string | undefined) => ({ mems: (turnId && facts.data?.get(turnId)) || [], learned: turnId ? learnedOf(src, turnId) : [] });
  const selTurn = rp?.tab === 'turn' ? (rp.turn ?? [...wire].reverse().find((w) => w.turn_id)?.turn_id ?? null) : null;
  const recentRow = rowOf(selTurn);
  const exactRow = useTraceRow(selTurn, 'turn_id', live && src == null && recentRow == null);
  const selRow = recentRow ?? exactRow.data ?? null;
  const inspected = useTurnTrace(selRow, selTurn ? ordinal(selTurn) : 0, memsOf(selTurn ?? undefined).mems, src);

  useBottomPin(scroller, rp?.tab !== 'turn', [conv]);
  useEffect(() => {
    scroller.current?.querySelector('[data-sel]')?.scrollIntoView?.({ block: 'center' });
  }, [selTurn, messages.length, traceRows.data]);

  const actions = createChatActions({
    conv: current,
    task,
    run,
    view,
    runtime: runtime.data ?? null,
    busy: tasksQ.data?.frontRunning ?? false,
    setLocal,
    setAnswered,
    setCancelled,
    setFailed,
    setSending,
    setBusyDecide,
    setNotice,
    select: setPicked,
    addReply: feed.add,
    settleReply: feed.settle,
    reload: {
      list: () => void convs.refetch(),
      turns: () => void turns.query.refetch(),
      tasks: () => refetchTasks(),
      runtime: async (refresh?: boolean) => (refresh ? recheckRuntime() : (await runtime.refetch()).data),
    },
    push,
    failSend: demo === 'sendfail',
  });

  const manage = (c: Conversation) =>
    manageItems(c, topBusy, { restore: () => void actions.restore(c), pin: () => void actions.pin(c), archive: () => void actions.archive(c), rename: () => setRenaming(c), remove: () => setDeleting(c) });

  const deliveries = task && view ? view.deliveries.filter((d) => d.task_id === task.id) : [];
  const delivery = [...deliveries].sort((a, b) => b.version - a.version)[0] ?? null;
  const canTask = task != null && view != null && state == null;
  const empty = state === 'empty' || (convs.data != null && list.length === 0);
  const openTurn = (turnId: string) => setRp((r) => (r?.tab === 'turn' && (r.turn ?? selTurn) === turnId ? null : { tab: 'turn', turn: turnId }));
  const openTask = (taskId?: string) => {
    const id = taskId ?? defaultTask?.id;
    if (id) setRp({ tab: 'task', turn: null, taskId: id });
  };

  const retryLoad = () => {
    void convs.refetch();
    void turns.query.refetch();
    refetchTasks();
  };
  const modelError = failed?.code ?? replies.at(-1)?.error ?? rowOf(wire.at(-1)?.turn_id)?.error_code ?? (selected?.id === 'pi' && runtime.data?.info.error === 'pi_connection_missing' ? 'pi_connection_missing' : null);

  const roleName = role.data?.name ?? '角色';
  const nameOf = (id: string) => (role.data?.names[id] ?? roleName);
  const runEnd = feed.runEnd ? runEndLabel(feed.runEnd.phase, feed.runEnd.outcome) : null;
  const first = messages.find((m) => 'at' in m);
  const firstAt = first && 'at' in first ? first.at : null;
  const listFailed = convs.isError && !convs.data;
  let body;
  if (state === 'loading' || (convs.isPending && !off) || (live && conv != null && turns.query.isPending)) body = <Skel rows={6} />;
  else if (listFailed) body = <ErrBar message="读取对话失败：后台服务没有响应" onRetry={() => void convs.refetch()} />;
  else if (empty) body = null;
  else
    body = (
      <>
        {turns.query.hasNextPage && state == null ? (
          <div className={styles.older}>
            <Btn size="sm" variant="text" loading={turns.query.isFetchingNextPage} onClick={() => void turns.query.fetchNextPage()}>
              加载更早的消息
            </Btn>
          </div>
        ) : (
          firstAt != null && <div className={styles.older}>{`${whenOf(firstAt, now).includes('月') ? '' : '今天 '}${whenOf(firstAt, now)}`}</div>
        )}
        <MessageList
          messages={messages}
          view={view}
          frontRun={headerRun}
          roleName={roleName}
          requests={requests}
          roleId={role.data?.id ?? null}
          names={role.data?.names ?? {}}
          now={now}
          answered={answered}
          cancelled={cancelled}
          stopped={local.stopped}
          frontTitle={headerRun ? (defaultTask?.title ?? null) : null}
          turnOf={(id) => {
            const r = rowOf(id);
            return r && id ? { no: ordinal(id), res: resultOf(r.result, r.turn_state), ms: r.duration_ms, provider: r.provider ?? null, account_label: r.account_label ?? null } : null;
          }}
          memsOf={memsOf}
          selTurn={selTurn}
          openTaskId={rp?.tab === 'task' ? (task?.id ?? null) : null}
          onOpenDrawer={openTask}
          onReceipt={receipt}
          onAnswer={(id, a) => {
            const r = findRequest(id);
            if (r) void actions.answer(r, a);
          }}
          onCancelQuestion={(id) => {
            const r = findRequest(id);
            if (r) void actions.dismiss(r);
          }}
          onQueueSide={(t) => void actions.queueSide(t)}
          onTurn={openTurn}
          {...(!history && state == null && replies.length === 0 ? { onExample: (text: string) => setDraft({ text }) } : {})}
        />
        <LiveTail replies={replies} roleName={roleName} roleId={role.data?.id ?? null} frontTitle={headerRun ? (defaultTask?.title ?? null) : null} incomplete={feed.incomplete && replies.some((r) => !r.final)} runEnd={runEnd} onFront={openTask} onQueue={(t) => void actions.queueSide(t)} onRetry={(r) => void actions.resend(r.said, r.options)} />
      </>
    );

  const side = replies.filter((r) => r.side).map((r) => ({ id: r.line_id, t0: r.at, t1: r.final ? r.at + 4000 : now }));
  const right =
    rp && current && !empty && state == null ? (
      <RightPanel tab={rp.tab === 'task' && !canTask ? 'turn' : rp.tab} hasTask={canTask} turn={selTurn} onTab={(t) => setRp((r) => ({ ...r, tab: t, turn: r?.turn ?? null }))} onClose={() => setRp(null)}>
        {rp.tab === 'task' && canTask && task && view ? (
          <>
          <TaskDrawer
            key={`${task.id}-${demo ?? ''}`}
            task={task}
            effective={view.effective[task.id] ?? 'running'}
            now={now}
            delivery={delivery}
            deliveries={deliveries}
            activeRun={run}
            pending={view.pending.filter((p) => p.task_id === task.id)}
            planSource={livePlan ? 'live' : 'snapshot'}
            rejecting={demo === 'reject'}
            canReveal={getBridge().capabilities.revealInFinder}
            kernelName={selected?.name}
            busy={busyDecide}
            onOpenTask={() => navigate({ page: 'overview', sel: task.id })}
            onAction={(a) => void actions.onDrawer(a)}
            onReceipt={receipt}
          />
          {task.run_id && <>
            <RunItems key={task.run_id} runId={task.run_id} running={run != null} />
            <Btn size="sm" variant="text" onClick={() => task.run_id && navigate({ page: 'trace', turn: task.run_id })}>完整运行记录 ↗</Btn>
          </>}
          </>
        ) : (
          <>
            <TurnInspector tr={inspected.trace} st={selRow ? (inspected.query.isError ? 'error' : inspected.query.isPending ? 'loading' : 'ok') : (exactRow.isError ? 'error' : exactRow.isFetching ? 'loading' : 'empty')} emptyText={selTurn ? '这轮没有保留追踪事件。' : '选择一轮以查看详情'} onRetry={() => void (selRow ? inspected.query : exactRow).refetch()} />
            {selTurn && <RunItems key={selTurn} runId={selTurn} running={activeTurn?.run_id === selTurn} />}
          </>
        )}
      </RightPanel>
    ) : null;

  const pickLine = (t: WireTurn) => {
    const c = t.conversation_id ? [...list, ...archived].find((x) => x.id === t.conversation_id) : undefined;
    if (!c) return push('这句台词不属于现有对话');
    setHistoryOpen(false);
    setPicked(c.id);
    if (t.turn_id) setRp({ tab: 'turn', turn: t.turn_id });
  };

  return (
    <div ref={motion.ref} className={styles.root} data-page="chat" data-state={state ?? 'ok'} data-demo={demo ?? undefined} data-rp={right ? '' : undefined}>
      <ChatBar
        title={empty || state != null ? null : (current?.title ?? null)}
        history={history}
        archived={current?.archived ?? false}
        elsewhere={topBusy && !stopTarget}
        run={empty ? null : headerRun}
        canStop={stopTarget != null}
        doneSteps={headerRun?.plan?.steps.filter((s) => s.status === 'completed').length ?? 0}
        totalSteps={headerRun?.plan?.steps.length ?? 0}
        manage={current && !empty ? manage(current) : null}
        onHistory={() => setHistoryOpen(true)}
        onStop={() => {
          if (stopTarget) setStopAsk({ run: stopTarget, task: stopTask, title: stopTask?.title ?? current?.title ?? '当前对话' });
        }}
      />
      <aside className={styles.list} data-g="list">
        {/* A failed list read shows once, in the message area. */}
        {state === 'loading' ? (
          <Skel rows={5} />
        ) : listFailed ? null : (
          <ConvList
            conversations={list}
            archived={archived}
            selected={current?.id ?? null}
            busy={topBusy}
            now={now}
            hourly={hourlyOf(traceRows.data?.values() ?? [], now)}
            roleId={role.data?.id ?? null}
            onSelect={(id) => {
              setPicked(id);
              setRp(null);
            }}
            onNew={() => void actions.newConversation()}
            manageItems={manage}
            onOpenArchived={(id) => { setPicked(id); setRp(null); }}
          />
        )}
      </aside>
      <section className={styles.thread} aria-label="消息" data-g="dialog">{motion.node}
        {current && !empty && state == null && <DlgHead title={current.title} turns={current.turn_count} />}
        {convs.data && state !== 'empty' && <ChatReadBanner errors={[convs.error, turns.query.error, tasksQ.error]} disconnected={convs.data.offline} readAt={convs.dataUpdatedAt} onRetry={retryLoad} />}
        {current && !history && !empty && state == null && <ChatTrack now={now} front={headerRun && defaultTask ? { id: headerRun.run_id, title: defaultTask.title, started_at: headerRun.started_at } : null} side={side} onFront={openTask} onSide={(id) => scroller.current?.querySelector(`[data-live="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })} />}
        {empty ? (
          <ChatEmpty still={still}>
            <Empty icon="send" title="还没有对话" action={<Btn variant="primary" icon="plus" tail="plus" onClick={() => void actions.newConversation()}>新建对话</Btn>} />
          </ChatEmpty>
        ) : (
          <div className={styles.msgs} ref={scroller} data-g="messages">
            <div className={styles.col}>{body}</div>
          </div>
        )}
        {((current != null && state == null && !empty) || listFailed) && (
          <div className={styles.compose} data-g="composer">
            <Composer
              roleName={roleName} modelError={modelError}
              history={history}
              archived={current?.archived ?? false}
              busy={topBusy}
              sideHint={(tasksQ.data?.frontRunning ?? false) && !right}
              quietSend={right != null && rp?.tab === 'task' && canTask}
              kernel={kernel}
              alternative={alternative}
              failed={failed}
              sending={sending}
              notice={notice}
              lookOff={lookOff.data ?? null}
              onSend={(t, o) => void actions.send(t, o)}
              onResend={() => failed && void actions.resend(failed.text, failed.options)}
              onDiscardFailed={() => setFailed(null)}
              onContinue={() => current && void actions.activate(current)}
              onRestore={() => current && void actions.restore(current)}
              onRecheck={() => void actions.recheck()}
              onCopy={(c) => void actions.copy(c)}
              {...(getBridge().capabilities.runInTerminal ? { onRunInTerminal: (c: string) => void actions.runInTerminal(c) } : {})}
              onSwitchKernel={(id) => void actions.switchKernel(id)}
              draft={draft}
            />
          </div>
        )}
      </section>
      {right}
      <Dialog open={historyOpen} title="历史记录" onClose={() => setHistoryOpen(false)}>
        <AllLines turns={historyTurns} roleName={nameOf} now={now} loading={hist.isPending} error={hist.isError} more={hist.hasNextPage} fetchingMore={hist.isFetchingNextPage} onPick={pickLine} onMore={() => void hist.fetchNextPage()} onRetry={() => void hist.refetch()} />
      </Dialog>
      <StopConfirm
        open={stopAsk != null}
        target={stopAsk?.title ?? ''}
        resume={resumeOf(stopAsk?.task ? [stopAsk.task] : [])}
        onCancel={() => setStopAsk(null)}
        onConfirm={() => {
          setStopAsk(null);
          if (stopAsk) void actions.stop(stopAsk.run, stopAsk.title);
        }}
      />
      <RenameDialog conv={renaming} onClose={() => setRenaming(null)} onRename={(c, t) => void actions.rename(c, t)} />
      <DeleteDialog conv={deleting} onClose={() => setDeleting(null)} onDelete={(c) => void actions.remove(c)} />
    </div>
  );
}
