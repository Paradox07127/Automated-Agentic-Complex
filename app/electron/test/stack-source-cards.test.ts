// The stack's question, reminder, delivery, coding review, voice hint and drop cards, the resume notice, and the poll's
// system pause (src/common/stack-source.ts, src/common/stack-cards.ts), with the cases and values of StackSourceTests,
// StackDecisionsTests and StackSourcePollTests that cover them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cancel, EventSource, StreamEvent } from '../src/common/page.ts';
import { type Notify, type SystemNote, StackDecisions, StackSource } from '../src/common/stack-source.ts';

type Json = Record<string, unknown>;
const DID = 'delivery-0123456789abcdef0123456789abcdef';

/** Replies per `METHOD path` (404 otherwise) and records every request. */
class Transport {
  calls: { method: string; path: string; json: unknown }[] = [];
  replies = new Map<string, { status: number; body: string }>();
  failure: Error | null = null;
  /** While set, a presented receipt's reply waits for it. */
  gate: Promise<void> | null = null;
  set(method: string, path: string, body: unknown, status = 200) {
    this.replies.set(`${method} ${path}`, { status, body: JSON.stringify(body) });
  }
  count(method: string, path: string) { return this.calls.filter((c) => c.method === method && c.path === path).length; }
  request = async (method: string, path: string, json?: unknown) => {
    this.calls.push({ method, path, json });
    if (this.failure) throw this.failure;
    if (this.gate && path.endsWith('/presented')) await this.gate;
    return this.replies.get(`${method} ${path}`) ?? { status: 404, body: '{"error":"not_found"}' };
  };
}

class Feed implements EventSource {
  live = new Set<{ onEvent: (e: StreamEvent) => void; onReload?: () => void }>();
  subscribe(_after: string | null, onEvent: (e: StreamEvent) => void, onReload?: () => void): Cancel {
    const s = { onEvent, onReload };
    this.live.add(s);
    return () => { this.live.delete(s); };
  }
  push(event: string, data: string) { for (const s of this.live) s.onEvent({ event, id: null, data }); }
}

class Harness {
  transport = new Transport();
  feed = new Feed();
  now = 1_000_000_000;
  notify: Notify = { modes: { done: 'card', waiting: 'card', error: 'card', brief: 'card', reminder: 'card' }, systemNotifications: true };
  hidden = false;
  fullscreen = false;
  /** What the notifier reports for each post: false is permission denied. */
  granted = true;
  posted: SystemNote[] = [];
  sounds = 0;
  pushes: Json[] = [];
  ids: string[][] = [];
  source = new StackSource({
    request: this.transport.request, notify: () => this.notify, avatarHidden: () => this.hidden, frontFullscreen: () => this.fullscreen,
    playSound: () => { this.sounds += 1; }, clock: () => this.now,
    notifier: { post: async (n) => { this.posted.push(n); return this.granted; }, withdraw: () => {} },
  });
  constructor() {
    this.transport.set('GET', '/approvals', { approvals: [] });
    this.transport.set('GET', '/tasks', { tasks: [] });
    this.transport.set('GET', '/agent/interactions', { requests: [] });
    this.transport.set('GET', '/agent/tasks?limit=50', { tasks: [], next_cursor: null });
    this.transport.set('GET', '/commitments?state=triggered', { commitments: [] });
    this.source.onPush = (ids) => this.ids.push(ids);
  }
  listen() { this.source.subscribe(null, (e) => this.pushes.push(JSON.parse(e.data) as Json), () => {}); }
  get cards(): Json[] { return this.source.snapshot().cards; }
  get history(): Json[] { return this.source.snapshot().history; }
  card(id: string): Json | undefined { return this.cards.find((c) => c.id === id); }
  item(id: string): Json | undefined { return this.card(id)?.item as Json | undefined; }
  get postedIds() { return this.posted.map((n) => n.id); }
  get seen() { return this.transport.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/seen')).map((c) => c.path).sort(); }
  get posts() { return this.transport.calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/presented')); }
  decisions(o: { confirm?: (t: string) => boolean; click?: () => number | null; asked?: string[] } = {}) {
    return new StackDecisions(this.source, this.transport.request, async (t) => { o.asked?.push(t); return o.confirm?.(t) ?? true; },
      o.click ?? (() => null), () => this.now);
  }
  async load(o: { approvals?: Json[]; requests?: Json[]; tasks?: Json[]; coding?: Json[]; commitments?: Json[] }) {
    this.transport.set('GET', '/approvals', { approvals: o.approvals ?? [] });
    this.transport.set('GET', '/agent/interactions', { requests: o.requests ?? [] });
    this.transport.set('GET', '/agent/tasks?limit=50', { tasks: o.tasks ?? [] });
    this.transport.set('GET', '/tasks', { tasks: o.coding ?? [] });
    this.transport.set('GET', '/commitments?state=triggered', { commitments: o.commitments ?? [] });
    await this.source.refresh();
  }
}

/** Polls `condition` for up to 2 s. */
async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), `${what} not met in 2 s`);
}
const pause = (n: number) => new Promise((r) => setTimeout(r, n));

function interaction(id = 'q1', o: { kind?: string; state?: string; revision?: number; expires?: number; questions?: Json[];
  preview?: string; danger?: [boolean, string | null] } = {}): Json {
  const data: Json = { questions: o.questions ?? [{ id: 'fmt', question: '用哪种格式？', options: [{ label: '表格', description: '按项目' }, { label: '列表' }] }],
    job_id: 'j1', character_id: 'voice_a' };
  if (o.preview !== undefined) data.preview_text = o.preview;
  if (o.danger) { data.dangerous = o.danger[0]; data.danger_rule = o.danger[1]; }
  return { request_id: id, run_id: 'r1', kind: o.kind ?? 'question', state: o.state ?? 'pending', revision: o.revision ?? 2, generation: 1, data,
    answer: null, created_at: 999_900.0, expires_at: o.expires ?? 0, conversation_id: 'c1' };
}

function delivery(o: { id?: string; revision?: number; state?: string; presented?: number } = {}): Json {
  return { delivery_id: o.id ?? DID, revision: o.revision ?? 5, generation: 2, state: o.state ?? 'produced', produced_at: 999_700.0,
    presented_at: o.presented ?? null, viewed_at: null, decided_at: null, summary: '按项目分组',
    artifacts: [{ artifact_id: 'f1', path: 'out/report.md', absolute_path: '/w/out/report.md', version: 1, sha256: 'ab', self_checked: true }],
    redacted: false, canonical_task_id: 'job:j1', run_id: 'r1' };
}

