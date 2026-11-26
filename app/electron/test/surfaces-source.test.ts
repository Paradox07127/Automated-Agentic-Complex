// The surface source (src/main/surfaces/): each tick's surfaces and the link's track
// handling, on a fake platform helper, a fake link and a fake clock. Nothing here reads the real system's windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AttentionSample, type HelperY, helperY } from '../src/common/attention.ts';
import type { Box } from '../src/common/c3.ts';
import type { HelperAnswer } from '../src/common/push-to-talk.ts';
import type { SurfaceWindow } from '../src/common/surfaces.ts';
import type { LinkEvent, SurfaceUpdate } from '../src/main/renderer/link.ts';
import { type SurfaceLink, startSurfaces } from '../src/main/surfaces/source.ts';

const ok = (result: Record<string, unknown>): HelperAnswer => ({ ok: true, result });
/** A `screen`: 1440×900 with a 25 pt menu bar. */
const SCREENS = ok({ screens: [{ display_id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 }, visible: { x: 0, y: 25, width: 1440, height: 875 }, scale: 2, primary: true }] });
type W = { id: number; pid?: number; x: number; y: number; w: number; h: number; alpha?: number };
const windows = (list: W[]) => ok({ windows: list.map((w) => ({ window_id: w.id, pid: w.pid ?? 702, bounds: { x: w.x, y: w.y, width: w.w, height: w.h }, layer: 0, alpha: w.alpha ?? 1 })) });

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

type Sent = { type: 'surfaces'; seq: number; windows: SurfaceWindow[] } | { type: 'surface'; s: SurfaceUpdate }
  | { type: 'covered'; w: { window_id: number; generation: number; frame: Box } | null } | { type: 'pass_through'; rects: Box[] };

function setup(o: { capabilities?: string[]; keyIdle?: number; fail?: string; helperY?: HelperY; watch?: HelperAnswer } = {}) {
  let clock = 1000;
  let stay = false;
  let fire: (() => void) | null = null;
  let windowList: W[] = [{ id: 640, x: 200, y: 120, w: 900, h: 600 }];
  let chain: Record<string, unknown>[] = [];
  /** While set, each `windows.list` waits here for `release`. */
  let held: ((a: HelperAnswer) => void)[] | null = null;
  const requests: [string, Record<string, unknown>][] = [];
  const sent: Sent[] = [];
  const logs: string[] = [];
  const exclusions: { above: Box[]; passThrough: Box[] }[] = [];
  let cursorMoves = 0;
  const listeners = new Set<(e: LinkEvent) => void>();
  let capabilities: string[] = [];
  const link: SurfaceLink = {
    hello: { pid: 4100 },
    get capabilities() { return capabilities; },
    hidden: false,
    on: (l) => { listeners.add(l); return () => listeners.delete(l); },
    sendSurfaces: (seq, w) => { sent.push({ type: 'surfaces', seq, windows: w }); return true; },
    sendSurface: (s) => { sent.push({ type: 'surface', s }); return true; },
    sendCovered: (w) => { sent.push({ type: 'covered', w }); return true; },
    sendPassThrough: (rects) => { sent.push({ type: 'pass_through', rects }); return true; },
    setHitExclusions: (rects) => { exclusions.push(rects); return true; },
    cursorMoved: () => { cursorMoves += 1; },
  };
  const emit = (e: LinkEvent) => { for (const l of listeners) l(e); };
  let cursor = { x: 0, y: 0 };
  const source = startSurfaces({
    helper: {
      request: async (op, params = {}) => {
        requests.push([op, params]);
        if (op === 'screens.list') return SCREENS;
        if (op === 'windows.list' && o.fail) return { ok: false, error: { code: o.fail } };
        if (op === 'windows.list') return held ? new Promise<HelperAnswer>((r) => held!.push(r)) : windows(windowList);
        if (op === 'workspace.watch') return o.watch ?? ok({ watching: true });
        if (op === 'ax.hit_chain') return ok({ pid: 702, chain });
        return { ok: false, error: { code: 'unsupported' } };
      },
    },
    link, cursor: () => cursor, ownPids: () => [77],
    keyIdle: () => o.keyIdle ?? Infinity,
    stayInPlace: () => stay,
    ...(o.helperY && { helperY: o.helperY }),
    now: () => clock,
    every: (_ms, fn) => { fire = fn; return () => { fire = null; }; },
    log: (line) => logs.push(line),
  });
  const hello = (caps = o.capabilities ?? ['surfaces', 'opacity', 'layering', 'pass_through']) => {
    capabilities = caps;
    emit({ kind: 'hello', hello: { v: 1, type: 'hello', role: 'avatar', pid: 4100, capabilities: caps } as never });
  };
  const message = (m: Record<string, unknown>) => emit({ kind: 'message', message: { v: 1, ...m } as never });
  const step = async (ms: number) => { clock += ms; fire?.(); await settle(); };
  const ops = () => requests.map(([op]) => op);
  return { source, sent, logs, requests, ops, hello, message, step, emit, exclusions, get cursorMoves() { return cursorMoves; },
    setWindows: (l: W[]) => { windowList = l; }, setChain: (c: Record<string, unknown>[]) => { chain = c; },
    setCursor: (p: { x: number; y: number }) => { cursor = p; }, clear: () => { sent.length = 0; requests.length = 0; },
    setStay: (on: boolean) => { stay = on; },
    covered: () => sent.flatMap((m) => (m.type === 'covered' ? [m.w && m.w.window_id] : [])),
    hold: () => { held = []; }, release: async (l: W[]) => { held!.shift()!(windows(l)); await settle(); } };
}

