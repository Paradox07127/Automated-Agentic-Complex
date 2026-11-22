import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import type { ActiveRun, Conversation, Question, Task, WireTurn } from '../../domain';
import { resumeOf, StopConfirm, TaskDrawer } from '../../features/task';
import { useToast } from '../../shell/toast';
import { useDemo } from '../../shell/demo';
import { Btn, Empty, ErrBar, Skel, type MenuItem } from '../../ui';
import { emptyLocal, type TasksLocal } from '../tasks/model';
import { navigate } from '../../shell/nav';
import { createChatActions } from './actions';
import { CharTabs } from './CharTabs';
import { ChatBar } from './ChatBar';
import { ChatReadBanner } from './ChatReadBanner';
import { Composer, type SendOptions } from './Composer';
import { DeleteCard, SwapCard } from './ConvDialogs';
import { ConvList, whenOf } from './ConvList';
import { DlgHead } from './DlgHead';
import { LiveTail } from './LiveTail';
import { manageItems } from './manage';
import { MessageList } from './MessageList';
import { ChatEmpty, useChatMotion } from './motion';
import { initialRp, RightPanel, type Rp } from './RightPanel';
import { RunItems } from './RunItems';
import { chatStream, runEndLabel } from './stream';
import { clock, demoQuery, kernelState, useCharacters, useChatTasks, useConversations, useLookOff, usePresent, useRuntime, useTurns, type ChatCharacter } from './useChatData';
import { useChatFeed } from './useChatFeed';
import { useChatReceipts, useChatTaskView } from './useChatTaskView';
import { demoSource, learnedOf, useTraceRows, useTurnFacts } from './useTurnData';
import styles from './Chat.module.css';
import { useBottomPin } from './useBottomPin';
import { useFold, useSwapAsk } from './useFrame';

