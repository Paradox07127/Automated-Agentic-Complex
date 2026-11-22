import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { appNow } from '../../bridge/clock';
import { revealText } from '../../bridge/platformText';
import type { LogSourceId } from '../../bridge/logs';
import type { ChartStatus } from '../../charts';
import { isoToMs } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as jump } from '../../shell/nav';
import { useToast } from '../../shell/toast';
import { Btn, Kbd, Tabs } from '../../ui';
import { demoSource, learnedOf, useTraceRow, useTraceRows, useTurnFacts } from '../chat/useTurnData';
import { useDiagStream } from '../diag/useDiag';
import type { WireDiagItem } from '../diag/wire';
import { useParam } from '../overview/nav';
import { dayOf, type ResFilter, shapeOf, type SrcGroup, useConvTitles, useTurnEvents, useTurnItems } from './data';
import { DEFAULT_LEVELS, filledSources, type LogFilters, LogView, shownLines } from './LogView';
import { buildTurn } from './steps';
import { TurnDetail } from './TurnDetail';
import { TurnList, visibleTurns } from './TurnList';
import { LEVEL_NAME, LOG_IDS, LOG_NAME, useLogs } from './useLogs';
import bs from './Bars.module.css';
import t from './Trace.module.css';

const newestFirst = (a: WireTraceTurn, b: WireTraceTurn) => isoToMs(b.started_at) - isoToMs(a.started_at);
const UPDATES_LIST = new Set(['input.received', 'model.finished', 'playback.ended', 'playback.interrupted', 'turn.settled']);
const isLogId = (v: string | null): v is LogSourceId => v != null && (LOG_IDS as string[]).includes(v);
const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const key = (k: string[], label: string) => (
  <span key={label}>
    {k.map((x) => <Kbd key={x}>{x}</Kbd>)}
    {label}
  </span>
);

