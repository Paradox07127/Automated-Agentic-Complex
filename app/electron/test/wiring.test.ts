import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appKitY, helperY } from '../src/common/attention.ts';
import { type Config, launchCharacter } from '../src/common/config.ts';
import { agentdForwarding, TRACE_FORWARD, TraceForwarder } from '../src/main/agentd/forward.ts';
import type { HelperReply } from '../src/main/helper/client.ts';
import { nextTraceEpoch } from '../src/main/placement/store.ts';
import { avatarPointRect, c3Cursor, currentCharacterOf, handleNudge, helloBuild, notifySettings, pagesRoot, refreshRoster, SystemPause } from '../src/main/wiring.ts';

const flush = () => new Promise((r) => setImmediate(r));

test('hello.build carries the git commit the build put in, unknown without one', () => {
  assert.deepEqual(helloBuild('1.2.0', '4a0d702'), { shell: 'electron', version: '1.2.0', git: '4a0d702' });
  assert.deepEqual(helloBuild('1.2.0', undefined), { shell: 'electron', version: '1.2.0', git: 'unknown' });
  assert.equal(helloBuild('1.2.0', '').git, 'unknown');
});

test('the cursor goes to the link in C3 points: the placement space point of the DIP pointer, mapped to C3', () => {
  const space = { fromDip: (r: { x: number; y: number }) => ({ x: r.x, y: 900 - r.y, w: 0, h: 0 }), pointToC3: (p: { x: number; y: number }) => ({ x: p.x, y: -p.y }) };
  assert.deepEqual(c3Cursor(space, { x: 10, y: 100 }), { x: 10, y: -800 });
});

test('trace_epoch is max(last + 1, now in ms) and is saved in state.json beside the other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epoch-'));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ last_character: 'aster', trace_epoch: 5000 }));
    assert.equal(nextTraceEpoch(dir, 1000), 5001);
    assert.equal(nextTraceEpoch(dir, 9000), 9000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), { last_character: 'aster', trace_epoch: 9000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace events go to POST /trace/events in batches after 0.5 s or 200 events, held and retried while agentd fails', async () => {
  let now = 100;
  const sent: Record<string, unknown>[][] = [];
  let status = 0;
  const f = new TraceForwarder(77, async (events) => (sent.push(events), status), () => now);
  try {
    f.add([{ n: 1 }]);
    f.add([{ n: 2 }]);
    f.tick();
    assert.equal(sent.length, 0);
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    await flush();
    assert.deepEqual([...sent], [[{ n: 1 }, { n: 2 }]]);
    // Failed: back in front, nothing before the retry time.
    f.add([{ n: 3 }]);
    f.tick();
    assert.equal(sent.length, 1);
    status = 200;
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    await flush();
    assert.deepEqual(sent[1], [{ n: 1 }, { n: 2 }, { n: 3 }]);
    f.add(Array.from({ length: TRACE_FORWARD.batchSize }, (_, n) => ({ n })));
    await flush();
    assert.equal(sent[2]!.length, TRACE_FORWARD.batchSize);
    // Past the buffer limit the oldest go, reported as one companion trace.dropped event in front of the next batch.
    status = 0;
    f.add([{ n: 'x' }]);
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    await flush();
    f.add(Array.from({ length: TRACE_FORWARD.maxBuffered }, (_, n) => ({ n })));
    status = 200;
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    await flush();
    const batch = sent.find((b) => b[0]?.kind === 'trace.dropped')!;
    assert.equal(batch.length, TRACE_FORWARD.batchSize);
    // 199 went with the report and 1801 left: nine full batches at once, the last one on the next tick.
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    await flush();
    assert.equal(sent.reduce((n, b) => n + b.filter((e) => e.kind !== 'trace.dropped').length, 0) - 206, TRACE_FORWARD.maxBuffered);
    assert.equal(batch[0]!.kind, 'trace.dropped');
    assert.equal(batch[0]!.producer, 'companion');
    assert.equal(batch[0]!.producer_epoch, 77);
    assert.deepEqual(batch[0]!.attrs && (batch[0]!.attrs as Record<string, unknown>).count, 1);
    assert.deepEqual(batch[1], { n: 0 });
  } finally {
    f.stop();
  }
});

