// List rows of the three tabs: what each row says, its end shape and its corner tag, from the task view and the schedules.
import { formatClock, formatDuration, type Approval, type Question, type Task } from '../../domain';
import type { Schedule } from '../../domain/schedules';
import type { BoardCard } from './board';
import { pendingOf, type TasksView } from './model';
import { dayText, triggerText } from './schedules';

/** End shape: tracking ring (running), yellow ring (waiting for you), hatch (queued, paused, stopped), forbid (failed), check (done). */
export type Shape = 'trk' | 'trkY' | 'hatch' | 'forbid' | 'ok';

export interface ListRow {
  id: string;
  title: string;
  /** State word, first on the second line. */
  state: string;
  /** The rest of the second line, joined by │. */
  sub: string[];
  shape: Shape;
  src: 'role' | 'code' | 'sched';
  /** Big faded glyph on the right: the role's first character or the coding tool. */
  who: string;
  /** Corner tag: approval countdown, version under review, a proposal. */
  tag?: { tone: 'y' | 'w'; text: string; clock?: number; icon?: 'clock' | 'chat' };
}

export interface RowGroup {
  key: string;
  title: string;
  /** 要你处理 / 她提议的: the game's ImportanceNode head. */
  vital?: boolean;
  note?: string;
  rows: ListRow[];
}

const toolWho = (t: Pick<Task, 'agent' | 'target'>) => (/codex/i.test(`${t.agent ?? ''} ${t.target ?? ''}`) ? 'CDX' : 'CC');
const stepsText = (t: Task) => (t.steps_total ? `第 ${Math.min(t.steps_done + 1, t.steps_total)} / ${t.steps_total} 步` : t.steps.length ? `第 ${Math.min(t.steps_done + 1, t.steps.length)} / ${t.steps.length} 步` : null);
const dirOf = (t: Task) => (t.cwd ?? '').split('/').filter(Boolean).pop() ?? null;

/** 进行中: the cards still live, waiting ones in 要你处理; external sessions stay with 编码会话. */
export function runGroups(view: TasksView, cards: readonly BoardCard[], who: string, now: number): RowGroup[] {
  const wait: ListRow[] = [];
  const run: ListRow[] = [];
  for (const c of cards) {
    const t = c.taskId ? view.tasks.find((x) => x.id === c.taskId) : undefined;
    if (!t || t.source === 'ext' || c.status === 'done' || c.status === 'err') continue;
    const code = t.source === 'code';
    const queued = t.status === 'queued';
    const open = pendingOf(view, t.id).filter((p) => !p.resolved);
    const approval = open.find((p): p is Approval | Question => p.kind === 'approval' || (p.kind === 'question' && p.interaction_kind === 'approval'));
    const review = open.find((p) => p.kind === 'review');
    const left = approval?.seconds_left ?? null;
    const sub = queued
      ? ['等前台任务结束后开始']
      : code
        ? [c.tool === 'codex' ? 'Codex' : 'Claude Code', dirOf(t)].filter((x): x is string => !!x)
        : [stepsText(t), t.started_at != null ? formatDuration(now - t.started_at) : null].filter((x): x is string => !!x);
    const row: ListRow = {
      id: t.id,
      title: t.title,
      state: queued ? '排队' : c.stateText,
      sub,
      shape: c.status === 'wait' ? 'trkY' : queued ? 'hatch' : 'trk',
      src: code ? 'code' : 'role',
      who: code ? toolWho(t) : who,
      ...(left != null ? { tag: { tone: 'y' as const, text: '', clock: left, icon: 'clock' as const } } : review && t.delivery ? { tag: { tone: 'w' as const, text: `v${t.delivery.version} 待你看` } } : {}),
    };
    (c.status === 'wait' ? wait : run).push(row);
  }
  return [
    ...(wait.length ? [{ key: 'wait', title: '要你处理', vital: true, rows: wait }] : []),
    ...(run.length ? [{ key: 'run', title: '在跑', note: '角色任务和她派的编码会话', rows: run }] : []),
  ];
}

/** Ended tasks the page lists under 已完成: done, failed and stopped. */
export function endedTasks(view: TasksView): Task[] {
  const end = (t: Task) => t.ended_at ?? t.updated_at;
  return view.tasks.filter((t) => t.source !== 'ext' && ['done', 'failed', 'stopped'].includes(view.effective[t.id] ?? '')).sort((a, b) => end(b) - end(a));
}

/** 已接受、完成、出错、已驳回、已停止… and its shape. */
export function endState(t: Task, view: TasksView): { text: string; shape: Shape; err: boolean } {
  const eff = view.effective[t.id];
  if (eff === 'failed') return { text: t.status === 'rejected' ? '已驳回' : t.status === 'denied' ? '已拒绝' : '出错', shape: 'forbid', err: true };
  if (eff === 'stopped') return { text: t.status === 'interrupted' ? '已中断' : t.status === 'expired' ? '已过期' : '已停止', shape: 'hatch', err: false };
  return { text: t.status === 'accepted' ? '已接受' : '完成', shape: 'ok', err: false };
}

const dayKey = (ms: number, now: number) => dayText(ms, now).replace(/ \d\d:\d\d$/, '');

/** 已完成 by end day, newest first; `q` filters title and result text. */
export function doneGroups(tasks: readonly Task[], view: TasksView, who: string, now: number): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const t of tasks) {
    const at = t.ended_at ?? t.updated_at;
    const key = dayKey(at, now);
    const s = endState(t, view);
    const files = t.delivery?.artifacts.length ?? 0;
    const row: ListRow = {
      id: t.id,
      title: t.title,
      state: s.text,
      sub: [t.source === 'role' ? '角色任务' : (t.agent ?? '编码会话'), formatClock(at), ...(files ? [`产物 ${files}`] : [])],
      shape: s.shape,
      src: t.source === 'code' ? 'code' : 'role',
      who: t.source === 'code' ? toolWho(t) : who,
    };
    const g = groups.find((x) => x.key === key);
    if (g) g.rows.push(row);
    else groups.push({ key, title: key, rows: [row] });
  }
  return groups;
}

export const matches = (t: Task, q: string) => !q || t.title.includes(q) || (t.summary ?? '').includes(q);

/** 她提议的 (proposals not yet on), 开着, 暂停. */
export function schedGroups(list: readonly Schedule[], now: number): RowGroup[] {
  const proposal = (s: Schedule) => s.created_from === 'agent_proposal' && !s.enabled;
  const row = (s: Schedule): ListRow => ({
    id: s.schedule_id,
    title: s.title,
    state: s.last_error ? '上次没跑成' : proposal(s) ? '她提议' : s.enabled ? '开着' : '暂停',
    sub: [triggerText(s.trigger), ...(s.enabled ? [s.next_run_at != null ? `下次 ${dayText(s.next_run_at, now)}` : s.trigger.kind === 'session_done' ? '等会话结束' : '下次 —'] : [])],
    shape: s.last_error ? 'forbid' : s.enabled ? 'trk' : 'hatch',
    src: 'sched',
    who: '',
    ...(proposal(s) ? { tag: { tone: 'y' as const, text: '待你决定', icon: 'chat' as const } } : {}),
  });
  const groups: RowGroup[] = [
    { key: 'proposal', title: '她提议的', vital: true, rows: list.filter(proposal).map(row) },
    { key: 'on', title: '开着', rows: list.filter((s) => s.enabled).map(row) },
    { key: 'off', title: '暂停', rows: list.filter((s) => !s.enabled && !proposal(s)).map(row) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}