function taskRow(cid = 'job:j1', o: { job?: string | null; task?: string | null; state?: string; delivery?: Json } = {}): Json {
  return { canonical_task_id: cid, task_id: o.task ?? null, job_id: o.job === undefined ? 'j1' : o.job, run_id: 'r1', generation: 2, revision: 4,
    title: '整理周报', state: o.state ?? 'needs_review', verification_source: 'automatic_checks', redacted: false, created_at: 999_000.0,
    updated_at: 999_800.0, delivery: o.delivery ?? delivery() };
}

function codingTask(id = 't9', o: { target?: string; state?: string } = {}): Json {
  return { task_id: id, target: o.target ?? 'codex', cwd: '/repo', title: '修 HostLink 重连', mode: 'workspace_write', state: o.state ?? 'needs_review',
    verify_cmd: null, session_id: 'own:aa', created_at: 999_000.0, updated_at: 999_500.0,
    result: { exit_code: null, output_tail: null, reason: 'no_verify_cmd' } };
}

const commitment = (id = 'c1', text = '16:00 组会') => ({ id, text, due_at: 999_990.0, state: 'triggered' });

function reminderDue(seq: number, o: { origin?: string; ids?: string[]; silent?: boolean } = {}): string {
  const a: Json = { seq, level: 'P0', kind: 'reminder_due', headline: '提醒你：交报销单', detail: null, speak: true, gate: null, project: null,
    session_id: null, origin: o.origin ?? 'c-42' };
  a.commitment_ids = o.ids ?? [a.origin];
  if (o.silent) a.silent = true;
  return JSON.stringify(a);
}

function announce(seq: number): string {
  return JSON.stringify({ seq, level: 'P2', kind: 'task', headline: '周报整理好了', detail: '3 个文件', speak: false, gate: null, project: null,
    session_id: 's-1', state: 'terminal' });
}

const roleQuestion = [{ id: 'decision', question: '是否允许这一次操作？', options: [{ label: '允许' }, { label: '拒绝' }] }];

// MARK: Questions

test('StackSourceTests.testQuestionsArePendingRequestsAndRoleApprovalsKeepTheirPreview', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1'),
    interaction('q2', { kind: 'approval', expires: 1_000_030, questions: roleQuestion, preview: '{\n  "path": "a.md"\n}' }),
    interaction('q3', { state: 'answered' })] });
  await h.source.refresh();
  assert.deepEqual(h.cards.map((c) => c.id), ['q1', 'q2']);
  const q1 = h.item('q1')!;
  assert.equal(q1.revision, 2);
  assert.equal(q1.interaction_kind, 'question');
  assert.equal(q1.expires_at, null);
  assert.equal(q1.seconds_left, null);
  assert.equal(q1.since, 999_900_000);
  assert.equal(q1.task_id, 'job:j1');
  assert.equal(((q1.questions as Json[])[0]!.options as Json[])[0]!.description, '按项目');
  const q2 = h.item('q2')!;
  assert.equal(q2.interaction_kind, 'approval');
  assert.equal(q2.preview_text, '{\n  "path": "a.md"\n}');
  assert.equal(q2.expires_at, 1_000_030_000);
  assert.equal(q2.seconds_left, 30);
  assert.equal(h.source.pendingCount, 2);
});

test('StackSourceTests.testRoleApprovalCarriesTheDangerVerdict', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1', { kind: 'approval', danger: [true, 'rm_recursive'] }),
    interaction('q2', { kind: 'approval', danger: [false, null] }), interaction('q3', { kind: 'approval' })] });
  await h.source.refresh();
  assert.equal(h.item('q1')!.dangerous, true);
  assert.equal(h.item('q1')!.danger_rule, 'rm_recursive');
  assert.equal(h.item('q2')!.dangerous, false);
  assert.equal(h.item('q2')!.danger_rule, undefined);
  // A row written before agentd sent the verdict.
  assert.equal(h.item('q3')!.dangerous, false);
});

test('StackSourceTests.testASettledRoleApprovalHasAnOutcome', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1', { kind: 'approval', expires: 1_000_030 }),
    interaction('q2', { kind: 'approval', expires: 1_000_030 }), interaction('q3', { kind: 'approval', expires: 1_000_030 }), interaction('q4')] });
  await h.source.refresh();
  h.source.settle('q1', 'denied', '已拒绝');
  h.source.settle('q4', 'approved', '已回答');
  assert.deepEqual(h.card('q1')!.outcome, { kind: 'denied', at: h.now, text: '已拒绝' });
  assert.equal(h.card('q1')!.receipt, '已拒绝');
  // A plain question keeps its receipt only.
  assert.equal(h.card('q4')!.outcome, undefined);
  h.source.markElsewhere('q2');
  assert.deepEqual(h.card('q2')!.outcome, { kind: 'elsewhere', at: h.now, text: '已在别处处理' });
  assert.equal(h.card('q2')!.receipt, '已在别处处理');
  h.now += 30_000;
  h.source.sweep();
  assert.equal((h.card('q3')!.outcome as Json).kind, 'expired');
  assert.equal(h.card('q3')!.receipt, '已过期');
});

test('StackSourceTests.testAnExpiredRoleApprovalLeavesWithoutARead', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q2', { kind: 'approval', expires: 1_000_030 })] });
  await h.source.refresh();
  assert.equal(h.source.pendingCount, 1);
  h.now += 30_000;
  h.source.sweep();
  assert.equal(h.card('q2')!.receipt, '已过期');
  assert.equal(h.source.pendingCount, 0);
  h.now += 9_000;
  h.source.sweep();
  assert.equal(h.card('q2'), undefined);
  assert.equal((h.history[0]!.card as Json).id, 'q2');
});

test('StackSourceTests.testOnlyWaitingApprovalsAndQuestionsArePresented', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [{ request_id: 'a1', generation: 3, tool_name: 'Bash', tool_summary: 'ls', status: 'pending', summary_truncated: false, dangerous: false, options: ['allow', 'deny'], window_s: 55, seconds_left: 50 }] });
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1')] });
  await h.source.refresh();
  h.source.addLookReceipt('前台窗口');
  assert.ok(h.source.presents('a1'));
  assert.ok(h.source.presents('q1'));
  assert.ok(!h.cards.map((c) => c.id as string).filter((id) => id !== 'a1' && id !== 'q1').some((id) => h.source.presents(id)));
});