test('trace, behavior receipts in their order and motion requests reach agentd on their routes', async () => {
  const posts: [string, unknown][] = [], lines: string[] = [];
  let release: (() => void) | null = null;
  const fw = agentdForwarding({
    epoch: 1,
    post: async (path, body) => {
      posts.push([path, body]);
      if (path === '/behavior/receipts' && (body as { behavior_id: string }).behavior_id === 'b1') await new Promise<void>((r) => { release = r; });
      if (path === '/trace/events') return { status: 200, body: { rejected: [{ error: 'bad_kind' }] } };
      return { status: path === '/motions/generate' ? 500 : 200, body: null };
    },
    log: (line) => lines.push(line),
  });
  try {
    fw.onBehaviorReceipt({ behavior_id: 'b1', phase: 'started' });
    fw.onBehaviorReceipt({ behavior_id: 'b2', phase: 'started' });
    await flush();
    assert.deepEqual(posts.map(([p]) => p), ['/behavior/receipts']);
    release!();
    await flush();
    await flush();
    assert.deepEqual(posts.map(([p, b]) => `${p} ${(b as { behavior_id: string }).behavior_id}`), ['/behavior/receipts b1', '/behavior/receipts b2']);
    fw.onMotionRequest({ request_id: 'm1' });
    await flush();
    assert.deepEqual(posts.at(-1), ['/motions/generate', { request_id: 'm1' }]);
    assert.ok(lines.includes('motion request forward request_id=m1 status=500'), lines.join('\n'));
    fw.onTrace([{ kind: 'k' }]);
    await new Promise((r) => setTimeout(r, TRACE_FORWARD.flushAfter * 1000 + 150));
    assert.deepEqual(posts.at(-1), ['/trace/events', { events: [{ kind: 'k' }] }]);
    assert.ok(lines.includes('trace forward events=1 rejected=1 error=bad_kind'), lines.join('\n'));
  } finally {
    fw.stop();
  }
});

test('lock and sleep pause her, unlock and wake end it once neither holds; each change is told once', () => {
  const told: boolean[] = [];
  const p = new SystemPause((paused) => told.push(paused));
  p.lock(true);
  p.sleep(true);
  p.lock(false);
  assert.deepEqual(told, [true]);
  p.sleep(false);
  p.sleep(false);
  assert.deepEqual(told, [true, false]);
});

test('an alert nudge makes her point (no window rect without the helper); a comment only logs', () => {
  const sent: [string, unknown][] = [], lines: string[] = [];
  let connected = true;
  const link = { avatarFrame: { x: 0, y: 0, w: 400, h: 600 }, sendPointAt: (id: string, rect: unknown) => (sent.push([id, rect]), connected) };
  const place = { helperY: appKitY, mainHeight: () => 900 };
  const nudge = (o: Record<string, unknown>) => handleNudge({ event: 'nudge', id: '1', data: JSON.stringify(o) }, link, null, place, (l) => lines.push(l));
  void nudge({ seq: 1, nudge_id: 'a1', kind: 'alert', level: 'P1', target: 42, speak: false });
  void nudge({ seq: 2, nudge_id: 'c1', kind: 'comment', level: 'P2', target: null, line_id: 'l1', speak: true, gate: 'quiet' });
  connected = false;
  void nudge({ seq: 3, nudge_id: 'a2', kind: 'alert', level: 'P1', speak: false });
  void handleNudge({ event: 'announce', id: '2', data: '{}' }, link, null, place, (l) => lines.push(l));
  void nudge({ nudge_id: 'bad' });
  assert.deepEqual(sent, [['a1', null], ['a2', null]]);
  assert.deepEqual(lines, [
    'NUDGE kind=alert target=42 speak=false gate=null result=point_at rect=null',
    'NUDGE kind=comment target=null speak=true gate=quiet result=none',
    'NUDGE kind=alert target=null speak=false gate=null result=point_at no_avatar',
  ]);
});

