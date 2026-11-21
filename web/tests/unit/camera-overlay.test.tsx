import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraOverlayState } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { CameraRoot } from '../../src/surfaces/desktop/CameraRoot';

// `stack.html#/camera`: the dashed area over her, the 全身 / 近景 / 复位 / 完成 bar
// under it, and what a drag, a wheel, a pinch and each button ask native for.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

const STATE: CameraOverlayState = { area: { x: 76, y: 351, width: 248, height: 448 }, value: { yaw: 0, pitch: 0, zoom: 1 }, editing: true,
  closeup: false };

function mount() {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  let push: (s: CameraOverlayState) => void = () => {};
  vi.spyOn(bridge.camera, 'onState').mockImplementation((cb) => {
    push = cb;
    return () => {};
  });
  const calls = {
    act: vi.spyOn(bridge.camera, 'act'),
    drag: vi.spyOn(bridge.camera, 'drag'),
    endDrag: vi.spyOn(bridge.camera, 'endDrag'),
    scroll: vi.spyOn(bridge.camera, 'scroll'),
    magnify: vi.spyOn(bridge.camera, 'magnify'),
  };
  window.agenticComplex = bridge;
  render(<CameraRoot />);
  return { calls, show: (s: CameraOverlayState) => act(() => push(s)) };
}

describe('the camera overlay page', () => {
  it('shows nothing before the state, then the area over her and the four buttons in order', () => {
    const { show } = mount();
    expect(screen.queryAllByRole('button')).toEqual([]);
    show(STATE);
    const area = screen.getByRole('application', { name: '镜头' });
    expect([area.style.left, area.style.top, area.style.width, area.style.height]).toEqual(['76px', '351px', '248px', '448px']);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['全身', '近景', '复位', '完成']);
    const closeup = () => screen.getByRole('button', { name: '近景' }).getAttribute('aria-disabled') === 'true';
    expect(closeup()).toBe(true);
    show({ ...STATE, closeup: true });
    expect(closeup()).toBe(false);
  });

  it('each button asks native for its action', () => {
    const { calls, show } = mount();
    show({ ...STATE, closeup: true });
    for (const name of ['全身', '近景', '复位', '完成']) fireEvent.click(screen.getByRole('button', { name }));
    expect(calls.act.mock.calls).toEqual([['fullBody'], ['closeup'], ['reset'], ['commit']]);
  });

  it('a drag on the area sends its travel, a wheel zooms, a pinch magnifies', () => {
    const { calls, show } = mount();
    show(STATE);
    const area = screen.getByRole('application', { name: '镜头' });
    fireEvent.mouseDown(area, { clientX: 100, clientY: 400, button: 0 });
    fireEvent.mouseMove(window, { clientX: 110, clientY: 395 });
    fireEvent.mouseMove(window, { clientX: 112, clientY: 395 });
    fireEvent.mouseUp(window, { clientX: 112, clientY: 395 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 395 });
    expect(calls.drag.mock.calls).toEqual([[10, -5], [2, 0]]);
    expect(calls.endDrag).toHaveBeenCalledTimes(1);
    fireEvent.wheel(area, { deltaY: -20, deltaMode: 0 });
    fireEvent.wheel(area, { deltaY: 3, deltaMode: 1 });
    fireEvent.wheel(area, { deltaY: 10, ctrlKey: true });
    expect(calls.scroll.mock.calls).toEqual([[20], [-30]]);
    expect(calls.magnify.mock.calls).toEqual([[-0.1]]);
  });
});
