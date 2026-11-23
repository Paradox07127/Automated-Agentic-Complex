import { describe, expect, it } from 'vitest';
import {
  composeHealth,
  fromApproval,
  fromAttention,
  fromCharacterState,
  fromConversation,
  fromCooldowns,
  fromDelivery,
  fromDiagBudget,
  fromEpisode,
  fromFact,
  fromGoal,
  fromInteraction,
  fromLedgerTask,
  fromRun,
  fromRuntimePublic,
  fromSession,
  fromStatePoint,
  fromStep,
  fromTaskRow,
  fromToolItem,
  fromTraceTurn,
  fromTurnNow,
  indexActiveRuns,
  mergeTasks,
} from '../../src/domain/adapt';
import type { WireRunItem, WireTaskRow } from '../../src/domain/wire';
import {
  at,
  NOW,
  WIRE_APPROVALS,
  WIRE_ATTENTION_APP,
  WIRE_ATTENTION_DOMAIN,
  WIRE_CHARACTER_STATE,
  WIRE_CONVERSATIONS,
  WIRE_DELIVERIES,
  WIRE_DIAG_BUDGET,
  WIRE_DIAG_CONNECTIONS,
  WIRE_DIAG_GATE,
  WIRE_DIAG_TURN,
  WIRE_EPISODES,
  WIRE_FACTS,
  WIRE_GOALS,
  WIRE_INTERACTION_APPROVAL,
  WIRE_INTERACTIONS,
  WIRE_ITEMS,
  WIRE_LEDGER,
  WIRE_RUNTIME,
  WIRE_SESSIONS,
  WIRE_STEPS,
  WIRE_TASK_ROWS,
  WIRE_TASK_RUNS,
  WIRE_TRACE_TURNS,
  WIRE_TURNS,
} from '../../src/mock/fixtures';
import { A1, C1, C2, C4, DLV_T1_V2, DLV_T4_V1, G1, Q1, S_5E10, S_C07A, T1, T2, T2_LEDGER, T3, T4, T5, T7 } from '../../src/mock/fixtures/ids';

const one = <T>(list: readonly T[], pred: (x: T) => boolean): T => {
  const x = list.find(pred);
  if (!x) throw new Error('fixture missing');
  return x;
};
const row = (id: string): WireTaskRow => one(WIRE_TASK_ROWS, (r) => r.canonical_task_id === id);
const ledgerOf = (r: WireTaskRow) => WIRE_LEDGER.find((l) => l.task_id === r.task_id);
const runOf = (r: WireTaskRow) => WIRE_TASK_RUNS.find((x) => x.run_id === r.run_id);
const tasks = () => mergeTasks(WIRE_TASK_ROWS.map((r) => fromTaskRow(r, ledgerOf(r), runOf(r))), WIRE_LEDGER.map(fromLedgerTask), WIRE_SESSIONS.map(fromSession));

