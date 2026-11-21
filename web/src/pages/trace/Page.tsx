import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChartState, type ChartStatus } from '../../charts';
import { formatClock, isoToMs, type VisualStateKey } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as jump } from '../../shell/nav';
import { Btn, SecHead, StatusTag, Table, TableCell, TableHead, TableRow, Tabs } from '../../ui';
import { RunItems } from '../chat/RunItems';
import { TurnInspector } from '../chat/TurnInspector';
import { fmtMs, OUTCOME_LABEL, resultOf, sourceOf, TI_SRC } from '../chat/turnTrace';
import { demoSource, useTraceRow, useTraceRows, useTurnFacts, useTurnTrace } from '../chat/useTurnData';
import { UsageCard } from '../diag/UsageCard';
import { useDiagState, useDiagStream } from '../diag/useDiag';
import { ToolBar } from '../diag/ToolBar';
import type { WireDiagItem } from '../diag/wire';
import { useParam } from '../overview/nav';
import { TraceTimeline } from './Timeline';
import styles from './Trace.module.css';

const newestFirst = (a: WireTraceTurn, b: WireTraceTurn) => isoToMs(b.started_at) - isoToMs(a.started_at);
const STATE: Readonly<Record<string, VisualStateKey>> = { failed: 'failed', interrupted: 'interrupted', skipped: 'skipped', blocked: 'skipped', open: 'running', unknown: 'warning', text_generated: 'idle' };
const UPDATES_LIST = new Set(['input.received', 'model.finished', 'playback.ended', 'playback.interrupted', 'turn.settled']);

