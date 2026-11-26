// The desktop surface rules (src/common/surfaces.ts), on
// fixed platform helper replies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helperY } from '../src/common/attention.ts';
import {
  aboveRects, COVER, CoverState, coveringWindow, DesktopSurfaces, firstInteractive, PassThroughCache, readHitChain, readScreens,
  readWindows, type SurfaceInput, type SurfaceMessage, SurfaceTracking,
} from '../src/common/surfaces.ts';

/** C12 `screens.list`: one 1440×900 display with a 25 pt menu bar (examples/ok-windows.ndjson). */
const SCREENS = { screens: [{ display_id: 1, frame: { x: 0, y: 0, width: 1440, height: 900 }, visible: { x: 0, y: 25, width: 1440, height: 875 }, scale: 2, primary: true }] };

type W = { id: number; pid?: number; x: number; y: number; w: number; h: number; layer?: number; alpha?: number };
/** C12 `windows.list` result, front to back, CG bounds. */
const windowsResult = (list: W[]) => ({
  windows: list.map((w) => ({ window_id: w.id, pid: w.pid ?? 700, bounds: { x: w.x, y: w.y, width: w.w, height: w.h },
    ...(w.layer === undefined ? {} : { layer: w.layer }), ...(w.alpha === undefined ? {} : { alpha: w.alpha }) })),
});

function input(list: W[], o: { excluded?: number[]; frontPid?: number | null } = {}): SurfaceInput {
  const { screens, mainHeight } = readScreens(SCREENS);
  return { windows: readWindows(windowsResult(list)), excludedPids: new Set(o.excluded ?? [4100]), screens, mainHeight, frontPid: o.frontPid ?? null };
}

const surfaces = (out: SurfaceMessage[]) => out.flatMap((m) => (m.kind === 'surfaces' ? [m] : []));
const updates = (out: SurfaceMessage[]) => out.flatMap((m) => (m.kind === 'surface' ? [m.update] : []));

test('C12 replies decode to global points: screens flip on the primary height, windows keep CG bounds and default layer and alpha', () => {
  const s = readScreens(SCREENS);
  assert.equal(s.mainHeight, 900);
  assert.deepEqual(s.screens, [{ displayId: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visible: { x: 0, y: 0, w: 1440, h: 875 } }]);
  assert.deepEqual(readWindows({ windows: [{ window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 } }, { pid: 1 }] }),
    [{ id: 640, pid: 702, layer: 0, alpha: 1, bounds: { x: 200, y: 120, w: 900, h: 600 } }]);
  // examples/ok-ax.ndjson's chain, frames flipped, a null frame kept null.
  const chain = readHitChain({ pid: 611, chain: [
    { role: 'AXStaticText', native_role: 'AXStaticText', subrole: null, frame: { x: 480, y: 290, width: 200, height: 18 } },
    { role: 'AXWebArea', native_role: 'AXWebArea', subrole: null, frame: null }] }, 900);
  assert.deepEqual(chain, [{ role: 'AXStaticText', subrole: null, frame: { x: 480, y: 592, w: 200, h: 18 } }, { role: 'AXWebArea', subrole: null, frame: null }]);
});

test('Windows: a helperY that keeps the y leaves screens, windows, the cover and the hit chain in the helper\'s pixels, y down', () => {
  const s = readScreens(SCREENS, helperY);
  assert.deepEqual(s.screens[0], { displayId: 1, frame: { x: 0, y: 0, w: 1440, h: 900 }, visible: { x: 0, y: 25, w: 1440, h: 875 } });
  const current = { ...input([{ id: 6, pid: 702, x: 100, y: 100, w: 300, h: 200 }], { frontPid: 702 }), screens: s.screens, helperY };
  const d = new DesktopSurfaces();
  d.update(current);
  assert.deepEqual(d.all[0]!.frame, { x: 100, y: 100, w: 300, h: 200 });
  assert.deepEqual(coveringWindow(current), { x: 100, y: 100, w: 300, h: 200 });
  assert.deepEqual(readHitChain({ chain: [{ role: 'AXButton', subrole: null, frame: { x: 480, y: 290, width: 200, height: 18 } }] }, 900, helperY)[0]!.frame,
    { x: 480, y: 290, w: 200, h: 18 });
});

