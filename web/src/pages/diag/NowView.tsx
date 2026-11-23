// `full` demo: the hourly stage aggregate and the process history show only with the mock data.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { resetVoice } from '../../bridge/agentd';
import { formatAgo } from '../../domain/time';
import { formatClock, formatDuration, type WireVoice } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';
import { Btn, Dialog, ErrBar, Kbd, Menu, Skel, type IconName } from '../../ui';
import { useDemo } from '../../shell/demo';
import { BottomBarSlot, PageHeaderSlot } from '../../shell/headerSlot';
import { useToast } from '../../shell/toast';
import { useGo, useNow } from '../overview/nav';
import { demo as slot } from './demoSlot';
import { flowOf, liveEdgeOf, nodeOfKind, waitingApprovals, type NodeId } from './flow';
import { FlowSection, type FailRow } from './FlowSection';
import { bucketsOf, HourBars } from './HourBars';
import { InternalState } from './InternalState';
import { Overview, RestartAgentd, rowsOf, type DiagTab, type OverviewProps } from './Overview';
import { Processes } from './Processes';
import { renderWhy } from './renderWhy';
import { overBudget, Resources } from './Resources';
import { healthOf, issuesOf, processesOf, type ProcKey } from './status';
import { UsageCard } from './UsageCard';
import { clock, STATE_KEY, type DiagSnap, useDecisions, useDiagState, useDiagStream, useFailEvents, useRenderStats, useSideReads, useTurns } from './useDiag';
import { CONFIRM, useDiagActions, viewLogs, type RestartTarget } from './useDiagActions';
import { seedOf, useProcSamples } from './useProcSamples';
import { reasonOf } from './reason';
import type { WireDiagItem } from './wire';
import styles from './Diag.module.css';
import stateStyles from './State.module.css';

const HOUR = 3_600_000;
/** 回看: what already happened. */
type BackTab = 'turns' | 'lanes' | 'behavior' | 'logs';
export type Tab = DiagTab | BackTab;
// Two groups, 现在 then 回看; the first 回看 tab opens the second group.
export const TABS: ReadonlyArray<{ id: Tab; label: string; icon: IconName; wm: string }> = [
  { id: 'overview', label: '总览', icon: 'd-overview', wm: 'DIAG' },
  { id: 'proc', label: '进程', icon: 'd-proc', wm: 'PROC' },
  { id: 'render', label: '帧与负载', icon: 'd-render', wm: 'FRAME' },
  { id: 'flow', label: '链路', icon: 'd-flow', wm: 'FLOW' },
  { id: 'state', label: '内部状态', icon: 'd-state', wm: 'STATE' },
  { id: 'turns', label: '对话轮次', icon: 'history', wm: 'TRACE' },
  { id: 'lanes', label: '事件线', icon: 'hub', wm: 'TRACE' },
  { id: 'behavior', label: '行为决策', icon: 'hand', wm: 'BEHAVIOR' },
  { id: 'logs', label: '日志', icon: 'file', wm: 'LOG' },
];
const ROW_ITEMS = new Set(['agentd', 'avatar', 'voice']);
/** Trace kinds that add a turn to the list or settle one. */
const LIST_KINDS = new Set(['input.received', 'model.finished', 'playback.ended', 'playback.interrupted', 'cancel.acked', 'turn.settled']);
const USER = new Set(['text', 'voice']);
export const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"]';

const keyHint = (k: string[], label: string) => (
  <span key={label}>
    {k.map((x) => (
      <Kbd key={x}>{x}</Kbd>
    ))}
    {label}
  </span>
);

export interface NowViewProps {
  tab: DiagTab;
  item: string | null;
  onTab: (id: Tab) => void;
  tabs: (marks: Partial<Record<Tab, string>>) => ReactNode;
}