test('StackSourceTests.testOnlyAMissingStoreEmptiesAList', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1')] });
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.ok(h.card('rem-c1'));
  h.transport.set('GET', '/agent/interactions', { error: 'resetting' }, 503);
  h.transport.set('GET', '/commitments?state=triggered', { error: 'no_commitments' }, 503);
  await h.source.refresh();
  assert.ok(h.card('q1'));
  assert.equal(h.card('q1')!.receipt, undefined);
  assert.equal(h.card('rem-c1'), undefined);
});

test('StackSourceTests.testFeedEventsTriggerARead', async () => {
  const h = new Harness();
  h.source.start(h.feed);
  try {
    await until(() => h.transport.count('GET', '/agent/interactions') === 1);
    h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1')] });
    h.feed.push('agent_interaction', '{"request_id":"q1"}');
    await until(() => h.card('q1') !== undefined, 'q1');
    h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
    h.feed.push('commitment', '{"action":"snoozed"}');
    await until(() => h.card('rem-c1') !== undefined, 'rem-c1');
    assert.equal(h.card('rem-c1')!.variant, 'reminder');
    assert.equal(h.card('rem-c1')!.title, '16:00 组会');
    h.feed.push('announce', announce(7));
    await until(() => h.card('announce-7') !== undefined, 'announce-7');
  } finally {
    h.source.stop();
  }
});

test('StackDecisionsTests.testAnswerSendsTheRevisionAndEveryQuestion', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q1')] });
  h.transport.set('POST', '/agent/interactions/q1/answer', { state: 'answered', resume_required: false });
  const d = h.decisions();
  await assert.rejects(d.decide('q1', { kind: 'answer', expected_version: 2, answers: { other: ['表格'] } }), { code: 'invalid_args' });
  await assert.rejects(d.decide('q1', { kind: 'answer', expected_version: 2, answers: { fmt: [] } }), { code: 'invalid_args' });
  await assert.rejects(d.decide('q1', { kind: 'answer', expected_version: 2, answers: { fmt: ['  '] } }), { code: 'invalid_args' });
  await assert.rejects(d.decide('q1', { kind: 'answer', expected_version: 1, answers: { fmt: ['表格'] } }), { code: 'stale' });
  assert.equal(h.posts.length, 0);
  await d.decide('q1', { kind: 'answer', expected_version: 2, answers: { fmt: ['表格'] } });
  assert.equal(h.posts[0]!.path, '/agent/interactions/q1/answer');
  assert.deepEqual(h.posts[0]!.json, { expected_version: 2, answers: { fmt: ['表格'] } });
  assert.equal(h.card('q1')!.receipt, '已回答');
  assert.equal(h.card('resume-q1'), undefined);
});

test('StackDecisionsTests.testARoleApprovalTakesOnlyAllowOrRefuse, and the resume notice', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q2', { kind: 'approval', expires: 1_000_030, questions: roleQuestion, preview: '{}' })] });
  h.transport.set('POST', '/agent/interactions/q2/answer', { state: 'answered', resume_required: true });
  const d = h.decisions();
  await assert.rejects(d.decide('q2', { kind: 'answer', expected_version: 2, answers: { decision: ['好的'] } }), { code: 'invalid_args' });
  await d.decide('q2', { kind: 'answer', expected_version: 2, answers: { decision: ['允许'] } });
  assert.equal(h.card('q2')!.receipt, '已允许');
  // The answer is saved, but the run must be continued from the main window.
  assert.deepEqual(h.card('resume-q2'), { id: 'resume-q2', kind: 'notice', variant: 'resume', title: '回答已保存 · 在主窗口继续',
    task_id: 'job:j1', at: h.now });
  h.now += 59_999;
  h.source.sweep();
  assert.ok(h.card('resume-q2'));
  h.now += 1;
  h.source.sweep();
  assert.equal(h.card('resume-q2'), undefined);
});

test('StackDecisionsTests.testADangerousRoleAllowNeedsAConfirmedClick', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q2', { kind: 'approval', expires: 1_000_030, questions: roleQuestion, preview: 'rm -rf build',
    danger: [true, 'rm_recursive'] })] });
  h.transport.set('POST', '/agent/interactions/q2/answer', { state: 'answered', resume_required: false });
  const allow = { kind: 'answer', expected_version: 2, answers: { decision: ['允许'] } };
  const confirmed = { ...allow, confirmed: true };
  const asked: string[] = [];
  let click: number | null = null;
  const d = h.decisions({ asked, confirm: () => false, click: () => click });
  await assert.rejects(d.decide('q2', confirmed), { code: 'declined' });
  click = h.now - 1200;
  await assert.rejects(d.decide('q2', confirmed), { code: 'declined' });
  assert.equal(asked.length, 0);
  // Without confirmed, a click too old asks natively.
  click = h.now - 2000;
  await assert.rejects(d.decide('q2', allow), { code: 'declined' });
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.includes('rm -rf build'));
  assert.equal(h.posts.length, 0);
  click = h.now - 500;
  await d.decide('q2', confirmed);
  assert.equal(asked.length, 1);
  assert.deepEqual(h.posts[0]!.json, { expected_version: 2, answers: { decision: ['允许'] } }, 'agentd gets the answer only');
  assert.deepEqual(h.card('q2')!.outcome, { kind: 'approved', at: h.now, text: '已允许' });
});

test('StackDecisionsTests.testAPlainRoleAllowNeedsNoGesture', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q2', { kind: 'approval', expires: 1_000_030, questions: roleQuestion, preview: '{}', danger: [false, null] }),
    interaction('q3', { kind: 'approval', expires: 1_000_030, questions: roleQuestion, danger: [true, 'rm_recursive'] })] });
  h.transport.set('POST', '/agent/interactions/q2/answer', { state: 'answered', resume_required: false });
  h.transport.set('POST', '/agent/interactions/q3/answer', { state: 'answered', resume_required: false });
  const asked: string[] = [];
  const d = h.decisions({ asked });
  await d.decide('q2', { kind: 'answer', expected_version: 2, answers: { decision: ['允许'] } });
  // Refusing a dangerous call needs no gesture either.
  await d.decide('q3', { kind: 'answer', expected_version: 2, answers: { decision: ['拒绝'] } });
  assert.deepEqual(asked, []);
  assert.equal(h.posts.length, 2);
  assert.equal((h.card('q2')!.outcome as Json).kind, 'approved');
  assert.equal((h.card('q3')!.outcome as Json).kind, 'denied');
});

