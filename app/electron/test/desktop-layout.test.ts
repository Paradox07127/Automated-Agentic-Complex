// The bubble, dock and wheel placement (src/common/desktop-layout.ts) with the cases and values of DesktopLayoutTests, and the
// follower (src/common/desktop-follow.ts) with those of DesktopCoordinatorTests and AvatarAnchorTrackerTests that cover them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AnchorInput, AnchorTracker, placementBox } from '../src/common/desktop-anchor.ts';
import { DesktopFollow, type FollowPanel } from '../src/common/desktop-follow.ts';
import {
  anchorPayload, cardIn, fallbackInsets, inside, inset, keepOut, keepOutOf, type LayoutMemory, overlaps, type PanelRequest, place,
  wheelFrame, ZERO_INSETS, type AnchorPayload,
} from '../src/common/desktop-layout.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';

/** A 1512 × 982 main display with a 25 pt menu bar, a 1920 × 1080 display to its right, and a portrait display. */
const main: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 }, visibleFrame: { x: 0, y: 0, w: 1512, h: 957 } };
const side: ScreenInfo = { id: 2, frame: { x: 1512, y: 0, w: 1920, h: 1080 }, visibleFrame: { x: 1512, y: 0, w: 1920, h: 1055 } };
const portrait: ScreenInfo = { id: 3, frame: { x: 0, y: 0, w: 1080, h: 1920 }, visibleFrame: { x: 0, y: 0, w: 1080, h: 1895 } };
const bubble: PanelRequest = { kind: 'bubble', size: { w: 380, h: 200 }, cardInsets: ZERO_INSETS, visible: true };
/** DockRoot's card, 180 × 156, in its 16 px padding. */
const dock: PanelRequest = { kind: 'dock', size: { w: 212, h: 188 }, cardInsets: fallbackInsets('dock'), visible: true };
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

function layout(body: Rect | null, o: { screens?: ScreenInfo[]; docked?: 'hidden' | 'fullscreen' | 'stale'; requests?: PanelRequest[];
  memory?: LayoutMemory; now?: number } = {}) {
  return place({ body, screens: o.screens ?? [main], docked: o.docked, mouse: { x: 700, y: 400 }, requests: o.requests ?? [bubble],
    memory: o.memory, now: o.now ?? 0 });
}

test('rule 1: the keep-out grows her body by 8', () => {
  assert.deepEqual(keepOut(r(100, 100, 100, 200)), r(92, 92, 116, 216));
});

test('the bubble on her roomier side with its top at her head', () => {
  const { placements: p } = layout(r(600, 100, 200, 400));
  assert.deepEqual(p.bubble, { frame: r(768, 300, 380, 200), side: 'right', docked: null, far: false });
});

test('her left and right screen edges flip the bubble', () => {
  let { placements: p } = layout(r(40, 400, 200, 400), { requests: [bubble] });
  assert.deepEqual(p.bubble?.frame, r(208, 600, 380, 200));
  assert.equal(p.bubble?.side, 'right');
  ({ placements: p } = layout(r(1272, 100, 200, 400)));
  assert.deepEqual(p.bubble?.frame, r(924, 300, 380, 200));
  assert.equal(p.bubble?.side, 'left');
});

test('cards, not windows, hug her', () => {
  const body = r(1272, 100, 200, 400);
  const k = keepOutOf('bubble', body, r(body.x + body.w / 2, body.y + body.h, 0, 0), 1);
  const ci = fallbackInsets('bubble');
  const { placements: p } = layout(body, { requests: [{ ...bubble, cardInsets: ci }] });
  const c = cardIn(ci, p.bubble!.frame);
  assert.equal(p.bubble?.side, 'left');
  assert.equal(c.x + c.w, k.x - 8);
  assert.equal(c.y + c.h, body.y + body.h);
});

test('a head at the menu bar clamps the tops below it; the second screen is her head\'s', () => {
  let { placements: p } = layout(r(600, 557, 200, 400));
  assert.deepEqual(p.bubble?.frame, r(768, 749, 380, 200));
  ({ placements: p } = layout(r(2400, 200, 200, 400), { screens: [main, side], requests: [bubble, dock] }));
  for (const kind of ['bubble', 'dock'] as const) {
    assert.equal(inside(p[kind]!.frame, inset(side.visibleFrame, 8)), true);
    assert.equal(p[kind]!.docked, null);
  }
});

