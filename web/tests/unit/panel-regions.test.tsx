import { cleanup, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { GlassRect } from '../../src/bridge';
import type { Region } from '../../src/bridge/protocol';
import { useRegions } from '../../src/surfaces/desktop/hooks/useRegions';

// A desktop panel is ordered out until it reports a region, and a hidden window runs no animation frames:
// the report must not wait for one.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

let open: () => void = () => {};

function Panel() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  open = () => setShown(true);
  useRegions(ref);
  return <div ref={ref}>{shown && <button data-region="">指令环</button>}</div>;
}

it('reports a new region while animation frames are paused', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  const sent: Region[][] = [];
  bridge.window.setInteractiveRegions = (regions: Region[]) => {
    sent.push(regions);
  };
  window.agenticComplex = bridge;
  render(<Panel />);
  await act(async () => open());
  await act(async () => {});
  expect(sent.at(-1)).toHaveLength(1);
});

// An entry animation moves a card with a transform, which neither ResizeObserver nor MutationObserver sees.
it('reports the glass rects again when an animation or transition ends', async () => {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  const glass: GlassRect[][] = [];
  bridge.window.setInteractiveRegions = (_regions: Region[], rects?: GlassRect[]) => {
    glass.push(rects ?? []);
  };
  window.agenticComplex = bridge;
  const { container } = render(<GlassPanel />);
  const card = container.querySelector<HTMLElement>('[data-glass]')!;
  let top = 0;
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, top, 200, 80));
  for (const [i, type] of ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'].entries()) {
    top = 40 + i;
    await act(async () => void card.firstElementChild!.dispatchEvent(new Event(type, { bubbles: true })));
    expect(glass.at(-1)).toEqual([{ x: 10, y: top, w: 200, h: 80 }]);
  }
});

function GlassPanel() {
  const ref = useRef<HTMLDivElement>(null);
  useRegions(ref);
  return (
    <div ref={ref}>
      <div data-glass="" data-region="">
        <span>她的话</span>
      </div>
    </div>
  );
}