test('StackDecisionsTests.testAnExpiredRoleApprovalShowsExpiredNotFailed', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q2', { kind: 'approval', expires: 1_000_030, questions: roleQuestion })] });
  h.transport.set('POST', '/agent/interactions/q2/answer', { error: 'approval_expired' }, 400);
  await assert.rejects(h.decisions().decide('q2', { kind: 'answer', expected_version: 2, answers: { decision: ['允许'] } }),
    { code: 'stale', detail: 'approval_expired' });
  assert.equal((h.card('q2')!.outcome as Json).kind, 'expired');
  assert.equal(h.card('q2')!.receipt, '已过期');
  assert.equal(h.source.pendingCount, 0);
});

test('StackDecisionsTests.testCancelQuestionDismissesThatRevision and testACancelledQuestionLeavesWithoutAFeedEvent', async () => {
  const h = new Harness();
  await h.load({ requests: [interaction('q1')] });
  assert.equal(h.source.pendingCount, 1);
  h.transport.set('POST', '/agent/interactions/q1/dismiss', { ok: true });
  h.transport.set('GET', '/agent/interactions', { requests: [] });
  await h.decisions().decide('q1', { kind: 'cancel-question', expected_version: 2 });
  assert.equal(h.posts[0]!.path, '/agent/interactions/q1/dismiss');
  assert.deepEqual(h.posts[0]!.json, { expected_version: 2 });
  assert.equal(h.source.pendingCount, 0);
  await until(() => h.card('q1') === undefined, 'q1 gone');
  assert.equal(h.history[0]!.title, '已取消这个请求');
});

// MARK: Reminders

test('StackSourceTests.testADueReminderIsAReminderCardForItsCommitmentAndSilentOnlyMutesIt', () => {
  const h = new Harness();
  h.notify.modes.reminder = 'sound';
  h.notify.modes.brief = 'silent';
  assert.equal(h.source.announce(reminderDue(9)), true);
  const card = h.card('announce-9')!;
  assert.equal(card.variant, 'reminder');
  assert.equal(card.commitment_id, 'c-42');
  assert.equal(h.sounds, 1);
  assert.equal(h.source.announce(reminderDue(10, { origin: 'c-43', silent: true })), true);
  assert.equal(h.card('announce-10')!.commitment_id, 'c-43', 'a silent reminder still shows');
  assert.equal(h.sounds, 1);
  h.now += 31_000;
  h.source.sweep();
  assert.ok(h.card('announce-9'), 'it waits for 延后 or 完成');
});

test('StackSourceTests.testADueReminderSettledElsewhereLeavesTheStack', async () => {
  const h = new Harness();
  h.source.start(h.feed);
  try {
    assert.equal(h.source.announce(reminderDue(9)), true);
    assert.equal(h.source.announce(reminderDue(10, { origin: 'c-43' })), true);
    h.feed.push('commitment', '{"action":"cancelled","commitment":{"id":"c-42","text":"交报销单","due_at":null,"state":"cancelled"}}');
    await until(() => h.card('announce-9') === undefined, 'announce-9 gone');
    assert.ok(h.card('announce-10'), 'only its own commitment\'s card');
    const reads = h.transport.count('GET', '/commitments?state=triggered');
    h.feed.push('commitment', '{"action":"fulfilled","commitment":{"id":"c-43","text":"交报销单","due_at":null,"state":"fulfilled"}}');
    await until(() => h.transport.count('GET', '/commitments?state=triggered') > reads, 'a read');
    assert.ok(h.card('announce-10'), 'delivery itself keeps it');
    h.feed.push('commitment', '{"action":"snoozed","commitment":{"id":"c-43","text":"交报销单","due_at":1000.0,"state":"armed"}}');
    await until(() => h.card('announce-10') === undefined, 'announce-10 gone');
  } finally {
    h.source.stop();
  }
});

test('StackSourceTests.testADueReminderIsOneCardWhicheverOfAnnounceAndListComesFirst', async () => {
  const h = new Harness();
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment('c-42', '交报销单')] });
  assert.equal(h.source.announce(reminderDue(9)), true);
  await h.source.refresh();
  assert.equal(h.cards.filter((c) => c.commitment_id === 'c-42').length, 1);
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment('c-43', '交报销单')] });
  await h.source.refresh();
  assert.equal(h.source.announce(reminderDue(10, { origin: 'c-43' })), true);
  assert.equal(h.cards.filter((c) => c.commitment_id === 'c-43').length, 1);
});

test('StackSourceTests.testAHiddenDueReminderGoesToMacOSWithItsCommitmentAndOpensTheReminders', () => {
  const h = new Harness();
  h.hidden = true;
  assert.equal(h.source.announce(reminderDue(9)), true);
  assert.equal(h.card('announce-9'), undefined);
  assert.deepEqual(h.posted, [{ id: 'announce-9', kind: 'reminder', text: '提醒你：交报销单', sound: false, sessionId: null, traceId: null,
    commitmentId: 'c-42' }]);
  assert.equal(h.source.notificationPath('announce-9'), '/overview?focus=reminders');
});

test('StackSourceTests.testAListedReminderCarriesItsCommitmentOnTheCardAndInItsNotification', async () => {
  const h = new Harness();
  h.hidden = true;
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.deepEqual(h.posted.map((n) => n.commitmentId), ['c1']);
  h.source.stop();
  h.hidden = false;
  await h.source.refresh();
  assert.equal(h.card('rem-c1')!.commitment_id, 'c1');
});

test('StackSourceTests.testReminderCardsAPageGetsAreNotReportedSeen', async () => {
  const h = new Harness();
  h.listen();
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  assert.equal(h.source.announce(reminderDue(9, { origin: 'a', ids: ['a', 'b'] })), true);
  await h.source.refresh();
  assert.deepEqual((h.pushes.at(-1)!.cards as Json[]).map((c) => c.id), ['announce-9', 'rem-c1']);
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [] });
  await h.source.refresh();
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  await h.source.refresh();
  assert.deepEqual(h.seen, [], 'the page that draws a card reports it');
});

test('StackSourceTests.testADueReminderCardPushedToAPageNamesItsCommitments', () => {
  const h = new Harness();
  h.listen();
  assert.equal(h.source.announce(reminderDue(9, { origin: 'a', ids: ['a', 'b'] })), true);
  const cards = h.pushes.at(-1)!.cards as Json[];
  assert.deepEqual(cards.find((c) => c.id === 'announce-9')!.commitment_ids, ['a', 'b']);
});