export function ChatPage() {
  const { state, demo, still } = useDemo();
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const q = useMemo(() => new URLSearchParams(search), [search]);
  const qc = useQueryClient();
  const off = state === 'loading' || state === 'empty';
  const live = !off && state !== 'error';
  const src = demoSource(demo);
  const now = clock();
  const chars = useCharacters();
  const presentQ = usePresent();
  const present = presentQ.data ?? null;
  const [pickedChar, setPickedChar] = useState<string | null>(null);
  const charList = chars.data?.list ?? [];
  const character = pickedChar ?? present ?? chars.data?.shown ?? charList[0]?.id ?? null;
  const who = charList.find((c) => c.id === character);
  const convs = useConversations(character, state === 'error', !off, demoQuery(demo === 'sparse', '&demo=sparse'));
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
  const [local, setLocal] = useState<TasksLocal>(emptyLocal);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [cancelled, setCancelled] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<{ text: string; reason: string; code?: string; options?: SendOptions } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [busyDecide, setBusyDecide] = useState(false);
  const [rp, setRp] = useState<Rp>(() => initialRp(demo));
  const [stopAsk, setStopAsk] = useState<{ run: Pick<ActiveRun, 'run_id' | 'generation'>; task: Task | null; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ files: File[] } | null>(null);
  const { folded, toggle } = useFold();
  const { swapAsk, ask, answer } = useSwapAsk(charList, present, (text) => setDraft({ text }));
  const push = useToast();
  const scroller = useRef<HTMLDivElement>(null);
  const motion = useChatMotion(conv, still);

  const feed = useChatFeed(conv, {
    turns: () => {
      void turns.query.refetch();
      void traceRows.refetch();
      void convs.refetch();
    },
    tasks: () => refetchTasks(),
    reload: () => {
      void convs.refetch();
      void turns.query.refetch();
      refetchTasks();
      void traceRows.refetch();
    },
  });

  useEffect(() => {
    setPicked(q.get('conv'));
    setLocal(emptyLocal());
    setFailed(demo === 'sendfail' ? { text: 'HostLink 断线那次提交，能把 diff 发我看看吗？', reason: '后台服务无响应' } : null);
    setAnswered({});
    setCancelled({});
    setStopAsk(null);
    setRp(initialRp(demo));
  }, [q, demo]);

  // A failed line, the notice and the quote belong to the conversation they were made in; null → id is the first line opening one.
  const shownConv = useRef(conv);
  useEffect(() => {
    if (shownConv.current != null && shownConv.current !== conv) {
      setFailed(null);
      setNotice(null);
      setQuote(null);
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
  const { selected, kernel } = kernelState(runtime.data);
  const findRequest = (id: string) => requests.find((r) => r.id === id);

  const wire: WireTurn[] = [...(turns.query.data?.pages ?? [])].reverse().flatMap((p) => p.turns);
  const rowOf = (turnId: string | null | undefined) => (turnId ? (traceRows.data?.get(turnId) ?? null) : null);
  const memsOf = (turnId: string | undefined) => ({ mems: (turnId && facts.data?.get(turnId)) || [], learned: turnId ? learnedOf(src, turnId) : [] });

  useBottomPin(scroller, true, [conv]);

  const actions = createChatActions({
    conv: current,
    character,
    present,
    askSwap: (text) => (who ? ask(who, text) : Promise.resolve(false)),
    task,
    run,
    view,
    busy: tasksQ.data?.frontRunning ?? false,
    setLocal,
    setAnswered,
    setCancelled,
    setFailed,
    setSending,
    setBusyDecide,
    setNotice,
    select: setPicked,
    editTitle: setRenaming,
    addReply: feed.add,
    settleReply: feed.settle,
    reload: {
      list: () => void qc.invalidateQueries({ queryKey: ['chat-convs'] }),
      turns: () => void turns.query.refetch(),
      tasks: () => refetchTasks(),
      present: () => void presentQ.refetch(),
      runtime: async (refresh?: boolean) => (refresh ? recheckRuntime() : (await runtime.refetch()).data),
    },
    push,
    failSend: demo === 'sendfail',
  });

  const manage = (c: Conversation) =>
    manageItems(c, topBusy, { restore: () => void actions.restore(c), pin: () => void actions.pin(c), archive: () => void actions.archive(c), rename: () => setRenaming(c.id), remove: () => setDeleting(c) });

  const pickChar = (id: string) => {
    setPickedChar(id);
    setPicked(null);
    setRp(null);
    setRenaming(null);
  };
  const tabMenu = (c: ChatCharacter): MenuItem[] => [
    {
      kind: 'item',
      label: '新话题',
      onSelect: () => {
        pickChar(c.id);
        void actions.newConversation(c.id);
      },
    },
    { kind: 'item', label: `换${c.name}出来`, disabled: c.id === present, reason: `${c.name}已在桌面`, onSelect: () => void ask(c, '').then((yes) => { if (yes) void actions.swap(c.id, c.name); }) },
    { kind: 'item', label: '她的专属记忆', onSelect: () => navigate({ page: 'memory', view: 'about' }) },
  ];
  const openTopic = (c: Conversation) => {
    setPicked(c.id);
    setRp(null);
    // While she works agentd refuses it; the row opens read-only with 继续此对话 waiting for her.
    if (!c.active && !c.archived && !topBusy) void actions.activate(c);
  };

  const deliveries = task && view ? view.deliveries.filter((d) => d.task_id === task.id) : [];
  const delivery = [...deliveries].sort((a, b) => b.version - a.version)[0] ?? null;
  const canTask = task != null && view != null && state == null;
  const empty = state === 'empty' || (convs.data != null && list.length === 0);
  const openTask = (taskId?: string) => {
    const id = taskId ?? defaultTask?.id;
    if (id) setRp({ taskId: id });
  };

  const retryLoad = () => {
    void convs.refetch();
    void turns.query.refetch();
    refetchTasks();
  };
  const modelError = failed?.code ?? replies.at(-1)?.error ?? rowOf(wire.at(-1)?.turn_id)?.error_code ?? (selected?.id === 'pi' && runtime.data?.info.error === 'pi_connection_missing' ? 'pi_connection_missing' : null);

  const roleName = who?.name ?? '角色';
  const headUrl = who?.head ? { headUrl: who.head } : {};
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
          roleId={character}
          names={chars.data?.names ?? {}}
          {...headUrl}
          now={now}
          answered={answered}
          cancelled={cancelled}
          stopped={local.stopped}
          frontTitle={headerRun ? (defaultTask?.title ?? null) : null}
          memsOf={memsOf}
          openTaskId={rp != null ? (task?.id ?? null) : null}
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
          onQuote={setQuote}
          onOpenTrace={(turn) => navigate({ page: 'trace', turn })}
          {...(!history && state == null && replies.length === 0 ? { onExample: (text: string) => setDraft({ text }) } : {})}
        />
        <LiveTail replies={replies} roleName={roleName} {...headUrl} roleId={character} frontTitle={headerRun ? (defaultTask?.title ?? null) : null} incomplete={feed.incomplete && replies.some((r) => !r.final)} runEnd={runEnd} onFront={openTask} onQueue={(t) => void actions.queueSide(t)} onRetry={(r) => void actions.resend(r.said, r.options)} onQuote={setQuote} onOpenTrace={(turn) => navigate({ page: 'trace', turn })} />
      </>
    );

  const right =
    rp && current && !empty && canTask && task && view ? (
      <RightPanel onClose={() => setRp(null)}>
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
        {task.run_id && (
          <>
            <RunItems key={task.run_id} runId={task.run_id} running={run != null} />
            <Btn size="sm" variant="text" onClick={() => task.run_id && navigate({ page: 'trace', turn: task.run_id })}>完整运行记录 ↗</Btn>
          </>
        )}
      </RightPanel>
    ) : null;

  return (
    <div ref={motion.ref} className={styles.root} data-page="chat" data-state={state ?? 'ok'} data-demo={demo ?? undefined} data-rp={right ? '' : undefined} data-fold={folded || undefined}>
      <ChatBar
        tabs={<CharTabs chars={charList} selected={character} present={present} onPick={pickChar} menuFor={tabMenu} />}
        status={current != null && !empty && state == null}
        elsewhere={topBusy && !stopTarget}
        run={empty ? null : headerRun}
        canStop={stopTarget != null}
        doneSteps={headerRun?.plan?.steps.filter((s) => s.status === 'completed').length ?? 0}
        totalSteps={headerRun?.plan?.steps.length ?? 0}
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
            who={roleName}
            conversations={list}
            archived={archived}
            selected={current?.id ?? null}
            busy={topBusy}
            now={now}
            folded={folded}
            onFold={toggle}
            onSelect={openTopic}
            onNew={() => void actions.newConversation()}
            manageItems={manage}
            renaming={renaming}
            onRenaming={setRenaming}
            onRename={(c, t) => void actions.rename(c, t)}
            onDelete={setDeleting}
          />
        )}
      </aside>
      <section
        className={styles.thread}
        aria-label="消息"
        data-g="dialog"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          setDropped({ files: [...e.dataTransfer.files] });
        }}
      >
        {motion.node}
        {current && !empty && state == null && <DlgHead title={current.title} />}
        {convs.data && state !== 'empty' && <ChatReadBanner errors={[convs.error, turns.query.error, tasksQ.error]} disconnected={convs.data.offline} readAt={convs.dataUpdatedAt} onRetry={retryLoad} />}
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
              quietSend={right != null}
              kernel={kernel}
              failed={failed}
              sending={sending}
              notice={notice}
              lookOff={lookOff.data ?? null}
              topicId={current?.id}
              quote={quote}
              onClearQuote={() => setQuote(null)}
              onSend={(t, o) => void actions.send(t, o)}
              onResend={() => failed && void actions.resend(failed.text, failed.options)}
              onDiscardFailed={() => setFailed(null)}
              onContinue={() => current && void actions.activate(current)}
              onRestore={() => current && void actions.restore(current)}
              onRecheck={() => void actions.recheck()}
              draft={draft}
              dropped={dropped}
            />
          </div>
        )}
      </section>
      {right}
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
      <DeleteCard conv={deleting} onClose={() => setDeleting(null)} onArchive={(c) => void actions.archive(c)} onDelete={(c) => void actions.remove(c)} />
      <SwapCard ask={swapAsk} onPick={answer} />
    </div>
  );
}
