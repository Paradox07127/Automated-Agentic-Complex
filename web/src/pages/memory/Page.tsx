// Version history, 已锁定 and 不再提及 / 停止此类推断 have no agentd endpoint yet; they show only in
// the fake bridge's `full` demo. 记忆概况 and 最近变化 live on the developer 管线 page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { AgentdCallError, del, get, put } from '../../bridge/agentd';
import type { MemoryTasksResponse } from '../../bridge/agentd-routes.generated';
import type { BridgeError } from '../../bridge/protocol';
import type { Fact, MemorySource } from '../../domain';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { ErrBar, PageIssues, reasonOf, Region, Tabs, type RegionSource } from '../../ui';
import { pageNow, useGo, usePageParams } from './api';
import { Archive } from './Archive';
import { Asks } from './Asks';
import { ActivityReview } from './ActivityReview';
import { RUNS_KEY, useBatches } from './data';
import { demo as slot } from './demoSlot';
import { errorText } from './errors';
import { FactDialog } from './FactDialog';
import { FactList } from './FactList';
import { FactSheet, type Version } from './FactSheet';
import { useFeedback } from './feedback';
import { Header } from './Header';
import { useLeave } from './motion';
import { factText, groupLabel, isCandidate, isProfileFact, profileOf, SRC, SRC_ORDER } from './model';
import { Profile } from './Profile';
import { Projects, type WorkTask } from './Projects';
import { FACTS_KEY, readMemory, useFacts, type MemoryView, type WriteResult } from './useFacts';
import styles from './Memory.module.css';

type View = 'activity' | 'projects' | 'about' | 'knowledge';

/** `?src=` takes agentd's source name or the short key (asserted, observed, confirmed, inferred). */
function srcParam(v: string | null): MemorySource | null {
  return SRC_ORDER.find((s) => s === v || SRC[s].key === v) ?? null;
}

/** `?view=`; a fact selection or source filter opens `about`, otherwise the page picks (null). */
function viewParam(p: URLSearchParams): View | null {
  const v = p.get('view');
  if (v === 'activity' || v === 'projects' || v === 'about' || v === 'knowledge') return v;
  return p.get('sel') || p.get('src') ? 'about' : p.get('q') ? 'projects' : null;
}

/** An agentd without the work-memory routes: the bridge refuses the path, or agentd answers 404. */
const noRoute = (e: unknown) => e instanceof AgentdCallError && (e.status === 404 || e.code === 'unclassified_route');