test('StackSourceTests.testAReminderNothingShowsIsNotSeen', async () => {
  const h = new Harness();
  h.listen();
  h.notify.modes.reminder = 'silent';
  assert.equal(h.source.announce(reminderDue(9)), true);
  h.notify.modes.reminder = 'card';
  h.hidden = true;
  h.notify.systemNotifications = false;
  assert.equal(h.source.announce(reminderDue(10, { origin: 'c-43' })), false);
  await h.source.refresh();
  assert.deepEqual(h.seen, []);
});

test('StackSourceTests.testADueReminderNotificationIsSeenOnlyOnceMacOSAddsIt', async () => {
  const h = new Harness();
  h.hidden = true;
  assert.equal(h.source.announce(reminderDue(9, { origin: 'a', ids: ['a', 'b'] })), true);
  await until(() => h.seen.length === 2, 'seen');
  assert.deepEqual(h.seen, ['/commitments/a/seen', '/commitments/b/seen']);
  h.granted = false;
  assert.equal(h.source.announce(reminderDue(10, { origin: 'c-43' })), true);
  assert.deepEqual(h.postedIds, ['announce-9', 'announce-10']);
  await h.source.refresh();
  assert.deepEqual(h.seen, ['/commitments/a/seen', '/commitments/b/seen']);
});

test('StackSourceTests.testAListedReminderSentToMacOSIsSeenOnlyOnceMacOSAddsIt', async () => {
  const h = new Harness();
  h.hidden = true;
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  await until(() => h.seen.length === 1, 'seen');
  h.granted = false;
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment(), commitment('c2', '17:00 交周报')] });
  await h.source.refresh();
  assert.deepEqual(h.postedIds, ['rem-c1', 'rem-c2']);
  await h.source.refresh();
  assert.deepEqual(h.seen, ['/commitments/c1/seen']);
});

test('StackSourceTests.testAHiddenReminderFollowsTheReminderNotifySetting', async () => {
  const h = new Harness();
  h.hidden = true;
  h.notify.modes.reminder = 'silent';
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.deepEqual(h.posted, [], 'a reminder is P3, not an approval');
});

test('StackSourceTests.testTheStackPanelGetsNoIdsOfChatWindowCards', async () => {
  const h = new Harness();
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.ok(h.card('rem-c1'));
  assert.deepEqual(h.ids.at(-1), [], 'a reminder shows in the chat window, so the stack stays closed');
});

test('StackDecisionsTests.testLaterSnoozesAReminderTenMinutesByDefault, AnHour and TakesOnlyMinutesAgentdAccepts', async () => {
  const h = new Harness();
  await h.load({ commitments: [commitment(), commitment('c2')] });
  h.transport.set('POST', '/commitments/c1/snooze', { commitment: {} });
  h.transport.set('POST', '/commitments/c2/snooze', { commitment: {} });
  const d = h.decisions();
  await assert.rejects(d.later('rem-c1', 30), { code: 'invalid_args' });
  assert.equal(h.posts.length, 0);
  assert.ok(h.card('rem-c1'));
  await d.later('rem-c1', null);
  assert.deepEqual(h.posts.map((c) => [c.path, c.json]), [['/commitments/c1/snooze', { minutes: 10 }]]);
  assert.equal(h.card('rem-c1'), undefined);
  assert.equal(h.history[0]!.title, '提醒 · 延后 10 分钟');
  await d.later('rem-c2', 60);
  assert.deepEqual(h.posts.at(-1)!.json, { minutes: 60 });
  assert.equal(h.history[0]!.title, '提醒 · 延后 1 小时');
});

test('StackDecisionsTests.testCollapsingAReminderOnlyFoldsIt', async () => {
  const h = new Harness();
  await h.load({ commitments: [commitment()] });
  h.decisions().collapse('rem-c1');
  assert.equal(h.posts.length, 0);
  assert.equal(h.card('rem-c1')!.collapsed, true);
});

test('StackDecisionsTests.testCompleteFinishesAReminder, testAReminderAgentdDidNotCompleteStays and testCompleteTakesRemindersOnly', async () => {
  const h = new Harness();
  await h.load({ approvals: [{ request_id: 'a1', generation: 3, status: 'pending', summary_truncated: false, dangerous: false, options: ['allow', 'deny'], window_s: 55, seconds_left: 50 }], commitments: [commitment(), commitment('c2')] });
  h.transport.set('POST', '/commitments/c1/complete', { commitment: {} });
  h.transport.set('POST', '/commitments/c2/complete', { error: 'boom' }, 500);
  const d = h.decisions();
  await d.complete('rem-c1');
  assert.deepEqual(h.posts.map((c) => c.path), ['/commitments/c1/complete']);
  assert.equal(h.card('rem-c1'), undefined);
  assert.equal(h.history[0]!.title, '提醒 · 已完成');
  await assert.rejects(d.complete('rem-c2'), { code: 'failed' });
  assert.ok(h.card('rem-c2'));
  assert.equal(h.card('rem-c2')!.collapsed, undefined);
  await assert.rejects(d.complete('a1'), { code: 'invalid_args' });
  await assert.rejects(d.complete('zz'), { code: 'invalid_args' });
  assert.equal(h.posts.length, 2);
});

// MARK: Deliveries

test('StackSourceTests.testReviewCardCarriesTheDeliveryRevisionAndReportsPresentedOnce', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow()] });
  h.transport.set('POST', `/agent/deliveries/${DID}/presented`, { delivery: delivery({ revision: 6, state: 'presented', presented: 1_000_000 }) });
  h.listen();
  await h.source.refresh();
  const card = h.card(`r-${DID}`)!;
  assert.equal(card.kind, 'review');
  assert.equal(card.source, 'delivery');
  const item = card.item as Json;
  assert.equal(item.task_id, 'job:j1');
  assert.equal(item.delivery_id, DID);
  assert.equal(item.generation, 2);
  assert.equal(item.verification_source, 'auto');
  assert.equal(item.title, '整理周报 v1', 'a runtime generation is not a delivery version');
  const d = card.delivery as Json;
  assert.equal(d.produced_at, 999_700_000);
  assert.equal((d.artifacts as Json[])[0]!.name, 'report.md');
  await until(() => h.transport.count('POST', `/agent/deliveries/${DID}/presented`) === 1, 'presented');
  assert.deepEqual(h.transport.calls.find((c) => c.path.endsWith('/presented'))!.json, { expected_revision: 5, generation: 2 });
  // The receipt's delivery is the record now, so a decision names revision 6.
  await until(() => h.item(`r-${DID}`)?.revision === 6, 'revision 6');
  await h.source.refresh();
  assert.equal(h.transport.count('POST', `/agent/deliveries/${DID}/presented`), 1);
  assert.equal(h.item(`r-${DID}`)?.revision, 6, 'a read that still lists revision 5 does not replace the receipt');
  assert.equal(h.source.pendingCount, 1);
});