describe('tasks and pending', () => {
  it('fromApproval: keys renamed, since from the fetch time, source split into agent and display', () => {
    const a = fromApproval(one(WIRE_APPROVALS, (x) => x.request_id === A1), NOW);
    expect(a).toMatchObject({ id: A1, kind: 'approval', agent: 'claude', tool: 'Bash', orig_len: 212, task_id: null, scope_ok: false, fetched_at: NOW });
    expect(a.since).toBe(NOW - (45 - 41) * 1000);
    expect(a.title).toBe('Bash: rm -rf build/ .build/release && swift build -c release');
    expect(a.source).toBe('Claude Code │ app');
    expect(a.display_session).toBe(S_5E10);
    const dispatch = fromApproval({ ...one(WIRE_APPROVALS, (x) => x.request_id === A1), kind: 'dispatch' }, NOW);
    expect(dispatch.task_id).toBe(`task:${A1}`);
  });

  it('fromApproval: a dispatch she proposed keeps its title, the user words and where the directory came from', () => {
    const wire = {
      ...one(WIRE_APPROVALS, (x) => x.request_id === A1),
      kind: 'dispatch' as const,
      dispatch: {
        target: 'codex', cwd: '/Users/me/Endfield', prompt: '修 HostLink 断线重连', source: 'agent' as const,
        utterance: '帮我把断线修了', modes: ['read_only', 'workspace_write'], mode: 'read_only', verify_cmd: null,
        cwd_from: { source: 'agent' as const, project: 'Endfield', matched: 'project' as const },
        title: '修 HostLink 断线', requested_by: { run_id: 'run-1', conversation_id: 'conv-1' },
      },
    };
    expect(fromApproval(wire, NOW).dispatch).toMatchObject({
      source: 'agent', utterance: '帮我把断线修了', title: '修 HostLink 断线',
      cwd_from: { source: 'agent', project: 'Endfield', matched: 'project' },
    });
    const { title: _title, requested_by: _by, ...regex } = wire.dispatch;
    const typed = fromApproval({ ...wire, dispatch: { ...regex, source: 'text', utterance: null, cwd_from: { source: 'explicit' } } }, NOW);
    expect(typed.dispatch?.cwd_from).toEqual({ source: 'explicit' });
    expect(typed.dispatch).not.toHaveProperty('title');
  });

  it('fromInteraction: first question fills title/options, no deadline is null, job maps to its task', () => {
    const q = fromInteraction(one(WIRE_INTERACTIONS, (x) => x.request_id === Q1), NOW);
    expect(q).toMatchObject({ id: Q1, task_id: T1, conversation_id: C1, revision: 1, expires_at: null, seconds_left: null, resolved: false });
    expect(q.options).toEqual(['包含', '不包含', '单列一节']);
    expect(q.since).toBe(at(14, 27, 40));
    const ap = fromInteraction(WIRE_INTERACTION_APPROVAL, NOW);
    expect(ap.interaction_kind).toBe('approval');
    expect(ap.preview_text).toContain('10 月.xlsx');
    expect(ap.expires_at).toBe(at(14, 34));
    expect(ap.seconds_left).toBeCloseTo((at(14, 34) - NOW) / 1000);
  });

  it('fromDelivery: id and task id renamed, version = generation + 1, seconds → ms', () => {
    const d = fromDelivery(one(WIRE_DELIVERIES, (x) => x.delivery_id === DLV_T1_V2));
    expect(d).toMatchObject({ id: DLV_T1_V2, task_id: T1, version: 2, generation: 1, revision: 3, verification_source: 'unverified', state: 'viewed' });
    expect(d.viewed_at).toBe(at(14, 30));
    expect(d.artifacts[0]).toMatchObject({ name: '2026-W44 周报.md', absolute_path: '/Users/me/Documents/周报/2026-W44 周报.md', version: 2 });
    expect(fromDelivery(one(WIRE_DELIVERIES, (x) => x.delivery_id === DLV_T4_V1)).verification_source).toBe('auto');
  });

  it('fromTaskRow: inline delivery, run count, end time and source', () => {
    const t1 = fromTaskRow(row(T1), undefined, runOf(row(T1)));
    expect(t1).toMatchObject({ id: T1, source: 'role', status: 'needs_review', run_count: 2, revision: 3, ended_at: at(14, 26), conversation_id: C1, target: 'character' });
    const finishedRun = { ...runOf(row(T1))!, state: 'completed', ended_at: at(14, 25) / 1000 };
    expect(fromTaskRow(row(T1), undefined, finishedRun).ended_at).toBe(at(14, 25));
    expect(t1.delivery?.id).toBe(DLV_T1_V2);
    expect(t1.summary).toContain('142 条');
    expect(t1.started_at).toBe(at(14, 22, 5));
    expect(fromTaskRow(row(T4)).ended_at).toBe(at(11, 2));
    const t2 = fromTaskRow(row(T2), ledgerOf(row(T2)));
    expect(t2).toMatchObject({ id: T2, task_id: T2_LEDGER, source: 'code', agent: 'Codex', cwd: '~/Endfield/app', run_count: 0, started_at: null });
  });

  it('fromLedgerTask and mergeTasks: a ledger row seen in /agent/tasks appears once; external sessions add ext rows', () => {
    expect(fromLedgerTask(one(WIRE_LEDGER, (l) => `task:${l.task_id}` === T7))).toMatchObject({ id: T7, source: 'code', agent: 'Claude Code', status: 'interrupted' });
    const all = tasks();
    expect(all.filter((t) => t.id === T2)).toHaveLength(1);
    expect(all.find((t) => t.id === T5)).toMatchObject({ source: 'ext', agent: 'Claude Code', title: 'Endfield' });
  });

  it('mergeTasks: a job row whose task_id is a ledger row (its run) hides that ledger row', () => {
    const job = { ...row(T1), task_id: 'character-run-8d03' };
    const ledger = { ...one(WIRE_LEDGER, (l) => `task:${l.task_id}` === T7), task_id: 'character-run-8d03', target: 'character' };
    const merged = mergeTasks([fromTaskRow(job, ledger)], [fromLedgerTask(ledger)]);
    expect(merged.map((t) => t.id)).toEqual([T1]);
  });

  it('fromSession: own sessions point at their ledger row, external ones at their ext row', () => {
    const own = fromSession(one(WIRE_SESSIONS, (s) => s.session_id === S_C07A));
    expect(own).toMatchObject({ id: S_C07A, own: true, kind: 'code', task_id: T2, agent: 'Codex', state: 'awaiting_approval', since: at(14, 31, 38) });
    const ext = fromSession(one(WIRE_SESSIONS, (s) => s.session_id === S_5E10));
    expect(ext).toMatchObject({ kind: 'ext', task_id: T5, display_session: S_5E10, title: 'Endfield' });
    expect(fromSession({ ...one(WIRE_SESSIONS, (s) => s.session_id === S_5E10), state: 'subagent' }).state).toBe('running');
  });

  it('fromSession: an external session without cwd is titled by its agent', () => {
    const s = fromSession({ ...one(WIRE_SESSIONS, (x) => x.session_id === S_5E10), cwd: null });
    expect(s).toMatchObject({ title: 'Claude Code', cwd: '' });
    const merged = mergeTasks([], [], [s]);
    expect(merged[0]).toMatchObject({ id: T5, title: 'Claude Code', cwd: '' });
  });

  it('fromSession: done and stale are idle, awaiting_input is kept', () => {
    const ext = one(WIRE_SESSIONS, (x) => x.session_id === S_5E10);
    expect(fromSession({ ...ext, state: 'done' }).state).toBe('idle');
    expect(fromSession({ ...ext, state: 'stale' }).state).toBe('idle');
    expect(fromSession({ ...ext, state: 'awaiting_input' }).state).toBe('awaiting_input');
  });

  it('fromGoal: task ids come from the rows carrying the goal; objective becomes the note', () => {
    const g = fromGoal(one(WIRE_GOALS, (x) => x.goal_id === G1), tasks());
    expect(g).toMatchObject({ id: G1, status: 'active', revision: 3, note: 'P4 浮窗栈与快速输入' });
    expect(g.task_ids).toEqual([T4]);
  });

  it('fromRun and indexActiveRuns: live runs keyed by the task whose row names them', () => {
    expect(fromRun(one(WIRE_TASK_RUNS, (r) => r.run_id === 'run-5b20'))).toMatchObject({ task_id: 'character-run-5b20', started_at: at(10, 40), ended_at: at(10, 58), state: 'completed' });
    const live = indexActiveRuns(WIRE_TASK_RUNS, tasks());
    expect(Object.keys(live).sort()).toEqual([T1, T3].sort());
    expect(live[T1]).toMatchObject({ run_id: 'run-8d03', generation: 1, phase: null, since: null, plan: null, conversation_id: C1 });
  });
});