export function TracePage() {
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
  const tab = useParam('tab') === 'logs' ? 'logs' : 'turns';
  const turnParam = useParam('turn');
  const srcParam = useParam('src');
  const put = useCallback((patch: Record<string, string | undefined>) => void navigate({ to: '/trace', search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true }), [navigate]);

  const [q, setQ] = useState('');
  const [group, setGroup] = useState<SrcGroup>('all');
  const [res, setRes] = useState<ResFilter>('all');
  const turnSearch = useRef<HTMLInputElement>(null);
  const logSearch = useRef<HTMLInputElement>(null);

  // Opening on the newest turn that has ended; a running one stays on top without taking the pick.
  const selId = turnParam ?? (all.find((r) => shapeOf(r) !== 'run') ?? all[0])?.turn_id ?? null;
  const recent = selId ? (rows.data?.get(selId) ?? null) : null;
  const exact = useTraceRow(selId, 'turn_id', live && src == null && rows.isSuccess && !recent);
  const selRow = recent ?? exact.data ?? null;
  const no = selId ? (noOf.get(selId) ?? 0) : 0;
  const ev = useTurnEvents(selRow, src);
  const items = useTurnItems(selRow, live && src == null);
  const turn = useMemo(
    () => (selRow && ev.data ? buildTurn({ row: selRow, events: ev.data.events, skew: ev.data.skew_ms ?? {}, items: items.data ?? [], mems: (selId && facts.data?.get(selId)) || [], learned: learnedOf(src, selRow.turn_id) }) : null),
    [selRow, ev.data, items.data, facts.data, selId, src],
  );
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setToggled(new Set()), [selId]);

  const onItem = useCallback((kind: 'trace' | 'decision', it: WireDiagItem) => {
    if (kind !== 'trace') return;
    if (UPDATES_LIST.has(it.kind)) void qc.invalidateQueries({ queryKey: ['chat-trace-rows'] });
    if (it.turn_id === selId) {
      void qc.invalidateQueries({ queryKey: ['trace-turn-text', it.trace_id] });
      if (it.kind === 'turn.settled') void qc.invalidateQueries({ queryKey: ['chat-run-items', selId] });
    }
  }, [qc, selId]);
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
    put({ tab: undefined, turn: r.turn_id });
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

  // Esc: a menu closes itself; then out of a field, then clear the picked lines or folded steps; only then 主页.
  const latest = useRef({ tab, sel, toggled });
  latest.current = { tab, sel, toggled };
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"], [role="dialog"]')) return;
      const l = latest.current;
      const stop = () => (e.preventDefault(), e.stopPropagation());
      if (editable(document.activeElement)) return stop(), (document.activeElement as HTMLElement).blur();
      if (l.tab === 'logs' && l.sel.size) return stop(), setSel(new Set());
      if (l.tab === 'turns' && l.toggled.size) return stop(), setToggled(new Set());
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
      const i = list.findIndex((r) => r.turn_id === selId);
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
  const fails = all.filter((r) => shapeOf(r) === 'fail').length;
  const running = all.filter((r) => ['run', 'wait'].includes(shapeOf(r))).length;
  const onIds = new Set(f.on ?? filledSources(logs));
  const today = logs.lines.filter((l) => onIds.has(l.source) && l.at != null && dayOf(l.at) === dayOf(now));
  const lamp = tab === 'logs'
    ? logs.status === 'missing' || logs.status === 'error' ? ['off', '读不到'] : !f.follow ? ['pause', '已暂停'] : ['on', '实时']
    : listSt === 'error' ? ['off', '后台已断开'] : ['on', '实时'];
  const conv = selRow?.conversation_id ?? null;

  return (
    <div className={t.page} data-page="trace" data-state={state ?? 'ok'}>
      <span className={t.wm} aria-hidden="true">{tab === 'logs' ? 'LOG' : 'TRACE'}</span>
      <PageHeaderSlot
        tabs={<Tabs label="运行记录页签" keys={false} value={tab} tabs={[{ id: 'turns', label: '轮次', icon: 'history' }, { id: 'logs', label: '日志', icon: 'file' }]} onChange={(id) => put({ tab: id === 'logs' ? 'logs' : undefined })} />}
        right={
          <span className={bs.reads}>
            {tab === 'turns' && listSt === 'ok' && all.length > 0 && (
              <>
                <span className={bs.long}>近 24 h</span>
                <b>{all.length}</b>轮<span className={bs.sl} />出错<b data-bad={fails > 0 || undefined}>{fails}</b>
                <span className={`${bs.sl} ${bs.long}`} />
                <span className={bs.long}>在跑</span>
                <b className={bs.long}>{running}</b>
              </>
            )}
            {tab === 'logs' && logs.status === 'ok' && (
              <>
                <span className={bs.long}>今天</span>
                <b>{today.length.toLocaleString('en-US')}</b>行<span className={bs.sl} />错误<b data-bad={today.some((l) => l.level === 'err') || undefined}>{today.filter((l) => l.level === 'err').length}</b>
              </>
            )}
            <span className={bs.lamp} data-s={lamp[0]} role="status">
              <i aria-hidden="true" />
              {lamp[1]}
            </span>
          </span>
        }
        bottom={
          <div className={bs.bar}>
            <span className={bs.keys} aria-hidden="true">
              {key(['Q', 'E'], '切页签')}
              {tab === 'turns' ? (
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
            <span className={bs.acts}>
              {tab === 'turns' ? (
                selRow && (
                  <>
                    <span className={bs.note}>第 {no} 轮的日志</span>
                    <Btn variant="ghost" icon="file" onClick={toLogs}>看日志</Btn>
                  </>
                )
              ) : (
                <>
                  <Btn variant="ghost" icon="copy" disabled={sel.size === 0} disabledReason="先点选日志行" onClick={copySel}>{sel.size ? `复制所选 ${sel.size} 行` : '复制所选'}</Btn>
                  <Btn variant="secondary" tail="folder" onClick={reveal}>{revealText('在 Finder 中显示')}</Btn>
                </>
              )}
            </span>
          </div>
        }
      />
      {tab === 'turns' ? (
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
            onPick={(id) => put({ turn: id })}
            onRetry={() => void rows.refetch()}
            onChat={() => jump({ page: 'chat' })}
          />
          <TurnDetail
            row={selRow}
            no={no}
            turn={turn}
            st={detailSt}
            emptyText={turnParam ? '这一轮没有保留追踪事件' : all.length ? '选一轮看经过' : '这里会显示一轮的经过'}
            convTitle={conv ? (convs.data?.get(conv) ?? null) : null}
            related={related}
            toggled={toggled}
            onToggle={(id) => setToggled((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onRetry={() => void (selRow ? ev.refetch() : exact.refetch())}
            onOpenChat={conv && selId ? () => jump({ page: 'chat', conv, turn: selId }) : null}
            onLogs={toLogs}
            onCopy={copy}
          />
        </div>
      ) : (
        <LogView logs={logs} f={f} sel={sel} now={now} searchRef={logSearch} turnNo={turnNo} onF={onF} onSelect={onSelect} onTurn={toTurn} />
      )}
    </div>
  );
}
