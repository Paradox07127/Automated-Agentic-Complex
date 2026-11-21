// `full` demo: the stage p50s, process CPU and memory history and online segments show only with the mock data.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { AgentdCallError, resetVoice } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';
import { formatAgo } from '../../domain/time';
import { formatClock, formatDuration, fromTraceTurn, type Turn, type WireVoice } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';
import { Btn, Dialog, Menu, PageIssues, type RegionSource } from '../../ui';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { useToast } from '../../shell/toast';
import { useGo, useNow, useParam } from '../overview/nav';
import { useTraceRow } from '../chat/useTurnData';
import { RunItems } from '../chat/RunItems';
import { demo as slot } from './demoSlot';
import { flowOf, liveEdgeOf, nodeOfKind, pathFromEvents, pathOf, type NodeId } from './flow';
import { FlowSection, useReplay } from './FlowSection';
import { HealthRow } from './Health';
import { inspectorOf } from './inspector';
import { InternalState } from './InternalState';
import { MemoryRunSheet } from './MemoryRunSheet';
import { localDay } from './model';
import { Processes } from './Processes';
import { renderWhy } from './renderWhy';
import { ToolBar } from './ToolBar';
import { Resources } from './Resources';
import { healthOf, issuesOf, processesOf, type DiagProcess, type ProcessKey } from './status';
import { TurnsSection } from './TurnsSection';
import { clock, STATE_KEY, type DiagSnap, useDiagState, useDiagStream, useFailEvents, useHourReads, useRenderStats, useSideReads, useTurnEvents, useTurns } from './useDiag';
import { CONFIRM, useDiagActions, type RestartTarget } from './useDiagActions';
import type { WireDiagItem } from './wire';
import styles from './Dg.module.css';

const HOUR = 3_600_000;
const asKey = (v: string | null): ProcessKey | null => (v === 'agentd' || v === 'avatar' || v === 'voice' ? v : null);
/** Trace kinds that add a turn to the list or settle one. */
const LIST_KINDS = new Set(['input.received', 'model.finished', 'playback.ended', 'playback.interrupted', 'cancel.acked', 'turn.settled']);
const USER = new Set(['text', 'voice']);

