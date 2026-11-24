// 角色页「拍照」: the game's photo panel — aperture and focus, shutter.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge, type AvatarDetails } from '../../src/bridge';
import { PhotoMode } from '../../src/pages/character/PhotoMode';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function view(flags: { photo: boolean; capture: boolean }) {
  const bridge = getBridge();
  const base = await bridge.avatar.details();
  vi.spyOn(bridge.avatar, 'details').mockResolvedValue({ ...base, ...flags } satisfies AvatarDetails);
  const calls: string[] = [];
  vi.spyOn(bridge.avatar, 'keepClearOfMain').mockImplementation(async (on) => void calls.push(`keepClear ${on}`));
  const photo = vi.spyOn(bridge.avatar.photo, 'set').mockImplementation(async (s) => void calls.push(`photo ${JSON.stringify(s)}`));
  const r = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PhotoMode avatar offline={false} />
    </QueryClientProvider>,
  );
  return { calls, photo, unmount: r.unmount };
}

describe('PhotoMode', () => {
  it('shows aperture and focus disabled, with the reason, while depth of field is not connected', async () => {
    await view({ photo: false, capture: true });
    expect((screen.getByRole('slider', { name: '光圈' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: '手动' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/景深还没有接上/)).toBeTruthy();
  });

  it('sends aperture and manual focus through avatar.photo.set', async () => {
    const v = await view({ photo: true, capture: true });
    await waitFor(() => expect((screen.getByRole('slider', { name: '光圈' }) as HTMLInputElement).disabled).toBe(false));
    const reading = (k: string) => document.querySelector(`[data-readout="${k}"]`)?.textContent;
    expect(reading('aperture')).toBe('f/32');
    fireEvent.change(screen.getByRole('slider', { name: '光圈' }), { target: { value: '5.6' } });
    expect(reading('aperture')).toBe('f/5.6');
    expect(v.photo).toHaveBeenLastCalledWith({ active: true, aperture: 5.6, focus: 'auto' });
    expect(reading('focus')).toBeUndefined();
    fireEvent.click(screen.getByRole('radio', { name: '手动' }));
    expect(v.photo).toHaveBeenLastCalledWith({ active: true, aperture: 5.6, focus: 10 });
    expect(reading('focus')).toBe('10.0m');
  });

  it('takes a transparent capture with the shutter and names the file', async () => {
    const capture = vi.spyOn(getBridge().avatar, 'capture').mockResolvedValue({ file: 'Agentic Complex-voice_a-20261116-120000.png' });
    await view({ photo: true, capture: true });
    const shutter = screen.getByRole('button', { name: '拍照' });
    await waitFor(() => expect(shutter.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(shutter);
    expect(capture).toHaveBeenCalledWith({ background: 'transparent' });
    expect(await screen.findByText(/Agentic Complex-voice_a-20261116-120000\.png/)).toBeTruthy();
  });

  it('greys the shutter without capture and says why', async () => {
    const capture = vi.spyOn(getBridge().avatar, 'capture');
    await view({ photo: true, capture: false });
    const shutter = screen.getByRole('button', { name: '拍照' });
    await waitFor(() => expect(shutter.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByText('渲染器没有提供截图')).toBeTruthy();
    fireEvent.click(shutter);
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps her clear, then opens the photo state; closing undoes both in reverse', async () => {
    const v = await view({ photo: true, capture: true });
    await waitFor(() => expect(v.calls).toHaveLength(2));
    v.unmount();
    expect(v.calls).toEqual([
      'keepClear true',
      'photo {"active":true,"aperture":32,"focus":"auto"}',
      'photo {"active":false,"aperture":32,"focus":"auto"}',
      'keepClear false',
    ]);
  });

  it('never opens the photo state without photo', async () => {
    const v = await view({ photo: false, capture: false });
    v.unmount();
    expect(v.calls).toEqual(['keepClear true', 'keepClear false']);
  });
});
