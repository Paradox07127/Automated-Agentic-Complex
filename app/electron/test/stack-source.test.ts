// The stack's approval and announcement cards (src/common/stack-source.ts) with the cases and values of StackSourceTests and
// StackDecisionsTests that cover them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComputerUsePanelState } from '../src/common/computer-control.ts';
import { AVATAR_STAGE_TITLES, type Notify, StackDecisions, StackSource, TEST_APPROVAL_ID } from '../src/common/stack-source.ts';

type Json = Record<string, unknown>;

/** Replies per `METHOD path` (404 otherwise) and records every request. */
class Transport {
  calls: { method: string; path: string; json: unknown }[] = [];
  replies = new Map<string, { status: number; body: string }>();
  failure: Error | null = null;
  set(method: string, path: string, body: unknown, status = 200) {
    this.replies.set(`${method} ${path}`, { status, body: JSON.stringify(body) });
  }
  request = async (method: string, path: string, json?: unknown) => {
    this.calls.push({ method, path, json });
    if (this.failure) throw this.failure;
    return this.replies.get(`${method} ${path}`) ?? { status: 404, body: '{"error":"not_found"}' };
  };
}

class Harness {
  transport = new Transport();
  now = 1_000_000_000;
  notify: Notify = { modes: { done: 'card', waiting: 'card', error: 'card', brief: 'card', reminder: 'card' } };
  hidden = false;
  sounds = 0;
  pushes: Json[] = [];
  ids: string[][] = [];
  source = new StackSource({
    request: this.transport.request, notify: () => this.notify, avatarHidden: () => this.hidden, frontFullscreen: () => false,
    playSound: () => { this.sounds += 1; }, clock: () => this.now,
  });
  constructor() {
    this.transport.set('GET', '/approvals', { approvals: [] });
    this.source.onPush = (ids) => this.ids.push(ids);
  }
  listen() {
    this.source.subscribe(null, (e) => this.pushes.push(JSON.parse(e.data) as Json), () => {});
  }
  get cards(): Json[] { return this.source.snapshot().cards as Json[]; }
  get history(): Json[] { return this.source.snapshot().history as Json[]; }
  card(id: string): Json | undefined { return this.cards.find((c) => c.id === id); }
}

function approval(o: { id?: string; generation?: number; dangerous?: boolean; options?: string[]; left?: number } = {}): Json {
  const options = o.options ?? ['allow', 'deny'];
  return {
    request_id: o.id ?? 'a1', generation: o.generation ?? 3, display_session: 'own:c07a1b2c3d4e', source: 'claude', session_id: 's-1',
    agent_id: null, tool_name: 'Bash', tool_summary: 'rm -rf build', kind: 'tool', dispatch: null, summary_truncated: false,
    summary_length: 12, content_preview: null, cwd: '/repo', dangerous: o.dangerous ?? false, danger_rule: o.dangerous ? 'rm_rf' : null,
    options, session_scope: options.includes('allow_session') ? { kind: 'rule', detail: 'Bash(rm:*)' } : null, status: 'pending',
    created_at: 999_995.0, window_s: 55, seconds_left: o.left ?? 50,
  };
}

function announce(seq: number, o: { level?: string; state?: string | null; kind?: string; origin?: string } = {}): string {
  const a: Json = { seq, level: o.level ?? 'P2', kind: o.kind ?? 'task', headline: '周报整理好了', detail: '3 个文件', speak: false, gate: null,
    project: null, session_id: 's-1' };
  if (o.state !== null) a.state = o.state ?? 'terminal';
  if (o.origin !== undefined) a.origin = o.origin;
  return JSON.stringify(a);
}

test('an approval card has epoch milliseconds and the backend fields', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval({ options: ['allow', 'allow_session', 'deny'] })] });
  await h.source.refresh();
  const card = h.card('a1')!;
  assert.equal(card.kind, 'approval');
  assert.equal(card.session, 'task');
  const item = card.item as Json;
  assert.equal(item.since, h.now - 5000);
  assert.equal(card.at, h.now - 5000);
  assert.equal(item.fetched_at, h.now);
  assert.equal(item.generation, 3);
  assert.equal(item.approval_kind, 'tool');
  assert.equal(item.title, 'Bash: rm -rf build');
  assert.equal(item.source, 'Claude Code · own:c07a1b2c3d4e');
  assert.equal(item.scope_ok, true);
  assert.equal(h.source.snapshot().now, h.now);
  assert.equal(h.source.pendingCount, 1);
});

