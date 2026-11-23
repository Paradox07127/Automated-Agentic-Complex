// Where her hover buttons (the dock, src/common/desktop-layout.ts) stand: just outside her torso and face, over her arms, sleeves,
// skirt and hair, centred on her torso, on the side with room.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardIn, fallbackInsets, inside, inset, overlaps, type PanelRequest, place } from '../src/common/desktop-layout.ts';
import type { Rect, ScreenInfo } from '../src/common/placement.ts';

const main: ScreenInfo = { id: 1, frame: { x: 0, y: 0, w: 1512, h: 982 }, visibleFrame: { x: 0, y: 0, w: 1512, h: 957 } };
/** DockRoot's card, 180 × 156, in its 16 px padding. */
const dock: PanelRequest = { kind: 'dock', size: { w: 212, h: 188 }, cardInsets: fallbackInsets('dock'), visible: true };
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const maxX = (a: Rect) => a.x + a.w;
const midY = (a: Rect) => a.y + a.h / 2;

/** Her torso and face on her box `body` with her head top at `hx`: the torso 0.45–0.86 of its height from its bottom and
 *  0.12 of it either side, the face 0.84–1 and 0.06. */
function core(body: Rect, hx: number): { torso: Rect; face: Rect } {
  const box = (from: number, to: number, half: number) => r(hx - half * body.h, body.y + from * body.h, 2 * half * body.h, (to - from) * body.h);
  return { torso: box(0.45, 0.86, 0.12), face: box(0.84, 1, 0.06) };
}

function dockCard(body: Rect, hx: number): { card: Rect; side: string } {
  const p = place({ body, head: r(hx, body.y + body.h, 0, 0), screens: [main], requests: [dock] }).placements.dock!;
  return { card: cardIn(dock.cardInsets, p.frame), side: p.side };
}

/** The gap between the card and her torso and face on the card's side. */
function gap(card: Rect, c: { torso: Rect; face: Rect }, side: string): number {
  const left = Math.min(c.torso.x, c.face.x), right = Math.max(maxX(c.torso), maxX(c.face));
  return side === 'left' ? left - maxX(card) : card.x - right;
}

test('the dock stands just right of her torso and face, over her arm, centred on her torso', () => {
  // Her box as the host's loose visual bounds give it: far wider than her torso, her head top at her anchor.
  const body = r(60, 100, 580, 520), hx = 300, c = core(body, hx);
  const { card, side } = dockCard(body, hx);
  assert.equal(side, 'right');
  const g = gap(card, c, side);
  assert.ok(g >= 8 && g <= 16, `the card's near edge is ${g} pt out from her torso and face`);
  assert.ok(card.x < maxX(body), 'it covers the outer part of her box');
  assert.equal(midY(card), midY(c.torso));
});

test('near the right screen edge the dock goes left of her torso and face and stays on screen', () => {
  const body = r(1180, 100, 320, 520), hx = 1400, c = core(body, hx);
  const { card, side } = dockCard(body, hx);
  assert.equal(side, 'left');
  const g = gap(card, c, side);
  assert.ok(g >= 8 && g <= 16, `the card's near edge is ${g} pt out from her torso and face`);
  assert.ok(inside(card, inset(main.visibleFrame, 8)));
});

test('the dock never covers her torso or face and stays on screen', () => {
  for (const h of [300, 520, 760]) {
    for (let hx = 0; hx <= 1512; hx += 37) {
      for (const lean of [-0.3, 0, 0.3]) {
        const w = 1.1 * h, body = r(hx - w / 2 + lean * w, 60, w, h), c = core(body, hx);
        const { card, side } = dockCard(body, hx);
        const at = `h ${h} head ${hx} lean ${lean}: ${side}`;
        assert.ok(inside(card, inset(main.visibleFrame, 8)), at);
        assert.ok(!overlaps(card, c.torso) && !overlaps(card, c.face), at);
      }
    }
  }
});
