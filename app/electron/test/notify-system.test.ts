// System notifications (src/common/notify.ts, src/main/notify/system.ts) and their clicks, over fake
// notifications: no test posts a real one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickRoute, noteContent } from '../src/common/notify.ts';
import { RecentAnnouncements } from '../src/common/recent-announcements.ts';
import { type SystemNote, StackSource } from '../src/common/stack-source.ts';
import { type NoteContent, SystemNotifier } from '../src/main/notify/system.ts';

/** Records what is done to it; `emit` stands in for the system. */
class FakeNote {
  listeners = new Map<string, ((event: unknown, error: string) => void)[]>();
  shown = 0;
  closed = 0;
  readonly content: NoteContent;
  constructor(content: NoteContent) { this.content = content; }
  on(event: string, listener: (event: unknown, error: string) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  show() { this.shown += 1; }
  close() { this.closed += 1; }
  emit(event: string, detail: unknown = {}, error = '') {
    for (const l of this.listeners.get(event) ?? []) l(detail, error);
  }
}

class Harness {
  supported = true;
  notes: FakeNote[] = [];
  opened: string[] = [];
  paths = new Map<string, string>();
  path = (id: string): string | null => this.paths.get(id) ?? null;
  /** What the fake system does on `show`. */
  answer: 'show' | 'failed' | null = 'show';
  recent = new RecentAnnouncements();
  notifier = new SystemNotifier({
    supported: () => this.supported,
    create: (content) => {
      const n = new FakeNote(content);
      const show = n.show.bind(n);
      n.show = () => {
        show();
        if (this.answer === 'show') n.emit('show');
        if (this.answer === 'failed') n.emit('failed', {}, 'denied');
      };
      this.notes.push(n);
      return n;
    },
    notificationPath: (id) => this.path(id),
    openMain: (route) => this.opened.push(route),
    recent: this.recent,
  });
}

const note = (o: Partial<SystemNote> = {}): SystemNote => ({
  id: 'announce-1', kind: 'done', text: '周报整理好了', sound: false, sessionId: null, traceId: null, commitmentId: null, ...o,
});

test('content: the title is the kind label, the body the line, the group its notify_* key, and only a sound mode sounds', () => {
  const kinds = [['done', '完成', 'notify_done'], ['waiting', '待确认', 'notify_approval'], ['error', '出错', 'notify_error'],
    ['brief', '简短', 'notify_brief'], ['reminder', '提醒', 'notify_reminder']] as const;
  for (const [kind, title, group] of kinds) {
    assert.deepEqual(noteContent(note({ id: `n-${kind}`, kind })),
      { id: `n-${kind}`, title, body: '周报整理好了', groupId: group, silent: true });
  }
  assert.equal(noteContent(note({ sound: true })).silent, false);
});

test('click route: the source\'s own path first, then the decision trace, then the session, else the home page', () => {
  assert.equal(clickRoute(note({ traceId: 't-1', sessionId: 's-1' }), '/overview?focus=reminders'), '/overview?focus=reminders');
  assert.equal(clickRoute(note({ traceId: 't 1&x', sessionId: 's-1' }), null), '/diag?tab=records&kind=decision&trace=t%201%26x');
  assert.equal(clickRoute(note({ sessionId: 's=1#2' }), null), '/overview?sel=s%3D1%232&focus=task-s%3D1%232');
  assert.equal(clickRoute(note(), null), '/home');
});

test('post: resolves true once the system showed it, with the content as the notification options', async () => {
  const h = new Harness();
  assert.equal(await h.notifier.post(note({ kind: 'error', sound: true })), true);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.shown, 1);
  assert.deepEqual(h.notes[0]!.content, { id: 'announce-1', title: '出错', body: '周报整理好了', groupId: 'notify_error', silent: false });
});

test('post: false when the system refused it (notifications turned off) or has no notifications; nothing is made then', async () => {
  const h = new Harness();
  h.answer = 'failed';
  assert.equal(await h.notifier.post(note()), false);
  h.supported = false;
  assert.equal(await h.notifier.post(note({ id: 'announce-2' })), false);
  assert.equal(h.notes.length, 1);
  // A refused one is not held: withdrawing it closes nothing.
  h.notifier.withdraw(['announce-1']);
  assert.equal(h.notes[0]!.closed, 0);
});

