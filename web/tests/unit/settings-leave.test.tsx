// Leaving 设置 with changes not yet in effect asks to restart the backend; 不重启 puts them back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { SettingsPage } from '../../src/pages/settings/Page';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

beforeEach(() => {
  pluginsOn();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  pluginsReset();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

async function mount() {
  await pluginsSaved();
  const bridge = getBridge();
  // The fake bridge's config.json outlives a test.
  await bridge.settings.save({ mute: false });
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });
  const chat = createRoute({ getParentRoute: () => root, path: '/chat', component: () => <p>对话页</p> });
  const router = createRouter({ routeTree: root.addChildren([settings, chat]), history: createMemoryHistory({ initialEntries: ['/settings?still=1&group=speak'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const mute = within(await screen.findByRole('radiogroup', { name: '出声' }));
  await act(async () => fireEvent.click(mute.getByRole('radio', { name: '只显示文字' })));
  return { bridge, router, leave: () => act(async () => void router.navigate({ to: '/chat' })) };
}

const dialog = () => screen.queryByRole('dialog');

describe('leaving 设置 with a change that waits for a backend restart', () => {
  it('asks, and 重启后台 restarts it and goes on', async () => {
    const m = await mount();
    const restart = vi.spyOn(m.bridge.supervisor, 'restart');
    await m.leave();
    expect(dialog()?.textContent).toContain('出声');
    expect(m.router.state.location.pathname).toBe('/settings');
    await act(async () => fireEvent.click(within(dialog()!).getByRole('button', { name: '重启后台' })));
    expect(restart).toHaveBeenCalledWith('agentd');
    await screen.findByText('对话页');
  });

  it('不重启 saves the value the backend runs with back, and goes on', async () => {
    const m = await mount();
    const save = vi.spyOn(m.bridge.settings, 'save');
    const restart = vi.spyOn(m.bridge.supervisor, 'restart');
    await m.leave();
    await act(async () => fireEvent.click(within(dialog()!).getByRole('button', { name: /不重启/ })));
    expect(save).toHaveBeenLastCalledWith({ mute: false });
    expect(restart).not.toHaveBeenCalled();
    await screen.findByText('对话页');
    await act(async () => void m.router.navigate({ to: '/settings', search: { still: '1', group: 'speak' } as never }));
    await m.leave();
    expect(dialog()).toBeNull();
  });

  it('does not ask once the value is back where the backend runs', async () => {
    const m = await mount();
    const mute = within(screen.getByRole('radiogroup', { name: '出声' }));
    await act(async () => fireEvent.click(mute.getByRole('radio', { name: '念出来' })));
    await m.leave();
    expect(dialog()).toBeNull();
    await screen.findByText('对话页');
  });
});
