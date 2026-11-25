// 设置 › 显示 › 外观: theme, window ground, frost, motion and size as the first section; 窗口背景 locked where the system has
// no glass; 恢复默认 takes them back too.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { SettingsPage } from '../../src/pages/settings/Page';
import { searchSettings } from '../../src/pages/settings/registry';
import { pluginsOn, pluginsReset, pluginsSaved } from './plugins';

beforeEach(() => {
  pluginsOn();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  pluginsReset();
  delete window.agenticComplex;
  window.location.hash = '';
});

async function mount(search: string) {
  await pluginsSaved();
  const router = createRouter({ routeTree: createRootRoute({ component: SettingsPage }), history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const options = (name: string) => within(screen.getByRole('radiogroup', { name })).getAllByRole('radio').map((r) => r.textContent);

describe('设置 › 显示 › 外观', () => {
  it('is the first section of 显示, with its five rows in order and their choices', async () => {
    await mount('&group=display');
    const sec = await screen.findByRole('region', { name: '外观' });
    expect(document.querySelector('section[aria-label]')).toBe(sec);
    expect([...sec.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))).toEqual(['appTheme', 'winBg', 'glassAlpha', 'reduceMotion', 'uiZoom']);
    expect(options('界面主题')).toEqual(['跟随系统', '浅色', '深色']);
    expect(options('窗口背景')).toEqual(['磨砂', '不透明']);
    expect(options('磨砂强度')).toEqual(['轻度', '适中', '较强']);
    expect(options('减弱动态效果')).toEqual(['跟随系统', '开启']);
    expect(options('界面缩放')).toEqual(['90 %', '100 %', '110 %', '125 %']);
  });

  it('saves a choice at once, and 磨砂强度 is off while the window is opaque', async () => {
    await mount('&group=display');
    await screen.findByRole('region', { name: '外观' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    expect(screen.getByRole('radiogroup', { name: '磨砂强度' }).getAttribute('aria-disabled')).toBeNull();
    await act(async () => fireEvent.click(within(row('winBg')).getByRole('radio', { name: '不透明' })));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ winBg: 'opaque' }));
    expect(screen.getByRole('radiogroup', { name: '磨砂强度' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => fireEvent.click(within(row('uiZoom')).getByRole('radio', { name: '125 %' })));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ uiZoom: '125' }));
  });

  it('where the system draws no glass, 窗口背景 offers only 不透明, locked, with the shell\'s reason', async () => {
    const settings = window.agenticComplex!.settings;
    const read = settings.read.bind(settings);
    vi.spyOn(settings, 'read').mockImplementation(async () => {
      const snap = await read();
      return { saved: { ...snap.saved, winBg: 'opaque' }, statuses: { ...snap.statuses, winBg: '要 Windows 11 22H2 或更新才有磨砂' } };
    });
    await mount('&group=display');
    await screen.findByRole('region', { name: '外观' });
    await waitFor(() => expect(row('winBg').textContent).toContain('要 Windows 11 22H2 或更新才有磨砂'));
    expect(options('窗口背景')).toEqual(['不透明']);
    expect(row('winBg').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: '磨砂强度' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('is found by search', () => {
    expect(searchSettings('磨砂').map((r) => r.id)).toEqual(expect.arrayContaining(['winBg', 'glassAlpha']));
    expect(searchSettings('深色').map((r) => r.id)).toContain('appTheme');
    expect(searchSettings('动画').map((r) => r.id)).toContain('reduceMotion');
    expect(searchSettings('缩放').map((r) => r.id)).toContain('uiZoom');
  });

  it('goes back to its defaults with 恢复默认设置', async () => {
    await mount('&group=display');
    await screen.findByRole('region', { name: '外观' });
    const save = vi.spyOn(window.agenticComplex!.settings, 'save');
    await act(async () => fireEvent.click(within(row('uiZoom')).getByRole('radio', { name: '125 %' })));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ uiZoom: '125' }));
    cleanup();
    await mount('&group=data');
    await screen.findByRole('button', { name: /恢复默认…/ });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /恢复默认…/ })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: '恢复默认' })));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ uiZoom: '100' })));
  });
});