test('portrait without side room goes above; a tall body keeps it beside', () => {
  let { placements: p } = layout(r(390, 700, 300, 400), { screens: [portrait], requests: [{ ...bubble, size: { w: 480, h: 200 } }] });
  assert.equal(p.bubble?.side, 'above');
  assert.deepEqual(p.bubble?.frame, r(300, 1116, 480, 200));
  ({ placements: p } = layout(r(600, 20, 200, 900)));
  assert.deepEqual(p.bubble?.frame, r(768, 720, 380, 200));
});

test('docked: a stale corner avoids her; hidden or fullscreen the bubble is the subtitle under the menu bar', () => {
  let { placements: p } = layout(r(1250, 500, 200, 400), { docked: 'stale', requests: [bubble, dock] });
  assert.deepEqual(p.bubble, { frame: r(8, 749, 380, 200), side: 'corner', docked: 'stale', far: false });
  assert.deepEqual(p.dock?.frame, r(1292, 8, 212, 188), 'clear of her and of the bubble');
  for (const reason of ['hidden', 'fullscreen'] as const) {
    const out = layout(r(600, 100, 200, 400), { docked: reason, requests: [bubble, dock] });
    p = out.placements;
    assert.deepEqual(p.bubble, { frame: r(566, 749, 380, 200), side: 'menubar', docked: reason, far: false });
    assert.deepEqual(p.dock, { frame: r(1292, 761, 212, 188), side: 'corner', docked: reason, far: false });
    assert.deepEqual(out.memory, {});
  }
});

test('the dock\'s card beside her chest, GAP out from her keep-out, on her roomier side, else the other, else above her', () => {
  const at = (body: Rect, memory?: LayoutMemory) => place({ body, screens: [main], requests: [dock], memory });
  let body = r(600, 100, 200, 400);
  let out = at(body);
  assert.deepEqual(out.placements.dock, { frame: r(800, 234, 212, 188), side: 'right', docked: null, far: false });
  const card = cardIn(dock.cardInsets, out.placements.dock!.frame);
  assert.equal(card.x, keepOut(body).x + keepOut(body).w + 8);
  assert.equal(card.y + card.h / 2, body.y + 0.57 * body.h);
  body = r(1272, 100, 200, 400);
  out = at(body);
  assert.equal(out.placements.dock?.side, 'left');
  assert.equal(cardIn(dock.cardInsets, out.placements.dock!.frame).x + 180, keepOut(body).x - 8);
  out = at(r(100, 100, 1300, 400));
  assert.deepEqual(out.placements.dock, { frame: r(644, 500, 212, 188), side: 'above', docked: null, far: false });
});

test('the dock keeps the side it had while that side has room, through a hide', () => {
  let { placements: p, memory: mem } = place({ body: r(1272, 100, 200, 400), screens: [main], requests: [dock] });
  assert.equal(p.dock?.side, 'left');
  ({ memory: mem } = place({ body: r(1272, 100, 200, 400), screens: [main], requests: [], memory: mem }));
  ({ placements: p, memory: mem } = place({ body: r(600, 100, 200, 400), screens: [main], requests: [dock], memory: mem }));
  assert.deepEqual(p.dock?.frame, r(388, 234, 212, 188), 'left, though her right has more room');
  ({ placements: p } = place({ body: r(100, 100, 200, 400), screens: [main], requests: [dock], memory: mem }));
  assert.equal(p.dock?.side, 'right', 'no room left of her');
});

test('a bubble meeting the dock on its side moves up clear of it; one on her other side stays', () => {
  let { placements: p } = layout(r(600, 100, 200, 400), { requests: [bubble, dock] });
  assert.deepEqual(p.dock?.frame, r(800, 234, 212, 188));
  assert.deepEqual(p.bubble?.frame, r(768, 414, 380, 200));
  assert.equal(overlaps(p.bubble!.frame, cardIn(dock.cardInsets, p.dock!.frame)), false);
  const memory: LayoutMemory = { bubble: { side: 'left', candidate: null, since: 0, hiddenAt: null },
    dock: { side: 'right', candidate: null, since: 0, hiddenAt: null } };
  ({ placements: p } = layout(r(600, 100, 200, 400), { requests: [bubble, dock], memory }));
  assert.deepEqual([p.bubble?.side, p.dock?.side], ['left', 'right']);
  assert.deepEqual(p.bubble?.frame, r(252, 300, 380, 200));
});

