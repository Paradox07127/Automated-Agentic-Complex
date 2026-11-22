import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { AgentdCallError, del, get, put } from '../../bridge/agentd';
import type { MemoryTasksResponse } from '../../bridge/agentd-routes.generated';
import type { BridgeError } from '../../bridge/protocol';
import type { Fact, FactKind } from '../../domain';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { usePlugins } from '../../shell/plugins';
import { toast } from '../../shell/toast';
import { Btn, Tabs } from '../../ui';
import { pageNow, useGo, usePageParams } from './api';
import { Archive } from './Archive';
import { RUNS_KEY, useBatches } from './data';
import { errorText } from './errors';
import { BarDanger, BarEnd, BarLink } from './Keys';
import { factText, hm, isCandidate, SRC, SRC_ORDER } from './model';
import { ClearCard } from './Papers';
import { VARS } from './parts';
import { Projects } from './Projects';
import { Review } from './Review';
import { FACTS_KEY, readMemory, useFacts, type MemoryView, type WriteResult } from './useFacts';
import styles from './Page.module.css';

type View = 'about' | 'projects' | 'activity';

/** `?view=`; a fact selection or a source opens 档案, otherwise 档案 unless asked for. */
function viewParam(p: URLSearchParams): View | null {
  const v = p.get('view');
  return v === 'about' || v === 'projects' || v === 'activity' ? v : null;
}

/** `?src=` (agentd's source name or its short key) lands as a search for that source's name. */
function srcQuery(v: string | null): string | null {
  const s = SRC_ORDER.find((x) => x === v || SRC[x].key === v);
  return s ? SRC[s].full : null;
}

/** An agentd without the work-memory routes: the bridge refuses the path, or agentd answers 404. */
const noRoute = (e: unknown) => e instanceof AgentdCallError && (e.status === 404 || e.code === 'unclassified_route');

