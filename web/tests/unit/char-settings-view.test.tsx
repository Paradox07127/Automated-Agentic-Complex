// 角色页「设定」: the vertical menu beside the stage, and the old 行为与画面 tabs landing on it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { CharacterSettings } from '../../src/pages/character/CharacterSettings';
import { CharacterPage } from '../../src/pages/character/Page';
import type { CharTab } from '../../src/pages/character/sections';
import { setDevMode } from '../../src/shell/devMode';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '';
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function view(tab: CharTab, onTab = vi.fn(), toast = vi.fn()) {
  render(
    <QueryClientProvider client={client()}>
      <CharacterSettings tab={tab} offline={false} avatar={false} onTab={onTab} toast={toast} />
    </QueryClientProvider>,
  );
  return onTab;
}

function mountAt(component: RouteComponent, search = '') {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function character(search: string) {
  window.location.hash = `#/character?still=1${search}`;
  mountAt(CharacterPage, search);
  await screen.findByRole('button', { name: /^切换角色/ });
}

describe('CharacterSettings', () => {
  it('lists the pages that have rows in a vertical menu and draws the render rows with the preview note', async () => {
    setDevMode(true);
    view('render');
    const menu = await screen.findByRole('tablist', { name: '设定' });
    expect(menu.getAttribute('aria-orientation')).toBe('vertical');
    expect(within(menu).getByRole('tab', { name: '行为' })).toBeTruthy();
    expect(within(menu).getByRole('tab', { name: '画面' }).getAttribute('aria-selected')).toBe('true');
    expect(within(menu).getByRole('tab', { name: '场景' })).toBeTruthy();
    expect(screen.getAllByText('原作镜头预设').length).toBeGreaterThan(0);
    expect(screen.getByText('画面设置作用在桌面上的她；左边的预览台暂不跟随')).toBeTruthy();
  });

  it('draws the behavior rows and asks for another page through onTab', async () => {
    const onTab = view('behavior');
    const menu = await screen.findByRole('tablist', { name: '设定' });
    expect(screen.getAllByText('坐在窗口顶上').length).toBeGreaterThan(0);
    fireEvent.click(within(menu).getByRole('tab', { name: '行为' }));
    expect(onTab).toHaveBeenCalledWith('behavior');
  });

  it('shows the performance details only in developer mode', async () => {
    setDevMode(false);
    view('render');
    await screen.findByRole('tablist', { name: '设定' });
    expect(screen.queryAllByText('2× SSAA')).toHaveLength(0);
    act(() => setDevMode(true));
    expect(screen.getAllByText('2× SSAA').length).toBeGreaterThan(0);
  });

  it('saves a dragged slider without toasts and toasts once for the value it is released at', async () => {
    const toast = vi.fn();
    view('render', vi.fn(), toast);
    const yaw = await screen.findByRole('slider', { name: '水平朝向' });
    const save = vi.spyOn(getBridge().settings, 'save');
    const drag = async (values: string[]) => {
      fireEvent.pointerDown(yaw);
      for (const v of values) fireEvent.change(yaw, { target: { value: v } });
      await new Promise((r) => setTimeout(r, 60));
      fireEvent.pointerUp(window);
    };
    try {
      await drag(['10', '20', '30.5']);
      expect(save.mock.calls.length).toBeGreaterThan(1);
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenLastCalledWith({ 'rnd.yaw': 30.5 });
      expect(toast.mock.calls[0]![0]).toBe('已保存 │ 立即生效');
      save.mockRejectedValue(new Error('down'));
      await drag(['40', '50']);
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
      expect(save).toHaveBeenLastCalledWith({ 'rnd.yaw': 50 });
      expect(toast.mock.calls[1]![0]).toBe('没有保存「水平朝向」：原生设置服务没有响应');
      await new Promise((r) => setTimeout(r, 60));
      expect(toast).toHaveBeenCalledTimes(2);
    } finally {
      save.mockRestore();
    }
  });
});

describe('角色 page 设定 view', () => {
  it('/character?tab=render puts the 设定 menu beside the stage', async () => {
    await character('&tab=render');
    expect(await screen.findByRole('tablist', { name: '设定' })).toBeTruthy();
    expect(document.querySelector('[data-character-preview]')).not.toBeNull();
  });

  it('/character has no 设定 menu', async () => {
    await character('');
    expect(screen.queryByRole('tablist', { name: '设定' })).toBeNull();
  });
});
