// 角色页「设定」: its own game tab bar when standalone, the panel's bar on the character page; desktop-only sections say so; a failed mid-drag save stays on its row.
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
  await screen.findByRole('navigation', { name: '角色分区' });
}

describe('CharacterSettings', () => {
  it('lists the pages that have rows in its tab bar and draws the render sections, the preview-following ones first', async () => {
    setDevMode(true);
    view('render');
    const menu = await screen.findByRole('tablist', { name: '设定' });
    expect(within(menu).getByRole('tab', { name: '行为' })).toBeTruthy();
    expect(within(menu).getByRole('tab', { name: '画面' }).getAttribute('aria-selected')).toBe('true');
    expect(within(menu).getByRole('tab', { name: '场景' })).toBeTruthy();
    const secs = screen.getAllByRole('region').map((r) => [r.getAttribute('aria-label'), within(r).queryByText('仅桌面') !== null]);
    expect(secs).toEqual([
      ['主光与轮廓', false],
      ['落地与景深', false],
      ['环境光', true],
      ['镜头', true],
      ['性能', true],
    ]);
    expect(screen.getAllByText('原作镜头预设').length).toBeGreaterThan(0);
    expect(screen.queryByText('镜头、帧率、环境光和光线包裹只作用在桌面上的她，预览不跟随')).toBeNull();
  });

  it('counts the changed rows of the page, dots the tabs with changes, and puts the page back with 恢复原作', async () => {
    setDevMode(false);
    const save = vi.spyOn(getBridge().settings, 'save');
    try {
      view('render');
      const bar = await screen.findByRole('tablist', { name: '设定' });
      const pad = screen.getByRole('radiogroup', { name: '主光方向' });
      fireEvent.click(within(pad).getByRole('radio', { name: '原作，抬高 10°' }));
      await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.lightYaw': '0', 'rnd.lightPitch': '10' }));
      fireEvent.click(within(screen.getByRole('radiogroup', { name: '景深' })).getByRole('radio', { name: '近景时' }));
      await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.dof': 'closeup' }));
      await waitFor(() => expect(screen.getByText('已改').parentElement?.textContent).toContain('已改2/ 18 项'));
      expect(within(bar).getByRole('tab', { name: '画面' }).getAttribute('aria-describedby')).not.toBeNull();
      expect(within(bar).getByRole('tab', { name: '行为' }).getAttribute('aria-describedby')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '恢复原作' }));
      await waitFor(() => expect(save).toHaveBeenLastCalledWith({ 'rnd.lightPitch': '0', 'rnd.dof': 'off' }));
      await waitFor(() => expect(screen.getByText('已改').parentElement?.textContent).toContain('已改0/ 18 项'));
    } finally {
      save.mockRestore();
    }
  });

  it('draws the behavior rows and asks for another page through onTab', async () => {
    const onTab = view('behavior');
    const menu = await screen.findByRole('tablist', { name: '设定' });
    expect(screen.getAllByText('坐在窗口顶上').length).toBeGreaterThan(0);
    fireEvent.click(within(menu).getByRole('tab', { name: '画面' }));
    expect(onTab).toHaveBeenCalledWith('render');
  });

  it('leaves the 调参 › 画面 rows to the tune page, in developer mode too', async () => {
    setDevMode(true);
    view('render');
    await screen.findByRole('tablist', { name: '设定' });
    for (const label of ['2× SSAA', '渲染尺寸', '自阴影精度']) expect(screen.queryAllByText(label)).toHaveLength(0);
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

  it('writes a save that fails mid-drag on its row, and clears it once a save of the row goes through', async () => {
    const toast = vi.fn();
    view('render', vi.fn(), toast);
    const yaw = await screen.findByRole('slider', { name: '水平朝向' });
    const row = document.getElementById('set-rnd.yaw')!;
    const save = vi.spyOn(getBridge().settings, 'save').mockRejectedValue(new Error('down'));
    fireEvent.pointerDown(yaw);
    fireEvent.change(yaw, { target: { value: '10' } });
    expect(await within(row).findByText('没有保存「水平朝向」：原生设置服务没有响应')).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
    save.mockRestore();
    fireEvent.pointerUp(window);
    await waitFor(() => expect(within(row).queryByText('没有保存「水平朝向」：原生设置服务没有响应')).toBeNull());
    expect(toast).toHaveBeenCalledWith('已保存 │ 立即生效');
  });
});

describe('角色 page 设定 view', () => {
  it('/character?tab=render names the 设定 pages in the panel tab bar, without its own menu', async () => {
    await character('&tab=render');
    const bar = await screen.findByRole('tablist', { name: '角色页签' });
    expect(within(bar).getAllByRole('tab').map((t) => t.getAttribute('data-tab'))).toEqual(['behavior', 'render', 'scene']);
    expect(within(bar).getByRole('tab', { name: '画面' }).getAttribute('aria-selected')).toBe('true');
    await screen.findByRole('slider', { name: '水平朝向' });
    expect(screen.queryByRole('tablist', { name: '设定' })).toBeNull();
    expect(document.querySelector('[data-character-preview]')).not.toBeNull();
  });

  it('/character has no 设定 menu', async () => {
    await character('');
    expect(screen.queryByRole('tablist', { name: '设定' })).toBeNull();
  });
});