test('rule 6: the column keeps its side while it fits, and switches only after half a second', () => {
  let { placements: p, memory: mem } = layout(r(600, 100, 200, 400), { requests: [bubble] });
  assert.equal(p.bubble?.side, 'right');
  for (const [i, x] of [880, 700, 850, 600].entries()) {
    ({ placements: p, memory: mem } = layout(r(x, 100, 200, 400), { requests: [bubble], memory: mem, now: (i + 1) * 2 }));
    assert.equal(p.bubble?.side, 'right');
  }
  const body = r(952, 100, 200, 400);
  mem = { bubble: { side: 'right', candidate: null, since: 0, hiddenAt: null } };
  for (const now of [0, 0.2, 0.49]) {
    ({ placements: p, memory: mem } = layout(body, { requests: [bubble], memory: mem, now }));
    assert.equal(p.bubble?.side, 'right');
    assert.equal(p.bubble?.frame.x, 1120);
  }
  assert.equal(mem.bubble?.candidate, 'left');
  ({ placements: p, memory: mem } = layout(body, { requests: [bubble], memory: mem, now: 0.5 }));
  assert.equal(p.bubble?.side, 'left');
});

test('the column side outlasts ten minutes hidden', () => {
  const body = r(600, 100, 200, 400);
  let { memory: mem } = layout(body, { requests: [], memory: { bubble: { side: 'left', candidate: null, since: 0, hiddenAt: null } }, now: 100 });
  assert.equal(mem.bubble?.hiddenAt, 100);
  const held = mem;
  let { placements: p } = layout(body, { requests: [bubble], memory: held, now: 699 });
  assert.equal(p.bubble?.side, 'left');
  ({ placements: p } = layout(body, { requests: [bubble], memory: held, now: 700 }));
  assert.equal(p.bubble?.side, 'right');
});

const chip: PanelRequest = { kind: 'chip', size: { w: 528, h: 36 }, cardInsets: fallbackInsets('chip'), visible: true };

test('the chip\'s circle beside her face on the side away from the bubble, its top at her head', () => {
  // Head top (700, 500), face 640…760.
  const body = r(600, 100, 200, 400);
  assert.deepEqual(fallbackInsets('chip'), { left: 246, right: 246, top: 0, bottom: 0 });
  const withBubble = { ...bubble, cardInsets: fallbackInsets('bubble') };
  let { placements: p, memory: mem } = layout(body, { requests: [withBubble, chip] });
  assert.equal(p.bubble?.side, 'right');
  assert.deepEqual(p.chip, { frame: r(350, 464, 528, 36), side: 'left', docked: null, far: false });
  assert.deepEqual(cardIn(chip.cardInsets, p.chip!.frame), r(596, 464, 36, 36));
  assert.equal(overlaps(cardIn(chip.cardInsets, p.chip!.frame), cardIn(withBubble.cardInsets, p.bubble!.frame)), false);
  assert.equal(mem.bubble?.side, 'right', 'the chip leaves the column\'s side to the bubble');
  // Alone it takes the column's remembered side, and keeps the column from going stale.
  mem = { bubble: { side: 'left', candidate: null, since: 0, hiddenAt: null } };
  ({ placements: p, memory: mem } = layout(body, { requests: [chip], memory: mem, now: 100 }));
  assert.deepEqual(p.chip, { frame: r(350, 464, 528, 36), side: 'left', docked: null, far: false });
  assert.equal(mem.bubble?.hiddenAt, null);
  for (const reason of ['hidden', 'fullscreen'] as const) {
    ({ placements: p } = layout(body, { docked: reason, requests: [chip] }));
    assert.deepEqual(p.chip, { frame: r(492, 913, 528, 36), side: 'menubar', docked: reason, far: false });
  }
});

test('the chip goes opposite her hover buttons without a bubble, and above her head when the far side has no room', () => {
  let { placements: p } = layout(r(600, 100, 200, 400), { requests: [dock, chip] });
  assert.equal(p.dock?.side, 'right');
  assert.equal(p.chip?.side, 'left');
  // At the screen's right edge the bubble goes left and the right has no room for the chip.
  const withBubble = { ...bubble, cardInsets: fallbackInsets('bubble') };
  ({ placements: p } = layout(r(1272, 100, 200, 400), { requests: [withBubble, chip] }));
  assert.equal(p.bubble?.side, 'left');
  assert.equal(p.chip?.side, 'above');
  assert.equal(overlaps(cardIn(chip.cardInsets, p.chip!.frame), cardIn(withBubble.cardInsets, p.bubble!.frame)), false);
});

