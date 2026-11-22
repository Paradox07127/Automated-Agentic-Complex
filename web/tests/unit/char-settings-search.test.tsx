// Settings search over 角色 › 设定 rows: a result lands on its own tab and row; developer-only rows stay out of a normal search.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsPage } from '../../src/pages/settings/Page';
import { setDevMode } from '../../src/shell/devMode';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mount() {
  const root = createRootRoute({ component: SettingsPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&group=about'] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function search(q: string) {
  mount();
  fireEvent.change(await screen.findByRole('textbox', { name: '搜索设置' }), { target: { value: q } });
}

function hashQuery(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '';
});

describe('settings search · 角色 rows', () => {
  it('opens 描边 on the 画面 tab at its row', async () => {
    await search('描边');
    fireEvent.click(await screen.findByRole('button', { name: /角色边界/ }));
    expect(window.location.hash.startsWith('#/character?')).toBe(true);
    expect(hashQuery().get('tab')).toBe('render');
    expect(hashQuery().get('row')).toBe('rnd.outline');
  });

  it('opens 滤镜 in the 拍照 panel, which is where the filter grid is', async () => {
    await search('滤镜');
    fireEvent.click(await screen.findByRole('button', { name: /滤镜/ }));
    expect(window.location.hash.startsWith('#/character?')).toBe(true);
    expect(hashQuery().get('view')).toBe('photo');
    expect(hashQuery().get('tab')).toBeNull();
  });

  it('lists 抗锯齿 only in developer mode', async () => {
    setDevMode(false);
    await search('抗锯齿');
    expect(await screen.findByText(/^没有找到「抗锯齿」，/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /2× SSAA/ })).toBeNull();
    cleanup();
    setDevMode(true);
    await search('抗锯齿');
    expect(await screen.findByRole('button', { name: /2× SSAA/ })).toBeTruthy();
  });

  it('updates open results when developer mode turns on', async () => {
    setDevMode(false);
    await search('抗锯齿');
    expect(await screen.findByText(/^没有找到「抗锯齿」，/)).toBeTruthy();
    act(() => setDevMode(true));
    expect(await screen.findByRole('button', { name: /2× SSAA/ })).toBeTruthy();
  });
});

describe('settings search · Pi-only rows', () => {
  it('leaves 执行命令 and 单次费用上限 out while the kernel is not Pi', async () => {
    await search('执行命令');
    expect(await screen.findByText(/^没有找到「执行命令」，/)).toBeTruthy();
    cleanup();
    await search('费用上限');
    expect(await screen.findByText(/^没有找到「费用上限」，/)).toBeTruthy();
  });
});
