import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { appNow } from '../../bridge/clock';
import { revealText } from '../../bridge/platformText';
import type { LogSourceId } from '../../bridge/logs';
import { type TraceEvent, traceEvents } from '../../bridge/traceEvents';
import type { ChartStatus } from '../../charts';
import { isoToMs, isoWithOffset } from '../../domain';
import type { VisualStateKey } from '../../domain/states';
import type { WireTraceTurn } from '../../domain/wire';
import { useDemo } from '../../shell/demo';
import { BottomBarSlot, PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as jump } from '../../shell/nav';
import { useToast } from '../../shell/toast';
import { Btn, Kbd, Sheet } from '../../ui';
import { StatusLamp } from '../../ui/game';
import { demoSource, learnedOf, useTraceRow, useTraceRows, useTurnFacts } from '../chat/useTurnData';
import { useDiagStream } from '../diag/useDiag';
import type { WireDiagItem } from '../diag/wire';
import { useParam } from '../overview/nav';
import { dayOf, type ResFilter, shapeOf, type SrcGroup, useConvTitles, useTurnEvents, useTurnItems } from './data';
import { LaneView } from './LaneView';
import { RANGES } from './lanes';
import { DEFAULT_LEVELS, filledSources, type LogFilters, LogView, shownLines } from './LogView';
import { buildTurn } from './steps';
import { TurnDetail } from './TurnDetail';
import { TurnList, visibleTurns } from './TurnList';
import { LEVEL_NAME, LOG_IDS, LOG_NAME, useLogs } from './useLogs';
import bs from './Bars.module.css';
import t from './Trace.module.css';

const newestFirst = (a: WireTraceTurn, b: WireTraceTurn) => isoToMs(b.started_at) - isoToMs(a.started_at);
/** The widest range the lanes offer, so every range choice is drawn from one read. */
const LANE_SPAN_MS = Math.max(...RANGES) * 60_000;

/** Every event of the lanes' stretch ending at `now`, page after page. */
async function laneStretch(now: number): Promise<TraceEvent[]> {
  const [since, until] = [isoWithOffset(now - LANE_SPAN_MS), isoWithOffset(now)];
  const out: TraceEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await traceEvents({ since, until, cursor });
    out.push(...page.events);
    cursor = page.cursor;
  } while (cursor != null);
  return out;
}

const UPDATES_LIST = new Set(['input.received', 'model.finished', 'playback.ended', 'playback.interrupted', 'turn.settled']);
const isLogId = (v: string | null): v is LogSourceId => v != null && (LOG_IDS as string[]).includes(v);
/** Below this width a turn's detail opens in a drawer over the list instead of beside it. */
const NARROW = '(max-width: 1199px)';
const narrowNow = () => window.matchMedia?.(NARROW).matches ?? false;
function useNarrow() {
  return useSyncExternalStore((on) => {
    const m = window.matchMedia?.(NARROW);
    m?.addEventListener('change', on);
    return () => m?.removeEventListener('change', on);
  }, narrowNow);
}
const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const key = (k: string[], label: string) => (
  <span key={label}>
    {k.map((x) => <Kbd key={x}>{x}</Kbd>)}
    {label}
  </span>
);

export interface TraceViewProps {
  tab: 'turns' | 'lanes' | 'logs';
  /** 诊断's tabs, put in the command bar. */
  tabs: ReactNode;
}

