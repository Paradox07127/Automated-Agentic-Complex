// `stack.html#/photo`: the game's photo panel in a bar under her — aperture and focus, the shutter, 关闭.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { PhotoOverlayState } from '../../src/bridge/photo';
import { PhotoRoot } from '../../src/surfaces/desktop/PhotoRoot';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

const ANCHOR = { x: 700, y: 300, width: 180, height: 280 };

function mount(flags: { photo: boolean; capture: boolean }) {
  const bridge = createFakeBridge({ surface: 'stack', still: true });
  let push: (s: PhotoOverlayState) => void = () => {};
  vi.spyOn(bridge.photo, 'onState').mockImplementation((cb) => {
    push = cb;
    cb({ anchor: ANCHOR, ...flags });
    return () => {};
  });
  const calls = {
    set: vi.spyOn(bridge.photo, 'set'),
    capture: vi.spyOn(bridge.photo, 'capture').mockResolvedValue({ file: 'Agentic Complex-voice_a-20261116-120000.png' }),
    close: vi.spyOn(bridge.photo, 'close'),
    regions: vi.spyOn(bridge.window, 'setInteractiveRegions'),
  };
  window.agenticComplex = bridge;
  render(<PhotoRoot />);
  return { calls, show: (s: PhotoOverlayState) => act(() => push(s)) };
}

const reading = (k: string) => document.querySelector(`[data-readout="${k}"]`)?.textContent;

describe('PhotoRoot', () => {
  it('shows aperture and focus disabled, with the reason, while depth of field is not connected', () => {
    mount({ photo: false, capture: true });
    expect((screen.getByRole('slider', { name: '光圈' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: '手动' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/景深能力尚未就绪/)).toBeTruthy();
  });

  it('opens on f/32 and sends aperture and manual focus through photo.set', () => {
    const v = mount({ photo: true, capture: true });
    expect(reading('aperture')).toBe('f/32');
    fireEvent.change(screen.getByRole('slider', { name: '光圈' }), { target: { value: '5.6' } });
    expect(reading('aperture')).toBe('f/5.6');
    expect(v.calls.set).toHaveBeenLastCalledWith({ aperture: 5.6, focus: 'auto' });
    expect(reading('focus')).toBeUndefined();
    fireEvent.click(screen.getByRole('radio', { name: '手动' }));
    expect(v.calls.set).toHaveBeenLastCalledWith({ aperture: 5.6, focus: 10 });
    expect(reading('focus')).toBe('10.0m');
  });

  it('takes a transparent capture with the shutter and names the file', async () => {
    const v = mount({ photo: true, capture: true });
    const shutter = screen.getByRole('button', { name: '拍照' });
    expect(shutter.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(shutter);
    expect(v.calls.capture).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Agentic Complex-voice_a-20261116-120000\.png/)).toBeTruthy();
  });

  it('says why a capture failed', async () => {
    const v = mount({ photo: true, capture: true });
    v.calls.capture.mockRejectedValueOnce({ code: 'not_implemented', detail: 'photo.capture' });
    fireEvent.click(screen.getByRole('button', { name: '拍照' }));
    expect(await screen.findByText('拍摄失败：当前版本暂不支持')).toBeTruthy();
  });

  it('greys the shutter without capture and says why', () => {
    const v = mount({ photo: true, capture: false });
    const shutter = screen.getByRole('button', { name: '拍照' });
    expect(shutter.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('当前渲染器未提供截图能力')).toBeTruthy();
    fireEvent.click(shutter);
    expect(v.calls.capture).not.toHaveBeenCalled();
  });

  it('关闭 and Esc close the overlay; only the bar under her takes the pointer', async () => {
    const v = mount({ photo: true, capture: true });
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }));
    expect(v.calls.close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(v.calls.close).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(v.calls.regions).toHaveBeenCalled());
    expect(v.calls.regions.mock.lastCall?.[0]).toHaveLength(1);
    expect(screen.getByRole('region', { name: '拍照' }).hasAttribute('data-region')).toBe(true);
  });

  it('a new opening starts again on f/32, auto focus and no result line', async () => {
    const v = mount({ photo: true, capture: true });
    fireEvent.change(screen.getByRole('slider', { name: '光圈' }), { target: { value: '5.6' } });
    fireEvent.click(screen.getByRole('radio', { name: '手动' }));
    fireEvent.click(screen.getByRole('button', { name: '拍照' }));
    await screen.findByText(/已保存/);
    v.show({ anchor: ANCHOR, photo: true, capture: true });
    expect(reading('aperture')).toBe('f/32');
    expect(reading('focus')).toBeUndefined();
    expect(screen.queryByText(/已保存/)).toBeNull();
  });
});