test('nothing is read before the helper runs and a renderer has said hello; after hello one snapshot goes out', async () => {
  const s = setup();
  await s.step(20);
  s.source.helper(true);
  await s.step(20);
  assert.deepEqual(s.ops(), ['workspace.watch'], 'no renderer yet');
  s.hello();
  await s.step(20);
  assert.deepEqual(s.ops(), ['workspace.watch', 'screens.list', 'windows.list']);
  assert.deepEqual(s.sent.map((m) => m.type === 'surfaces' && [m.seq, m.windows.map((w) => w.window_id)]), [[0, [640]]]);
});

test('without the helper nothing is read; a failed read sends nothing and is logged once per code', async () => {
  const s = setup();
  s.hello();
  await s.step(20);
  assert.deepEqual(s.ops(), []);
  const failing = setup({ fail: 'internal' });
  failing.source.helper(true);
  failing.hello();
  await failing.step(20);
  failing.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
  await failing.step(20);
  assert.deepEqual(failing.ops(), ['workspace.watch', 'screens.list', 'windows.list', 'windows.list']);
  assert.equal(failing.sent.length, 0);
  assert.deepEqual(failing.logs, ['SURFACES windows.list failed code=internal']);
});

test('The snapshot is polled every 0.5 s without tracks or a body and sent only when it changed', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  await s.step(17);
  s.clear();
  for (let i = 0; i < 29; i += 1) await s.step(1000 / 60);
  assert.deepEqual(s.ops(), [], 'not before 0.5 s');
  await s.step(20);
  assert.deepEqual(s.ops(), ['windows.list']);
  assert.equal(s.sent.length, 0, 'unchanged');
  s.setWindows([{ id: 640, x: 300, y: 120, w: 900, h: 600 }]);
  await s.step(500);
  assert.equal(s.sent.length, 0, 'the snapshot is checked on the cached read; the new one is checked 0.5 s later');
  await s.step(500);
  assert.deepEqual(s.sent.map((m) => m.type === 'surfaces' && m.seq), [1]);
});

test('Workspace.changed reads again at once; a screens change reads the displays too', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  await s.step(17);
  s.clear();
  s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
  await s.step(17);
  assert.deepEqual(s.ops(), ['windows.list']);
  s.source.event('workspace.changed', { reason: 'screens', front_pid: 702 });
  await s.step(17);
  assert.deepEqual(s.ops(), ['windows.list', 'screens.list', 'windows.list']);
});

test('A track is answered on the next read and polled at 30 Hz; the fifth is gone too_many; untrack stops it', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  await s.step(17);
  s.clear();
  s.source.track({ kind: 'track', trackId: 'a', windowId: 640, generation: null });
  await s.step(17);
  assert.deepEqual(s.sent.map((m) => m.type === 'surface' && [m.s.track_id, m.s.state]), [['a', 'tracking']]);
  s.clear();
  for (let i = 0; i < 6; i += 1) await s.step(1000 / 60);
  assert.equal(s.ops().filter((op) => op === 'windows.list').length, 3, 'one read per 1/30 s');
  for (const id of ['b', 'c', 'd']) s.source.track({ kind: 'track', trackId: id, windowId: 640, generation: null });
  s.clear();
  s.source.track({ kind: 'track', trackId: 'e', windowId: 640, generation: null });
  assert.deepEqual(s.sent, [{ type: 'surface', s: { track_id: 'e', state: 'gone', reason: 'too_many' } }]);
  for (const id of ['a', 'b', 'c', 'd']) s.source.track({ kind: 'untrack', trackId: id });
  s.clear();
  await s.step(200);
  assert.ok(!s.sent.some((m) => m.type === 'surface'), 'no keepalive after untrack');
});

