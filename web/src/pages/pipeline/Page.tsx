import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentdCallError } from '../../bridge/agentd';
import { keyText } from '../../bridge/platformText';
import { formatClock, type MemorySource } from '../../domain';
import { stateVisual } from '../../domain/status';
import { useDemo } from '../../shell/demo';
import { BottomBarSlot, PageHeaderSlot } from '../../shell/headerSlot';
import { useGo } from '../../shell/nav';
import { Btn, ErrBar, Kbd, type KbdItem, Skel } from '../../ui';
import { GameFrame, LoadBar, StatusLamp } from '../../ui/game';
import { StateGlyph } from '../../ui/game/StateGlyph';
import { added14, isCandidate, SRC_ORDER, sum } from '../memory/model';
import { FACTS_KEY, readMemory } from '../memory/useFacts';
import { KEY, localDate, nowOf, pageNow, readTask, taskGuessOf, usePageParams, type WireDiagSeen } from '../observe/data';
import { useActions } from '../observe/useActions';
import { DIAG_KEY, readDiag, RUNS_KEY, useInterp, useRuns, type DiagRead } from './data';
import { DetailHead } from './Detail';
import { InterpView } from './InterpView';
import { OBS_RESULT, RUN_STATE } from './labels';
import { Line, type CardRead } from './Line';
import { MemView } from './MemView';
import { interpState, isStation, lineWord, memState, obsState, PHASE, startOfDay, STATIONS, storeState, troubled, type StationId, type StationState, type States } from './model';
import { ObsView } from './ObsView';
import { RunSheet } from './RunSheet';
import { StoreView } from './StoreView';
import styles from './Pipeline.module.css';

const DAY_MS = 86_400_000;
const NO_DIAG: DiagRead = {};
const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const offlineOf = (e: unknown) => e instanceof AgentdCallError && e.code === 'offline';

const KEYS: KbdItem[] = [
  { keys: ['←', '→'], label: '换工位' },
  { keys: ['↑', '↓'], label: '选行' },
  { keys: ['↵'], label: '展开 / 打开', more: true },
  { keys: ['Q', 'E'], label: '切页签', more: true },
  { keys: ['esc'], label: '回主页' },
];

/** The big number while a read is on its way. */
const SKEL = <span className={styles.skel} aria-label="读取中" />;

/** 最近 6 次观察的结果：实心成功、红失败、空心被挡。 */
function ObsDots({ recent }: { recent: ReadonlyArray<{ request_id: string; state: string }> }) {
  return (
    <span className={styles.dots} aria-label={`最近 ${recent.length} 次：${recent.map((r) => OBS_RESULT[r.state]?.label ?? '其他').join('，')}`}>
      {recent.map((r) => (
        <i key={r.request_id} data-r={r.state === 'ready' ? 'ok' : r.state === 'failed' ? 'fail' : 'skip'} />
      ))}
    </span>
  );
}