test('the anchor payload: toHead from the panel centre, y down; room is the visible frame less the edge', () => {
  const { placements: p } = layout(r(600, 100, 200, 400));
  const a = anchorPayload('bubble', p.bubble!, 'settled', r(700, 500, 0, 0), [main]);
  assert.deepEqual(a, { panel: 'bubble', state: 'settled', side: 'right', docked: null, far: false, toHead: { dx: -258, dy: -100 },
    room: { width: 1496, height: 941 } });
});

class Panel implements FollowPanel {
  isShown = true;
  isFrozen = false;
  isKey = false;
  contentSize: { w: number; h: number } | null;
  cardInsets = null;
  moves: { frame: Rect; animated: boolean }[] = [];
  anchors: AnchorPayload[] = [];
  alpha = 1;
  tookKey = 0;
  released = 0;
  constructor(size: { w: number; h: number }) { this.contentSize = size; }
  move(frame: Rect, animated: boolean) { this.moves.push({ frame, animated }); }
  setAlpha(alpha: number) { this.alpha = alpha; }
  pushAnchor(anchor: AnchorPayload) { this.anchors.push(anchor); }
  takeKey() { this.tookKey += 1; }
  releaseKey() { this.released += 1; }
}

function sample(body: Rect | null, now: number, o: { placement?: Rect | null; hidden?: boolean } = {}) {
  return { body, bodyAt: body ? now : null, hidden: o.hidden ?? false, frontFullscreen: false, dragging: false, now, screens: [main],
    placement: o.placement ?? null, figure: 'si/default', visual: null };
}

test('the follower places a shown panel at once, holds inside the dead zone and docks when her samples go stale', () => {
  const b = new Panel({ w: 380, h: 200 }), d = new Panel({ w: 212, h: 188 });
  const f = new DesktopFollow({ bubble: b, dock: d });
  f.tick(sample(r(600, 100, 200, 400), 0), { x: 0, y: 0 });
  // The bubble's card lifted clear of the dock's on her right.
  assert.deepEqual(b.moves, [{ frame: r(752, 398, 380, 200), animated: false }]);
  assert.deepEqual(d.moves, [{ frame: r(800, 234, 212, 188), animated: false }]);
  assert.deepEqual(f.placedCard('dock'), { card: r(816, 250, 180, 156), side: 'right' });
  assert.equal(b.anchors.at(-1)?.state, 'settled');
  assert.equal(b.anchors.at(-1)?.side, 'right');
  // A small sway stays inside the dead zone.
  f.tick(sample(r(610, 100, 200, 400), 0.1), { x: 0, y: 0 });
  assert.equal(b.moves.length, 1);
  f.tick(sample(null, 3.1), { x: 0, y: 0 });
  assert.equal(f.state, 'docked');
  assert.equal(b.anchors.at(-1)?.docked, 'stale');
  assert.equal(b.anchors.at(-1)?.side, 'corner');
});

test('hidden, the bubble is the subtitle bar under the menu bar; a bubble page with nothing to show learns of the dock', () => {
  const b = new Panel({ w: 380, h: 120 });
  const f = new DesktopFollow({ bubble: b });
  f.tick(sample(r(600, 100, 200, 400), 0), { x: 0, y: 0 });
  f.tick(sample(null, 0.1, { hidden: true }), { x: 0, y: 0 });
  assert.deepEqual(b.moves.at(-1)?.frame, r(566, 829, 380, 120));
  assert.equal(b.anchors.at(-1)?.side, 'menubar');
  assert.equal(b.anchors.at(-1)?.docked, 'hidden');
  b.isShown = false;
  f.tick(sample(r(600, 100, 200, 400), 0.2), { x: 0, y: 0 });
  assert.equal(b.anchors.at(-1)?.docked, null);
  f.tick(sample(null, 0.3, { hidden: true }), { x: 0, y: 0 });
  assert.equal(b.anchors.at(-1)?.docked, 'hidden');
});

test('a frozen panel holds; her placement moves the panels once her box held', () => {
  const b = new Panel({ w: 380, h: 200 });
  const f = new DesktopFollow({ bubble: b });
  const at = placementBox(700, 100, 1);
  f.tick(sample(r(600, 100, 200, 400), 0, { placement: at }), { x: 0, y: 0 });
  assert.equal(b.moves.length, 1);
  b.isFrozen = true;
  const moved = placementBox(300, 100, 1);
  f.tick(sample(r(200, 100, 200, 400), 0.1, { placement: moved }), { x: 0, y: 0 });
  assert.equal(f.state, 'frozen');
  assert.equal(b.moves.length, 1);
  b.isFrozen = false;
  f.tick(sample(r(200, 100, 200, 400), 0.2, { placement: moved }), { x: 0, y: 0 });
  f.tick(sample(r(200, 100, 200, 400), 0.4, { placement: moved }), { x: 0, y: 0 });
  assert.equal(b.moves.length, 2);
  assert.equal(b.moves[1]!.animated, true);
  assert.equal(b.anchors.at(-1)?.state, 'glide');
});