test('a delivery read again while its presented receipt is in flight is reported once', async () => {
  const h = new Harness();
  let open = () => {};
  h.transport.gate = new Promise((r) => { open = r; });
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow()] });
  h.transport.set('POST', `/agent/deliveries/${DID}/presented`, { delivery: delivery({ revision: 6, state: 'presented', presented: 1_000_000 }) });
  h.listen();
  await h.source.refresh();
  await h.source.refresh();
  assert.equal(h.transport.count('POST', `/agent/deliveries/${DID}/presented`), 1);
  open();
  await until(() => h.item(`r-${DID}`)?.revision === 6, 'revision 6');
});

test('a delivery card leaves once its delivery is accepted or rejected', async () => {
  const h = new Harness();
  h.listen();
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  h.transport.set('POST', `/agent/deliveries/${DID}/presented`, { delivery: delivery({ revision: 6, state: 'presented', presented: 1_000_000 }) });
  await h.source.refresh();
  assert.ok(h.card(`d-${DID}`));
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed', delivery: delivery({ revision: 7, state: 'accepted' }) })] });
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined);
});

test('StackSourceTests.testPresentedWaitsForAPageToShowTheCard', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow()] });
  await h.source.refresh();
  await h.source.refresh();
  assert.ok(h.card(`r-${DID}`));
  assert.equal(h.transport.count('POST', `/agent/deliveries/${DID}/presented`), 0);
  h.listen();
  await until(() => h.transport.count('POST', `/agent/deliveries/${DID}/presented`) === 1, 'presented');
});

test('StackSourceTests.testOnlyAJustProducedDeliveryOpensADeliveryCard', async () => {
  const h = new Harness();
  h.listen();
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed', delivery: delivery({ state: 'presented', presented: 999_800 }) })] });
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined);
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  h.transport.set('POST', `/agent/deliveries/${DID}/presented`, { delivery: delivery({ revision: 6, state: 'presented', presented: 1_000_000 }) });
  await h.source.refresh();
  assert.ok(h.card(`d-${DID}`));
  await until(() => (h.card(`d-${DID}`)?.delivery as Json | undefined)?.revision === 6, 'revision 6');
  // Once shown it stays for its lifetime, though agentd now lists it as presented.
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed',
    delivery: delivery({ revision: 6, state: 'presented', presented: 1_000_000 }) })] });
  await h.source.refresh();
  assert.ok(h.card(`d-${DID}`));
  assert.equal(h.source.pendingCount, 0);
  h.now += 30_000;
  h.source.sweep();
  assert.equal(h.card(`d-${DID}`), undefined);
});

test('StackSourceTests.testDeliveriesAreReadPastTheFirstPage', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [], next_cursor: 'eyJ2IjoxfQ==' });
  h.transport.set('GET', '/agent/tasks?limit=50&cursor=eyJ2IjoxfQ%3D%3D', { tasks: [taskRow()], next_cursor: null });
  await h.source.refresh();
  assert.ok(h.card(`r-${DID}`));
});

test('StackSourceTests.testCollapseSendsNoticesErrorsAndDeliveriesToHistoryAndOnlyFoldsWaitingCards', async () => {
  const h = new Harness();
  h.transport.set('GET', '/agent/interactions', { requests: [interaction('q1')] });
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  await h.source.refresh();
  h.source.announce(announce(2));
  assert.ok(h.card(`d-${DID}`));
  for (const id of ['announce-2', `d-${DID}`, 'q1']) assert.ok(h.source.collapse(id), id);
  assert.equal(h.card(`d-${DID}`), undefined);
  assert.deepEqual(h.history.map((x) => (x.card as Json).id), [`d-${DID}`, 'announce-2']);
  assert.equal(h.card('q1')!.collapsed, true, 'a card waiting for the user only folds');
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined, 'an archived delivery does not come back');
});

test('StackSourceTests.testWhileSheIsHiddenADeliveryOrReminderGoesToMacOSInsteadOfTheStack', async () => {
  const h = new Harness();
  h.hidden = true;
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined);
  assert.equal(h.card('rem-c1'), undefined);
  assert.deepEqual(h.postedIds, [`d-${DID}`, 'rem-c1']);
  assert.deepEqual(h.posted[0], { id: `d-${DID}`, kind: 'done', text: '整理周报', sound: false, sessionId: null, traceId: null, commitmentId: null });
  await h.source.refresh();
  assert.equal(h.posted.length, 2, 'each is posted once');
  h.hidden = false;
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined, 'a delivery sent to macOS does not come back');
  assert.ok(h.card('rem-c1'), 'a reminder still due takes its card once she is back');
  assert.equal(h.posted.length, 2);
});

test('StackSourceTests.testANotificationSentAwayOpensItsTaskOrTheReminders', async () => {
  const h = new Harness();
  h.hidden = true;
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  h.transport.set('GET', '/commitments?state=triggered', { commitments: [commitment()] });
  await h.source.refresh();
  assert.equal(h.source.notificationPath(`d-${DID}`), '/overview?sel=job:j1&focus=task-job:j1');
  assert.equal(h.source.notificationPath('rem-c1'), '/overview?focus=reminders');
  assert.equal(h.source.notificationPath('announce-1'), null);
});

test('StackSourceTests.testAFullscreenAppSendsDeliveriesToMacOSButKeepsWaitingCards', async () => {
  const h = new Harness();
  h.fullscreen = true;
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' }),
    taskRow('job:j2', { job: 'j2', delivery: delivery({ id: 'delivery-2' }) })] });
  await h.source.refresh();
  assert.equal(h.card(`d-${DID}`), undefined);
  assert.ok(h.card('r-delivery-2'), 'a P1 review docks on the stack');
  assert.deepEqual(h.postedIds, [`d-${DID}`]);
});

test('StackSourceTests.testWithoutSystemNotificationsADeliveryKeepsItsCardWhileSheIsHidden', async () => {
  const h = new Harness();
  h.hidden = true;
  h.notify.systemNotifications = false;
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [taskRow('job:j1', { state: 'failed' })] });
  await h.source.refresh();
  assert.ok(h.card(`d-${DID}`));
  assert.deepEqual(h.posted, []);
});

