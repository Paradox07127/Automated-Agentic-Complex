import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { get, seg } from '../../bridge/agentd';
import { useRuntimePublic } from '../../data/runtime';
import { loadRestOfList, loadTasksList, type TasksListPage } from '../../data/tasksBase';
import { usePlugins } from '../../shell/plugins';
import {
  fromRun,
  fromRuntimePublic,
  fromStep,
  fromToolItem,
  isAgentdTask,
  runFailure,
  secToMs,
  type FileEffect,
  type Plan,
  type StepEvent,
  type StepStatus,
  type Task,
  type ToolItem,
  type WireRun,
  type WireRunItem,
  type WireRuntimePublic,
  type WireStep,
} from '../../domain';

export { classify, failText, loadTasksBase, TasksLoadError, type Got, type LoadFail, type TasksBase } from '../../data/tasksBase';

/** The first page of tasks and deliveries, then every other page in the background; `data` is the newer of the two reads, `key` the first's query key. */
export function useTasksList(roleFail: boolean, enabled = true, demo: string | null = null) {
  const qc = useQueryClient();
  const plugins = usePlugins();
  const on = { sessions: plugins.coding_sessions, agent: plugins.personal_agent };
  const key = useMemo(() => ['tasks-page', roleFail, demo, on.sessions, on.agent], [roleFail, demo, on.sessions, on.agent]);
  const first = useQuery({ queryKey: key, queryFn: () => loadTasksList(roleFail, on, demo), enabled, retry: false, staleTime: Number.POSITIVE_INFINITY });
  const more = first.data != null && (first.data.next.tasks != null || first.data.next.deliveries != null);
  const rest = useQuery({
    queryKey: [...key, 'rest'],
    queryFn: () => {
      const head = qc.getQueryData<TasksListPage>(key);
      return head ? loadRestOfList(head, roleFail, demo) : Promise.reject(new Error('还没有第一页'));
    },
    enabled: enabled && more,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const data = more && rest.data && rest.dataUpdatedAt >= first.dataUpdatedAt ? rest.data : first.data;
  return { key, first, rest: more ? rest : null, data };
}

/** workspace.py run_files row plus its run; GET /agent/tasks/{id}/files → {files} (a later run's row wins per path). */
interface WireTaskFile {
  path: string;
  op: FileEffect['op'];
  added: number | null;
  removed: number | null;
  run_id: string;
}

/** own.py session line; GET /sessions/{id}/lines → {lines, next}. */
interface WireSessionLine {
  seq: number;
  role: string;
  text: string;
  ts: number;
}

/** One run of the task with what its `result` says (store.py finish: `{error, failure}` or the checks of verify_run). */
export interface RunOutcome {
  run_id: string;
  generation: number;
  state: string;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  checks: { passed: number; total: number } | null;
}

export interface TaskExtras {
  steps: StepEvent[];
  tools: ToolItem[];
  files: FileEffect[];
  /** Latest plan item of the task's runs. */
  plan: Plan | null;
  runs: RunOutcome[];
  failure: { reason: string; fix?: string } | null;
  stepsFailed: boolean;
  /** `/steps` has a next page. */
  moreSteps: boolean;
}

const NONE: TaskExtras = { steps: [], tools: [], files: [], plan: null, runs: [], failure: null, stepsFailed: false, moreSteps: false };

const record = (v: unknown): Record<string, unknown> | null => (v != null && typeof v === 'object' ? (v as Record<string, unknown>) : null);

function outcomeOf(w: WireRun): RunOutcome {
  const run = fromRun(w);
  const result = record(w.result);
  const checks = Array.isArray(result?.checks) ? (result.checks as unknown[]).map(record) : null;
  return {
    run_id: w.run_id,
    generation: w.generation,
    state: w.state,
    started_at: run.started_at,
    ended_at: run.ended_at,
    error: typeof result?.error === 'string' ? result.error : null,
    checks: checks && checks.length > 0 ? { passed: checks.filter((c) => c?.ok === true).length, total: checks.length } : null,
  };
}

/** The failure line of the latest failed run. */
const failureOf = (runs: readonly WireRun[]): TaskExtras['failure'] => runFailure(runs.at(-1));

function planOf(items: readonly WireRunItem[]): Plan | null {
  const plans = items.filter((i) => i.kind === 'plan' && Array.isArray(i.steps)).sort((a, b) => a.updated_at - b.updated_at);
  const last = plans.at(-1);
  if (!last) return null;
  const steps = (last.steps as Array<{ text: string; status: StepStatus }>).map((s) => ({ text: s.text, status: s.status, since: null }));
  return { revision: plans.length, steps, run_id: last.run_id, status: last.status, at: secToMs(last.updated_at) };
}

/** Steps (`pages` pages of them), the tool and plan items of every run in them, files and the runs' results. */
export async function loadTaskExtras(task: Pick<Task, 'id'>, stepsFail: boolean, pages = 1): Promise<TaskExtras> {
  if (!isAgentdTask(task.id)) return NONE;
  const id = seg(task.id);
  // `?fail=1` picks the mock's 404 demo; real agentd answers an unknown query with 400.
  const demo = stepsFail && !window.agenticComplex;
  const readSteps = async () => {
    const out: WireStep[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < pages; i += 1) {
      const page: { steps: WireStep[]; next_cursor: string | null } = cursor
        ? await get(`/agent/tasks/${id}/steps?cursor=${encodeURIComponent(cursor)}`)
        : demo
          ? await get(`/agent/tasks/${id}/steps?fail=1`)
          : await get(`/agent/tasks/${id}/steps`);
      out.push(...page.steps);
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    return { steps: out, more: cursor != null };
  };
  const [steps, files] = await Promise.allSettled([readSteps(), get<{ files: WireTaskFile[] }>(`/agent/tasks/${id}/files`)]);
  const wireSteps = steps.status === 'fulfilled' ? steps.value.steps : [];
  const runIds = [...new Set(wireSteps.flatMap((s) => (s.run_id ? [s.run_id] : [])))];
  const readRuns = Promise.allSettled([runIds.length > 0 ? get<{ runs: WireRun[] }>(`/agent/runs?${runIds.map((r) => `run_id=${encodeURIComponent(r)}`).join('&')}`) : { runs: [] }]);
  const items = await Promise.allSettled(runIds.map((r) => get<{ items: WireRunItem[] }>(`/agent/runs/${seg(r)}/items`)));
  const [runs] = await readRuns;
  const wireItems = items.flatMap((x) => (x.status === 'fulfilled' ? x.value.items : []));
  const taskRuns = runs.status === 'fulfilled' ? [...runs.value.runs].sort((a, b) => a.started_at - b.started_at) : [];
  // A call still open when its run ended was cut off: agentd stores it as it was, never as finished.
  const ended = new Set(taskRuns.flatMap((r) => (r.ended_at != null ? [r.run_id] : [])));
  const tools = items.flatMap((x, k) => (x.status === 'fulfilled' ? x.value.items.flatMap((i) => {
    const tool = fromToolItem(i);
    if (!tool) return [];
    return tool.status === 'in_progress' && ended.has(runIds[k]!) ? [{ ...tool, status: 'failed' as const }] : [tool];
  }) : []));
  return {
    steps: wireSteps.map(fromStep),
    tools,
    files: files.status === 'fulfilled' ? files.value.files.map((f) => ({ path: f.path, op: f.op, added: f.added, removed: f.removed })) : [],
    plan: planOf(wireItems),
    runs: taskRuns.map(outcomeOf),
    failure: failureOf(taskRuns),
    stepsFailed: steps.status === 'rejected',
    moreSteps: steps.status === 'fulfilled' && steps.value.more,
  };
}

export function useTaskExtras(task: Pick<Task, 'id'> | null, stepsFail: boolean, retry: number, pages: number) {
  return useQuery({
    queryKey: ['task-extras', task?.id ?? null, stepsFail, retry, pages],
    queryFn: () => loadTaskExtras(task ?? { id: 'ext:' }, stepsFail, pages),
    enabled: task != null,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (prev) => prev,
  });
}

/** Display name of the selected role kernel (`/character/runtime`). */
export function kernelName(w: WireRuntimePublic): string | null {
  if (!Array.isArray(w.available_backends)) return null;
  const rt = fromRuntimePublic(w);
  return rt.runtimes.find((r) => r.id === rt.selected)?.name ?? null;
}

export function useKernelName() {
  return useRuntimePublic({ select: kernelName });
}

export interface SessionLines {
  lines: string[];
  /** own.py's cursor: the last seq read, for `?after=`. */
  next: number;
}

/** Transcript lines of an own coding session after seq `after`; agentd keeps none for an external one. */
export async function loadSessionLines(sessionId: string, after = 0): Promise<SessionLines> {
  const r = await get<{ lines: WireSessionLine[]; next: number }>(`/sessions/${seg(sessionId)}/lines${after > 0 ? `?after=${after}` : ''}`);
  return { lines: r.lines.map((l) => l.text), next: r.next };
}

/** Read every few seconds while the session runs (the caller passes null otherwise), each time only the lines after the last; agentd has no session-line event on /feed. */
export function useSessionLines(sessionId: string | null, retry: number) {
  const qc = useQueryClient();
  const key = ['session-lines', sessionId, retry];
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<SessionLines> => {
      const had = qc.getQueryData<SessionLines>(key);
      const more = await loadSessionLines(sessionId ?? '', had?.next ?? 0);
      return had ? { lines: [...had.lines, ...more.lines], next: more.next } : more;
    },
    select: (d) => d.lines,
    enabled: sessionId != null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : 3000),
  });
}