test('an alert nudge with a target points at the bounds windows.list gives that window, else at null; no target asks nothing', async () => {
  const sent: [string, unknown][] = [], lines: string[] = [], asked: [string, unknown][] = [];
  let reply: HelperReply = { ok: true, result: { windows: [
    { window_id: 7, pid: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { window_id: 42, pid: 2, bounds: { x: 300.25, y: 200, width: 500, height: 300.5 } },
  ] } };
  const link = { avatarFrame: { x: 100, y: 50, w: 400, h: 600 }, sendPointAt: (id: string, rect: unknown) => (sent.push([id, rect]), true) };
  const helper = { request: async (op: string, params?: Record<string, unknown>) => (asked.push([op, params]), reply) };
  const place = { helperY: appKitY, mainHeight: () => 900 };
  const nudge = (o: Record<string, unknown>) => handleNudge({ event: 'nudge', id: '1', data: JSON.stringify(o) }, link, helper, place, (l) => lines.push(l));
  await nudge({ seq: 1, nudge_id: 'a1', kind: 'alert', level: 'P1', target: 42, speak: false });
  await nudge({ seq: 2, nudge_id: 'a2', kind: 'alert', level: 'P1', target: 8, speak: false });
  reply = { ok: false, error: { code: 'helper_exited', message: 'the helper is not running' } };
  await nudge({ seq: 3, nudge_id: 'a3', kind: 'alert', level: 'P1', target: 42, speak: false });
  await nudge({ seq: 4, nudge_id: 'a4', kind: 'alert', level: 'P1', target: null, speak: false });
  assert.deepEqual(sent, [['a1', { x: 200.25, y: 349.5, w: 500, h: 300.5 }], ['a2', null], ['a3', null], ['a4', null]]);
  assert.deepEqual(asked, [['windows.list', undefined], ['windows.list', undefined], ['windows.list', undefined]]);
  assert.deepEqual(lines, [
    'NUDGE kind=alert target=42 speak=false gate=null result=point_at rect=200,350,500,301',
    'NUDGE kind=alert target=8 speak=false gate=null result=point_at rect=null',
    'NUDGE kind=alert target=42 speak=false gate=null result=point_at rect=null',
    'NUDGE kind=alert target=null speak=false gate=null result=point_at rect=null',
  ]);
});

test('a window\'s helper bounds become a rect in her window\'s points: C3 global, less her frame\'s origin', () => {
  const frame = { x: 100, y: 50, w: 400, h: 600 }, bounds = { x: 300, y: 200, w: 500, h: 300 };
  assert.deepEqual(avatarPointRect(bounds, 900, frame, appKitY), { x: 200, y: 350, w: 500, h: 300 });
  assert.deepEqual(avatarPointRect(bounds, 900, frame, helperY), { x: 200, y: 150, w: 500, h: 300 });
});

test('TraceForwarder.emit queues a companion event of the turn at its own moment, numbered with trace.dropped', async () => {
  let now = 100;
  const sent: Record<string, unknown>[][] = [];
  const f = new TraceForwarder(77, async (events) => (sent.push(events), 200), () => now);
  try {
    f.emit('ui.submitted', 't1', 'l1', 3, { wall: 50.5, monoMs: 1234 });
    f.emit('ui.ack', 't1', 'l1', 3, { wall: 50.75, monoMs: 1484 });
    now += TRACE_FORWARD.flushAfter;
    f.tick();
    assert.equal(sent.length, 1);
    const [first, second] = sent[0]!;
    assert.match(String(first!.event_id), /^[0-9a-f-]{36}$/);
    assert.match(String(first!.span_id), /^[0-9a-f]{16}$/);
    assert.deepEqual({ ...first, event_id: null, span_id: null }, { v: 1, event_id: null, trace_id: 't1', turn_id: 'l1', turn_generation: 3,
      span_id: null, parent_span_id: null, causation_id: null, producer: 'companion', producer_epoch: 77, seq: 1, kind: 'ui.submitted',
      t_wall: new Date(50500).toISOString(), t_mono_ms: 1234, status: 'ok', attrs: {} });
    assert.deepEqual([second!.seq, second!.kind, second!.t_mono_ms], [2, 'ui.ack', 1484]);
  } finally {
    f.stop();
  }
});

test('agentdForwarding.mark posts the turn mark with the trace events', async () => {
  const posted: [string, unknown][] = [];
  const f = agentdForwarding({ epoch: 5, post: async (path, body) => (posted.push([path, body]), { status: 200, body: null }), log: () => {} });
  try {
    f.mark('ui.first_text', 't9', 'l9', 2, { wall: 1, monoMs: 2 });
    const deadline = Date.now() + 5000;
    while (posted.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(posted[0]![0], '/trace/events');
    const events = (posted[0]![1] as { events: Record<string, unknown>[] }).events;
    assert.deepEqual(events.map((e) => [e.kind, e.trace_id, e.turn_id, e.turn_generation, e.producer_epoch]), [['ui.first_text', 't9', 'l9', 2, 5]]);
  } finally {
    f.stop();
  }
});

test("desktop.onState's and the preview's character is the switch's current one, which a text-only character keeps from the renderer's", () => {
  // Switched from the rendered si to the text-only cedar: the stopped renderer still reports si.
  assert.equal(currentCharacterOf({ current: 'cedar' }, { currentCharacter: 'si' }, 'si'), 'cedar');
  assert.equal(currentCharacterOf({ current: null }, { currentCharacter: 'si' }, 'cedar'), 'si', 'before the first hello: the renderer\'s');
  assert.equal(currentCharacterOf(null, null, 'si'), 'si');
  assert.equal(currentCharacterOf(null, null, ''), null);
});

test('notify_* left out take their defaults: card for done and brief, sound for approval, error and reminder', () => {
  assert.deepEqual(notifySettings({}, false), { modes: { done: 'card', waiting: 'sound', error: 'sound', brief: 'card', reminder: 'sound' },
    systemNotifications: true });
  assert.deepEqual(notifySettings({ notify_reminder: 'silent', notify_done: 'loud', system_notifications: false }, false).modes.reminder, 'silent');
  assert.equal(notifySettings({ system_notifications: false }, false).systemNotifications, false);
});

test('while quiet an approval card still comes but does not sound; the other kinds keep their modes', () => {
  assert.deepEqual(notifySettings({}, true).modes, { done: 'card', waiting: 'card', error: 'sound', brief: 'card', reminder: 'sound' });
  assert.equal(notifySettings({ notify_approval: 'silent' }, true).modes.waiting, 'silent');
  assert.equal(notifySettings({}, false).modes.waiting, 'sound');
});

test('the first character imported into an empty library is the one the renderer and agentd then launch', () => {
  const roster = (ids: string[]) => ids.map((id) => ({ id, name: id, avatarApp: '/a', avatarArgs: [], renderEnabled: true }));
  const config = { characters: roster([]), character: '' } as Pick<Config, 'characters' | 'character'>;
  refreshRoster(config, { characters: roster(['si']), character: 'si' });
  assert.equal(launchCharacter(config as Config, undefined), 'si');
  refreshRoster(config, { characters: roster(['si', 'cedar']), character: 'si' });
  assert.deepEqual(config.characters.map((c) => c.id), ['si', 'cedar']);
  assert.equal(launchCharacter(config as Config, 'cedar'), 'cedar', 'the last switch still wins');
});

test('the pages come from the dev deployment\'s ui/ when dev_resources has one, its art inside it (WebMainWindowAssembly.resource)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-'));
  try {
    const base = { devWeb: null, webSrc: '/repo/web', packaged: null, webDist: '/repo/web/dist', uiArt: '/art', devResources: join(dir, 'current') };
    assert.deepEqual(pagesRoot(base), { root: '/repo/web/dist', art: '/art' }, 'no deployment yet');
    mkdirSync(join(dir, 'current', 'ui'), { recursive: true });
    assert.deepEqual(pagesRoot(base), { root: join(dir, 'current', 'ui'), art: null });
    assert.deepEqual(pagesRoot({ ...base, packaged: '/App/Resources/ui' }), { root: join(dir, 'current', 'ui'), art: null });
    assert.deepEqual(pagesRoot({ ...base, devResources: null, packaged: '/App/Resources/ui' }), { root: '/App/Resources/ui', art: null });
    assert.deepEqual(pagesRoot({ ...base, devWeb: 'http://127.0.0.1:5173' }), { root: '/repo/web', art: '/art' }, 'the vite server first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