// Her body column from `placementBox`, `column` and the visual sample less its padding.
test('her body column: her visual rect less 24 a side around her anchor, or her capsules with each side at least 60', () => {
  const tracker = new AnchorTracker();
  const display: ScreenInfo = { id: 4, frame: r(0, 0, 1920, 1080), visibleFrame: r(0, 25, 1920, 1030) };
  const at = (input: Partial<AnchorInput>) => tracker.update({ body: null, bodyAt: null, hidden: false, frontFullscreen: false,
    dragging: false, now: 0, screens: [display], placement: null, figure: 'si/default', visual: null, ...input });
  assert.deepEqual(placementBox(1100, 33, 1), r(830, 33, 540, 780));
  // The visual rect 787…1459 × 9…782: lo = 787 - 1100 + 24 = -289, hi = 1459 - 1100 - 24 = 335, top = 782 - 33 - 24 = 725.
  const s = at({ body: r(860, 40, 470, 700), bodyAt: 0, placement: placementBox(1100, 33, 1), visual: r(787, 9, 672, 773) });
  assert.deepEqual(s.settledBody, r(811, 33, 624, 725));
  assert.deepEqual(s.head, r(1100, 758, 0, 0));
  assert.deepEqual(s.column, { anchor: { x: 1100, y: 33 }, source: 'visual', posture: 'standing' });
  // Capsules only, at scale 1.5: lo = -20 and hi = 26.7 widen to ±60, top = 900 / 1.5 = 600.
  const narrow = new AnchorTracker().update({ body: r(470, 100, 70, 900), bodyAt: 0, hidden: false, frontFullscreen: false, dragging: false,
    now: 0, screens: [display], placement: placementBox(500, 100, 1.5), figure: 'si/default', visual: null });
  assert.deepEqual(narrow.settledBody, r(410, 100, 180, 900));
  assert.deepEqual(narrow.head, r(500, 1000, 0, 0));
  assert.equal(narrow.column?.source, 'capsules');
});

test('on that column the dock goes on her roomier left at her chest', () => {
  const display: ScreenInfo = { id: 4, frame: r(0, 0, 1920, 1080), visibleFrame: r(0, 0, 1920, 1055) };
  const d = new Panel({ w: 212, h: 188 });
  const lines: string[] = [];
  const f = new DesktopFollow({ dock: d }, (l) => lines.push(l));
  f.tick({ body: r(860, 40, 470, 700), bodyAt: 0, hidden: false, frontFullscreen: false, dragging: false, now: 0, screens: [display],
    placement: placementBox(1100, 33, 1), figure: 'si/default', visual: r(787, 9, 672, 773) }, { x: 0, y: 0 });
  assert.equal(f.placedCard('dock')?.side, 'left');
  assert.ok(lines.includes('desk: column anchor 1100,33 rect 811,33 624x725 source visual posture standing'));
  assert.ok(lines.includes('desk: dock frame 599,352 212x188'));
});

// The wheel: its panel centred where it opened, kept on the screen it opened on.
test('wheelFrame centres the panel on the point and moves it onto the visible frame of that point\'s screen', () => {
  assert.deepEqual(wheelFrame({ x: 700, y: 500 }, 520, [main, side]), r(440, 240, 520, 520));
  assert.deepEqual(wheelFrame({ x: 100, y: 900 }, 520, [main, side]), r(8, 429, 520, 520));
  assert.deepEqual(wheelFrame({ x: 3400, y: 20 }, 520, [main, side]), r(3432 - 8 - 520, 8, 520, 520));
});

// DesktopLayoutTests' command layer cases (rules 5, 6): the wheel and input in the cmd panel.
const cmd = (mode: 'ring' | 'input', w: number, h: number): PanelRequest =>
  ({ kind: 'cmd', size: { w, h }, cardInsets: ZERO_INSETS, visible: true, mode });
const input = cmd('input', 420, 60);

