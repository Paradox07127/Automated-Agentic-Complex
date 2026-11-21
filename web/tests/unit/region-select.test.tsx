import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { RegionRoot } from '../../src/surfaces/desktop/RegionRoot';

// `stack.html#/region`: the dimmed page, the 1 pt border of the rect being dragged, and the drag's
// corners or a cancel handed to native.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

function mount() {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  const calls = { finish: vi.spyOn(bridge.region, 'finish'), cancel: vi.spyOn(bridge.region, 'cancel') };
  window.agenticComplex = bridge;
  render(<RegionRoot />);
  return { calls, page: screen.getByRole('application', { name: '框选' }) };
}

describe('the region selection page', () => {
  it('draws the rect from the press to the pointer, either corner first, and hands native the press and the release', () => {
    const { calls, page } = mount();
    expect(page.querySelector('[data-rect]')).toBeNull();
    fireEvent.mouseDown(page, { clientX: 110, clientY: 70, button: 0 });
    fireEvent.mouseMove(page, { clientX: 10, clientY: 90 });
    const rect = page.querySelector<HTMLElement>('[data-rect]')!;
    expect([rect.style.left, rect.style.top, rect.style.width, rect.style.height]).toEqual(['10px', '70px', '100px', '20px']);
    fireEvent.mouseUp(page, { clientX: 10, clientY: 20 });
    expect(calls.finish.mock.calls).toEqual([[{ x: 110, y: 70 }, { x: 10, y: 20 }]]);
    expect(calls.cancel).not.toHaveBeenCalled();
    expect(page.querySelector('[data-rect]')).toBeNull();
  });

  it('a right click, or a release without a press, cancels', () => {
    const { calls, page } = mount();
    fireEvent.mouseUp(page, { clientX: 5, clientY: 5 });
    fireEvent.mouseDown(page, { clientX: 5, clientY: 5, button: 2 });
    expect(calls.cancel).toHaveBeenCalledTimes(2);
    expect(calls.finish).not.toHaveBeenCalled();
  });
});