/** `/feed` plan event (runtime.py plan sink) as a Plan; null when the data is not one. */
export function parsePlanEvent(data: string): (Plan & { run_id: string }) | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  const o = record(v);
  if (!o || typeof o.run_id !== 'string' || !Array.isArray(o.steps)) return null;
  const steps = (o.steps as Array<{ text: string; status: StepStatus }>).map((s) => ({ text: s.text, status: s.status, since: null }));
  return {
    revision: typeof o.revision === 'number' ? o.revision : 0,
    steps,
    run_id: o.run_id,
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.status === 'string' ? { status: o.status } : {}),
    ...(typeof o.at === 'number' ? { at: secToMs(o.at) } : {}),
  };
}

/** Events that change a task row, a pending item, a delivery, an approval or a coding session. */
const BASE_EVENTS: ReadonlySet<string> = new Set(['delivery', 'background_job', 'agent_interaction', 'approval', 'task', 'session']);

/** agent_run phases (runtime.py _emit) that happen inside a running run and change no row. */
const IN_RUN_PHASES: ReadonlySet<string> = new Set(['capabilities_checked', 'first_token', 'tool_started', 'tool_finished']);

type FeedChange = 'base' | 'extras';

/** Subscribes to `/feed`: plans by run id, `base` when a row may change, `extras` when an item of a run of the selected task arrives. */
export function watchTasksFeed(onPlan: (runId: string, plan: Plan) => void, onChange: (what: FeedChange) => void, isSelectedRun: (runId: string) => boolean): () => void {
  const phases = new Map<string, string>();
  return getBridge().feed.subscribe(
    (e) => {
      if (e.event === 'plan') {
        const p = parsePlanEvent(e.data);
        if (p) onPlan(p.run_id, p);
      } else if (BASE_EVENTS.has(e.event)) onChange('base');
      // A coding task leaves 验证中 after its verify command, once its session has stopped changing; agentd announces the end here.
      else if (e.event === 'announce') {
        const kind = parseRecord(e.data)?.kind;
        if (typeof kind === 'string' && kind.startsWith('dispatch_')) onChange('base');
      } else if (e.event === 'agent_run') {
        const o = parseRecord(e.data);
        const runId = typeof o?.run_id === 'string' ? o.run_id : null;
        const phase = typeof o?.phase === 'string' ? (IN_RUN_PHASES.has(o.phase) ? 'running' : o.phase) : null;
        if (runId == null || phase == null) onChange('base');
        else if (phases.get(runId) !== phase) {
          phases.set(runId, phase);
          onChange('base');
        }
      } else if (e.event === 'agent_item') {
        const runId = parseRecord(e.data)?.run_id;
        if (typeof runId === 'string' && isSelectedRun(runId)) onChange('extras');
      }
    },
    () => onChange('base'),
  );
}