test('Only layer 0, visible, ≥ 80 pt, on-screen windows of other processes are listed, front to back, in global points', () => {
  const d = new DesktopSurfaces();
  d.update(input([
    { id: 1, x: 10, y: 10, w: 300, h: 300, layer: 25 },
    { id: 2, x: 10, y: 10, w: 300, h: 300, alpha: 0 },
    { id: 3, x: 10, y: 10, w: 79, h: 300 },
    { id: 4, pid: 4100, x: 10, y: 10, w: 300, h: 300 },
    { id: 5, x: 3000, y: 10, w: 300, h: 300 },
    { id: 6, x: 100, y: 100, w: 300, h: 200 },
    { id: 7, x: 0, y: 250, w: 1000, h: 400 },
  ]));
  assert.deepEqual(d.all.map((w) => [w.window_id, w.order, w.display_id, w.generation]), [[6, 0, 1, 1], [7, 1, 1, 1]]);
  assert.deepEqual(d.all[0]!.frame, { x: 100, y: 600, w: 300, h: 200 });
  assert.deepEqual(d.presence(1), { kind: 'notListed' });
  assert.deepEqual(d.presence(99), { kind: 'closed' });
});

test('Segments leave out windows in front, the menu bar and parts under 40 pt; at most 8, by size, ascending', () => {
  const d = new DesktopSurfaces();
  d.update(input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }, { id: 7, x: 0, y: 250, w: 1000, h: 400 }]));
  assert.deepEqual(d.all[0]!.edges, [{ side: 'top', segments: [[100, 400]] }, { side: 'left', segments: [[600, 800]] }, { side: 'right', segments: [[600, 800]] }]);
  assert.deepEqual(d.all[1]!.edges, [{ side: 'top', segments: [[0, 100], [400, 1000]] }, { side: 'left', segments: [[250, 650]] }, { side: 'right', segments: [[250, 650]] }]);
  // Under the menu bar: no top edge, the sides stop at the visible frame.
  d.update(input([{ id: 8, x: 0, y: 0, w: 500, h: 300 }]));
  assert.deepEqual(d.all[0]!.edges, [{ side: 'left', segments: [[600, 875]] }, { side: 'right', segments: [[600, 875]] }]);
  // Ten 80 pt windows on one top line leave eleven gaps: the 140 pt one and the first seven 50 pt ones stay.
  const front = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, x: 50 + 130 * i, y: 380, w: 80, h: 80 }));
  d.update(input([...front, { id: 9, x: 0, y: 400, w: 1440, h: 300 }]));
  assert.deepEqual(d.all.at(-1)!.edges[0], { side: 'top', segments: [[0, 50], [130, 180], [260, 310], [390, 440], [520, 570], [650, 700], [780, 830], [1300, 1440]] });
});

test('A window id that leaves the list and comes back gets the next generation', () => {
  const d = new DesktopSurfaces();
  d.update(input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }]));
  d.update(input([]));
  d.update(input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }]));
  assert.equal(d.all[0]!.generation, 2);
  d.update(input([{ id: 6, x: 100, y: 100, w: 300, h: 200, alpha: 0 }]));
  d.update(input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }]));
  assert.equal(d.all[0]!.generation, 3);
});

test('A snapshot goes out at the first tick, then only when it changed, checked every 0.5 s, with at most 32 windows', () => {
  const t = new SurfaceTracking();
  let current = input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }]);
  assert.deepEqual(surfaces(t.tick(0, null, () => current)).map((m) => [m.seq, m.windows.length]), [[0, 1]]);
  assert.deepEqual(t.tick(0.5, null, () => current), []);
  current = input([{ id: 6, x: 120, y: 100, w: 300, h: 200 }]);
  assert.deepEqual(t.tick(0.6, null, () => current), [], 'not polled again before 0.5 s');
  assert.deepEqual(surfaces(t.tick(1.0, null, () => current)).map((m) => m.seq), [1]);
  current = input(Array.from({ length: 40 }, (_, i) => ({ id: 200 + i, x: 10 * i, y: 100, w: 200, h: 200 })));
  t.refreshSoon();
  assert.equal(surfaces(t.tick(1.1, null, () => current))[0]!.windows.length, 32);
});

test('A track is answered on the next poll with tracking, or gone generation / not_listed / closed, kept alive every 0.1 s', () => {
  const t = new SurfaceTracking();
  const current = input([{ id: 6, x: 100, y: 100, w: 300, h: 200 }, { id: 7, x: 0, y: 250, w: 1000, h: 400, alpha: 0 }]);
  t.tick(0, null, () => current);
  assert.deepEqual(t.track('a', 6, null, 0.01), []);
  assert.deepEqual(t.track('b', 6, 2, 0.01), []);
  assert.deepEqual(t.track('c', 7, null, 0.01), []);
  const first = updates(t.tick(0.02, null, () => current));
  assert.deepEqual(first.map((u) => [u.track_id, u.state, u.state === 'gone' ? u.reason : u.window.window_id]),
    [['b', 'gone', 'generation'], ['c', 'gone', 'not_listed'], ['a', 'tracking', 6]]);
  assert.deepEqual(t.track('d', 99, null, 0.03), []);
  assert.deepEqual(updates(t.tick(0.05, null, () => current)).map((u) => [u.track_id, u.state === 'gone' && u.reason]), [['d', 'closed']]);
  assert.deepEqual(updates(t.tick(0.13, null, () => current)).map((u) => u.track_id), ['a'], 'keepalive after 0.1 s');
  // The window closes: gone closed, and nothing more for that id.
  assert.deepEqual(updates(t.tick(0.2, null, () => input([]))), [{ track_id: 'a', state: 'gone', reason: 'closed' }]);
  assert.deepEqual(t.tick(0.4, null, () => input([])), []);
});

