// 角色页「拍照」: the game's photo panel — filter grid from settings.schema, aperture and focus, shutter.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge, type AvatarDetails } from '../../src/bridge';
import { PhotoMode } from '../../src/pages/character/PhotoMode';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NAMES = ['无', '黑金', '温暖', '苍白', '胶片', '希望色彩', '血忆', '武陵印象', '明亮', '冷调', '清新', '暗色', '黑白', '春', '文艺', '蓝橙'];

async function view(flags: { photo: boolean; capture: boolean }) {
  const bridge = getBridge();
  const base = await bridge.avatar.details();
  vi.spyOn(bridge.avatar, 'details').mockResolvedValue({ ...base, ...flags, filters: true } satisfies AvatarDetails);
  const calls: string[] = [];
  vi.spyOn(bridge.avatar, 'keepClearOfMain').mockImplementation(async (on) => void calls.push(`keepClear ${on}`));
  const photo = vi.spyOn(bridge.avatar.photo, 'set').mockImplementation(async (s) => void calls.push(`photo ${JSON.stringify(s)}`));
  const r = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PhotoMode avatar offline={false} toast={vi.fn()} />
    </QueryClientProvider>,
  );
  const grid = await screen.findByRole('radiogroup', { name: '滤镜' });
  await waitFor(() => expect(within(grid).getAllByRole('radio')).toHaveLength(16));
  return { calls, photo, grid, unmount: r.unmount };
}

describe('PhotoMode', () => {
  it('draws the 16 filters of rnd.filter in schema order, 无 first, numbered on a drawn hatch rather than game art', async () => {
    const v = await view({ photo: true, capture: true });
    const cells = within(v.grid).getAllByRole('radio');
    expect(cells.map((c) => c.getAttribute('aria-label'))).toEqual(NAMES);
    expect(cells[0]!.getAttribute('aria-checked')).toBe('true');
    expect(cells.map((c) => c.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(['', 'SP·01', 'SP·02', 'SP·03', 'SP·04', 'SP·05', 'SP·06', 'SP·07', 'F·01', 'F·02', 'F·03', 'F·04', 'F·05', 'F·06', 'F·07', 'F·08']);
    expect(v.grid.querySelector('img')).toBeNull();
    expect(screen.queryByText('调整照片色彩的滤镜')).toBeNull();
    expect(screen.queryByText('只复刻调色部分')).toBeNull();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells[4]);
  });

  it('saves rnd.filter when a filter is picked', async () => {
    const save = vi.spyOn(getBridge().settings, 'save');
    const v = await view({ photo: true, capture: true });
    fireEvent.click(within(v.grid).getByRole('radio', { name: '黑金' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ 'rnd.filter': 'sp_filter_1' }));
    await waitFor(() => expect(within(v.grid).getByRole('radio', { name: '黑金' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('只复刻调色部分')).toBeTruthy();
  });

  it('sends a pick back to the saved filter while the save of another is still out', async () => {
    const real = getBridge().settings.save.bind(getBridge().settings);
    let answer!: () => void;
    const save = vi.spyOn(getBridge().settings, 'save').mockImplementationOnce((v) => new Promise((r) => (answer = () => void real(v).then(r))));
    const v = await view({ photo: true, capture: true });
    const cells = within(v.grid).getAllByRole('radio');
    const saved = cells.find((c) => c.getAttribute('aria-checked') === 'true')!;
    fireEvent.click(cells.find((c) => c !== saved)!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(saved);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    answer();
    await waitFor(() => expect(saved.getAttribute('aria-checked')).toBe('true'));
  });

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