test('a vanished approval shows elsewhere, then moves to history', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval()] });
  await h.source.refresh();
  h.transport.set('GET', '/approvals', { approvals: [] });
  h.now += 1000;
  await h.source.refresh();
  assert.equal((h.card('a1')!.outcome as Json).kind, 'elsewhere');
  assert.equal(h.source.pendingCount, 0);
  h.now += 9000;
  await h.source.refresh();
  assert.equal(h.card('a1'), undefined);
  assert.equal(h.history[0]!.title, 'Bash: rm -rf build');
  assert.equal((h.history[0]!.card as Json).id, 'a1');
});

test('an approval gone after its deadline is expired', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval({ left: 2 })] });
  await h.source.refresh();
  h.transport.set('GET', '/approvals', { approvals: [] });
  h.now += 3000;
  await h.source.refresh();
  assert.equal((h.card('a1')!.outcome as Json).kind, 'expired');
});

test('a card this panel settled goes to history under its receipt', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval()] });
  await h.source.refresh();
  h.source.settle('a1', 'approved', '已批准');
  assert.equal(h.card('a1')!.receipt, '已批准');
  assert.equal((h.card('a1')!.outcome as Json).kind, 'approved');
  h.transport.set('GET', '/approvals', { approvals: [] });
  await h.source.refresh();
  assert.equal(h.card('a1'), undefined);
  assert.equal(h.history[0]!.title, '已批准');
});

test('a done card carries the task its announcement names: task:<origin>; none without an origin, a session id is not one', () => {
  const h = new Harness();
  h.source.announce(announce(1, { kind: 'dispatch_closed', origin: 'aaaa' }));
  assert.equal(h.card('announce-1')!.variant, 'done');
  assert.equal(h.card('announce-1')!.task_id, 'task:aaaa');
  h.source.announce(announce(2, { kind: 'dispatch_done' }));
  assert.equal(h.card('announce-2')!.variant, 'done');
  assert.equal(Object.hasOwn(h.card('announce-2')!, 'task_id'), false);
});

test('announcements map to cards by kind, and the same seq twice is one card', () => {
  const h = new Harness();
  assert.equal(h.source.announce(announce(1, { level: 'P1', state: null })), true);
  const error = h.card('announce-1')!;
  assert.equal(error.kind, 'error');
  assert.equal(error.title, '周报整理好了');
  assert.equal(error.reason, '3 个文件');
  assert.equal(h.source.announce(announce(2)), true);
  assert.equal(h.card('announce-2')!.kind, 'notice');
  assert.equal(h.card('announce-2')!.variant, 'done');
  assert.equal(h.source.announce(announce(3, { state: 'progress' })), true);
  assert.equal(h.card('announce-3')!.variant, 'brief');
  assert.equal(h.source.announce(announce(3, { state: 'progress' })), true);
  assert.equal(h.cards.filter((c) => c.id === 'announce-3').length, 1);
  assert.equal(h.sounds, 0);
});

test('notices leave for history after their lifetime', () => {
  const h = new Harness();
  h.source.announce(announce(1));
  h.source.announce(announce(2, { level: 'P1', state: null }));
  h.now += 21_000;
  h.source.sweep();
  assert.equal(h.card('announce-1'), undefined);
  assert.notEqual(h.card('announce-2'), undefined);
  assert.equal(h.history[0]!.title, '周报整理好了');
});

test('a silent mode shows no card; while she is hidden nothing shows', () => {
  const h = new Harness();
  h.notify = { modes: { ...h.notify.modes, brief: 'silent' } };
  assert.equal(h.source.announce(announce(1, { state: 'progress' })), true);
  assert.equal(h.card('announce-1'), undefined);
  h.notify = { modes: { ...h.notify.modes, brief: 'card' } };
  h.hidden = true;
  assert.equal(h.source.announce(announce(2, { state: 'progress' })), false);
  assert.equal(h.card('announce-2'), undefined);
});

test('pushes the whole payload on subscribe and only after a change; ids leave out chat cards', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval()] });
  await h.source.refresh();
  h.listen();
  assert.equal(h.pushes.length, 1);
  await h.source.refresh();
  assert.equal(h.pushes.length, 1);
  h.source.announce(announce(1, { state: 'progress' }));
  assert.equal(h.pushes.length, 2);
  assert.deepEqual(h.ids.at(-1), ['a1']);
});