function parseRecord(data: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(data));
  } catch {
    return null;
  }
}

/** Live plans by run id; `onChange` coalesces bursts into one read, and a burst during a read into one more read after it. */
export function useTasksFeed(onChange: (what: FeedChange) => unknown, isSelectedRun: (runId: string) => boolean): Record<string, Plan> {
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const latest = useRef(onChange);
  latest.current = onChange;
  const selected = useRef(isSelectedRun);
  selected.current = isSelectedRun;
  useEffect(() => {
    const due = new Set<FeedChange>();
    const reading = new Set<FeedChange>();
    const dirty = new Set<FeedChange>();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (w: FeedChange) => {
      if (reading.has(w)) {
        dirty.add(w);
        return;
      }
      reading.add(w);
      void Promise.resolve(latest.current(w))
        .catch(() => {})
        .finally(() => {
          reading.delete(w);
          if (live && dirty.delete(w)) read(w);
        });
    };
    const schedule = (what: FeedChange) => {
      due.add(what);
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const w of due) read(w);
        due.clear();
      }, 300);
    };
    const off = watchTasksFeed(
      (runId, plan) => setPlans((p) => ((p[runId]?.revision ?? -1) > plan.revision ? p : { ...p, [runId]: plan })),
      schedule,
      (runId) => selected.current(runId),
    );
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, []);
  return plans;
}