/** 记忆：页签 档案（默认）/ 项目 / 回顾；顶栏是记录状态和暂停，底栏是键位说明、整理记录、导出和清空。 */
export function MemoryPage() {
  const { state, demo, still } = useDemo();
  const params = usePageParams();
  const go = useGo();
  const qc = useQueryClient();
  const now = pageNow();

  const mem = useQuery({ queryKey: FACTS_KEY, queryFn: () => readMemory(pageNow()), enabled: state !== 'loading' && state !== 'error' });
  const runs = useBatches(state == null || state === 'error');
  const empty = state === 'empty';
  // `?demo=absent` reaches the fake bridge only: an agentd without /memory/tasks.
  const fake = !window.agenticComplex && demo ? `&demo=${encodeURIComponent(demo)}` : '';
  const plugins = usePlugins();
  const work = useQuery({
    queryKey: ['memory', 'tasks', fake],
    queryFn: async () => (await get<MemoryTasksResponse>(`/memory/tasks?status=active,parked,done,uncertain${fake}`)).tasks,
    enabled: state !== 'loading' && !empty && plugins.daily_brief,
    retry: false,
  });
  const hasProjects = plugins.daily_brief && !noRoute(work.error);
  const hasReview = plugins.screen_awareness;
  const facts = useMemo(() => (empty ? [] : mem.data?.facts), [empty, mem.data]);
  const model = useFacts(facts ?? []);
  const [pausedDemo, setPausedDemo] = useState(demo === 'paused');
  const recording = !pausedDemo && (mem.data?.recording ?? true);

  const [picked, setPicked] = useState<View | null>(viewParam(params));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [exportOff, setExportOff] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const view: View = (picked === 'projects' && !hasProjects) || (picked === 'activity' && !hasReview) ? 'about' : (picked ?? 'about');
  const sel = params.get('sel');
  const q = params.get('q') ?? srcQuery(params.get('src')) ?? '';

  useEffect(() => setPicked(viewParam(params)), [params]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // /feed memory events (server.py, integration.py, memory_pipeline.py): rows change live, a finished run moves 上次整理.
  useEffect(() => {
    return getBridge().feed.subscribe(
      (e) => {
        if (e.event === 'reset') void qc.invalidateQueries({ queryKey: ['memory'] });
        if (e.event !== 'memory') return;
        let d: { action?: string; fact_id?: string };
        try {
          d = JSON.parse(e.data) as typeof d;
        } catch {
          d = {};
        }
        void qc.invalidateQueries({ queryKey: FACTS_KEY });
        if (d.action === 'extracted') void qc.invalidateQueries({ queryKey: RUNS_KEY });
        if (d.action === 'added' && d.fact_id) setFresh((s) => new Set(s).add(d.fact_id ?? ''));
      },
      () => void qc.invalidateQueries({ queryKey: ['memory'] }),
    );
  }, [qc]);

  const report = (r: WriteResult, done: string, verb: string): boolean => {
    toast(r.ok ? done : r.conflict ? `没有${verb}：已在别处更新，已重新读取` : `没有${verb}：${r.message}`);
    return r.ok;
  };
  const write = {
    confirm: async (f: Fact) => report(await model.confirm(f), `已记住：${f.text}`, '记住'),
    correct: async (f: Fact, text: string) => report(await model.correct(f, text), isCandidate(f) ? `已按修改记住：${text}` : '改好了，下一句起按新的说', '修改'),
    reject: async (f: Fact) => report(await model.reject(f), `已划掉：${f.text}`, '划掉'),
    forget: async (f: Fact) => report(await model.forget(f), `已删除：${factText(f)}`, '删除'),
    add: async (text: string, kind: FactKind) => {
      const r = await model.add(text, kind);
      toast(!r.ok ? `没有保存：${r.message}` : r.reinforced ? '已有这条记忆，已加强' : '已新增 1 条记忆 │ 来源「用户陈述」');
      return r.ok;
    },
  };
  const jump = (k: 'chat' | 'obs') => go(k === 'chat' ? { page: 'chat' } : { page: 'overview', focus: 'timeline' });

  const onRecording = async (on: boolean) => {
    try {
      const r = await put<{ paused: boolean }>('/memory/paused', { paused: !on });
      setPausedDemo(false);
      qc.setQueryData<MemoryView>(FACTS_KEY, (d) => d && { ...d, recording: !r.paused });
      toast(r.paused ? '暂停记忆：不记新的事，已记住的照常用' : '已恢复记忆');
    } catch (e) {
      toast(`没有切换：${errorText(e)}`);
    }
  };
  const onExport = async () => {
    try {
      const saved = await getBridge().files.saveAgentdExport({ path: '/memory/export', suggestedName: '记忆.json' });
      toast(saved ? '已导出全部记忆' : '没有导出：保存面板已取消');
    } catch (e) {
      const code = (e as BridgeError | null)?.code;
      if (code === 'not_implemented' || code === 'op_not_allowed') setExportOff('这个窗口还不能保存文件');
      toast(code === 'offline' ? '没有导出：后台已断开' : code === 'not_implemented' || code === 'op_not_allowed' ? '没有导出：这个窗口还不能保存文件' : '没有导出：文件没有保存成功');
    }
  };
  const onClear = () => {
    setClearing(false);
    void del<{ facts_deleted: number }>('/memory?scope=facts')
      .then((r) => toast(`已清空 ${r.facts_deleted} 条记忆，称呼和生日保留`))
      .catch((e: unknown) => toast(`没有清空：${errorText(e)}`))
      .finally(() => void qc.invalidateQueries({ queryKey: ['memory'] }));
  };

  const memError = state === 'error' ? '记忆库正在被另一个进程写入' : mem.isError && !mem.data ? errorText(mem.error) : null;
  const asks = facts?.filter(isCandidate).length ?? 0;
  const lastRun = empty ? null : runs.pending ? undefined : runs.lastAt;
  const any = (facts?.length ?? 0) > 0;
  const actions = (
    <BarEnd>
      <BarLink onClick={() => go({ page: 'diag', tab: 'records', kind: 'memory' })}>整理记录 ›</BarLink>
      <Btn disabled={!any || exportOff != null} disabledReason={exportOff ?? '还没有可导出的记忆'} onClick={() => void onExport()}>
        导出
      </Btn>
      {any && <BarDanger onClick={() => setClearing(true)}>清空记忆…</BarDanger>}
    </BarEnd>
  );
  const tabs = [
    { id: 'about', label: '档案', icon: 'file' as const, ...(asks > 0 && view !== 'about' ? { mark: '有待确认' } : {}) },
    ...(hasProjects ? [{ id: 'projects', label: '项目', icon: 'folder' as const }] : []),
    ...(hasReview ? [{ id: 'activity', label: '回顾', icon: 'history' as const }] : []),
  ];

  return (
    <div className={`${styles.page} ${VARS}`} data-page="memory">
      <PageHeaderSlot
        tabs={<Tabs label="记忆视图" keys={false} value={view} onChange={(id) => setPicked(id as View)} tabs={tabs} />}
        right={
          <span className={styles.rec} role="status" data-off={!recording || undefined}>
            <i aria-hidden="true" />
            {recording ? '记录中' : '已暂停记忆'}
            {lastRun !== undefined && (
              <small data-fold="1">
                {lastRun != null ? (
                  <>
                    上次整理 <span className="num">{hm(lastRun)}</span>
                  </>
                ) : (
                  '还没有整理'
                )}
              </small>
            )}
          </span>
        }
        action={
          recording ? (
            <Btn size="sm" variant="secondary" onClick={() => void onRecording(false)}>
              暂停记忆
            </Btn>
          ) : (
            <Btn size="sm" variant="secondary" tail="play" onClick={() => void onRecording(true)}>
              恢复记忆
            </Btn>
          )
        }
      />
      {view === 'projects' ? (
        <Projects
          tasks={empty ? [] : work.data}
          error={work.isError && !noRoute(work.error) ? errorText(work.error) : null}
          onRetry={() => void work.refetch()}
          initialQ={q}
          searchRef={searchRef}
          onSession={(id) => go({ page: 'overview', sel: id })}
        />
      ) : view === 'activity' ? (
        <Review searchRef={searchRef} />
      ) : (
        <Archive
          key={sel ?? ''}
          facts={facts}
          error={memError}
          onRetry={() => void mem.refetch()}
          now={now}
          still={still}
          fresh={fresh}
          initial={{ sel, q }}
          searchRef={searchRef}
          write={write}
          onJump={jump}
          onChat={() => go({ page: 'chat' })}
          actions={actions}
        />
      )}
      {clearing && <ClearCard count={facts?.filter((f) => f.kind !== 'name' && f.kind !== 'birthday').length ?? 0} onCancel={() => setClearing(false)} onConfirm={onClear} />}
    </div>
  );
}