test('rule 5: without her, input sits a quarter up the mouse\'s screen and the ring in its middle', () => {
  const at = (request: PanelRequest) =>
    place({ body: null, screens: [main, side], mouse: { x: 2000, y: 500 }, requests: [request] }).placements.cmd;
  assert.deepEqual(at(cmd('input', 420, 60)), { frame: r(2262, 263.75, 420, 60), side: 'mouse', docked: 'hidden', far: false });
  assert.deepEqual(at(cmd('ring', 300, 300))?.frame, r(2322, 377.5, 300, 300));
});

test('input below her, then beside her', () => {
  let { placements: p } = layout(r(600, 300, 200, 400), { requests: [input] });
  assert.deepEqual(p.cmd, { frame: r(490, 224, 420, 60), side: 'below', docked: null, far: true });
  ({ placements: p } = layout(r(600, 30, 200, 400), { requests: [input] }));
  assert.deepEqual(p.cmd?.frame, r(816, 370, 420, 60));
  assert.equal(p.cmd?.side, 'right');
});

test('the command panel keeps clear of the bubble and the dock', () => {
  const { placements: p } = layout(r(600, 300, 200, 400), { requests: [bubble, dock, input] });
  assert.deepEqual([p.bubble?.side, p.dock?.side, p.cmd?.side], ['right', 'right', 'below']);
  assert.equal(overlaps(p.cmd!.frame, p.bubble!.frame), false);
  assert.equal(overlaps(p.cmd!.frame, p.dock!.frame), false);
});

test('rule 6: the command panel flips side only after 300 ms, and a side within the tolerance does not take over', () => {
  let { placements: p, memory: mem } = layout(r(600, 30, 200, 400), { requests: [input], now: 0 });
  assert.equal(p.cmd?.side, 'right', 'no room below her');
  const body = r(600, 150, 200, 400);
  ({ placements: p, memory: mem } = layout(body, { requests: [input], memory: mem, now: 0.1 }));
  assert.equal(p.cmd?.side, 'right');
  assert.equal(mem.cmd?.candidate, 'below');
  ({ placements: p, memory: mem } = layout(body, { requests: [input], memory: mem, now: 0.3 }));
  assert.equal(p.cmd?.side, 'right');
  ({ placements: p, memory: mem } = layout(body, { requests: [input], memory: mem, now: 0.4 }));
  assert.equal(p.cmd?.side, 'below');
  assert.deepEqual(mem.cmd, { side: 'below', candidate: null, since: 0, hiddenAt: null, mode: 'input' });

  // 16 pt under her keep-out is short of the frame and 40.
  const held: LayoutMemory = { cmd: { side: 'right', candidate: null, since: 0, hiddenAt: null, mode: 'input' } };
  ({ memory: mem } = layout(r(600, 100, 200, 400), { requests: [input], memory: held, now: 0 }));
  ({ placements: p } = layout(r(600, 100, 200, 400), { requests: [input], memory: mem, now: 5 }));
  assert.equal(p.cmd?.side, 'right');
});

// DesktopCoordinatorTests' command layer cases: open and close, the page closing it, 快速输入 in the bubble.
function commandFollower() {
  const panels = { bubble: new Panel({ w: 380, h: 120 }), cmd: new Panel({ w: 300, h: 300 }) };
  panels.bubble.isShown = false;
  panels.cmd.isShown = false;
  const commands: Record<string, unknown>[] = [];
  const f = new DesktopFollow(panels, () => {}, (c) => commands.push(c));
  return { f, ...panels, commands };
}

test('open takes key and close hands it back; the wheel closes on a click outside, input does not', () => {
  const { f, cmd: c, commands } = commandFollower();
  assert.equal(f.wantsTicks, false);
  f.open('ring', '你好');
  assert.deepEqual(commands, [{ kind: 'open', mode: 'ring', prefill: '你好' }]);
  assert.equal(c.tookKey, 1);
  assert.equal(f.wantsTicks, true);
  assert.equal(f.closesOnOutsideClick, true);
  c.isShown = true;
  f.tick(sample(r(600, 100, 160, 400), 0), { x: 10, y: 10 });
  const placed = c.moves.at(-1)!.frame;
  assert.equal(overlaps(cardIn(fallbackInsets('cmd'), placed), keepOut(r(600, 100, 160, 400))), false);
  f.close();
  assert.deepEqual(commands.at(-1), { kind: 'close' });
  assert.equal(c.released, 1);
  assert.equal(f.cmdMode, null);
  f.close();
  assert.equal(c.released, 1);
  f.open('input');
  assert.equal(f.closesOnOutsideClick, false);
});