describe('steps and conversation', () => {
  it('fromStep: raw phase codes map onto the lanes; time in ms', () => {
    const steps = (WIRE_STEPS[T1] ?? []).map(fromStep);
    expect(steps.map((s) => s.phase)).toEqual(['prepare', 'execute', 'verify', 'end', 'prepare', 'execute', 'verify', 'execute']);
    expect(steps[0]).toMatchObject({ raw_phase: 'task_started', run_id: 'run-71a2', at: at(14, 14) });
    expect(steps[3]?.name).toBeNull();
  });

  it('fromToolItem: tool calls only; an open call has no end; unknown status counts as completed', () => {
    const items = WIRE_ITEMS['run-8d03'] ?? [];
    const open = items.find((i) => i.status === 'in_progress');
    if (!open) throw new Error('fixture missing');
    expect(fromToolItem(open)).toMatchObject({ kind: 'tool_call', name: 'Bash · python 统计', status: 'in_progress', created_at: at(14, 31, 30), updated_at: null });
    expect(fromToolItem({ ...open, kind: 'assistant_text' } as WireRunItem)).toBeNull();
    expect(fromToolItem({ ...open, status: 'denied' })?.status).toBe('completed');
  });

  it('fromConversation: group from pinned and the clock', () => {
    const g = (id: string) => fromConversation(one(WIRE_CONVERSATIONS, (c) => c.id === id), NOW).group;
    expect([g(C1), g(C2), g(C4)]).toEqual(['置顶', '今天', '更早']);
    expect(fromConversation(one(WIRE_CONVERSATIONS, (c) => c.id === C1), NOW)).toMatchObject({ revision: 6, active: true, archived: false, updated_at: at(14, 31) });
  });

  it('turnsToMessages: each turn is a me / ai pair with the turn time', async () => {
    const { turnsToMessages } = await import('../../src/domain/adapt');
    const msgs = turnsToMessages(WIRE_TURNS);
    expect(msgs.map((m) => m.kind)).toEqual(['me', 'ai', 'me', 'ai']);
    expect(msgs[1]).toMatchObject({ kind: 'ai', at: at(14, 14, 12), turn_ms: 12_000, turn_id: 'tr8' });
  });
});