test('A request that arrives during a read waits for the next read', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  await s.step(17);
  s.clear();
  s.hold();
  s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
  await s.step(17);
  s.source.track({ kind: 'track', trackId: 'a', windowId: 640, generation: null });
  await s.release([]);
  assert.ok(!s.sent.some((m) => m.type === 'surface'), 'the read in flight was dispatched before the track');
  assert.deepEqual(s.ops(), ['windows.list', 'windows.list'], 'the track asked for another read at once');
  await s.release([{ id: 640, x: 200, y: 120, w: 900, h: 600 }]);
  assert.deepEqual(s.sent.filter((m) => m.type === 'surface').map((m) => m.type === 'surface' && m.s.state), ['tracking']);
});

test('Attach puts above on the attached track; the avatar\'s own windows never count', async () => {
  const s = setup();
  s.source.helper(true);
  s.setWindows([{ id: 9, pid: 4100, x: 300, y: 100, w: 200, h: 200 }, { id: 6, x: 100, y: 100, w: 300, h: 200 }, { id: 7, x: 0, y: 250, w: 1000, h: 400 }]);
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [350, 700], b: [350, 800], r: 50 }] });
  await s.step(17);
  const snapshot = s.sent[0];
  assert.deepEqual(snapshot?.type === 'surfaces' && snapshot.windows.map((w) => w.window_id), [6, 7]);
  s.source.track({ kind: 'track', trackId: 'w', windowId: 7, generation: null });
  await s.step(17);
  s.clear();
  s.source.track({ kind: 'attach', trackId: 'w' });
  await s.step(17);
  const surface = s.sent.find((m) => m.type === 'surface');
  assert.deepEqual(surface?.type === 'surface' && surface.s.state === 'tracking' && surface.s.window.above, [{ x: 100, y: 600, w: 300, h: 200 }]);
});

test('Each tick hands the attached track\'s above and the pass-through rects to the link\'s hit exclusions', async () => {
  const s = setup();
  s.source.helper(true);
  s.setWindows([{ id: 6, x: 100, y: 100, w: 300, h: 200 }, { id: 7, x: 0, y: 250, w: 1000, h: 400 }]);
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [350, 700], b: [350, 800], r: 50 }] });
  await s.step(17);
  assert.deepEqual(s.exclusions.at(-1), { above: [], passThrough: [] }, 'nothing attached');
  s.source.track({ kind: 'track', trackId: 'w', windowId: 7, generation: null });
  await s.step(17);
  s.source.track({ kind: 'attach', trackId: 'w' });
  await s.step(17);
  assert.deepEqual(s.exclusions.at(-1), { above: [{ x: 100, y: 600, w: 300, h: 200 }], passThrough: [] });
  s.source.track({ kind: 'untrack', trackId: 'w' });
  await s.step(17);
  assert.deepEqual(s.exclusions.at(-1), { above: [], passThrough: [] });
  const p = setup();
  p.source.helper(true);
  p.hello();
  p.message({ type: 'window_frame', frame: { x: 100, y: 100, w: 400, h: 600 } });
  p.message({ type: 'hit_capsules', space: 'window', capsules: [{ a: [200, 100], b: [200, 400], r: 60 }] });
  p.setChain([{ role: 'AXButton', native_role: 'AXButton', subrole: null, frame: { x: 240, y: 370, width: 120, height: 30 } }]);
  p.setCursor({ x: 300, y: 505 });
  await p.step(17);
  await p.step(17);
  assert.deepEqual(p.exclusions.at(-1), { above: [], passThrough: [{ x: 240, y: 500, w: 120, h: 30 }] });
  p.setCursor({ x: 1400, y: 50 });
  await p.step(2000);
  assert.deepEqual(p.exclusions.at(-1), { above: [], passThrough: [] }, 'expired after 2 s');
});

test('Entering or leaving a cover lets the next cursor sample through', async () => {
  const s = setup();
  s.source.helper(true);
  s.setWindows([{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [200, 400], b: [200, 600], r: 50 }] });
  for (let i = 0; i < 25; i += 1) await s.step(20);
  assert.equal(s.cursorMoves, 1);
  for (let i = 0; i < 5; i += 1) await s.step(20);
  assert.equal(s.cursorMoves, 1, 'only on a change');
  s.message({ type: 'drag', phase: 'begin' });
  await s.step(20);
  assert.equal(s.cursorMoves, 2);
});