test('the page hiding the command panel ends the mode', () => {
  const { f, cmd: c } = commandFollower();
  f.open('ring');
  c.isShown = true;
  f.tick(sample(r(600, 100, 160, 400), 0), { x: 10, y: 10 });
  assert.equal(f.cmdMode, 'ring');
  c.isShown = false;
  f.tick(sample(r(600, 100, 160, 400), 0.1), { x: 10, y: 10 });
  assert.equal(f.cmdMode, null);
});

test('快速输入 opens in the bubble and closes the command layer; a bare close goes first', () => {
  const { f, bubble: b, cmd: c, commands } = commandFollower();
  f.open('ring');
  commands.length = 0;
  f.openQuickInput('你好', { kind: 'scope', scopeId: 's1', files: 2 });
  assert.deepEqual(commands, [{ kind: 'close' }, { kind: 'scope', scopeId: 's1', files: 2 }, { kind: 'open', mode: 'input', prefill: '你好' }]);
  assert.equal(f.cmdMode, null);
  assert.equal(c.released, 1);
  assert.equal(b.tookKey, 1);
  assert.equal(c.tookKey, 1, 'only the ring\'s open keyed the cmd panel');
  assert.equal(f.quickInputOpen, true);
  f.closeQuickInput();
  assert.equal(f.quickInputOpen, false);
  assert.equal(b.released, 1);
  commands.length = 0;
  f.openQuickInput();
  assert.deepEqual(commands, [{ kind: 'close' }, { kind: 'open', mode: 'input' }]);
  assert.equal(c.released, 1);
});

test('a right click opens the wheel centred on the click, kept on screen, and tells the page where its centre is', () => {
  const { f, cmd: c, commands } = commandFollower();
  c.contentSize = { w: 520, h: 520 };
  f.open('ring', undefined, { centre: { x: 700, y: 500 }, screens: [main], at: true });
  assert.deepEqual(commands, [{ kind: 'open', mode: 'ring', at: { x: 260, y: 260 } }]);
  c.isShown = true;
  f.tick(sample(r(600, 100, 160, 400), 0), { x: 700, y: 500 });
  assert.deepEqual(c.moves.at(-1)?.frame, r(440, 240, 520, 520));
  f.close();
  // Near her screen's corner the panel stays on screen and the centre moves within it.
  f.open('ring', undefined, { centre: { x: 100, y: 900 }, screens: [main], at: true });
  assert.deepEqual(commands.at(-1), { kind: 'open', mode: 'ring', at: { x: 92, y: 49 } });
  f.tick(sample(r(600, 100, 160, 400), 0.1), { x: 100, y: 900 });
  assert.deepEqual(c.moves.at(-1)?.frame, r(8, 429, 520, 520));
  f.close();
  // The hot key's wheel sends no centre: the page centres it in its box.
  f.open('ring', undefined, { centre: { x: 700, y: 500 }, screens: [main], at: false });
  assert.deepEqual(commands.at(-1), { kind: 'open', mode: 'ring' });
});

// DesktopLayoutTests' and DesktopCoordinatorTests' console cases: the console under the menu bar button, on its own channel.
const consoleRequest = (w: number, h: number, statusItem: Rect | null): PanelRequest =>
  ({ kind: 'console', size: { w, h }, cardInsets: ZERO_INSETS, visible: true, statusItem });

test('the console card hangs under the menu bar button even over her, its right edge kept on screen', () => {
  const item = r(1300, 957, 30, 25);
  let { placements: p } = layout(r(100, 100, 200, 400), { requests: [consoleRequest(360, 300, item)] });
  // The page's inset is 4 pt on the left and top, 8 pt on the right and bottom for the card's shadow.
  assert.deepEqual(p.console, { frame: r(978, 657, 360, 300), side: 'status', docked: null, far: true });
  ({ placements: p } = layout(r(1000, 500, 200, 400), { requests: [consoleRequest(360, 300, item)] }));
  assert.deepEqual(p.console, { frame: r(978, 657, 360, 300), side: 'status', docked: null, far: false });
  ({ placements: p } = layout(null, { requests: [consoleRequest(360, 300, r(1490, 957, 30, 25))] }));
  assert.equal(p.console!.frame.x + p.console!.frame.w, 1504 + 8, 'the card\'s right edge stays on screen');
  ({ placements: p } = layout(null, { docked: 'stale', requests: [dock, consoleRequest(360, 300, item)] }));
  assert.equal(overlaps(p.dock!.frame, p.console!.frame), false, 'a cornered dock keeps clear of the console');
});