test('A fifth track or an eleventh request within a second is answered gone too_many at once', () => {
  const t = new SurfaceTracking();
  for (const id of ['a', 'b', 'c', 'd']) assert.deepEqual(t.track(id, 6, null, 0), []);
  assert.deepEqual(t.track('e', 6, null, 0), [{ kind: 'surface', update: { track_id: 'e', state: 'gone', reason: 'too_many' } }]);
  const r = new SurfaceTracking();
  for (let i = 0; i < 10; i += 1) {
    r.track(`t${i}`, 6, null, 0.05 * i);
    r.untrack(`t${i}`);
  }
  assert.equal(updates(r.track('late', 6, null, 0.5))[0]?.state, 'gone');
  assert.deepEqual(r.track('later', 6, null, 1.01), [], 'the first request is over a second old');
});

test('The attached track carries above — windows in front of W near her body — and the others never do', () => {
  const t = new SurfaceTracking();
  // W is 7; 6 is in front and near her; 5 is in front but far; 4 is behind W.
  const current = input([{ id: 5, x: 1200, y: 600, w: 200, h: 200 }, { id: 6, x: 100, y: 100, w: 300, h: 200 },
    { id: 7, x: 0, y: 250, w: 1000, h: 400 }, { id: 4, x: 50, y: 50, w: 400, h: 400 }]);
  const body = { x: 300, y: 650, w: 150, h: 200 };
  t.tick(0, body, () => current);
  t.track('w', 7, null, 0);
  t.track('x', 6, null, 0);
  const plain = updates(t.tick(0.02, body, () => current));
  assert.ok(plain.every((u) => u.state === 'tracking' && u.window.above === undefined));
  t.attach('w');
  const attached = updates(t.tick(0.03, body, () => current));
  assert.deepEqual(attached.map((u) => [u.track_id, u.state === 'tracking' && u.window.above]), [['w', [{ x: 100, y: 600, w: 300, h: 200 }]]]);
  assert.equal(t.attachedAbove?.length, 1);
  t.attach('unknown');
  assert.equal(t.attached, null, 'an unknown track_id counts as null');
  const after = updates(t.tick(0.04, body, () => current));
  assert.ok(after.every((u) => u.state === 'tracking' && u.window.above === undefined));
  t.attach('w');
  t.untrack('w');
  assert.equal(t.attached, null, 'untrack ends the attach');
});

test('Past 8 windows above, the pair whose bounding box adds the least area merges', () => {
  const list: W[] = Array.from({ length: 9 }, (_, i) => ({ id: 10 + i, x: 100 + 100 * i, y: 500, w: 90, h: 90 }));
  const current = input([...list, { id: 7, x: 0, y: 300, w: 1440, h: 500 }]);
  const above = aboveRects(current, 7, { x: 0, y: 0, w: 1440, h: 900 });
  assert.equal(above.length, 8);
  assert.deepEqual(above[0], { x: 100, y: 310, w: 190, h: 90 });
  assert.deepEqual(aboveRects(current, 7, null), []);
});

test('Covered after 300 ms at ≥ 15 % of her body under the front window, uncovered after 300 ms under 5 %', () => {
  const c = new CoverState();
  const body = { x: 100, y: 100, w: 100, h: 100 };
  const front = (x: number) => input([{ id: 6, pid: 702, x, y: 700, w: 100, h: 100 }], { frontPid: 702 });
  assert.equal(c.update(front(185), body, 0), null);
  assert.equal(c.update(front(185), body, 0.29), null);
  assert.equal(c.update(front(185), body, 0.3), 'entered');
  assert.deepEqual(c.frame, { x: 185, y: 100, w: 100, h: 100 });
  assert.equal(c.update(front(196), body, 0.4), null);
  assert.equal(c.update(front(196), body, 0.75), 'left');
  assert.equal(c.covered, false);
  c.update(front(100), body, 1);
  c.update(front(100), body, 1.3);
  assert.equal(c.pause(), 'left', 'a pause ends a cover at once');
  assert.equal(coveringWindow(input([{ id: 6, pid: 702, x: 0, y: 0, w: 100, h: 100 }], { frontPid: 702, excluded: [702] })), null);
  assert.equal(coveringWindow(input([{ id: 6, pid: 702, x: 0, y: 0, w: 100, h: 100, layer: 3 }], { frontPid: 702 })), null);
  assert.deepEqual([COVER.enterFraction, COVER.leaveFraction, COVER.dwell, COVER.readInterval, COVER.typingPause], [0.15, 0.05, 0.3, 0.1, 1.5]);
});