/** 记忆：页头切「项目」「用户档案」，共用一个搜索。用户档案是档案一行、待确认、记忆列表，各区块自己处理读取状态，记忆读不到时列表处是一条出错条；点一行开右侧抽屉。 */
export function MemoryPage() {
  const { state, demo, still } = useDemo();
  const params = usePageParams();
  const go = useGo();
  const fb = useFeedback();
  const qc = useQueryClient();
  const now = pageNow();
  const preview = demo === 'full' && !window.agenticComplex;
  const pv = preview ? slot.preview : undefined;

  const mem = useQuery({ queryKey: FACTS_KEY, queryFn: () => readMemory(pageNow()), enabled: state !== 'loading' && state !== 'error' });
  const runs = useBatches(state == null || state === 'error');
  const empty = state === 'empty';
  // `?demo=absent` reaches the fake bridge only: an agentd without /memory/tasks.
  const fake = !window.agenticComplex && demo ? `&demo=${encodeURIComponent(demo)}` : '';
  const work = useQuery({
    queryKey: ['memory', 'tasks', fake],
    queryFn: async () => (await get<MemoryTasksResponse>(`/memory/tasks?status=active,parked,done,uncertain${fake}`)).tasks,
    enabled: state !== 'loading' && !empty,
    retry: false,
  });
  const hasProjects = !noRoute(work.error);
  const facts = useMemo(() => (empty ? [] : (mem.data?.facts ?? [])), [empty, mem.data]);
  const model = useFacts(facts);
  const [pausedDemo, setPausedDemo] = useState(demo === 'paused');
  const recording = !pausedDemo && (mem.data?.recording ?? true);

  const [src, setSrc] = useState<MemorySource | null>(srcParam(params.get('src')));
  const [q, setQ] = useState(params.get('q') ?? '');
  const [sel, setSel] = useState<string | null>(params.get('sel'));
  const [picked, setPicked] = useState<View | null>(viewParam(params));
  const [adding, setAdding] = useState(false);
  const [exportOff, setExportOff] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [quiet, setQuiet] = useState<ReadonlySet<string>>(new Set(pv?.quiet));
  const [never, setNever] = useState<ReadonlySet<string>>(new Set());
  const [restored, setRestored] = useState<Record<string, Version[]>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  // With observation off there is no activity to review, so the page opens on the profile.
  const observeOff = useQuery({ queryKey: ['memory', 'observe-setting'], queryFn: async () => (await getBridge().settings.read()).saved.observe === false, retry: false }).data === true;
  const view: View = picked === 'projects' && !hasProjects ? 'about' : (picked ?? (observeOff ? 'about' : 'activity'));
  const { slot: leave, pick } = useLeave(view, setPicked);

  useEffect(() => {
    setSel(params.get('sel'));
    setPicked(viewParam(params));
  }, [params]);

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
    fb.toast(r.ok ? done : r.conflict ? `没有${verb}：已在别处更新，已重新读取` : `没有${verb}：${r.message}`);
    return r.ok;
  };
  const save = async (f: Fact, text: string) => report(await model.correct(f, text), '已修改', '修改');
  const remove = (f: Fact) =>
    fb.ask({
      title: '删除这条记忆？',
      note: `「${factText(f)}」删除后角色不再引用这条记忆。`,
      danger: true,
      confirmLabel: '删除',
      onConfirm: () =>
        void model.forget(f).then((r) => {
          if (report(r, `已删除：${factText(f)}`, '删除') && sel === f.id) setSel(null);
        }),
    });
  const jump = (k: 'chat' | 'obs') => go(k === 'chat' ? { page: 'chat' } : { page: 'overview', focus: 'timeline' });

  const onRecording = async (on: boolean) => {
    try {
      const r = await put<{ paused: boolean }>('/memory/paused', { paused: !on });
      setPausedDemo(false);
      qc.setQueryData<MemoryView>(FACTS_KEY, (d) => d && { ...d, recording: !r.paused });
      fb.toast(r.paused ? '已暂停记忆：不新增、不更新，已有记忆照常引用' : '已恢复记忆');
    } catch (e) {
      fb.toast(`没有切换：${errorText(e)}`);
    }
  };
  const onExport = async () => {
    try {
      const saved = await getBridge().files.saveAgentdExport({ path: '/memory/export', suggestedName: '记忆.json' });
      fb.toast(saved ? '已导出全部记忆' : '没有导出：保存面板已取消');
    } catch (e) {
      const code = (e as BridgeError | null)?.code;
      if (code === 'not_implemented' || code === 'op_not_allowed') setExportOff('这个窗口还不能保存文件');
      fb.toast(code === 'offline' ? '没有导出：后台已断开' : code === 'not_implemented' || code === 'op_not_allowed' ? '没有导出：这个窗口还不能保存文件' : '没有导出：文件没有保存成功');
    }
  };
  const onClear = () =>
    fb.ask({
      title: '清空记忆？',
      warning: '清空后不能恢复',
      note: `清空 ${model.facts.length} 条记忆（称呼和生日保留）。输入「删除」确认。`,
      danger: true,
      confirmWord: '删除',
      confirmLabel: '清空',
      onConfirm: () =>
        void del<{ facts_deleted: number }>('/memory?scope=facts')
          .then((r) => fb.toast(`已清空 ${r.facts_deleted} 条记忆`))
          .catch((e: unknown) => fb.toast(`没有清空：${errorText(e)}`))
          .finally(() => void qc.invalidateQueries({ queryKey: ['memory'] })),
    });

  // The error demo stands for a /memory read that failed; 上次整理 still reads its own runs.
  const memSrc: RegionSource<MemoryView> =
    state === 'error'
      ? { status: 'error', data: undefined, error: new Error('记忆库正在被另一个进程写入'), refetch: mem.refetch }
      : {
          status: mem.status,
          data: mem.data && (empty ? { ...mem.data, facts: [] } : mem.data),
          error: mem.error && new Error(errorText(mem.error)),
          isFetching: mem.isFetching,
          dataUpdatedAt: mem.dataUpdatedAt,
          refetch: mem.refetch,
        };
  const workSrc: RegionSource<WorkTask[]> = empty
    ? { status: 'success', data: [] }
    : { status: work.status, data: work.data, error: work.error && new Error(errorText(work.error)), isFetching: work.isFetching, dataUpdatedAt: work.dataUpdatedAt, refetch: work.refetch };
  const memFailed = memSrc.status === 'error' && memSrc.data === undefined;
  const lastRun = empty ? null : runs.pending ? undefined : runs.lastAt;
  const header = (
    <Header
      recording={recording}
      candidateCount={facts.filter(isCandidate).length}
      activeCount={facts.filter((f) => !isCandidate(f)).length}
      lastRun={lastRun}
      onRecording={(on) => void onRecording(on)}
      onExport={() => void onExport()}
      exportOff={exportOff}
      onRecords={() => go({ page: 'diag', tab: 'records', kind: 'memory' })}
      onClear={onClear}
    />
  );
  const tabs = (
    <PageHeaderSlot
      tabs={
        <Tabs
          label="记忆视图"
          keys={false}
          value={view}
          onChange={(id) => pick(id as View)}
          tabs={[{ id: 'activity', label: '活动回顾', icon: 'history' as const }, ...(hasProjects ? [{ id: 'projects', label: '项目', icon: 'folder' as const }] : []), { id: 'about', label: '用户档案', icon: 'user' as const }, { id: 'knowledge', label: '其他事实与线索', icon: 'data' as const }]}
        />
      }
    />
  );

  const inView = facts.filter((f) => view === 'knowledge' ? !isProfileFact(f) : isProfileFact(f));
  const active = inView.filter((f) => !isCandidate(f));
  const asks = inView.filter((f) => isCandidate(f) && !never.has(f.id));
  const open = facts.find((f) => f.id === sel) ?? null;
  const tally = (profile: boolean) => {
    const xs = facts.filter((f) => isProfileFact(f) === profile);
    return { count: xs.filter((f) => !isCandidate(f)).length, asks: xs.filter((f) => isCandidate(f) && !never.has(f.id)).length };
  };
  const fx = preview
    ? {
        locked: new Set(pv?.locked),
        quiet,
        onQuiet: (f: Fact, on: boolean) => {
          setQuiet((s) => {
            const n = new Set(s);
            if (on) n.add(f.id);
            else n.delete(f.id);
            return n;
          });
          fb.toast(on ? `不再提及：${factText(f)} │ 记忆保留` : `恢复提及：${factText(f)}`);
        },
      }
    : undefined;

  const toChat = () => go({ page: 'chat' });
  const always = () => false;
  // Only the list shows the refresh ring; the bands above it keep their right edge clear.
  const bandSrc = { ...memSrc, isFetching: false };

  return (
    <div className={styles.page} data-page="memory">
      {header}
      {tabs}
      {fb.node}
      <PageIssues>
        {view === 'activity' ? <ActivityReview searchRef={searchRef} /> : view === 'projects' ? (
          <>
            <Archive tasks={workSrc.data} about={tally(true)} knowledge={tally(false)} lastRun={lastRun} onOpen={pick} leave={leave} />
            <Projects source={workSrc} now={now} q={q} onQ={setQ} searchRef={searchRef} onSession={(id) => go({ page: 'overview', sel: id })} />
          </>
        ) : (
          <>
            {view === 'knowledge' && <p>一般事实和旧候选保留在这里，出处和确认状态不变。项目进展请在「项目」中继续；这些线索不作为个人基本信息。</p>}
            {view === 'about' && !memFailed && (
              <Region q={bandSrc} what="记忆" reserve={{ height: 44 }} isEmpty={always}>
                {() => <Profile profile={profileOf(facts)} onOpen={setSel} onChat={toChat} selected={open?.id ?? null} leave={leave} />}
              </Region>
            )}
            {memSrc.data && (
              <Asks
                key={view}
                asks={asks}
                now={now}
                still={still}
                onConfirm={async (f) => report(await model.confirm(f), `已确认：${f.text}`, '确认')}
                onFix={async (f, text) => report(await model.correct(f, text), `已按修改记录：${text}`, '修改')}
                onDeny={async (f) => report(await model.reject(f), `已否认：${f.text}`, '否认')}
                {...(preview
                  ? {
                      onNever: (f: Fact) => {
                        setNever((s) => new Set(s).add(f.id));
                        fb.toast(`已停止此类推断：${groupLabel(f)} │ ${f.evidence.some((r) => r.startsWith('episode:')) ? '来自观察' : '来自对话'}`);
                      },
                    }
                  : {})}
                onJump={jump}
              />
            )}
            <div className={styles.listAnchor}>
              {memFailed ? (
                <ErrBar message={`没有读到记忆：${reasonOf(memSrc.error)}`} onRetry={() => void memSrc.refetch?.()} />
              ) : (
                <Region q={memSrc} what="记忆" reserve={{ rows: 6 }} isEmpty={always}>
                  {() => (
                    <FactList
                      facts={active}
                      now={now}
                      src={src}
                      onSrc={setSrc}
                      q={q}
                      onQ={setQ}
                      searchRef={searchRef}
                      selected={open?.id ?? null}
                      onSelect={setSel}
                      fresh={fresh}
                      onSave={save}
                      onDelete={remove}
                      onAdd={() => setAdding(true)}
                      {...(fx ? { preview: fx } : {})}
                    />
                  )}
                </Region>
              )}
            </div>
          </>
        )}
      </PageIssues>
      {open && (
        <FactSheet
          key={open.id}
          fact={open}
          now={now}
          onClose={() => setSel(null)}
          onSave={save}
          onDelete={remove}
          onJump={jump}
          {...(preview
            ? {
                preview: {
                  versions: restored[open.id] ?? pv?.versions[open.id],
                  locked: pv?.locked.includes(open.id) ?? false,
                  quiet: quiet.has(open.id),
                  onQuiet: (on: boolean) => fx?.onQuiet(open, on),
                  onRestore: (v: Version) => {
                    const vs = restored[open.id] ?? pv?.versions[open.id] ?? [];
                    void model.correct(open, v.text).then((r) => {
                      if (report(r, '已恢复到此版本', '恢复')) setRestored((x) => ({ ...x, [open.id]: [...vs, { text: v.text, when: '刚刚', by: '用户恢复' }] }));
                    });
                  },
                },
              }
            : {})}
        />
      )}
      <FactDialog
        open={adding}
        onCancel={() => setAdding(false)}
        onSave={async (text, kind) => {
          const r = await model.add(text, kind);
          if (r.ok) setAdding(false);
          fb.toast(!r.ok ? `没有保存：${r.message}` : r.reinforced ? '已有这条记忆，已加强' : '已新增 1 条记忆 │ 来源「用户陈述」');
          return r.ok;
        }}
      />
    </div>
  );
}