test('the console card stands on a taskbar at the bottom, its right edge on the notification area icon\'s', () => {
  const display: ScreenInfo = { id: 4, frame: r(0, 0, 1920, 1080), visibleFrame: r(0, 48, 1920, 1032) };
  const { placements: p } = layout(null, { screens: [display], requests: [consoleRequest(360, 300, r(1700, 12, 24, 24))] });
  assert.deepEqual(p.console!.frame, r(1372, 44, 360, 300));
});

const ITEM = r(1188, 873, 36, 24);

function consoleFollower() {
  const panels = { console: new Panel({ w: 392, h: 261 }), cmd: new Panel({ w: 300, h: 300 }), bubble: new Panel({ w: 380, h: 120 }) };
  for (const p of Object.values(panels)) p.isShown = false;
  const commands: Record<string, unknown>[] = [], consoleCommands: Record<string, unknown>[] = [];
  const f = new DesktopFollow(panels, () => {}, (c) => commands.push(c), (c) => consoleCommands.push(c));
  const at = (now: number) => f.tick(sample(r(600, 100, 160, 400), now), { x: 10, y: 10 });
  return { f, ...panels, commands, consoleCommands, at };
}

test('the console waits for its own size, then aligns its card with the menu bar button', () => {
  const { f, console: c, commands, consoleCommands, at } = consoleFollower();
  c.contentSize = null;
  f.openConsole(ITEM);
  assert.deepEqual(consoleCommands, [{ kind: 'openConsole' }]);
  assert.deepEqual(commands, [], 'the other pages get nothing');
  assert.equal(c.tookKey, 1);
  assert.equal(f.wantsTicks, true);
  c.isShown = true;
  c.isKey = true;
  at(0);
  assert.equal(c.moves.length, 0, 'not placed with the empty page\'s size');
  c.contentSize = { w: 392, h: 261 };
  at(0.1);
  // The card inside the page's inset (8 pt right, 4 pt top): its right edge on the button's, its top 4 pt below the menu bar.
  assert.deepEqual(c.moves, [{ frame: r(1224 + 8 - 392, 873 - 4 + 4 - 261, 392, 261), animated: false }]);
});

test('the console shows with an unchanged size after a while', () => {
  const { f, console: c, at } = consoleFollower();
  c.isShown = true;
  f.openConsole(ITEM);
  at(0);
  at(0.2);
  assert.equal(c.moves.length, 0);
  at(0.4);
  assert.deepEqual(c.moves.at(-1)?.frame, r(840, 612, 392, 261));
});

test('the wheel opens in the command panel and leaves the console; closing either leaves the other; the page closing it ends it', () => {
  const { f, console: c, cmd, commands, consoleCommands, at } = consoleFollower();
  c.isShown = true;
  f.openConsole(ITEM);
  at(0);
  at(0.4);
  const frame = c.moves.at(-1)!.frame;
  f.open('ring');
  cmd.isShown = true;
  at(0.5);
  at(0.9);
  assert.equal(f.consoleOpen, true);
  assert.deepEqual(c.moves.at(-1)?.frame, frame);
  assert.equal(c.moves.length, 1);
  assert.notDeepEqual(cmd.moves.at(-1)?.frame, frame);
  f.close();
  assert.equal(f.consoleOpen, true);
  assert.equal(f.closesOnOutsideClick, true, 'the console closes on a click outside it');
  assert.deepEqual(consoleCommands, [{ kind: 'openConsole' }], 'no wheel command reaches the console');
  assert.deepEqual(commands, [{ kind: 'open', mode: 'ring' }, { kind: 'close' }]);
  f.open('ring');
  commands.length = 0;
  f.closeConsole();
  assert.equal(f.consoleOpen, false);
  assert.equal(f.cmdMode, 'ring');
  assert.deepEqual(commands, []);
  assert.equal(c.released, 1);
  f.closeConsole();
  assert.equal(c.released, 1);
  f.openConsole(ITEM);
  at(1);
  c.isShown = false;
  at(1.1);
  assert.equal(f.consoleOpen, false, 'the page hid it');
});

test('快速输入 closes an open console', () => {
  const { f, consoleCommands } = consoleFollower();
  f.openConsole(r(1400, 1040, 30, 24));
  consoleCommands.length = 0;
  f.openQuickInput();
  assert.equal(f.consoleOpen, false);
  assert.deepEqual(consoleCommands, [{ kind: 'close' }]);
});
