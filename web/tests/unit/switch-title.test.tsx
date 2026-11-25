// 雷霆大字: the title page (`stack.html#/title`) shows the name from its URL with the English name under it or no line, and
// 设置 › 显示 has its switch, which saves `switchTitle`. Its timeline is in tests/e2e/switch-title.spec.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { SettingsPage } from '../../src/pages/settings/Page';
import { TitleRoot } from '../../src/surfaces/desktop/TitleRoot';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('the title page', () => {
  it('shows her name with her English name under it', () => {
    window.location.hash = `#/title?${new URLSearchParams({ name: '佩丽卡', en: 'Perlica' }).toString()}`;
    render(<TitleRoot />);
    const root = document.querySelector('[data-surface-root="title"]')!;
    expect(root.querySelector('[data-slot="name"]')?.textContent).toBe('佩丽卡');
    expect(root.querySelector('[data-slot="sub"]')?.textContent).toBe('Perlica');
    expect(root.querySelector('[data-slot="shadow"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves the subtitle line out without an English name', () => {
    window.location.hash = '#/title?name=%E7%AE%A1%E7%90%86%E5%91%98';
    render(<TitleRoot />);
    expect(document.querySelector('[data-slot="name"]')?.textContent).toBe('管理员');
    expect(document.querySelector('[data-slot="sub"]')).toBeNull();
  });
});

describe('切换角色时的雷霆大字', () => {
  beforeEach(() => {
    pluginsOn();
    window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  });
  afterEach(() => {
    pluginsReset();
    delete window.agenticComplex;
  });

  it('is a switch in 设置 › 显示, on by default, that saves switchTitle', async () => {
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    await pluginsSaved();
    const router = createRouter({ routeTree: createRootRoute({ component: SettingsPage }), history: createMemoryHistory({ initialEntries: ['/?still=1&group=display'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: '切换角色时显示标题动画' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await act(async () => void fireEvent.click(toggle));
    expect(save).toHaveBeenCalledWith({ switchTitle: false });
  });
});