/** 诊断's 对话轮次, 事件线 and 日志 tabs. */
export function TraceView({ tab, tabs }: TraceViewProps) {
  const { state, demo, still } = useDemo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const off = state === 'loading' || state === 'empty';
  const live = !off && state !== 'error';
  const src = demoSource(demo);
  const rows = useTraceRows(live, src);
  const facts = useTurnFacts(live, src);
  const convs = useConvTitles(live && src == null);
  const all = useMemo(() => (state === 'empty' ? [] : [...(rows.data?.values() ?? [])].sort(newestFirst)), [rows.data, state]);
  const noOf = useMemo(() => new Map(all.map((r, i) => [r.turn_id, all.length - i])), [all]);
  const turnParam = useParam('turn');
  const atParam = Number(useParam('at') ?? NaN);
  const srcParam = useParam('src');
  const put = useCallback((patch: Record<string, string | undefined>) => void navigate({ to: '/diag', search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true }), [navigate]);

  const narrow = useNarrow();
  // A link to one turn opens it; under 1200 px that is the drawer.
  const [drawer, setDrawer] = useState(() => turnParam != null);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<SrcGroup>('all');
  const [res, setRes] = useState<ResFilter>('all');
  const turnSearch = useRef<HTMLInputElement>(null);
  const logSearch = useRef<HTMLInputElement>(null);

  // Opening on the newest turn that has ended; a running one stays on top without taking the pick.
  // `turn` is a turn_id or a trace_id (notifications link the trace_id); one the list does not hold is asked for by both.
  const atTurn = Number.isFinite(atParam) ? all.findLast((r) => isoToMs(r.started_at) >= atParam) : undefined;
  const listed = turnParam ? all.find((r) => r.turn_id === turnParam || r.trace_id === turnParam) : undefined;
  const selId = listed?.turn_id ?? turnParam ?? atTurn?.turn_id ?? (all.find((r) => shapeOf(r) !== 'run') ?? all[0])?.turn_id ?? null;
  const recent = selId ? (rows.data?.get(selId) ?? null) : null;
  const ask = live && src == null && rows.isSuccess && !recent;
  const byTurn = useTraceRow(selId, 'turn_id', ask);
  const byTrace = useTraceRow(selId, 'trace_id', ask && byTurn.isSuccess && byTurn.data == null);
  const exact = byTurn.isSuccess && byTurn.data == null ? byTrace : byTurn;
  const selRow = recent ?? exact.data ?? null;
  const selTurn = selRow?.turn_id ?? selId;
  const no = selTurn ? (noOf.get(selTurn) ?? 0) : 0;
  const ev = useTurnEvents(selRow, src);
  const items = useTurnItems(selRow, live && src == null);
  const turn = useMemo(
    () => (selRow && ev.data ? buildTurn({ row: selRow, events: ev.data.events, skew: ev.data.skew_ms ?? {}, items: items.data ?? [], mems: facts.data?.get(selRow.turn_id) ?? [], learned: learnedOf(src, selRow.turn_id) }) : null),
    [selRow, ev.data, items.data, facts.data, src],
  );

  const onItem = useCallback((kind: 'trace' | 'decision', it: WireDiagItem) => {
    if (kind !== 'trace') return;
    if (UPDATES_LIST.has(it.kind)) void qc.invalidateQueries({ queryKey: ['chat-trace-rows'] });
    if (it.turn_id === selTurn) {
      void qc.invalidateQueries({ queryKey: ['trace-turn-text', it.trace_id] });
      if (it.kind === 'turn.settled') void qc.invalidateQueries({ queryKey: ['chat-run-items', selTurn] });
    }
  }, [qc, selTurn]);
  useDiagStream(live && src == null, onItem, () => {
    void qc.invalidateQueries({ queryKey: ['chat-trace-rows'] });
    void qc.invalidateQueries({ queryKey: ['trace-turn-text'] });
  });

  const logs = useLogs(true, tab === 'logs' && !still);
  const [f, setF] = useState<LogFilters>(() => ({ on: isLogId(srcParam) ? [srcParam] : null, levels: DEFAULT_LEVELS, q: '', win: null, follow: true, pausedAt: 0 }));
  const onF = useCallback((patch: Partial<LogFilters>) => setF((x) => ({ ...x, ...patch })), []);
  useEffect(() => {
    if (isLogId(srcParam)) onF({ on: [srcParam] });
  }, [srcParam, onF]);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const now = appNow();
  const lanes = useQuery({ queryKey: ['trace-lane-events'], queryFn: () => laneStretch(appNow()), enabled: live && tab === 'lanes', retry: false });
  const laneEvents = state === 'empty' ? [] : (lanes.data ?? []);
  const laneSt: ChartStatus = state === 'loading' || (live && lanes.isPending) ? 'loading' : state === 'error' || lanes.isError ? 'error' : 'ok';

  const copy = useCallback((text: string, done: string) => {
    getBridge().clipboard.writeText(text).then(() => toast(done)).catch(() => toast('没有复制成功', { severity: 'danger' }));
  }, [toast]);
  const reveal = () => {
    getBridge().app.action('reveal_logs').then(() => toast(revealText('已在 Finder 中显示日志文件'))).catch(() => toast('显示日志失败', { severity: 'danger' }));
  };
  const selectedText = () =>
    logs.lines.filter((l) => sel.has(l.key)).map((l) => [`${l.at != null ? new Date(l.at).toISOString() : '—'} ${LOG_NAME[l.source]} ${LEVEL_NAME[l.level]} ${l.text}`, ...l.more].join('\n')).join('\n');
  const copySel = () => sel.size > 0 && copy(selectedText(), `已复制 ${sel.size} 行`);

  const start = selRow ? isoToMs(selRow.started_at) : 0;
  const win = selRow ? { no, t0: start - 2000, t1: start + selRow.duration_ms + 3000 } : null;
  const related = win && logs.status === 'ok' ? logs.lines.filter((l) => l.at != null && l.at >= win.t0 && l.at <= win.t1 && (l.level === 'err' || l.level === 'warn')).sort((a, b) => (a.level === b.level ? 0 : a.level === 'err' ? -1 : 1)).slice(0, 4) : [];
  const toLogs = () => {
    if (!win) return;
    setF((x) => ({ ...x, win, levels: { err: true, warn: true, info: true, dbg: true }, on: null, follow: false, pausedAt: logs.last }));
    put({ tab: 'logs' });
  };
  const turnNo = (id: string) => {
    const r = all.find((x) => x.turn_id === id || x.trace_id.startsWith(id));
    return r ? (noOf.get(r.turn_id) ?? null) : null;
  };
  const toTurn = (id: string) => {
    const r = all.find((x) => x.turn_id === id || x.trace_id.startsWith(id));
    if (!r) return;
    setRes('all');
    setQ('');
    setGroup('all');
    put({ tab: 'turns', turn: r.turn_id });
  };
  const onSelect = (k: string, range: boolean) => {
    const shown = shownLines(logs, f).map((l) => l.key);
    if (range && anchor.current) {
      const [a, b] = [shown.indexOf(anchor.current), shown.indexOf(k)].sort((x, y) => x - y);
      if (a! >= 0) setSel(new Set([...sel, ...shown.slice(a, b! + 1)]));
    } else {
      setSel(sel.has(k) && sel.size === 1 ? new Set() : new Set([k]));
      anchor.current = k;
    }
    if (f.follow) onF({ follow: false, pausedAt: logs.last });
  };

  // Esc: a menu closes itself; then out of a field, then clear the picked lines; only then 主页. Open steps stay open.
  const latest = useRef({ tab, sel });
  latest.current = { tab, sel };
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"], [role="dialog"]')) return;
      const l = latest.current;
      const stop = () => (e.preventDefault(), e.stopPropagation());
      if (editable(document.activeElement)) return stop(), (document.activeElement as HTMLElement).blur();
      if (l.tab === 'logs' && l.sel.size) return stop(), setSel(new Set());
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, []);
  const keyed = useRef<(e: KeyboardEvent) => void>(() => {});
  keyed.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || editable(e.target) || document.querySelector('[role="dialog"]')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && tab === 'logs' && sel.size && !window.getSelection()?.toString()) {
      e.preventDefault();
      copySel();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      (tab === 'logs' ? logSearch : turnSearch).current?.focus();
    } else if (tab === 'logs' && e.key === 'End') {
      e.preventDefault();
      onF({ follow: true });
    } else if (tab === 'turns' && ['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
      const list = visibleTurns(all, noOf, q, group, res);
      const i = list.findIndex((r) => r.turn_id === selTurn);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)))];
      if (!next) return;
      e.preventDefault();
      put({ turn: next.turn_id });
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyed.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const listSt: ChartStatus = state === 'loading' || (live && rows.isPending) ? 'loading' : state === 'error' || rows.isError ? 'error' : 'ok';
  const detailSt: ChartStatus = listSt !== 'ok' ? listSt : !selRow ? (exact.isFetching ? 'loading' : exact.isError ? 'error' : 'empty') : ev.isError ? 'error' : ev.isPending ? 'loading' : 'ok';
  const onIds = new Set(f.on ?? filledSources(logs));
  const today = logs.lines.filter((l) => onIds.has(l.source) && l.at != null && dayOf(l.at) === dayOf(now));
  const lamp: [VisualStateKey, string] = tab === 'logs'
    ? logs.status === 'missing' || logs.status === 'error' ? ['broken', '读不到'] : !f.follow ? ['stopped', '已暂停'] : ['ok', '实时']
    : tab === 'lanes' && lanes.isError ? ['broken', '读不到']
    : listSt === 'error' ? ['broken', '后台已断开'] : ['ok', '实时'];
  const conv = selRow?.conversation_id ?? null;
  const detail = (
    <TurnDetail
      row={selRow}
      no={no}
      turn={turn}
      st={detailSt}
      emptyText={turnParam ? '这一轮没有保留追踪事件' : all.length ? '选一轮看经过' : '这里会显示一轮的经过'}
      convTitle={conv ? (convs.data?.get(conv) ?? null) : null}
      related={related}
      onRetry={() => void (selRow ? ev.refetch() : exact.refetch())}
      onOpenChat={conv && selTurn ? () => jump({ page: 'chat', conv, turn: selTurn }) : null}
      onLogs={toLogs}
      onCopy={copy}
    />
  );

  return (
    <div className={t.page} data-page="diag" data-tab={tab} data-state={state ?? 'ok'}>
      <span className={t.wm} aria-hidden="true">{tab === 'logs' ? 'LOG' : 'TRACE'}</span>
      <PageHeaderSlot
        tabs={tabs}
        right={
          <span className={bs.reads}>
            {tab === 'logs' && logs.status === 'ok' && (
              <>
                <span className={bs.long}>今天</span>
                <b>{today.length.toLocaleString('en-US')}</b>行<span className={bs.sl} />错误<b data-bad={today.some((l) => l.level === 'err') || undefined}>{today.filter((l) => l.level === 'err').length}</b>
              </>
            )}
            <span role="status">
              <StatusLamp state={lamp[0]} label={lamp[1]} onDark />
            </span>
          </span>
        }
      />
      <BottomBarSlot
        lead={
          <span className={bs.keys} aria-hidden="true">
            {key(['Q', 'E'], '切页签')}
            {tab === 'lanes' ? (
              key(['←', '→'], '换一个事件')
            ) : tab === 'turns' ? (
              <>
                {key(['↑', '↓'], '换一轮')}
                <span className={bs.opt}>{key(['↵'], '展开一步')}</span>
              </>
            ) : (
              <>
                {key(['/'], '搜索')}
                <span className={bs.opt}>
                  {key(['End'], '回到最新')}
                  {key(['⇧', '点'], '选多行')}
                </span>
              </>
            )}
            {key(['esc'], '主页')}
          </span>
        }
        actions={
          tab === 'lanes' ? undefined : tab === 'turns' ? (
            selRow ? (
              <>
                <span className={bs.note}>第 {no} 轮的日志</span>
                <Btn variant="ghost" icon="file" onClick={toLogs}>看日志</Btn>
              </>
            ) : undefined
          ) : (
            <>
              <Btn variant="ghost" icon="copy" disabled={sel.size === 0} disabledReason="先点选日志行" onClick={copySel}>{sel.size ? `复制所选 ${sel.size} 行` : '复制所选'}</Btn>
              <Btn variant="secondary" tail="folder" onClick={reveal}>{revealText('在 Finder 中显示')}</Btn>
            </>
          )
        }
      />
      {tab === 'lanes' ? (
        <LaneView events={laneEvents} st={laneSt} now={now} />
      ) : tab === 'turns' ? (
        <div className={t.turns}>
          <TurnList
            rows={all}
            noOf={noOf}
            sel={selRow?.turn_id ?? selId}
            st={listSt}
            stoppedAt={null}
            q={q}
            group={group}
            res={res}
            searchRef={turnSearch}
            onQ={setQ}
            onGroup={setGroup}
            onRes={setRes}
            onPick={(id) => {
              put({ turn: id });
              setDrawer(true);
            }}
            onRetry={() => void rows.refetch()}
            onChat={() => jump({ page: 'chat' })}
          />
          {narrow ? (
            <Sheet open={drawer && selId != null} title={`第 ${no} 轮`} head="close" width={640} closeLabel="收起这一轮" onClose={() => setDrawer(false)}>
              {detail}
            </Sheet>
          ) : (
            detail
          )}
        </div>
      ) : (
        <LogView logs={logs} f={f} sel={sel} now={now} searchRef={logSearch} turnNo={turnNo} onF={onF} onSelect={onSelect} onTurn={toTurn} />
      )}
    </div>
  );
}