test('a new delivery and a new review card are on the stack page and present it', async () => {
  const h = new Harness();
  const delivery = (id: string) => ({ delivery_id: id, revision: 5, generation: 2, state: 'produced', produced_at: 999_700.0, presented_at: null,
    summary: '按项目分组', artifacts: [{ artifact_id: 'f1', path: 'out/report.md', absolute_path: '/w/out/report.md' }], canonical_task_id: `job:${id}` });
  const row = (id: string, state: string) => ({ canonical_task_id: `job:${id}`, task_id: null, job_id: id, run_id: 'r1', generation: 2, revision: 4,
    title: '整理周报', state, redacted: false, delivery: delivery(id) });
  h.transport.set('GET', '/agent/tasks?limit=50', { tasks: [row('j1', 'running'), row('j2', 'needs_review')] });
  await h.source.refresh();
  assert.deepEqual(h.ids.at(-1), ['d-j1', 'r-j2']);
  assert.ok(h.source.presents('d-j1'));
  assert.ok(h.source.presents('r-j2'));
});

test('stop pushes offline once', async () => {
  const h = new Harness();
  await h.source.refresh();
  h.listen();
  h.source.stop();
  h.source.stop();
  assert.deepEqual(h.pushes.at(-1), { error: { code: 'offline', detail: '后台已断开' } });
  assert.equal(h.pushes.filter((p) => p.error).length, 1);
});

test('a malformed /approvals row is a failed read: the cards stay, polling and requestRefresh go on', async () => {
  const transport = new Transport();
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => { rejections.push(e); };
  process.on('unhandledRejection', onRejection);
  const source = new StackSource({ request: transport.request, notify: () => ({ modes: {} }), avatarHidden: () => false,
    frontFullscreen: () => false, playSound: () => {}, pollInterval: 10 });
  const reads = () => transport.calls.filter((c) => c.path === '/approvals').length;
  const ids = () => source.snapshot().cards.map((c) => c.id);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    return ok();
  };
  try {
    transport.set('GET', '/approvals', { approvals: [approval()] });
    source.start(null);
    assert.ok(await until(() => ids().includes('a1')));
    transport.set('GET', '/approvals', { approvals: [null] });
    const before = reads();
    assert.ok(await until(() => reads() >= before + 3), 'polling stopped after the malformed row');
    source.requestRefresh();
    assert.deepEqual(ids(), ['a1']);
    transport.set('GET', '/approvals', { approvals: [approval({ id: 'a2' })] });
    assert.ok(await until(() => ids().includes('a2')), `${ids()}`);
    const after = transport.calls.length;
    source.requestRefresh();
    assert.ok(await until(() => transport.calls.slice(after).some((c) => c.path === '/agent/interactions')), 'requestRefresh stayed stuck');
    assert.deepEqual(rejections, []);
  } finally {
    source.stop();
    process.off('unhandledRejection', onRejection);
  }
});

test('the settings test approval shows and settles locally', async () => {
  const h = new Harness();
  await h.source.refresh();
  const decisions = new StackDecisions(h.source, h.transport.request, async () => true, () => null, () => h.now);
  assert.equal(h.source.showTestApproval(), true);
  const card = h.card(TEST_APPROVAL_ID)!;
  const item = card.item as Json;
  assert.equal(item.title, '测试审批: 允许一次演示操作？');
  await decisions.decide(TEST_APPROVAL_ID, { kind: 'approval', verdict: 'allow', generation: item.generation });
  assert.equal(h.card(TEST_APPROVAL_ID)!.receipt, '测试已批准');
  assert.equal(h.transport.calls.filter((c) => c.method === 'POST').length, 0);
});

test('allow sends the decision with the card generation and settles the card', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval()] });
  await h.source.refresh();
  h.transport.set('POST', '/approvals/a1/decision', { ok: true });
  const decisions = new StackDecisions(h.source, h.transport.request, async () => true, () => null, () => h.now);
  await decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 3 });
  const call = h.transport.calls.find((c) => c.method === 'POST')!;
  assert.deepEqual(call.json, { decision: 'allow', generation: 3 });
  assert.equal(h.card('a1')!.receipt, '已批准');
  await assert.rejects(decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 3 }), { code: 'busy' });
});