test('click: opens the route the source names for the id, read at the click, else by the note\'s trace and session', async () => {
  const h = new Harness();
  await h.notifier.post(note({ id: 'rem-c1', kind: 'reminder', traceId: 't-1' }));
  await h.notifier.post(note({ id: 'announce-2', sessionId: 's-1' }));
  h.paths.set('rem-c1', '/overview?focus=reminders');
  h.notes[0]!.emit('click', {});
  h.notes[1]!.emit('click', {});
  assert.deepEqual(h.opened, ['/overview?focus=reminders', '/overview?sel=s-1&focus=task-s-1']);
});

test('click: its 最近播报 entry first, marked read, selecting its session; one without a session or gone falls through', async () => {
  const h = new Harness();
  const announce = (seq: number, extra: Record<string, unknown> = {}) => h.recent.receive({ event: 'announce', id: String(seq),
    data: JSON.stringify({ seq, level: 'P1', kind: 'task', headline: `第 ${seq} 条`, speak: false, ...extra }) }, 0);
  announce(1, { session_id: 's 1' });
  announce(2);
  await h.notifier.post(note({ id: 'announce-1', sessionId: 'other', traceId: 't-1' }));
  await h.notifier.post(note({ id: 'announce-2', traceId: 't-2' }));
  await h.notifier.post(note({ id: 'announce-3', sessionId: 's-3' }));
  h.paths.set('announce-1', '/overview?focus=reminders');
  for (const n of h.notes) n.emit('click', {});
  assert.deepEqual(h.opened, ['/overview?sel=s%201&focus=task-s%201', '/diag?tab=records&kind=decision&trace=t-2',
    '/overview?sel=s-3&focus=task-s-3']);
  assert.deepEqual(h.recent.rows().map((r) => [r.id, r.unread]), [['announce-2', false], ['announce-1', false]]);
});

test('withdraw: closes the held notifications it names, once; a clicked one is no longer held', async () => {
  const h = new Harness();
  await h.notifier.post(note({ id: 'a' }));
  await h.notifier.post(note({ id: 'b' }));
  await h.notifier.post(note({ id: 'c' }));
  h.notes[2]!.emit('click', {});
  h.notifier.withdraw(['a', 'c', 'unknown']);
  h.notifier.withdraw(['a']);
  assert.deepEqual(h.notes.map((n) => n.closed), [1, 0, 0]);
});

test('with StackSource: a hidden avatar\'s reminder goes to a notification, is seen once shown, and its click opens the reminders', async () => {
  const h = new Harness();
  const calls: string[] = [];
  const source = new StackSource({
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      return { status: 200, body: '{}' };
    },
    notify: () => ({ modes: { reminder: 'sound', error: 'card' }, systemNotifications: true }),
    avatarHidden: () => true, frontFullscreen: () => false, playSound: () => {}, notifier: h.notifier,
  });
  h.path = (id) => source.notificationPath(id);
  assert.equal(source.announce(JSON.stringify({ seq: 7, level: 'P2', kind: 'reminder_due', headline: '喝水', origin: 'c1', commitment_ids: ['c1'], silent: true })), true);
  assert.equal(source.announce(JSON.stringify({ seq: 8, level: 'P1', kind: 'task', headline: '构建失败', session_id: 's-1', trace_id: 't-9' })), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.notes.map((n) => n.content), [
    { id: 'announce-7', title: '提醒', body: '喝水', groupId: 'notify_reminder', silent: true },
    { id: 'announce-8', title: '出错', body: '构建失败', groupId: 'notify_error', silent: true },
  ]);
  assert.deepEqual(calls, ['POST /commitments/c1/seen']);
  h.notes[0]!.emit('click', {});
  h.notes[1]!.emit('click', {});
  assert.deepEqual(h.opened, ['/overview?focus=reminders', '/diag?tab=records&kind=decision&trace=t-9']);
  assert.equal(source.announce(JSON.stringify({ seq: 9, level: 'P1', kind: 'task', headline: '又失败了' })), true);
  // agentd gone: the notifications still up are taken back.
  source.stop();
  assert.deepEqual(h.notes.map((n) => n.closed), [0, 0, 1]);
});
