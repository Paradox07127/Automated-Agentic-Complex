// A page or stack that throws shows a one-line Chinese error (sidebar kept), logs through console.error, and recovers on 重试.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { createAppRouter } from '../../src/shell/router';
import type { PageRoute } from '../../src/shell/types';
import { StackErrorBoundary } from '../../src/surfaces/stack/StackErrorBoundary';
import { stubMatchMedia } from './mediaStub';

const boom = vi.hoisted(() => ({ fail: true }));

vi.mock('../../src/shell/registry', async (original) => {
  const real = await original<typeof import('../../src/shell/registry')>();
  const route: PageRoute = {
    id: 'boom',
    path: '/boom',
    title: '试炸',
    en: 'boom',
    order: 999,
    group: 'secondary',
    component: () => {
      if (boom.fail) throw new Error('kaboom in page');
      return <p>页面恢复了</p>;
    },
    demos: [],
  };
  const pageRoutes = [...real.pageRoutes, route];
  return { ...real, pageRoutes, findRoute: (p: string) => pageRoutes.find((r) => r.path === p) };
});

beforeEach(() => {
  boom.fail = true;
  stubMatchMedia();
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('page error', () => {
  it('shows the Chinese error inside the content area, keeps the sidebar, logs the path and recovers on 重试', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.location.hash = '#/boom';
    const router = createAppRouter();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('这一页出错了，已记到日志')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy();
    expect(screen.queryByText('Something went wrong!')).toBeNull();
    const main = document.querySelector('main') as HTMLElement;
    expect(main.textContent).toContain('这一页出错了');
    // The English message is only inside a closed fold.
    const fold = main.querySelector('details');
    expect(fold?.open).toBe(false);
    expect(fold?.textContent).toContain('kaboom in page');
    expect(screen.getByRole('button', { name: '复制错误' })).toBeTruthy();
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('/boom');
    expect(logged).toContain('kaboom in page');

    boom.fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('页面恢复了')).toBeTruthy();
    expect(screen.queryByText('这一页出错了，已记到日志')).toBeNull();
  });
});

describe('stack error', () => {
  it('folds to one Chinese line with 重试 and no English', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { fail: true };
    function Card() {
      if (state.fail) throw new Error('kaboom in stack');
      return <p>浮窗恢复了</p>;
    }
    const { container } = render(
      <StackErrorBoundary>
        <Card />
      </StackErrorBoundary>,
    );
    expect(screen.getByText('浮窗出错，已记到日志')).toBeTruthy();
    expect(container.textContent).not.toMatch(/kaboom/);
    expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('kaboom in stack');
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('浮窗恢复了')).toBeTruthy();
  });
});
