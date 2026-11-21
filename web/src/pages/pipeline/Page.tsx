import { useEffect, useMemo, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AgentdCallError } from '../../bridge/agentd';
import { useDemo } from '../../shell/demo';
import { useGo } from '../../shell/nav';
import { Btn, KV, OpenSec, PageIssues, Region, type RegionSource } from '../../ui';
import { MemoryRunSheet } from '../diag/MemoryRunSheet';
import { ToolBar } from '../diag/ToolBar';
import { pageNow, usePageParams } from '../memory/api';
import { Changes } from '../memory/Changes';
import { useBatches } from '../memory/data';
import { errorText } from '../memory/errors';
import { added14, countOps, hm, isCandidate, SRC, stamp, type Batch } from '../memory/model';
import { Overview } from '../memory/Overview';
import { FACTS_KEY, readMemory, type MemoryView } from '../memory/useFacts';
import { NowSlot } from '../observe/NowBand';
import { KEY, nowOf, pausedUntilOf, readDiag, readTask, taskGuessOf } from '../observe/data';
import { useActions } from '../observe/useActions';
import styles from './Pipeline.module.css';

const DAY_MS = 86_400_000;
const NO_SET: ReadonlySet<string> = new Set();
const always = () => false;

/** 管线（开发者）：记忆概况、最近的整理批次和它们的生成记录、截图配额、「现在」（焦点与任务推断）。 */
export function PipelinePage() {
  const { state } = useDemo();
  const params = usePageParams();
  const go = useGo();
  const now = pageNow();
  const reads = state !== 'loading' && state !== 'error';
  const empty = state === 'empty';

  const mem = useQuery({ queryKey: FACTS_KEY, queryFn: () => readMemory(pageNow()), enabled: reads });
  const runs = useBatches(reads && !empty);
  const diag = useQuery({ queryKey: KEY.diag, queryFn: readDiag, enabled: reads });
  const task = useQuery({ queryKey: KEY.task, queryFn: readTask, enabled: reads });
  const act = useActions(() => {});

  const [run, setRun] = useState<string | null>(params.get('run'));
  useEffect(() => setRun(params.get('run')), [params]);

  const facts = useMemo(() => (empty ? [] : (mem.data?.facts ?? [])), [empty, mem.data]);
  const active = facts.filter((f) => !isCandidate(f));
  const offline = new AgentdCallError(0, 'offline', undefined, null, 'offline');
  const sourceOf = <T,>(q: UseQueryResult<T, Error>, what: (e: unknown) => string): RegionSource<T> =>
    state === 'loading'
      ? { status: 'pending', data: undefined, isFetching: true }
      : state === 'error'
        ? { status: 'error', data: undefined, error: new Error(what(offline)), refetch: q.refetch }
        : { status: q.status, data: q.data, error: q.error && new Error(what(q.error)), isFetching: q.isFetching, dataUpdatedAt: q.dataUpdatedAt, refetch: q.refetch };
  const memSrc: RegionSource<MemoryView> = { ...sourceOf(mem, errorText), isFetching: false };
  const diagSrc = sourceOf(diag, errorText);
  const batchSrc: RegionSource<Batch[]> = empty ? { status: 'success', data: [] } : state === 'error' ? { status: 'error', data: undefined, error: new Error(errorText(offline)) } : runs.source;
  const nowData = empty ? null : nowOf(diag.data);
  const shots = nowData?.screenshots ?? null;
  const when = (t: number) => (stamp(t, now).startsWith('今天') ? hm(t) : stamp(t, now));
  const toFacts = (extra: { sel?: string; src?: string }) => go({ page: 'memory', view: 'about', ...extra });

  return (
    <div className={styles.page} data-page="pipeline">
      <ToolBar />
      <div className={styles.body}>
        <PageIssues>
          <NowSlot
            q={diagSrc}
            data={nowData}
            guess={empty ? null : taskGuessOf(task.data)}
            pausedUntil={pausedUntilOf(diag.data)}
            lastActive={null}
            onCorrect={act.correct}
            onReject={act.rejectGuess}
            onClear={act.clearItems}
          />
          <Region q={memSrc} what="记忆" reserve={{ height: 76 }} isEmpty={always}>
            {() => <Overview facts={active} added={added14(facts, now)} since={now - 13 * DAY_MS} value={null} onPick={(s) => s && toFacts({ src: SRC[s].key })} />}
          </Region>
          <Changes source={batchSrc} live={[]} recording={mem.data?.recording ?? true} now={now} has={(id) => facts.some((f) => f.id === id)} onOpen={(sel) => toFacts({ sel })} undone={NO_SET} />
          <OpenSec title="生成记录">
            <Region q={batchSrc} what="整理记录" reserve={{ rows: 2 }} empty={{ text: '还没有整理记录' }}>
              {(list) => (
                <ul className={styles.runs}>
                  {list.map((b) => {
                    const n = countOps(b.items);
                    return (
                      <li key={b.id} className={styles.run}>
                        <span className="num">{when(b.at)}</span>
                        <span className={styles.cap}>
                          新增 <span className="num">{n.add}</span> │ 更新 <span className="num">{n.upd}</span> │ 删除 <span className="num">{n.del}</span>
                        </span>
                        <Btn size="sm" variant="text" onClick={() => setRun(b.id)}>
                          查看生成记录
                        </Btn>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Region>
          </OpenSec>
          <OpenSec title="截图配额">
            <Region q={diagSrc} what="截图配额" reserve={{ rows: 3 }} isEmpty={always}>
              {() => (
                <KV
                  items={[
                    { key: '已用', value: shots ? <span className="num">{`${shots.used} / ${shots.limit}`}</span> : null },
                    { key: '预留', value: shots ? <span className="num">{shots.reserved}</span> : null },
                    { key: '已释放', value: shots ? <span className="num">{shots.released}</span> : null },
                  ]}
                />
              )}
            </Region>
          </OpenSec>
        </PageIssues>
      </div>
      <MemoryRunSheet id={run} onClose={() => setRun(null)} />
    </div>
  );
}