/** One short reason for a failed read; only `offline` means agentd is gone. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'unknown_trace') return '这一轮没有留下事件';
  if (e.code === 'no_trace') return '后台没有事件记录库';
  if (e.code === 'no_memory' || e.code === 'no_memory_journal') return '后台没有开启记忆';
  if (e.status === 0) return '请求没有发出';
  return `后台返回 ${e.status}`;
}

export function DiagPage() {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const toast = useToast();
  const qc = useQueryClient();
  const item = useParam('item');
  const selLink = useParam('sel');
  // An announcement or approval card links its trace; it opens that turn.
  const traceLink = useParam('trace');
  const obsParam = useParam('obs');
  const kindParam = useParam('kind');
  const runLink = useParam('run');
  // Only a 记忆生成 link names a memory run; a task's link sends its agent run id under the same key.
  const runParam = kindParam === 'memory' ? runLink : null;
  const agentRunParam = kindParam === 'memory' ? null : runLink;
  const selParam = selLink ?? traceLink ?? agentRunParam;
  const rngParam = useParam('rng');
  const full = demo === 'full';
  const [paused, setPaused] = useState(demo === 'paused');
  const [stateOpen, setStateOpen] = useState(item === 'state');
  const [highlight, setHighlight] = useState<ProcessKey | null>(asKey(item));
  const [turnId, setTurnId] = useState<string | null>(selParam);
  const [memRun, setMemRun] = useState<string | null>(runParam);
  const [range, setRange] = useState<'24h' | '7d'>(rngParam === '7d' ? '7d' : '24h');
  const [nodeF, setNodeF] = useState<NodeId | null>(null);
  const [confirm, setConfirm] = useState<RestartTarget | null>(demo === 'confirm' ? 'all' : null);

  const enabled = state !== 'loading';
  const base = useMemo(() => clock(), []);
  const now = useNow(base, still);
  const ds = useDiagState(enabled);
  const side = useSideReads(enabled);
  const turns = useTurns(range, enabled);
  const hour = useHourReads(enabled, localDay(base));
  const allTurns = turns.data?.turns ?? [];
  const recent = allTurns.find((t) => t.id === turnId || t.turn_id === turnId) ?? null;
  const exact = useTraceRow(recent?.id ?? turnId, recent || (traceLink === turnId && !selLink) ? 'trace_id' : 'turn_id', enabled && turns.isSuccess);
  const byTrace = useTraceRow(turnId, 'trace_id', enabled && turns.isSuccess && recent == null && traceLink !== turnId && exact.data === null);
  const exactRow = exact.data ?? byTrace.data ?? null;
  const sel = recent ?? (exactRow ? fromTraceTurn(exactRow) : null);
  const detail = useTurnEvents(sel?.id ?? null);
  const renderAvailable = getBridge().capabilities.avatar;
  const samples = useRenderStats(renderAvailable && !paused);
  const act = useDiagActions(now, toast);

  const selected = useRef(sel?.id);
  selected.current = sel?.id;
  const onItem = useCallback(
    (kind: 'trace' | 'decision', it: WireDiagItem) => {
      if (kind === 'decision') return void qc.invalidateQueries({ queryKey: ['diag', 'decisions'] });
      if (it.trace_id === selected.current) void qc.invalidateQueries({ queryKey: ['diag', 'turn', it.trace_id] });
      if (LIST_KINDS.has(it.kind)) void qc.invalidateQueries({ queryKey: ['diag', 'turns'] });
    },
    [qc],
  );
  useDiagStream(enabled && !paused, onItem);

  // 检测中 while the reset runs, then the state it answers; a failure rereads /diag/state.
  const reconnectVoice = useCallback(() => {
    const setTts = (v: Partial<WireVoice>) =>
      qc.setQueryData<DiagSnap>(STATE_KEY, (s) => s && { ...s, state: { ...s.state, connections: { ...s.state.connections, tts: { ...s.state.connections.tts, ...v } } } });
    setTts({ state: 'probing', retry_after_s: null });
    resetVoice().then(
      (r) => setTts(r.tts),
      (e: unknown) => {
        void qc.invalidateQueries({ queryKey: STATE_KEY });
        toast(`没能重新连接语音：${reasonOf(e)}`, { severity: 'danger', persistent: true });
      },
    );
  }, [qc, toast]);

  useEffect(() => {
    if (selParam) setTurnId(selParam);
    if (item === 'state') setStateOpen(true);
    if (asKey(item)) setHighlight(asKey(item));
  }, [selParam, item]);
  useEffect(() => {
    if (runParam) setMemRun(runParam);
  }, [runParam]);
  useEffect(() => {
    if (!highlight || still) return;
    const id = setTimeout(() => setHighlight(null), 1600);
    return () => clearTimeout(id);
  }, [highlight, still]);
  useEffect(() => {
    if (item === 'usage' && ds.data) document.getElementById('diag-usage')?.scrollIntoView({ block: 'center' });
  }, [item, ds.data]);

  const d = ds.data?.state ?? null;
  const connection = ds.isError ? 'offline' : (side.connection.data ?? 'connected');
  const sup = side.supervisor.data ?? null;
  const health = d || ds.isError ? healthOf(connection, side.runtime.data ?? null, sup, d, samples.at(-1)?.fps ?? null) : null;
  const offline = ds.isError || connection === 'offline';
  const staleAt = offline ? (ds.data?.at ?? 0) : null;
  // The time of the flow and process data shown while agentd is gone: its last state, else when the page read them.
  const dataAt = offline ? staleAt || base : null;
  // supervisor.state alone draws the rows; the voice row waits for /diag/state, which names its state.
  const processes = sup ? processesOf(sup, side.connection.data ?? null, health ?? healthOf(connection, null, sup, null, null), d).filter((p) => p.key !== 'voice' || d != null || ds.isError) : null;
  const procQ: RegionSource<DiagProcess[]> = {
    status: side.supervisor.status,
    data: processes ?? undefined,
    error: side.supervisor.error && new Error(reasonOf(side.supervisor.error)),
    isFetching: side.supervisor.isFetching,
    dataUpdatedAt: side.supervisor.dataUpdatedAt,
    refetch: side.supervisor.refetch,
  };

  const since = now - HOUR;
  const failedIds = allTurns.filter((t) => t.result === 'failed' && t.started_at >= since).map((t) => t.id);
  const failReads = useFailEvents(failedIds);
  const failAt: Record<string, NodeId> = {};
  failReads.forEach((q, i) => {
    const bad = q.data?.events.find((e) => e.status === 'failed');
    const node = bad ? nodeOfKind(bad.kind) : null;
    if (node && failedIds[i]) failAt[failedIds[i]] = node;
  });
  const hooks = d?.hooks;
  const hookLast = Math.max(0, ...[hooks?.claude.last_at, hooks?.codex.last_at].map((x) => isoToMsOrNull(x) ?? 0));
  const hookSub = !hooks ? '没读到' : hooks.claude.installed || hooks.codex.installed ? (hookLast ? formatAgo(now - hookLast) : '已安装') : '未安装';
  const { nodes, edges } = flowOf({
    turns: allTurns,
    runs: hour.runs.data ?? [],
    decisions: hour.decisions.data ?? [],
    since,
    failAt,
    voiceDown: health?.voice.state === 'unreachable',
    hookSub,
    hourly: full ? (slot.full?.hourly ?? null) : null,
  });
  const path = sel && detail.data ? pathFromEvents(detail.data.events) : [];
  const [step, replay] = useReplay(path, sel?.id ?? null, still);
  const nodeTurns = nodeF ? allTurns.filter((t) => (range === '24h' ? pathOf(t.source, t.result, failAt[t.id] ?? null) : pathOf(t.source, 'ok')).includes(nodeF)) : allTurns;
  const group = (t: Turn) => USER.has(t.source);
  const no = sel ? allTurns.filter((t) => group(t) === group(sel) && t.started_at <= sel.started_at && t.started_at >= new Date(sel.started_at).setHours(0, 0, 0, 0)).length : 0;
  const trace = sel && detail.data ? inspectorOf(sel, detail.data.events, no, detail.data.skew_ms) : null;
  const pick = (t: Turn) => setTurnId(t.id);

  const memTotal = processes?.reduce((a, p) => a + (p.memory_mb ?? 0), 0) ?? 0;
  const cpuTotal = processes?.reduce((a, p) => a + (p.cpu_percent ?? 0), 0) ?? 0;
  const totals = sup ? `内存 ${Math.round(memTotal)} MB │ CPU ${Math.round(cpuTotal)}%` : null;
  const caps = side.caps.data ?? null;
  const screenOff = side.perms.data && side.perms.data.screenRecording !== 'granted';
  const issues = [
    ...(screenOff ? [{ id: 'screen', title: '屏幕录制未授权', detail: '', to: { page: 'settings' as const, group: 'perm', item: 'screenRecording' } }] : []),
    ...issuesOf(caps),
  ];
  const textOnly = caps?.items.share_screenshots?.reason === 'off';
  const togglePause = () => {
    if (paused) void qc.invalidateQueries({ queryKey: STATE_KEY });
    setPaused((v) => !v);
  };
  const c = confirm ? CONFIRM[confirm] : null;
  const close = () => setConfirm(null);
  const loading = !enabled || (!ds.data && !ds.isError);
  const calm = still || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // With agentd gone the alert above names the cause; the turns keep their data under a time tag.
  const tst = !enabled || (!turns.data && !turns.isError) ? 'loading' : turns.isError && !turns.data ? 'error' : allTurns.length === 0 ? 'empty' : 'ok';

  return (
    <div className={styles.page} data-page="diag">
      <PageHeaderSlot
        right={
          <>
            <span className={styles.live} data-off={paused || offline || undefined}>
              只存本机 │{' '}
              {offline ? (
                <>
                  已断开{staleAt ? <> │ 截至 <span className="num">{formatClock(staleAt)}</span></> : null}
                </>
              ) : paused ? (
                '已暂停'
              ) : (
                '实时'
              )}
              <i aria-hidden="true" />
            </span>
          </>
        }
      />
      <ToolBar
        action={
          <>
            <Btn size="sm" icon="copy" onClick={act.copyDiag}>
              复制诊断信息
            </Btn>
            <Menu
              label="重启"
              align="right"
              items={[
                { kind: 'item', label: '重启后台服务', onSelect: () => setConfirm('agentd') },
                { kind: 'item', label: '重启角色', onSelect: () => setConfirm('avatar') },
                { kind: 'sep' },
                { kind: 'item', label: '全部重启…', danger: true, onSelect: () => setConfirm('all') },
              ]}
            />
          </>
        }
      >
        <Btn size="sm" icon={paused ? 'play' : 'stop'} disabled={offline} disabledReason="后台已断开" onClick={togglePause}>
          {paused ? '继续' : '暂停'}
        </Btn>
      </ToolBar>
      <PageIssues>
        <div className={styles.dg}>
          <HealthRow
            health={loading ? null : health}
            now={now}
            issues={issues}
            textOnly={textOnly}
            staleAt={staleAt}
            go={go}
            onNode={(n) => (n === 'runtime' ? go({ page: 'settings', group: 'kernel' }) : n === 'agentd' ? setConfirm('agentd') : setHighlight(n))}
            onRestartAgentd={() => setConfirm('agentd')}
            onVoiceReset={reconnectVoice}
            source={side.app.data ?? null}
          >
            <Processes
              q={procQ}
              uptime={health && health.agentd.up && health.agentd.started_at ? { agentd: formatDuration(now - health.agentd.started_at) } : {}}
              history={full ? (slot.full?.procRows ?? null) : null}
              actions={act.actions}
              highlight={highlight}
              staleAt={dataAt}
              onRestart={setConfirm}
              onLogs={act.revealLogs}
              onVoice={() => go({ page: 'settings', group: 'speak', item: 'tts' })}
            />
          </HealthRow>
          <FlowSection
            nodes={nodes}
            edges={edges}
            loading={loading}
            sel={sel}
            path={path}
            replayLoading={detail.isPending}
            step={step}
            onReplay={replay}
            onExit={() => setTurnId(null)}
            nodeF={nodeF}
            onNode={(id) => setNodeF((f) => (f === id ? null : id))}
            live={paused || offline ? null : liveEdgeOf(d?.turn.phase)}
            staleAt={dataAt}
            calm={calm}
          />
          <TurnsSection
            turns={nodeTurns}
            start={turns.data?.start ?? now - 24 * HOUR}
            end={turns.data?.end ?? now}
            range={range}
            setRange={(r) => (setRange(r), setTurnId(null))}
            st={tst}
            stoppedAt={staleAt || undefined}
            truncated={turns.data?.truncated ?? false}
            sel={sel}
            onPick={pick}
            node={nodeF ? (nodes.find((n) => n.id === nodeF) ?? null) : null}
            onClearNode={() => setNodeF(null)}
            trace={trace}
            traceSt={detail.isError ? 'error' : trace ? 'ok' : 'loading'}
            onRetry={() => void detail.refetch()}
            onRecords={sel ? () => go({ page: 'trace', turn: sel.turn_id }) : null}
            onChat={sel && exactRow?.conversation_id ? () => go({ page: 'chat', conv: exactRow.conversation_id!, turn: sel.turn_id }) : null}
          />
          {agentRunParam && <RunItems runId={agentRunParam} running={sel?.result === 'running'} />}
          {turnId && !sel && !exact.isFetching && !byTrace.isFetching && turns.isSuccess && !agentRunParam && <p role="status" className={styles.empty}>没有找到此轮的追踪记录。</p>}
          <Resources
            samples={samples}
            renderWhy={renderWhy(renderAvailable, health?.avatar ?? null, side.avatar.data ?? null)}
            details={side.avatar.data ?? null}
            budget={d?.budget ?? null}
            procHistory={full ? (slot.full?.procHistory ?? null) : null}
            procNow={(processes ?? []).filter((p) => p.cpu_percent != null || p.memory_mb != null).map((p) => ({ k: p.key, label: p.name, cpu: p.cpu_percent, mem: p.memory_mb }))}
            totals={totals}
            st={loading ? 'loading' : offline && !d ? 'error' : 'ok'}
            stoppedAt={staleAt || undefined}
          />
          {d && ds.data && <InternalState d={d} readAt={ds.data.at} now={now} open={stateOpen} onToggle={setStateOpen} focus={item === 'state'} obs={obsParam} />}
        </div>
      </PageIssues>
      <MemoryRunSheet id={memRun} onClose={() => setMemRun(null)} />
      {c && confirm && (
        <Dialog
          open
          title={c.title}
          onClose={close}
          footer={
            <>
              <Btn variant="secondary" onClick={close}>
                不重启
              </Btn>
              <Btn
                variant={c.danger ? 'danger' : 'primary'}
                onClick={() => {
                  close();
                  act.restart(confirm);
                }}
              >
                {c.label}
              </Btn>
            </>
          }
        >
          <p className={styles.dialogText}>{c.note}</p>
        </Dialog>
      )}
    </div>
  );
}