test('Covered after 300 ms under the front app\'s window, after the keys rest; null on leaving', async () => {
  const s = setup();
  s.source.helper(true);
  s.setWindows([{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [200, 400], b: [200, 600], r: 50 }] });
  for (let i = 0; i < 25; i += 1) await s.step(20);
  assert.deepEqual(s.sent.filter((m) => m.type === 'covered'), [{ type: 'covered', w: { window_id: 6, generation: 1, frame: { x: 0, y: 300, w: 600, h: 600 } } }]);
  assert.ok(s.logs.includes('SURFACES cover entered'));
  s.clear();
  s.setWindows([{ id: 6, pid: 702, x: 900, y: 0, w: 400, h: 400 }]);
  for (let i = 0; i < 25; i += 1) await s.step(20);
  assert.deepEqual(s.sent.filter((m) => m.type === 'covered'), [{ type: 'covered', w: null }]);
});

test('No covered while the user types, nor when she does not list opacity', async () => {
  for (const o of [{ keyIdle: 0.5 }, { capabilities: ['surfaces'] }]) {
    const s = setup(o);
    s.source.helper(true);
    s.setWindows([{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
    s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 });
    s.hello();
    s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [200, 400], b: [200, 600], r: 50 }] });
    for (let i = 0; i < 25; i += 1) await s.step(20);
    assert.deepEqual(s.sent.filter((m) => m.type === 'covered'), []);
  }
});

/** Her body at global (150..250, 350..650), under the front app's window `id` over the main display's top left. */
async function coveredBy(s: ReturnType<typeof setup>, list: W[], front: () => void = () => s.source.event('workspace.changed', { reason: 'front_app', front_pid: 702 })) {
  s.source.helper(true);
  s.setWindows(list);
  front();
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [200, 400], b: [200, 600], r: 50 }] });
  for (let i = 0; i < 25; i += 1) await s.step(20);
}

test('A pause ends the cover at once with `covered` null', async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  assert.equal(s.source.isCovered, true);
  s.message({ type: 'drag', phase: 'begin' });
  await s.step(20);
  assert.deepEqual(s.covered(), [6, null]);
  assert.equal(s.source.isCovered, false);
  assert.ok(s.logs.includes('SURFACES cover left'));
});

test('Staying in place withdraws `covered` and sends none while it lasts', async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  s.setStay(true);
  for (let i = 0; i < 5; i += 1) await s.step(20);
  assert.deepEqual(s.covered(), [6, null]);
  s.setStay(false);
  for (let i = 0; i < 5; i += 1) await s.step(20);
  assert.deepEqual(s.covered(), [6, null, 6]);
});

test('Another front window over her sends `covered` again; a window the surfaces do not list sends none', async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  s.setWindows([{ id: 7, pid: 702, x: 0, y: 0, w: 600, h: 600 }, { id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  for (let i = 0; i < 5; i += 1) await s.step(20);
  assert.deepEqual(s.covered(), [6, 7]);
  const hidden = setup();
  await coveredBy(hidden, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600, alpha: 0 }]);
  assert.ok(hidden.logs.includes('SURFACES cover entered'));
  assert.deepEqual(hidden.covered(), []);
});

test("The avatar's own window in front is never a cover", async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 4100, x: 0, y: 0, w: 600, h: 600 }],
    () => s.source.event('workspace.changed', { reason: 'front_app', front_pid: 4100 }));
  assert.deepEqual(s.covered(), []);
  assert.ok(!s.logs.includes('SURFACES cover entered'));
});

test('Without front_pid (Windows), before the first workspace.changed the front app comes from the attention sample', async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }], () => s.source.sampled({ front: { pid: 702 } } as AttentionSample));
  assert.deepEqual(s.covered(), [6]);
  // Once the watch has spoken, a sample no longer moves the front app.
  const w = setup();
  await coveredBy(w, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }], () => {
    w.source.event('workspace.changed', { reason: 'front_app', front_pid: 800 });
    w.source.sampled({ front: { pid: 702 } } as AttentionSample);
  });
  assert.deepEqual(w.covered(), []);
});

test('Workspace.watch\'s front_pid is the front app at start; samples no longer stand in for it', async () => {
  const s = setup({ watch: ok({ watching: true, front_pid: 702 }) });
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }], () => s.source.sampled({ front: { pid: 800 } } as AttentionSample));
  assert.deepEqual(s.covered(), [6]);
  const none = setup({ watch: ok({ watching: true, front_pid: null }) });
  await coveredBy(none, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }], () => none.source.sampled({ front: { pid: 702 } } as AttentionSample));
  assert.deepEqual(none.covered(), [], 'no front app is a front app too');
});