test("The covering window is the front app's first layer 0 window; none for an unknown front", () => {
  const list: W[] = [{ id: 1, pid: 702, x: 0, y: 0, w: 10, h: 10, layer: 3 }, { id: 2, pid: 702, x: 0, y: 0, w: 20, h: 20 },
    { id: 3, pid: 702, x: 0, y: 0, w: 30, h: 30 }];
  assert.deepEqual(coveringWindow(input(list, { frontPid: 702 })), { x: 0, y: 880, w: 20, h: 20 });
  assert.equal(coveringWindow(input(list, { frontPid: null })), null);
  assert.equal(coveringWindow(input([{ id: 1, pid: 800, x: 0, y: 0, w: 10, h: 10 }], { frontPid: 702 })), null);
});

test('A read that stops calling for the change restarts the dwell; a pause forgets it', () => {
  const body = { x: 100, y: 100, w: 100, h: 100 };
  // CG y 786..800 is global y 100..114: 14 of her 100 points are under 15 %.
  const low = input([{ id: 6, pid: 702, x: 100, y: 786, w: 100, h: 14 }], { frontPid: 702 });
  const enough = input([{ id: 6, pid: 702, x: 100, y: 785, w: 100, h: 15 }], { frontPid: 702 });
  const c = new CoverState();
  assert.equal(c.update(low, body, 0), null);
  assert.equal(c.fraction, 0.14);
  assert.equal(c.update(enough, body, 1), null);
  assert.equal(c.update(low, body, 1.2), null);
  assert.equal(c.update(enough, body, 1.4), null);
  assert.equal(c.update(enough, body, 1.6), null);
  assert.equal(c.update(enough, body, 1.8), 'entered');
  const p = new CoverState();
  p.update(enough, body, 0);
  assert.equal(p.pause(), null, 'nothing to end');
  assert.equal(p.update(enough, body, 0.3), null, 'the dwell starts again after a pause');
  assert.equal(p.covered, false);
});

test('The first interactive control up the chain, stopping at a window, an application or a web area', () => {
  const frame = { x: 0, y: 0, w: 50, h: 20 };
  assert.equal(firstInteractive([{ role: 'AXStaticText', subrole: null, frame }, { role: 'AXButton', subrole: null, frame }])?.role, 'AXButton');
  assert.equal(firstInteractive([{ role: 'AXStaticText', subrole: null, frame }, { role: 'AXWebArea', subrole: null, frame },
    { role: 'AXButton', subrole: null, frame }]), null);
  assert.equal(firstInteractive([{ role: 'AXButton', subrole: null, frame: { x: 0, y: 0, w: 0, h: 20 } }]), null);
});

test('A probed control is kept 2 s and probed again after 0.5 s under the cursor; at most 8, oldest dropped', () => {
  const cache = new PassThroughCache();
  const p = { x: 10, y: 10 };
  assert.equal(cache.needsProbe(p, 0), true);
  cache.record(p, { role: 'AXButton', subrole: null, frame: { x: 0, y: 0, w: 50, h: 20 } }, 0);
  assert.equal(cache.needsProbe({ x: 400, y: 400 }, 0.04), false, 'probes are 50 ms apart');
  assert.equal(cache.needsProbe(p, 0.4), false);
  assert.equal(cache.needsProbe(p, 0.5), true);
  assert.equal(cache.contains(p, 1.9), true);
  assert.equal(cache.contains(p, 2), false);
  cache.expire(2);
  assert.equal(cache.rects.length, 0);
  for (let i = 0; i < 9; i += 1) cache.record({ x: 100 * i + 1, y: 1 }, { role: 'AXButton', subrole: null, frame: { x: 100 * i, y: 0, w: 50, h: 20 } }, 3);
  assert.equal(cache.rects.length, 8);
  assert.equal(cache.rects[0]!.x, 100);
  cache.record({ x: 101, y: 1 }, null, 3.1);
  assert.equal(cache.rects.length, 7, 'nothing interactive there drops the old rect');
});