/** 现在: 总览, 进程, 帧与负载, 链路, 内部状态. */
export function NowView({ tab, item, onTab, tabs }: NowViewProps) {
  const { state, demo, still } = useDemo();
  const go = useGo();
  const toast = useToast();
  const qc = useQueryClient();
  const full = demo === 'full';
  const [paused, setPaused] = useState(demo === 'paused');
  const [highlight, setHighlight] = useState<string | null>(item && ROW_ITEMS.has(item) ? item : null);
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [metric, setMetric] = useState<'cpu' | 'mem'>('cpu');
  const [node, setNode] = useState<NodeId | null>(null);
  const [confirm, setConfirm] = useState<RestartTarget | null>(demo === 'confirm' ? 'all' : null);

  const enabled = state !== 'loading';
  const base = useMemo(() => clock(), []);
  const now = useNow(base, still);
  const ds = useDiagState(enabled);
  const side = useSideReads(enabled);
  const turns = useTurns(range, enabled);
  const decisions = useDecisions(enabled);
  const renderAvailable = getBridge().capabilities.avatar;
  const samples = useRenderStats(renderAvailable && !paused);
  const act = useDiagActions(now, toast);
  const seed = useMemo(() => seedOf(full), [full]);
  const procSamples = useProcSamples(side.supervisor, base, enabled && !paused && !still, seed);

  const onItem = useCallback(
    (kind: 'trace' | 'decision', it: WireDiagItem) => {
      if (kind === 'decision') return void qc.invalidateQueries({ queryKey: ['diag', 'decisions'] });
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
    if (item && ROW_ITEMS.has(item)) setHighlight(item);
  }, [item]);
  useEffect(() => {
    if (!highlight || still) return;
    const id = setTimeout(() => setHighlight(null), 1600);
    return () => clearTimeout(id);
  }, [highlight, still]);

  const setTab = useCallback((id: DiagTab) => {
    setNode(null);
    onTab(id);
  }, [onTab]);
  const togglePause = useCallback(() => {
    if (paused) void qc.invalidateQueries({ queryKey: STATE_KEY });
    setPaused((v) => !v);
  }, [paused, qc]);

  const d = ds.data?.state ?? null;
  const connection = ds.isError ? 'offline' : (side.connection.data ?? 'connected');
  const sup = side.supervisor.data ?? null;
  const last = samples.at(-1) ?? null;
  const health = d || ds.isError ? healthOf(connection, side.runtime.data ?? null, sup, d, last?.fps ?? null) : null;
  const offline = ds.isError || connection === 'offline';
  const staleAt = offline ? (ds.data?.at ?? 0) : null;
  const procs = sup ? processesOf(sup, side.connection.data ?? null) : null;

  const since = now - HOUR;
  const allTurns = turns.data?.turns ?? [];
  const hourTurns = allTurns.filter((t) => t.started_at >= since);
  const failed = hourTurns.filter((t) => t.result === 'failed');
  const failReads = useFailEvents(failed.map((t) => t.id));
  const failAt: Record<string, NodeId> = {};
  const failRows: Array<FailRow & { node: NodeId }> = [];
  failReads.forEach((q, i) => {
    const t = failed[i];
    if (!t) return;
    const bad = q.data?.events.find((e) => e.status === 'failed');
    const at = bad ? nodeOfKind(bad.kind) : null;
    if (at) failAt[t.id] = at;
    const code = bad?.attrs.code ?? bad?.attrs.error ?? bad?.kind ?? '失败';
    failRows.push({ id: t.id, turn_id: t.turn_id, at: t.started_at, src: USER.has(t.source) ? '对话' : '主动发言', code: String(code), node: at ?? 'model' });
  });
  const hooks = d?.hooks;
  const hookLast = Math.max(0, ...[hooks?.claude.last_at, hooks?.codex.last_at].map((x) => isoToMsOrNull(x) ?? 0));
  const hookSub = !hooks ? '没读到' : hooks.claude.installed || hooks.codex.installed ? (hookLast ? formatAgo(now - hookLast) : '已安装') : '未安装';
  const { nodes, edges } = flowOf({
    turns: allTurns,
    decisions: decisions.data ?? [],
    since,
    failAt,
    voiceDown: health?.voice.state === 'unreachable',
    hookSub,
    hourly: full ? (slot.full?.hourly ?? null) : null,
    p50: Object.fromEntries(Object.entries(d?.stages.nodes ?? {}).map(([id, s]) => [id, s.p50_ms])),
  });
  const live = paused || offline ? null : liveEdgeOf(d?.turn.phase);
  const liveAt = live ? (nodes.find((n) => n.id === live[1])?.label ?? null) : null;
  const approvals = waitingApprovals(decisions.data ?? [], since);
  const worst = nodes.filter((n) => (n.stat?.fail ?? 0) > 0).sort((a, b) => (b.stat?.fail ?? 0) - (a.stat?.fail ?? 0))[0];
  const hourTotal = full ? (slot.full?.hourly.ctx.count ?? hourTurns.length) : hourTurns.length;
  const hourFails = full ? nodes.reduce((a, n) => a + (n.stat?.fail ?? 0), 0) : failed.length;

  const caps = side.caps.data ?? null;
  const screenOff = side.perms.data != null && side.perms.data.screenRecording !== 'granted';
  const why = renderWhy(renderAvailable, health?.avatar ?? null, side.avatar.data ?? null);
  const loading = !enabled || (!ds.data && !ds.isError);
  const calm = still || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const ov: OverviewProps = {
    loading,
    health,
    staleAt,
    now,
    procs,
    runtime: side.runtime.data ?? null,
    d,
    issues: issuesOf(caps),
    screenOff,
    textOnly: caps?.items.share_screenshots?.reason === 'off',
    fps: last?.fps ?? null,
    p95: last?.p95_ms ?? null,
    over: overBudget(samples),
    renderWhy: why,
    flow: { turns: hourTotal, fails: hourFails, worst: worst ? { label: worst.label, n: worst.stat?.fail ?? 0 } : null, approvals },
    source: side.app.data ?? null,
    highlight,
    go,
    onTab: setTab,
    onRestart: (t) => setConfirm(t),
    onVoiceReset: reconnectVoice,
  };
  const link = loading ? [] : rowsOf(ov).link;
  const linkOk = link.filter((r) => r.state === 'ok').length;
  const linkBad = link.filter((r) => r.state === 'failed').length;

  // Space pauses, Esc first clears the picked flow node.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(TYPING)) return;
      if (e.key === 'Escape' && node) {
        e.preventDefault();
        e.stopPropagation();
        setNode(null);
        return;
      }
      if (e.key === ' ' && !offline && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [node, offline, togglePause]);

  const gone = staleAt != null && tab !== 'overview' && (
    <ErrBar message="后台服务没有响应" staleAt={staleAt || undefined} extra={<RestartAgentd onClick={() => setConfirm('agentd')} />} />
  );
  const lamp: [string, string] = offline ? ['off', '已断开'] : paused ? ['pause', '已暂停'] : ['on', '实时'];
  const c = confirm ? CONFIRM[confirm] : null;
  const close = () => setConfirm(null);
  const marks: Partial<Record<Tab, string>> = {
    ...(health?.avatar && procs?.find((p) => p.key === 'avatar')?.tone === 'failed' ? { proc: '角色没有在运行' } : {}),
    ...(staleAt != null ? { proc: '后台服务没有响应' } : {}),
    ...(hourFails > 0 && !offline ? { flow: `近 1 小时失败 ${hourFails} 轮` } : {}),
  };

  return (
    <div className={styles.page} data-page="diag" data-tab={tab}>
      <span className={styles.wm} aria-hidden="true">
        {TABS.find((t) => t.id === tab)?.wm}
      </span>
      <PageHeaderSlot
        tabs={tabs(marks)}
        right={
          <span className={styles.reads}>
            {!loading && (
              <>
                <span className={styles.long}>链路</span>
                <b className="num">{linkOk}</b>项正常<span className={styles.sl} />出错<b className="num" data-bad={linkBad > 0 || undefined}>{linkBad}</b>
              </>
            )}
            <span className={styles.lamp} data-s={lamp[0]} role="status">
              <i aria-hidden="true" />
              {lamp[1]}
              {staleAt ? <> │ 截至 <span className="num">{formatClock(staleAt)}</span></> : null}
            </span>
          </span>
        }
      />
      <BottomBarSlot
        lead={
          <span className={styles.keys} aria-hidden="true">
            {keyHint(['Q', 'E'], '切页签')}
            {keyHint(['1', '9'], '直达页签')}
            <span className={styles.long}>{keyHint(['Space'], '暂停')}</span>
            {keyHint(['esc'], node ? '取消选中' : '主页')}
          </span>
        }
        actions={
          <>
            <Btn size="sm" icon={paused ? 'play' : 'stop'} disabled={offline} disabledReason="后台已断开" onClick={togglePause}>
              {paused ? '继续' : '暂停'}
            </Btn>
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
      />
      {tab === 'overview' && <Overview {...ov} />}
      {tab === 'proc' && (
        <div className={styles.view}>
          {gone}
          <Processes
            rows={procs}
            error={side.supervisor.error ? reasonOf(side.supervisor.error) : null}
            onRetry={() => void side.supervisor.refetch()}
            samples={procSamples}
            now={procSamples.at(-1)?.at ?? now}
            metric={metric}
            onMetric={setMetric}
            uptime={health?.agentd.up && health.agentd.started_at ? { agentd: formatDuration(now - health.agentd.started_at) } : {}}
            agentdGone={staleAt != null}
            actions={act.actions}
            highlight={highlight === 'agentd' || highlight === 'avatar' || highlight === 'tts' || highlight === 'motion' || highlight === 'llm' ? highlight : null}
            onRestart={setConfirm}
            onLogs={viewLogs}
          />
        </div>
      )}
      {tab === 'render' && (
        <div className={styles.view}>
          {loading ? <Skel rows={2} shape="cards" /> : <Resources samples={samples} renderWhy={why} details={side.avatar.data ?? null} onProc={() => setTab('proc')} />}
        </div>
      )}
      {tab === 'flow' && (
        <div className={styles.view}>
          {gone}
          <FlowSection
            nodes={nodes}
            edges={edges}
            loading={loading}
            error={turns.isError && !turns.data ? reasonOf(turns.error) : null}
            onRetry={() => void turns.refetch()}
            turns={hourTotal}
            fails={hourFails}
            liveAt={liveAt}
            live={live}
            dead={offline}
            calm={calm}
            sel={node}
            onPick={(id) => setNode((x) => (x === id ? null : id))}
            onClear={() => setNode(null)}
            onStation={(station) => go({ page: 'pipeline', station })}
            failsOf={(id) => failRows.filter((f) => f.node === id)}
            approvals={approvals}
            onTasks={() => go({ page: 'tasks' })}
            onTrace={(turn) => go(turn ? { page: 'diag', tab: 'turns', turn } : { page: 'diag', tab: 'turns' })}
            onChat={() => go({ page: 'chat' })}
          >
            <HourBars buckets={bucketsOf(allTurns, range, turns.data?.end ?? now)} range={range} onRange={setRange} onPick={(at) => go({ page: 'diag', tab: 'turns', at })} truncated={turns.data?.truncated ?? false} />
            <UsageCard budget={d?.budget ?? null} loading={loading} />
          </FlowSection>
        </div>
      )}
      {tab === 'state' && (
        <div className={styles.view}>
          {gone}
          {d ? (
            <InternalState d={d} />
          ) : loading ? (
            <Skel rows={3} shape="cards" />
          ) : (
            <div className={stateStyles.empty} role="status">
              <b>后台断开时没有内部状态</b>
              <span>{staleAt ? `最后一次读到是 ${formatClock(staleAt)}，重启后会重新读` : '重启后台服务后会重新读'}</span>
            </div>
          )}
        </div>
      )}
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