describe('memory', () => {
  it('fromFact: uses with days ago, episode refs parsed, score only for observed facts, stale after 30 days', () => {
    const f2 = fromFact(one(WIRE_FACTS, (f) => f.text.startsWith('在 Endfield')), NOW);
    expect(f2.uses.map((u) => u.days_ago)).toEqual([0, 0, 1, 2, 4]);
    expect(f2.episode_refs.map((r) => r.id)).toEqual(['1201', '1203', '1205']);
    expect(f2.score).toBe(0.81);
    const f3 = fromFact({ ...one(WIRE_FACTS, (f) => f.source === 'asserted_by_user'), score: 0.9 }, NOW);
    expect(f3.score).toBeUndefined();
    expect(fromFact(one(WIRE_FACTS, (f) => f.text === '咖啡不加糖'), NOW).stale).toBe(true);
    expect(fromFact(one(WIRE_FACTS, (f) => f.state === 'candidate'), NOW).state).toBe('candidate');
  });

  it('fromEpisode and fromAttention', () => {
    const e = fromEpisode(WIRE_EPISODES[0] ?? WIRE_EPISODES[1]!);
    expect(e).toMatchObject({ id: '1201', start: at(9, 2), end: at(9, 48), apps: ['Xcode'] });
    const a = fromAttention(WIRE_ATTENTION_APP, WIRE_ATTENTION_DOMAIN);
    expect(a.summary).toEqual({ active_s: 16_030, afk_s: 4200, unknown_s: 900 });
    expect(a.apps[0]).toEqual({ app: 'Terminal', seconds: 85 * 60 });
    expect(a.hosts.map((h) => h.app)).toContain('github.com');
  });
});

