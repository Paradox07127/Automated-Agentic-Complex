// 角色页「设定」: while it is open she walks clear of the main window (avatar.keepClearOfMain).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { CharacterSettings } from '../../src/pages/character/CharacterSettings';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function view(avatar: boolean) {
  const keep = vi.spyOn(getBridge().avatar, 'keepClearOfMain');
  const r = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CharacterSettings tab="render" avatar={avatar} offline={false} onRestart={vi.fn()} onTab={vi.fn()} toast={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.findByRole('tablist', { name: '设定' });
  // The fake bridge holds the last value it was sent; false until the page asks.
  return { on: () => keep.mock.lastCall?.[0] ?? false, unmount: r.unmount, keep };
}

describe('CharacterSettings keeps her clear of the main window', () => {
  it('turns it on while mounted and off once unmounted', async () => {
    const v = await view(true);
    expect(v.on()).toBe(true);
    v.unmount();
    expect(v.on()).toBe(false);
  });

  it('never asks without an avatar host', async () => {
    const v = await view(false);
    expect(v.on()).toBe(false);
    v.unmount();
    expect(v.keep).not.toHaveBeenCalledWith(true);
  });
});
