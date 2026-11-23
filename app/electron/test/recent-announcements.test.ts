// 最近播报 (src/common/recent-announcements.ts): what is announced, kept and opened from the bubble.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECENT_LIMIT, RecentAnnouncements } from '../src/common/recent-announcements.ts';

const announce = (seq: number, extra: Record<string, unknown> = {}) => ({ event: 'announce', id: String(seq),
  data: JSON.stringify({ seq, level: 'P2', kind: 'session_done', headline: `第 ${seq} 条`, speak: false, ...extra }) });
const at = (h: number, m: number) => new Date(2026, 10, 20, h, m).getTime();

test('recent: newest first with the local HH:mm it came at, unread, at most 20', () => {
  const r = new RecentAnnouncements();
  r.receive(announce(1), at(9, 5));
  r.receive(announce(2), at(14, 35));
  assert.deepEqual(r.rows(), [{ id: 'announce-2', text: '第 2 条', time: '14:35', unread: true },
    { id: 'announce-1', text: '第 1 条', time: '09:05', unread: true }]);
  for (let seq = 3; seq <= 25; seq += 1) r.receive(announce(seq), at(15, 0));
  assert.equal(RECENT_LIMIT, 20);
  assert.equal(r.rows().length, 20);
  assert.deepEqual([r.rows()[0]!.id, r.rows()[19]!.id], ['announce-25', 'announce-6']);
});

test('recent: the same seq again moves to the top unread; other events and malformed announces are left alone', () => {
  const r = new RecentAnnouncements();
  r.receive(announce(1), at(9, 0));
  r.receive(announce(2), at(9, 1));
  r.markAllRead();
  r.receive(announce(1), at(9, 2));
  assert.deepEqual(r.rows().map((x) => [x.id, x.unread, x.time]), [['announce-1', true, '09:02'], ['announce-2', false, '09:01']]);
  // FeedAnnounce decodes seq, level, kind, headline and speak or nothing.
  for (const data of ['{', JSON.stringify({ seq: 9, level: 'P2', headline: 'x', speak: false }),
    JSON.stringify({ seq: 9, level: 'P2', kind: 'k', headline: 'x' }), JSON.stringify({ seq: '9', level: 'P2', kind: 'k', headline: 'x', speak: false })]) {
    r.receive({ event: 'announce', id: null, data }, at(9, 3));
  }
  r.receive({ event: 'line', id: null, data: JSON.stringify({ seq: 9, level: 'P2', kind: 'k', headline: 'x', speak: false }) }, at(9, 3));
  assert.equal(r.rows().length, 2);
});

test('recent: a terminal takes back the earlier entries of its slot (session, else project, else kind), never a terminal', () => {
  const r = new RecentAnnouncements();
  r.receive(announce(1, { session_id: 's1', state: 'progress' }), at(9, 0));
  r.receive(announce(2, { session_id: 's2', state: 'progress' }), at(9, 0));
  r.receive(announce(3, { project: 'p', state: 'progress' }), at(9, 0));
  r.receive(announce(4, { kind: 'brief', state: 'progress' }), at(9, 0));
  r.receive(announce(5, { session_id: 's1' }), at(9, 0));
  r.receive(announce(6, { session_id: 's1', state: 'terminal' }), at(9, 0));
  assert.deepEqual(r.rows().map((x) => x.id), ['announce-6', 'announce-4', 'announce-3', 'announce-2']);
  r.receive(announce(10, { project: 'q', state: 'progress' }), at(9, 0));
  r.receive(announce(7, { session_id: 's1', state: 'terminal' }), at(9, 0));
  r.receive(announce(8, { project: 'p', state: 'terminal' }), at(9, 0));
  r.receive(announce(9, { kind: 'brief', state: 'terminal' }), at(9, 0));
  assert.deepEqual(r.rows().map((x) => x.id), ['announce-9', 'announce-8', 'announce-7', 'announce-10', 'announce-6', 'announce-2']);
});

test('recent: open marks one read and names its session; one without a session or gone names none', () => {
  const r = new RecentAnnouncements();
  r.receive(announce(1, { session_id: 'own:abc' }), at(9, 0));
  r.receive(announce(2), at(9, 1));
  assert.equal(r.open('announce-1'), 'own:abc');
  assert.equal(r.open('announce-2'), null);
  assert.equal(r.open('announce-7'), null);
  assert.deepEqual(r.rows().map((x) => x.unread), [false, false]);
  r.receive(announce(3), at(9, 2));
  r.receive(announce(4), at(9, 3));
  r.markAllRead();
  assert.deepEqual(r.rows().map((x) => x.unread), [false, false, false, false]);
});

test('recent: onChange hears each change of the rows, an announce, an open and 全部标为已读; nothing else', () => {
  const r = new RecentAnnouncements();
  let n = 0;
  r.onChange = () => { n += 1; };
  r.receive(announce(1), at(9, 0));
  r.receive({ event: 'line', id: null, data: '{}' }, at(9, 0));
  r.receive({ event: 'announce', id: null, data: '{' }, at(9, 0));
  assert.equal(n, 1);
  r.open('announce-1');
  r.open('announce-7');
  assert.equal(n, 2);
  r.markAllRead();
  assert.equal(n, 3);
});