/** 记忆页的管线页签（开发者）：观察 → 理解 → 整理 → 记忆库四个工位排成一条线，选中一个看它的详情；Q / E 留给记忆页的页签。 */
export function PipelineView() {
  const { state } = useDemo();
  const params = usePageParams();
  const go = useGo();
  const qc = useQueryClient();
  const now = pageNow();
  const reads = state !== 'loading' && state !== 'error';
  const empty = state === 'empty';
  const day = localDate(now);

  const diag = useQuery({ queryKey: DIAG_KEY, queryFn: readDiag, enabled: reads });
  const task = useQuery({ queryKey: KEY.task, queryFn: readTask, enabled: reads && !empty });
  const mem = useQuery({ queryKey: FACTS_KEY, queryFn: () => readMemory(pageNow()), enabled: reads });
  const interp = useInterp(reads && !empty, day);
  const runs = useRuns(reads && !empty);
  const act = useActions(() => {});

  const offline = state === 'error' || [diag, mem, interp, runs].some((q) => offlineOf(q.error));
  const diagData: DiagRead | undefined = empty ? NO_DIAG : diag.data;
  const interpData = empty ? [] : interp.data;
  const runData = empty ? [] : runs.data;
  const facts = useMemo(() => (empty ? [] : mem.data?.facts), [empty, mem.data]);

  // Each station: its data derives the state; a read still on its way says 读取中, a failed one 读不到.
  const readOf = <T,>(data: T | undefined, failed: boolean, derive: (d: T) => StationState): StationState =>
    data !== undefined ? derive(data) : state !== 'loading' && (offline || failed) ? { phase: 'unread', why: null } : { phase: 'loading', why: null };
  const dayStart = startOfDay(now);
  const extract = (runData ?? []).filter((r) => r.purpose === 'extract');
  const today = (runData ?? []).filter((r) => r.at >= dayStart);
  const candidates = facts?.filter(isCandidate).length ?? 0;
  const states: States = {
    obs: readOf(diagData, diag.isError, (d) => obsState(d.observation, d.budget?.screenshots ?? null)),
    interp: readOf(interpData, interp.isError, interpState),
    mem: readOf(runData, runs.isError, () => memState(mem.data ? !mem.data.recording : false, extract)),
    store: readOf(facts, mem.isError, () => storeState(candidates)),
  };

  const [picked, setPicked] = useState<StationId | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [row, setRow] = useState<string | null>(null);
  useEffect(() => {
    const s = params.get('station');
    const run = params.get('run');
    setPicked(isStation(s) ? s : run ? 'mem' : null);
    setSheet(run);
    setRow(run);
  }, [params]);
  const trouble = offline ? null : troubled(states);
  const sel: StationId = picked ?? trouble ?? 'mem';
  const pick = (k: StationId) => {
    setPicked(k);
    setRow(null);
  };

  // Cards: today's throughput of each station.
  const shots = diagData?.budget?.screenshots ?? null;
  const recent = diagData?.observation?.recent ?? [];
  const nowData = diagData ? nowOf(diagData as WireDiagSeen) : null;
  const active = facts?.filter((f) => !isCandidate(f)) ?? [];
  const added = added14(facts ?? [], now);
  const todayDone = today.filter((r) => r.state !== 'running');
  const big = (v: number | undefined, k: StationId) => (v !== undefined ? v || '—' : states[k].phase === 'loading' ? SKEL : '—');
  const cards: Record<StationId, CardRead> = {
    obs: {
      value: diagData ? (shots ? shots.used : '—') : big(undefined, 'obs'),
      ...(shots ? { unit: `/${shots.limit}`, note: <LoadBar variant="port" fraction={shots.limit > 0 ? shots.used / shots.limit : 0} label="今天的截图额度" /> } : {}),
      sub:
        recent.length > 0 ? (
          <>
            <span>今天截图 │ 最近 {recent.slice(0, 6).length} 次</span>
            <ObsDots recent={recent.slice(0, 6)} />
          </>
        ) : diagData ? (
          '尚无请求'
        ) : null,
    },
    interp: {
      value: big(interpData?.length, 'interp'),
      note: '今日理解',
      sub: nowData?.activity ? (
        <>
          推断当前活动：<b className={styles.subValue}>{nowData.activity.label}</b>
        </>
      ) : diagData ? (
        '尚无推断'
      ) : null,
    },
    mem: {
      value: big(runData && todayDone.length, 'mem'),
      note: '今日整理批次',
      sub:
        runData && runData.length > 0 ? (
          <>
            <span>
              写入 <b className="num">{sum(today.map((r) => runs.digest.get(r.id)?.changes.length ?? 0))}</b> 条
            </span>
            <span>
              无新增 <b className="num">{today.filter((r) => r.state === 'no_new_knowledge').length}</b>
            </span>
          </>
        ) : runData ? (
          '尚无整理记录'
        ) : null,
    },
    store: {
      value: big(facts && active.length, 'store'),
      note: '已存储条目',
      sub:
        facts && facts.length > 0 ? (
          <>
            <span>
              今天 <b className="num">+{added.at(-1) ?? 0}</b>
            </span>
            <span>
              14 天 <b className="num">+{sum(added)}</b>
            </span>
          </>
        ) : facts ? (
          '尚无记忆'
        ) : null,
    },
  };

  const lastExtract = extract[0];
  const alert: { at: StationId; text: ReactNode; onClick: () => void } | null =
    trouble === 'mem' && lastExtract
      ? {
          at: 'mem',
          text: (
            <>
              <span className="num">{formatClock(lastExtract.at)}</span> 整理失败：{RUN_STATE[lastExtract.state]}
              {runs.digest.get(lastExtract.id)?.code ? `（${runs.digest.get(lastExtract.id)?.code}）` : ''}
            </>
          ),
          onClick: () => {
            pick('mem');
            setRow(lastExtract.id);
            setSheet(lastExtract.id);
          },
        }
      : trouble === 'interp' && interpData?.[0]
        ? {
            at: 'interp',
            text: (
              <>
                <span className="num">{formatClock(interpData[0].at)}</span> 理解失败：{interpData[0].error ?? '未说明原因'}
              </>
            ),
            onClick: () => pick('interp'),
          }
        : trouble === 'obs'
          ? { at: 'obs', text: '截图额度已用尽，当前仅读取窗口文本', onClick: () => pick('obs') }
          : null;

  // Row ids of the open station, in table order, for ↑ / ↓.
  const rowIds: string[] =
    sel === 'obs'
      ? [...(diagData?.observation?.pending ?? []).map((p) => `wait-${p.request_id}`), ...recent.map((r) => r.request_id)]
      : sel === 'interp'
        ? (interpData ?? []).map((r) => r.id)
        : sel === 'mem'
          ? (runData ?? []).map((r) => r.id)
          : SRC_ORDER;
  const detailRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ sel, row, rowIds, runData });
  latest.current = { sel, row, rowIds, runData };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]')) return;
      const l = latest.current;
      const k = e.key;
      const step = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
      if (step) {
        e.preventDefault();
        pick(STATIONS[(STATIONS.indexOf(l.sel) + step + STATIONS.length) % STATIONS.length] ?? 'mem');
        return;
      }
      if ((k === 'ArrowDown' || k === 'ArrowUp') && l.rowIds.length > 0) {
        e.preventDefault();
        const i = l.row == null ? -1 : l.rowIds.indexOf(l.row);
        const next = l.rowIds[Math.max(0, Math.min(l.rowIds.length - 1, i < 0 ? 0 : i + (k === 'ArrowDown' ? 1 : -1)))] ?? null;
        setRow(next);
        return;
      }
      if (k === 'Enter' && l.row != null && !(e.target instanceof HTMLElement && e.target.closest('button, a, [role="button"]'))) {
        const toggle = detailRef.current?.querySelector<HTMLElement>('[data-stub="ExpandRow"][data-selected] [role="button"]');
        e.preventDefault();
        if (toggle) toggle.click();
        else if (l.sel === 'mem' && l.runData?.some((r) => r.id === l.row && r.state !== 'running')) setSheet(l.row);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    detailRef.current?.querySelector('[data-stub="ExpandRow"][data-selected]')?.scrollIntoView?.({ block: 'nearest' });
  }, [row]);

  const retry = () => {
    void qc.invalidateQueries({ queryKey: DIAG_KEY });
    void qc.invalidateQueries({ queryKey: FACTS_KEY });
    void qc.invalidateQueries({ queryKey: RUNS_KEY });
    void qc.invalidateQueries({ queryKey: ['pipeline', 'interp'] });
  };

  const word = offline ? null : lineWord(states);
  const bySource = Object.fromEntries(SRC_ORDER.map((s) => [s, active.filter((f) => f.source === s).length])) as Record<MemorySource, number>;
  const detail = (): ReactNode => {
    const st = states[sel];
    if (st.phase === 'loading') return <Skel rows={5} />;
    if (sel === 'obs') return diagData ? <ObsView diag={diagData} readAt={diag.dataUpdatedAt || now} now={now} selected={row} onSelect={setRow} /> : <Unread onRetry={retry} what="观察状态" />;
    if (sel === 'interp')
      return interpData ? (
        <InterpView
          runs={interpData}
          now={nowData}
          guess={empty ? null : taskGuessOf(task.data)}
          selected={row}
          onSelect={setRow}
          onEpisode={(ep) => go({ page: 'overview', ep: String(ep) })}
          onCorrect={act.correct}
          onReject={act.rejectGuess}
          onClear={act.clearItems}
        />
      ) : (
        <Unread onRetry={retry} what="理解记录" />
      );
    if (sel === 'mem')
      return runData ? (
        <MemView runs={runData} digest={runs.digest} today={today} picked={params.get('run')} selected={row} onSelect={setRow} onRecord={setSheet} onChat={() => go({ page: 'chat' })} />
      ) : (
        <Unread onRetry={retry} what="整理记录" />
      );
    return facts ? (
      <StoreView bySource={bySource} added={added} since={now - 13 * DAY_MS} selected={row} onSelect={setRow} onSource={(src) => go({ page: 'memory', view: 'about', src })} />
    ) : (
      <Unread onRetry={retry} what="记忆" />
    );
  };

  const action =
    sel === 'obs' ? (
      <Btn variant="secondary" onClick={() => go({ page: 'settings', group: 'privacy' })}>
        观察设置
      </Btn>
    ) : sel === 'store' && candidates > 0 ? (
      <Btn variant="primary" onClick={() => go({ page: 'memory', view: 'about' })}>
        处理 {candidates} 条待确认
      </Btn>
    ) : sel === 'mem' || sel === 'store' ? (
      <Btn variant="secondary" onClick={() => go({ page: 'memory', view: 'about' })}>
        查看记忆档案
      </Btn>
    ) : null;

  return (
    <div className={styles.page} data-view="pipeline" data-state={state ?? 'ok'}>
      <PageHeaderSlot
        right={
          <span className={styles.reads}>
            <span data-fold="1">今日 00:00 起</span>
            {word && (
              <>
                <i className={styles.sl} data-fold="1" aria-hidden="true" />
                <span className={styles.word} data-phase={word.phase} role="status">
                  <StateGlyph shape={word.phase === 'ok' ? 'check' : stateVisual(PHASE[word.phase].key).shape} />
                  {word.text}
                </span>
              </>
            )}
            <StatusLamp state={offline ? 'broken' : 'ok'} label={offline ? '已断开' : '实时'} onDark />
          </span>
        }
      />
      <BottomBarSlot
        lead={
          <span aria-hidden="true">
            <Kbd variant="bar" held items={KEYS.map((it) => ({ ...it, keys: it.keys.map((k) => keyText(k)) }))} />
          </span>
        }
        actions={action}
      />
      {offline && <ErrBar message="后台服务已断开 │ 管线数据显示断开前缓存状态" staleAt={diag.dataUpdatedAt || undefined} onRetry={retry} />}
      <Line states={states} cards={cards} selected={sel} onSelect={pick} flow={{ obs: (diagData?.observation?.pending?.length ?? 0) > 0, mem: lastExtract?.state === 'running' }} stale={offline} alert={alert} />
      <div className={styles.detail}>
        <GameFrame label="工位详情">
          <div className={styles.dt}>
            <DetailHead k={sel} state={states[sel]} />
            <div key={sel} ref={detailRef} className={styles.scroll} data-station={sel}>
              {detail()}
            </div>
          </div>
        </GameFrame>
      </div>
      <RunSheet id={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

function Unread({ what, onRetry }: { what: string; onRetry: () => void }) {
  return <ErrBar message={`无法读取${what}`} onRetry={onRetry} />;
}
