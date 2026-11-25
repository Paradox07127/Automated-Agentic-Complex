// Leaving 设置 with changes not yet in effect asks to restart the backend; 不重启 puts them back.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { PLUGINS } from '../../src/bridge/plugins.generated';
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
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });
  const chat = createRoute({ getParentRoute: () => root, path: '/chat', component: () => <p>对话页</p> });
  const router = createRouter({ routeTree: root.addChildren([settings, chat]), history: createMemoryHistory({ initialEntries: ['/settings?still=1&group=perm'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // Plug-ins still take a backend restart; every one is on here (pluginsOn), once config.json is read.
  const plugin = await screen.findByRole('switch', { name: '外部智能体接入' });
  await waitFor(() => expect(plugin.getAttribute('aria-checked')).toBe('true'));
  await act(async () => fireEvent.click(plugin));
  return { bridge, router, leave: () => act(async () => void router.navigate({ to: '/chat' })) };
}

const dialog = () => screen.queryByRole('dialog');

describe('leaving 设置 with a change that waits for a backend restart', () => {
  it('asks, and 重启后台 restarts it and goes on', async () => {
    const m = await mount();
    const restart = vi.spyOn(m.bridge.supervisor, 'restart');
    await m.leave();
    expect(dialog()?.textContent).toContain('外部智能体接入');
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
    expect(save).toHaveBeenLastCalledWith({ 'plugins.external_access': true });
    expect(restart).not.toHaveBeenCalled();
    await screen.findByText('对话页');
    await act(async () => void m.router.navigate({ to: '/settings', search: { still: '1', group: 'perm' } as never }));
    await m.leave();
    expect(dialog()).toBeNull();
  });

  it('Escape, the backdrop and 留在设置 stay with the change kept; only 不重启 puts it back', async () => {
    const m = await mount();
    const save = vi.spyOn(m.bridge.settings, 'save');
    const ways: Array<[string, () => void]> = [
      ['Escape', () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })],
      ['backdrop', () => fireEvent.mouseDown(document.querySelector('[data-stub="Dialog"]')!)],
      ['留在设置', () => fireEvent.click(within(dialog()!).getByRole('button', { name: /留在设置/ }))],
    ];
    for (const [way, stay] of ways) {
      await m.leave();
      expect(dialog(), way).not.toBeNull();
      await act(async () => stay());
      expect(dialog(), way).toBeNull();
      expect(m.router.state.location.pathname, way).toBe('/settings');
      expect(screen.getByRole('switch', { name: '外部智能体接入' }).getAttribute('aria-checked'), way).toBe('false');
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('does not ask once the value is back where the backend runs', async () => {
    const m = await mount();
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '外部智能体接入' })));
    await m.leave();
    expect(dialog()).toBeNull();
    await screen.findByText('对话页');
  });
});

describe('leaving 设置 with a kernel picked that its plug-in turned away', () => {
  it('applies the pick with the plug-in and restarts the backend for it', async () => {
    pluginsOn(...PLUGINS.map((p) => p.id).filter((id) => id !== 'harness_bridge'));
    await pluginsSaved();
    const bridge = getBridge();
    const real = bridge.agentd.request.bind(bridge.agentd);
    vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
      const res = await real(method, path, body);
      if (method !== 'GET' || path !== '/character/runtime') return res as never;
      const off = (id: string, title: string) => ({ id, title, available: false, reason: 'plugin_off' });
      return { ...res, body: { ...(res.body as object), backend: 'pi', available_backends: [{ id: 'pi', title: 'Pi', available: true, reason: null }, off('codex', 'Codex')] } } as never;
    });
    const save = vi.spyOn(bridge.settings, 'save');
    const restart = vi.spyOn(bridge.supervisor, 'restart');
    const root = createRootRoute({ component: Outlet });
    const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage });
    const chat = createRoute({ getParentRoute: () => root, path: '/chat', component: () => <p>对话页</p> });
    const router = createRouter({ routeTree: root.addChildren([settings, chat]), history: createMemoryHistory({ initialEntries: ['/settings?still=1&group=kernel'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const codex = await screen.findByRole('radio', { name: 'Codex' });
    await act(async () => fireEvent.click(codex.closest('tr')!));
    await act(async () => void router.navigate({ to: '/chat' }));
    const confirm = within(dialog()!).getAllByRole('button').find((b) => b.textContent === '重启后台' || b.textContent === '应用')!;
    await act(async () => fireEvent.click(confirm));
    expect(save).toHaveBeenLastCalledWith({ 'plugins.harness_bridge': true });
    expect(restart).toHaveBeenCalledWith('agentd');
    await screen.findByText('对话页');
  });
});