export function TracePage() {
  const { state, demo } = useDemo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState('turns');
  const off = state === 'loading' || state === 'empty';
  const live = !off && state !== 'error';
  const src = demoSource(demo);
  const rows = useTraceRows(live, src);
  const facts = useTurnFacts(live, src);
  const diag = useDiagState(live);
  const list = state === 'empty' ? [] : [...(rows.data?.values() ?? [])].sort(newestFirst);
  const turnParam = useParam('turn');
  const selId = turnParam ?? list[0]?.turn_id ?? null;
  const recent = selId ? (rows.data?.get(selId) ?? null) : null;
  const exact = useTraceRow(selId, 'turn_id', live && src == null && rows.isSuccess);
  const selRow = exact.data ?? recent ?? null;
  // Ordinal over the list, oldest first: the page has no conversation to count in.
  const no = recent ? list.length - list.indexOf(recent) : 0;
  const inspected = useTurnTrace(selRow, no, (selId && facts.data?.get(selId)) || [], src);
  const listSt: ChartStatus = state === 'loading' || (live && rows.isPending) ? 'loading' : state === 'error' || rows.isError ? 'error' : list.length === 0 ? 'empty' : 'ok';
  const traceSt: ChartStatus = !selRow ? (exact.isError ? 'error' : exact.isFetching ? 'loading' : 'empty') : inspected.query.isError ? 'error' : inspected.query.isPending ? 'loading' : 'ok';
  const usageSt: ChartStatus = state === 'loading' || (live && diag.isPending) ? 'loading' : state === 'error' || diag.isError ? 'error' : 'ok';
  const pick = (turn: string) => void navigate({ to: '/trace', search: (prev: Record<string, unknown>) => ({ ...prev, turn }), replace: true });
  const onItem = useCallback((kind: 'trace' | 'decision', it: WireDiagItem) => {
    if (kind !== 'trace') return;
    if (UPDATES_LIST.has(it.kind)) void qc.invalidateQueries({ queryKey: ['chat-trace-rows'] });
    if (it.turn_id === selId) {
      void qc.invalidateQueries({ queryKey: ['chat-turn-events', it.trace_id] });
      if (it.kind === 'turn.settled') void qc.invalidateQueries({ queryKey: ['chat-run-items', selId] });
    }
  }, [qc, selId]);
  useDiagStream(live && src == null, onItem, () => {
    void qc.invalidateQueries({ queryKey: ['chat-trace-rows'] });
    void qc.invalidateQueries({ queryKey: ['chat-turn-events'] });
    if (selId) void qc.invalidateQueries({ queryKey: ['chat-run-items', selId] });
  });

  return (
    <div className={styles.page} data-page="trace" data-state={state ?? 'ok'}>
      <ToolBar action={<Btn size="sm" icon="refresh" loading={rows.isFetching} onClick={() => {
        void rows.refetch();
        if (selRow) void inspected.query.refetch();
        else if (turnParam) void exact.refetch();
      }}>刷新记录</Btn>} />
      <PageHeaderSlot
        tabs={
          <Tabs
            label="运行记录页签"
            keys={false}
            value={tab}
            tabs={[
              { id: 'turns', label: '轮次', icon: 'history' },
              { id: 'timeline', label: '今日时间线', icon: 'clock' },
            ]}
            onChange={setTab}
          />
        }
      />
      {tab === 'timeline' && (
        <div className={styles.body}>
          <TraceTimeline />
        </div>
      )}
      <div className={styles.body} style={tab === 'turns' ? undefined : { display: 'none' }}>
        <section className={styles.sec} aria-label="轮次">
          <SecHead
            no="01"
            title="轮次"
            right={
              listSt === 'ok' ? (
                <span className={styles.t2}>
                  近 24 小时 <span className="num">{list.length}</span> 轮
                </span>
              ) : null
            }
          />
          <div className={styles.split}>
            <ChartState state={listSt} emptyText="近 24 小时没有轮次" height={220} onRetry={() => void rows.refetch()}>
              <div className={`${styles.list} panel-bg`}>
                <Table
                  label="近 24 小时的轮次"
                  maxHeight="var(--trace-list-max, 640px)"
                  selected={selRow?.turn_id ?? null}
                  onSelect={pick}
                  head={
                    <TableHead>
                      <TableCell head num>
                        时间
                      </TableCell>
                      <TableCell head>来源</TableCell>
                      <TableCell head>结果</TableCell>
                      <TableCell head num>
                        用时
                      </TableCell>
                    </TableHead>
                  }
                >
                  {list.map((r) => (
                    <TableRow key={r.turn_id} id={r.turn_id}>
                      <TableCell num>{formatClock(isoToMs(r.started_at), { seconds: true })}</TableCell>
                      <TableCell>
                        {TI_SRC[sourceOf(r.source)]}
                        {r.head && <span className={styles.head}>{r.head}{(r.len ?? 0) > r.head.length ? '…' : ''}</span>}
                      </TableCell>
                      <TableCell>
                        <StatusTag state={r.turn_state === 'waiting_user' ? 'waiting_user' : (STATE[r.result] ?? 'ok')} label={resultOf(r.result, r.turn_state)} />
                        {r.turn_outcome && <span className={styles.head}>{OUTCOME_LABEL[r.turn_outcome] ?? r.turn_outcome}</span>}
                      </TableCell>
                      <TableCell num>{fmtMs(r.duration_ms)}</TableCell>
                    </TableRow>
                  ))}
                </Table>
              </div>
            </ChartState>
            <div className={styles.detail}>
              <TurnInspector wide tr={inspected.trace} st={selId ? traceSt : listSt} emptyText={turnParam ? '这轮没有保留追踪事件。' : '选择一轮以查看详情'} onRetry={() => void (selRow ? inspected.query : exact).refetch()} />
              {selId && <RunItems key={selId} runId={selId} running={selRow?.result === 'open'} />}
              {selId && exact.data?.conversation_id && <Btn size="sm" variant="text" onClick={() => jump({ page: 'chat', conv: exact.data!.conversation_id!, turn: selId })}>在对话中打开 ↗</Btn>}
            </div>
          </div>
        </section>
        <section className={styles.sec} aria-label="用量">
          <SecHead no="02" title="用量" />
          <div className={styles.usage}>
            <UsageCard budget={diag.data?.state.budget ?? null} st={usageSt} />
          </div>
        </section>
      </div>
    </div>
  );
}