test('an old generation is stale, and agentd replies map to stale, failed and offline', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval(), approval({ id: 'a2' }), approval({ id: 'a3' })] });
  await h.source.refresh();
  const decisions = new StackDecisions(h.source, h.transport.request, async () => true, () => null, () => h.now);
  await assert.rejects(decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 2 }), { code: 'stale' });
  await assert.rejects(decisions.decide('zz', { kind: 'approval', verdict: 'allow', generation: 3 }), { code: 'invalid_args' });
  h.transport.set('POST', '/approvals/a1/decision', { error: 'gone' }, 409);
  await assert.rejects(decisions.decide('a1', { kind: 'approval', verdict: 'deny', generation: 3 }), { code: 'stale' });
  assert.equal((h.card('a1')!.outcome as Json).kind, 'elsewhere');
  h.transport.set('POST', '/approvals/a2/decision', { error: 'boom' }, 500);
  await assert.rejects(decisions.decide('a2', { kind: 'approval', verdict: 'deny', generation: 3 }), { code: 'failed' });
  h.transport.failure = new Error('ECONNREFUSED');
  await assert.rejects(decisions.decide('a3', { kind: 'approval', verdict: 'deny', generation: 3 }), { code: 'offline' });
});

test('a dangerous allow needs a recent click or the native confirm', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval({ dangerous: true })] });
  await h.source.refresh();
  h.transport.set('POST', '/approvals/a1/decision', { ok: true });
  const asked: string[] = [];
  let click: number | null = null;
  const decisions = new StackDecisions(h.source, h.transport.request, async (t) => { asked.push(t); return false; }, () => click, () => h.now);
  await assert.rejects(decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 3 }), { code: 'declined' });
  assert.equal(asked.length, 1);
  await assert.rejects(decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 3, confirmed: true }), { code: 'declined' });
  click = h.now - 500;
  await decisions.decide('a1', { kind: 'approval', verdict: 'allow', generation: 3, confirmed: true });
  assert.equal(asked.length, 1);
});

test('collapse sends notices and errors to history and only folds waiting cards; later on them collapses', async () => {
  const h = new Harness();
  h.transport.set('GET', '/approvals', { approvals: [approval()] });
  await h.source.refresh();
  h.source.announce(announce(1));
  const decisions = new StackDecisions(h.source, h.transport.request, async () => true, () => null, () => h.now);
  decisions.collapse('announce-1');
  assert.equal(h.card('announce-1'), undefined);
  await decisions.later('a1', null);
  assert.equal(h.card('a1')!.collapsed, true);
  assert.throws(() => decisions.collapse('nope'), { code: 'invalid_args' });
  await assert.rejects(decisions.complete('a1'), { code: 'invalid_args' });
});

test('StackSourceTests.testAvatarLoadingFollowsTheHostAndAFailureWaitsForTheUser', () => {
  const h = new Harness();
  h.listen();
  h.source.setAvatarLoading({ kind: 'loading', character: '示例甲', title: '正在加载动作' });
  assert.deepEqual(h.card('avatar-loading'), { id: 'avatar-loading', kind: 'notice', variant: 'loading', phase: 'loading', title: '正在加载动作',
    character: '示例甲', at: h.now });
  h.source.setAvatarLoading({ kind: 'hidden' });
  assert.equal(h.card('avatar-loading'), undefined);
  assert.equal(h.history.length, 0);

  h.source.setAvatarLoading({ kind: 'recovering', character: '示例甲', seconds: 5 });
  assert.equal(h.card('avatar-loading')!.phase, 'recovering');
  assert.equal(h.card('avatar-loading')!.title, '角色恢复中');
  assert.equal(h.card('avatar-loading')!.retry_at, h.now + 5000);
  h.source.setAvatarLoading({ kind: 'failed', message: '角色加载失败' });
  assert.equal(h.card('avatar-loading')!.phase, 'failed');
  assert.equal(h.card('avatar-loading')!.title, '角色加载失败');
  assert.equal(h.card('avatar-loading')!.character, undefined);
  assert.deepEqual((h.pushes.at(-1)!.cards as Json[]).map((c) => c.id), ['avatar-loading']);
  // A notice is a chat card: the hud's ids leave it out.
  assert.deepEqual(h.ids.at(-1), []);
  h.now += 3_600_000;
  h.source.sweep();
  assert.ok(h.card('avatar-loading'));
  // 关闭 sends it to history.
  assert.ok(h.source.collapse('avatar-loading'));
  assert.equal(h.card('avatar-loading'), undefined);
  assert.equal(h.history[0]!.title, '角色加载失败');
});