const reviewDecision = (kind: string, o: { revision?: number; note?: string; task?: string } = {}): Json => ({ kind, task_id: o.task ?? 'job:j1',
  delivery_id: DID, expected_revision: o.revision ?? 5, generation: 2, ...(o.note !== undefined ? { note: o.note } : {}) });
const presentedRow = (cid = 'job:j1', o: { job?: string | null; task?: string | null } = {}) =>
  taskRow(cid, { ...o, delivery: delivery({ state: 'presented', presented: 999_800 }) });

test('StackDecisionsTests.testAcceptSendsTheDeliveryRevision', async () => {
  const h = new Harness();
  await h.load({ tasks: [presentedRow()] });
  h.transport.set('POST', '/agent/tasks/job%3Aj1/accept', { task: {}, delivery: {} });
  const d = h.decisions();
  await assert.rejects(d.decide(`r-${DID}`, reviewDecision('accept', { revision: 4 })), { code: 'stale' });
  await assert.rejects(d.decide(`r-${DID}`, { ...reviewDecision('accept'), delivery_id: 'delivery-ffffffffffffffffffffffffffffffff' }),
    { code: 'invalid_args' });
  await d.decide(`r-${DID}`, reviewDecision('accept'));
  assert.equal(h.posts[0]!.path, '/agent/tasks/job%3Aj1/accept');
  assert.deepEqual(h.posts[0]!.json, { expected_revision: 5, generation: 2, delivery_id: DID });
  assert.equal(h.card(`r-${DID}`)!.receipt, '已接受这一版');
});

test('StackDecisionsTests.testRejectWithANoteResumesTheJob', async () => {
  const h = new Harness();
  await h.load({ tasks: [presentedRow()] });
  h.transport.set('POST', '/agent/tasks/job%3Aj1/reject', { task: {}, delivery: {} });
  h.transport.set('POST', '/agent/jobs/j1/resume', { ok: true });
  await h.decisions().decide(`r-${DID}`, reviewDecision('reject', { note: '  按项目分组 ' }));
  assert.deepEqual(h.posts.map((c) => c.path), ['/agent/tasks/job%3Aj1/reject', '/agent/jobs/j1/resume']);
  assert.deepEqual(h.posts[1]!.json, { text: '按项目分组', use_current_backend: false });
  assert.equal(h.card(`r-${DID}`)!.receipt, '已退回：按项目分组');
});

test('StackDecisionsTests.testRejectWithANoteContinuesALedgerTask', async () => {
  const h = new Harness();
  await h.load({ tasks: [presentedRow('task:t5', { job: null, task: 't5' })] });
  h.transport.set('POST', '/agent/tasks/task%3At5/reject', { task: {}, delivery: {} });
  h.transport.set('POST', '/tasks/t5/continue', { ok: true });
  await h.decisions().decide(`r-${DID}`, reviewDecision('reject', { note: '补上测试', task: 'task:t5' }));
  assert.deepEqual(h.posts.map((c) => c.path), ['/agent/tasks/task%3At5/reject', '/tasks/t5/continue']);
  assert.deepEqual(h.posts[1]!.json, { text: '补上测试' });
});

test('StackDecisionsTests.testAnEmptyNoteRejectsOnly and testANoteThatDoesNotArriveIsPartial', async () => {
  const h = new Harness();
  await h.load({ tasks: [presentedRow()] });
  h.transport.set('POST', '/agent/tasks/job%3Aj1/reject', { task: {}, delivery: {} });
  await h.decisions().decide(`r-${DID}`, reviewDecision('reject', { note: '   ' }));
  assert.deepEqual(h.posts.map((c) => c.path), ['/agent/tasks/job%3Aj1/reject']);
  assert.equal(h.card(`r-${DID}`)!.receipt, '已退回');

  const p = new Harness();
  await p.load({ tasks: [presentedRow()] });
  p.transport.set('POST', '/agent/tasks/job%3Aj1/reject', { task: {}, delivery: {} });
  p.transport.set('POST', '/agent/jobs/j1/resume', { error: 'job_not_resumable' }, 409);
  await assert.rejects(p.decisions().decide(`r-${DID}`, reviewDecision('reject', { note: '按项目分组' })),
    { code: 'partial', detail: 'job_not_resumable' });
  assert.equal(p.card(`r-${DID}`)!.receipt, '已退回：按项目分组');
});

// MARK: Coding reviews

test('StackSourceTests.testCodingReviewsComeFromTheTaskLedgerExceptCharacterWork', async () => {
  const h = new Harness();
  h.transport.set('GET', '/tasks', { tasks: [codingTask(), codingTask('t8', { target: 'character' }), codingTask('t7', { state: 'running' })] });
  await h.source.refresh(false);
  assert.deepEqual(h.cards.map((c) => c.id), ['c-t9']);
  assert.equal(h.transport.count('GET', '/agent/interactions'), 0, 'a poll reads /approvals and /tasks only');
  const card = h.card('c-t9')!;
  assert.equal(card.kind, 'review');
  assert.equal(card.source, 'coding');
  assert.equal((card.item as Json).task_id, 'task:t9');
  assert.equal((card.item as Json).source, 'Codex · 修 HostLink 重连');
  assert.equal(card.summary, '没有设置检查命令，结果需要你复核。');
  assert.equal(h.source.pendingCount, 1);
});

test('StackDecisionsTests.testCodingReviewsUseTheLedgerRoutes', async () => {
  const h = new Harness();
  await h.load({ coding: [codingTask(), codingTask('t8')] });
  h.transport.set('POST', '/tasks/t9/accept', { ok: true });
  h.transport.set('POST', '/tasks/t8/reject', { ok: true });
  const d = h.decisions();
  await assert.rejects(d.decide('c-t9', { kind: 'accept', task_id: 'task:t8', delivery_id: '', expected_revision: 0, generation: 0 }),
    { code: 'invalid_args' });
  await d.decide('c-t9', { kind: 'accept', task_id: 'task:t9', delivery_id: '', expected_revision: 0, generation: 0 });
  assert.equal(h.card('c-t9')!.receipt, '已接受这一版');
  // agentd's /tasks/:id/continue takes character tasks only, so a coding task's note has nowhere to go.
  await assert.rejects(d.decide('c-t8', { kind: 'reject', task_id: 'task:t8', delivery_id: '', expected_revision: 0, generation: 0, note: '再跑一遍' }),
    { code: 'partial', detail: 'no_target' });
  assert.deepEqual(h.posts.map((c) => c.path), ['/tasks/t9/accept', '/tasks/t8/reject']);
  assert.ok(h.posts.every((c) => c.json === undefined));
});