test('workspace.watch is asked for once; a restarted helper gets it from the supervisor, a failed one is asked again', async () => {
  const s = setup();
  s.source.helper(true);
  await s.step(20);
  s.source.helper(false);
  s.source.helper(true);
  await s.step(20);
  assert.deepEqual(s.ops().filter((op) => op === 'workspace.watch').length, 1);
  const failed = setup({ watch: { ok: false, error: { code: 'helper_exited' } } });
  failed.source.helper(true);
  await failed.step(20);
  failed.source.helper(false);
  failed.source.helper(true);
  await failed.step(20);
  assert.deepEqual(failed.ops().filter((op) => op === 'workspace.watch').length, 2);
});

test('A new connection starts uncovered and sends `covered` again', async () => {
  const s = setup();
  await coveredBy(s, [{ id: 6, pid: 702, x: 0, y: 0, w: 600, h: 600 }]);
  s.emit({ kind: 'lost', reason: 'EOF' });
  s.hello();
  s.message({ type: 'hit_capsules', space: 'global', capsules: [{ a: [200, 400], b: [200, 600], r: 50 }] });
  for (let i = 0; i < 25; i += 1) await s.step(20);
  assert.deepEqual(s.covered(), [6, 6]);
});

test('Near her the control under the cursor is probed in CG points and sent as pass_through, then [] after 2 s', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  s.message({ type: 'window_frame', frame: { x: 100, y: 100, w: 400, h: 600 } });
  s.message({ type: 'hit_capsules', space: 'window', capsules: [{ a: [200, 100], b: [200, 400], r: 60 }] });
  s.setChain([{ role: 'AXStaticText', native_role: 'AXStaticText', subrole: null, frame: { x: 250, y: 380, width: 40, height: 10 } },
    { role: 'AXButton', native_role: 'AXButton', subrole: null, frame: { x: 240, y: 370, width: 120, height: 30 } }]);
  s.setCursor({ x: 300, y: 505 });
  await s.step(17);
  const probe = s.requests.find(([op]) => op === 'ax.hit_chain');
  assert.deepEqual(probe?.[1], { point: { x: 300, y: 395 }, exclude_pids: [77, 4100] });
  assert.deepEqual(s.sent.filter((m) => m.type === 'pass_through'), [{ type: 'pass_through', rects: [{ x: 240, y: 500, w: 120, h: 30 }] }]);
  s.clear();
  s.setCursor({ x: 1400, y: 50 });
  await s.step(2000);
  assert.deepEqual(s.sent.filter((m) => m.type === 'pass_through'), [{ type: 'pass_through', rects: [] }]);
  assert.ok(!s.requests.some(([op]) => op === 'ax.hit_chain'), 'far from her nothing is probed');
});

test('Windows: with a helperY that keeps the y, the probe point and the pass_through rect stay in the helper\'s pixels', async () => {
  const s = setup({ helperY });
  s.source.helper(true);
  s.hello();
  s.message({ type: 'window_frame', frame: { x: 100, y: 100, w: 400, h: 600 } });
  s.message({ type: 'hit_capsules', space: 'window', capsules: [{ a: [200, 100], b: [200, 400], r: 60 }] });
  s.setChain([{ role: 'AXButton', native_role: 'AXButton', subrole: null, frame: { x: 240, y: 370, width: 120, height: 30 } }]);
  s.setCursor({ x: 300, y: 505 });
  await s.step(17);
  assert.deepEqual(s.requests.find(([op]) => op === 'ax.hit_chain')?.[1], { point: { x: 300, y: 505 }, exclude_pids: [77, 4100] });
  assert.deepEqual(s.sent.filter((m) => m.type === 'pass_through'), [{ type: 'pass_through', rects: [{ x: 240, y: 370, w: 120, h: 30 }] }]);
});

test('a lost renderer ends its tracks and reads; a new hello starts over with generation 1 and seq 0', async () => {
  const s = setup();
  s.source.helper(true);
  s.hello();
  await s.step(17);
  s.source.track({ kind: 'track', trackId: 'a', windowId: 640, generation: null });
  s.emit({ kind: 'lost', reason: 'EOF' });
  s.clear();
  await s.step(1000);
  assert.deepEqual(s.ops(), []);
  assert.equal(s.sent.length, 0);
  s.hello();
  await s.step(17);
  assert.deepEqual(s.sent.map((m) => m.type === 'surfaces' && [m.seq, m.windows[0]!.generation]), [[0, 1]]);
});