test('the loading stage titles are AvatarLoadingStage.title', () => {
  assert.deepEqual(AVATAR_STAGE_TITLES, { starting: '正在启动角色', loading_character: '正在加载角色', loading_animations: '正在加载动作',
    preparing_graphics: '正在准备画面', connecting: '正在连接角色', ready: '角色已准备好', failed: '角色加载失败' });
});

test('StackSourceTests.testALookReceiptLastsTwoSeconds', () => {
  const h = new Harness();
  h.listen();
  h.source.addLookReceipt('Terminal — endfield-companion');
  const id = h.cards[0]!.id as string;
  assert.ok(id.startsWith('look-'));
  assert.deepEqual(h.card(id), { id, kind: 'notice', variant: 'look', title: '已识读：Terminal — endfield-companion', at: h.now });
  h.now += 1_900;
  h.source.sweep();
  assert.ok(h.card(id));
  h.now += 100;
  h.source.sweep();
  assert.equal(h.card(id), undefined);
  assert.equal(h.history[0]!.title, '已识读：Terminal — endfield-companion');
  // A notice is a chat card: the hud's ids leave it out.
  assert.deepEqual(h.ids.at(-1), []);
});

function panel(phase: ComputerUsePanelState['phase'], o: Partial<ComputerUsePanelState> = {}): ComputerUsePanelState {
  return { phase, targetApp: null, action: '只有你启用后，才会查看或操作指定窗口。', scopeChips: [], permissions: {}, pendingGrants: [],
    showsPermissionChoices: true, canResume: false, challenge: null, ...o };
}

test('StackSourceTests.testComputerUseIsAResidentCardThatFoldsAndGoesToHistoryWhenTheSessionEnds', () => {
  const h = new Harness();
  h.listen();
  h.source.setComputerUse(panel('disabled'));
  assert.equal(h.card('computer-use'), undefined);
  h.source.setComputerUse(panel('executing', { targetApp: '访达', action: '已移动 12 / 30 个文件', scopeChips: ['下载文件夹'] }));
  assert.deepEqual(h.card('computer-use'), { id: 'computer-use', kind: 'notice', variant: 'computer', title: '正在操作', phase: 'executing',
    target_app: '访达', target_title: null, action: '已移动 12 / 30 个文件', scopes: ['下载文件夹'], at: h.now });
  // The hud shows it, and it waits on no one.
  assert.deepEqual(h.ids.at(-1), ['computer-use']);
  assert.equal(h.source.pendingCount, 0);
  const at = h.now;
  // No lifetime: it stays however long the session runs.
  h.now += 3_600_000;
  h.source.sweep();
  assert.ok(h.card('computer-use'));
  // 收起 folds it; a later state keeps the fold and the arrival time.
  assert.ok(h.source.collapse('computer-use'));
  h.source.setComputerUse(panel('verifying', { targetApp: '访达' }));
  assert.equal(h.card('computer-use')!.collapsed, true);
  assert.equal(h.card('computer-use')!.phase, 'verifying');
  assert.equal(h.card('computer-use')!.title, '正在检查结果');
  assert.equal(h.card('computer-use')!.at, at);
  h.source.setComputerUse(panel('completed'));
  assert.equal(h.card('computer-use'), undefined);
  assert.equal(h.history[0]!.title, '电脑操作');
  assert.deepEqual(h.ids.at(-1), []);
  h.source.setComputerUse(null);
  assert.equal(h.history.length, 1);
});

test('the computer use card is up while observing, executing, verifying or paused, under ComputerUsePhase.title', () => {
  const h = new Harness();
  const titles: Record<string, string> = { observing: '正在查看', executing: '正在操作', verifying: '正在检查结果', paused: '已暂停' };
  for (const phase of ['disabled', 'ready', 'waitingPermission', 'observing', 'executing', 'verifying', 'paused', 'completed', 'failed'] as const) {
    h.source.setComputerUse(panel(phase));
    assert.equal(h.card('computer-use')?.title, titles[phase], phase);
  }
});