// MARK: Native cards

test('StackSourceTests.testAVoiceResultStaysTwoAndAHalfSecondsAndMicDeniedStaysUntilClosed', () => {
  const h = new Harness();
  h.listen();
  h.source.setVoiceHint({ kind: 'listening', levels: [0.2], elapsed: 1.6, text: '提醒我开会' });
  assert.deepEqual(h.card('voice-hint'), { id: 'voice-hint', kind: 'notice', variant: 'voice', phase: 'listening', title: '正在录音',
    text: '提醒我开会', elapsed_s: 1, at: h.now });
  // A recording that ends without a result leaves at once and leaves no history.
  h.source.setVoiceHint(null);
  assert.equal(h.card('voice-hint'), undefined);
  assert.equal(h.history.length, 0);
  // So does a download let go of before it finished.
  h.source.setVoiceHint({ kind: 'downloading', fraction: 0.5, receivedMB: 104, totalMB: 208 });
  assert.deepEqual(h.card('voice-hint'), { id: 'voice-hint', kind: 'notice', variant: 'voice', phase: 'downloading',
    title: '第一次用，要先下载识别模型', fraction: 0.5, received_mb: 104, total_mb: 208, at: h.now });
  h.source.setVoiceHint(null);
  assert.equal(h.card('voice-hint'), undefined);
  assert.equal(h.history.length, 0);

  h.source.setVoiceHint({ kind: 'sent', text: '提醒我开会', elapsed: 2 });
  assert.equal(h.card('voice-hint')!.phase, 'sent');
  h.now += 2000;
  // The same result again does not start its time over, and null keeps a result up.
  h.source.setVoiceHint({ kind: 'sent', text: '提醒我开会', elapsed: 2 });
  h.source.setVoiceHint(null);
  h.now += 400;
  h.source.sweep();
  assert.ok(h.card('voice-hint'));
  h.now += 100;
  h.source.sweep();
  assert.equal(h.card('voice-hint'), undefined);
  assert.equal(h.history[0]!.title, '已发送');

  h.source.setVoiceHint({ kind: 'discarded', reason: '按住不到 0.3 秒', elapsed: 0.2 });
  assert.equal(h.card('voice-hint')!.text, '按住不到 0.3 秒');
  h.source.setVoiceHint({ kind: 'micDenied' });
  assert.equal(h.card('voice-hint')!.phase, 'mic_denied');
  h.source.setVoiceHint(null);
  h.now += 600_000;
  h.source.sweep();
  assert.ok(h.card('voice-hint'));
  assert.ok(h.source.collapse('voice-hint'));
  assert.equal(h.card('voice-hint'), undefined);
  assert.equal(h.history[0]!.title, '麦克风被拒');
  assert.equal(h.source.pendingCount, 0);
  // A notice is a chat card: the hud's ids leave it out.
  assert.deepEqual(h.ids.at(-1), []);
});

test('StackSourceTests.testADropIsACardOfItsPathsNamesHandlesAndKindsOnly', () => {
  const h = new Harness();
  h.listen();
  h.source.addDrop([{ kind: 'file', path: '/Users/someone/Desktop/周报.md', handle: 'H1' }, { kind: 'file', path: '/Users/someone/Desktop/a.png', handle: 'H2' },
    { kind: 'url', url: 'https://example.com/a' }, { kind: 'text', text: '记得带伞' }], true);
  const id = (h.pushes.at(-1)!.cards as Json[])[0]!.id as string;
  assert.equal(id, `drop-${h.now}`);
  assert.deepEqual(h.card(id), { id, kind: 'notice', variant: 'drop', title: '交给她 · 4 项', truncated: true, at: h.now, items: [
    { kind: 'file', path: '/Users/someone/Desktop/周报.md', name: '周报.md', handle: 'H1' },
    { kind: 'file', path: '/Users/someone/Desktop/a.png', name: 'a.png', handle: 'H2' },
    { kind: 'url', url: 'https://example.com/a' }, { kind: 'text', text: '记得带伞' }] });
  // It waits for an action or 关闭.
  h.now += 3_600_000;
  h.source.sweep();
  assert.ok(h.card(id));
  assert.ok(h.source.collapse(id));
  assert.equal(h.card(id), undefined);
  assert.equal(h.history[0]!.title, '交给她 · 4 项');
});

test('a Windows path dropped on her is named by its last segment', () => {
  const h = new Harness();
  h.source.addDrop([{ kind: 'file', path: 'C:\\Users\\a\\b.txt', handle: 'H1' }], false);
  assert.deepEqual((h.cards[0]!.items as Json[])[0], { kind: 'file', path: 'C:\\Users\\a\\b.txt', name: 'b.txt', handle: 'H1' });
});

// MARK: System pause (StackSourcePollTests)

function polled(every: number) {
  const transport = new Transport();
  transport.set('GET', '/approvals', { approvals: [] });
  transport.set('GET', '/tasks', { tasks: [] });
  const source = new StackSource({ request: transport.request, notify: () => ({ modes: {}, systemNotifications: false }), avatarHidden: () => false,
    frontFullscreen: () => false, playSound: () => {}, pollInterval: every });
  return { transport, source, polls: () => transport.count('GET', '/approvals') };
}

test('StackSourcePollTests.testNothingIsPolledWhileSystemPaused', async () => {
  const { transport, source, polls } = polled(20);
  source.start(null);
  try {
    await until(() => polls() >= 3, 'three polls');
    source.setSystemPaused(true);
    await pause(60);
    const paused = polls();
    await pause(200);
    assert.equal(polls(), paused, 'no /approvals or /tasks while locked or asleep');
    assert.equal(transport.count('GET', '/tasks'), paused);
  } finally {
    source.stop();
  }
});

test('StackSourcePollTests.testTheEndOfAPauseReadsAtOnce', async () => {
  const { source, polls } = polled(30_000);
  source.start(null);
  try {
    await until(() => polls() === 1, 'the first read');
    source.setSystemPaused(true);
    source.setSystemPaused(false);
    await until(() => polls() === 2, 'a read at once');
  } finally {
    source.stop();
  }
});

test('StackSourcePollTests.testAPauseAtStartWaitsForItsEnd', async () => {
  const { transport, source, polls } = polled(20);
  source.setSystemPaused(true);
  source.start(null);
  try {
    await pause(100);
    assert.equal(polls(), 0);
    source.setSystemPaused(false);
    await until(() => transport.count('GET', '/agent/interactions') === 1, 'a full read');
  } finally {
    source.stop();
  }
});