describe('character, diagnostics, kernel', () => {
  it('fromCharacterState and fromStatePoint: ISO causes and epoch-second points become ms', () => {
    const s = fromCharacterState(WIRE_CHARACTER_STATE);
    expect(s).toMatchObject({ character_id: 'si', affects_behavior: true, activity: 'sitting' });
    expect(s.causes[0]).toEqual({ attr: 'valence', cause: 'task_failed', delta: -0.08, at: at(10, 15) });
    expect(fromCharacterState({ ...WIRE_CHARACTER_STATE, energy: null, labels: null }).energy).toBeNull();
    expect(fromStatePoint({ at: at(9, 0) / 1000, energy: 0.5, valence: 0.1, cause: 'user_spoke' })).toEqual({ at: at(9, 0), energy: 0.5, valence: 0.1, cause: 'user_spoke' });
  });

  it('fromRuntimePublic: one row per backend, titles as names, Pi has no login', () => {
    const r = fromRuntimePublic(WIRE_RUNTIME);
    expect(r.selected).toBe('codex');
    expect(r.runtimes.map((x) => x.id)).toEqual(['codex', 'pi']);
    expect(r.runtimes[0]).toMatchObject({ name: 'Codex', path: '/opt/homebrew/bin/codex', authenticated: true });
    expect(r.runtimes[1]).toMatchObject({ name: 'Pi', path: null, authenticated: null, available: true, reason: null });
  });

  it('fromTraceTurn: trace id as id, ISO start, result mapped', () => {
    const [open, blocked, failed] = WIRE_TRACE_TURNS.map(fromTraceTurn);
    expect(open).toMatchObject({ id: 'tr0', turn_id: 'turn-tr0', started_at: at(14, 32, 4), result: 'running', stages: [], marks: [] });
    expect(blocked?.result).toBe('skipped');
    expect(failed?.result).toBe('failed');
  });

  it('fromDiagBudget, fromCooldowns, fromTurnNow', () => {
    const b = fromDiagBudget(WIRE_DIAG_BUDGET, WIRE_DIAG_GATE);
    expect(b.gate).toEqual({ today: 6, daily_limit: 12, blocked_today: 3 });
    expect(b.model?.by_call.mouth).toMatchObject({ label: '对话回复', cache_tokens: 388_000, cost_usd: 0.29, unpriced: 0 });
    expect(fromDiagBudget({ ...WIRE_DIAG_BUDGET, model: null, screenshots: null }, WIRE_DIAG_GATE)).toMatchObject({ model: null, screenshots: null });
    expect(fromCooldowns(WIRE_DIAG_GATE)).toEqual([
      { key: 'proactive', label: '主动发言', left_s: 180, total_s: null },
      { key: 'rest', label: '休息提醒', left_s: 1440, total_s: null },
    ]);
    const now = fromTurnNow(WIRE_DIAG_TURN);
    expect(now?.phases_ms.map((p) => p.label)).toEqual(['收到输入', '组装上下文', '调模型']);
    expect(fromTurnNow({ ...WIRE_DIAG_TURN, trace_id: null })).toBeNull();
  });

  it('composeHealth: voice from the TTS block, runtime name from its backend title', () => {
    const h = composeHealth('connected', WIRE_RUNTIME, { agentd: { state: 'running', pid: 1 }, avatar: { state: 'running', pid: 2 } }, { connections: WIRE_DIAG_CONNECTIONS }, 60);
    expect(h).toEqual({
      agentd: { up: true, started_at: at(13, 20) },
      runtime: { ready: true, name: 'Codex', error: null },
      avatar: { child: 'running', fps: 60 },
      voice: { state: 'unreachable', retryAfterS: null },
    });
    const off = composeHealth('offline', null, null, { connections: { ...WIRE_DIAG_CONNECTIONS, tts: { configured: false, result: null, at: null, token_set: false, provider: 'none', state: 'off', reason: 'not_configured', retry_after_s: null } } });
    expect(off.voice.state).toBe('off');
    expect(off.agentd.up).toBe(false);
  });

});
