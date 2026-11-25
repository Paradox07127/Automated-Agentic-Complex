// The 动作线 tab of 运行记录 on the demo stretch: a pick shows its causes and effects across lanes; lanes hide.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagPage } from '../../src/pages/diag/Page';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function mount(search: string) {
  const root = createRootRoute({ component: DiagPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${/tab=/.test(search) ? '' : '&tab=turns'}${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const lane = (name: string) => screen.getByRole('group', { name });

describe('运行记录 动作线', () => {
  it('draws the lanes in order and highlights a refusal’s cause and effects', async () => {
    mount('&tab=lanes');
    const board = await screen.findByRole('region', { name: '事件线' });
    expect([...board.querySelectorAll('[role="group"][aria-label]')].map((g) => g.getAttribute('aria-label'))).toEqual(['粗判', '指针', '注意力', '触碰', '舞台', '决定', '渲染器', '语音']);
    const hover = within(lane('指针')).getByRole('button', { name: /hover → true$/ });
    fireEvent.click(hover);
    expect(hover.getAttribute('aria-pressed')).toBe('true');
    const refused = within(lane('决定')).getByRole('button', { name: /拒绝 user\.hover │ stage$/ });
    expect(refused.getAttribute('data-rel')).toBe('effect');
    const detail = screen.getByRole('region', { name: '所选事件' });
    expect(within(within(detail).getByRole('list', { name: '引起' })).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(detail).getByRole('button', { name: /拒绝 user\.hover/ }));
    expect(refused.getAttribute('aria-pressed')).toBe('true');
    expect(hover.getAttribute('data-rel')).toBe('cause');
    expect(within(detail).getByRole('list', { name: '起因' }).textContent).toContain('hover → true');
  });

  it('hides a lane from the menu and clears the pick on Escape', async () => {
    mount('&tab=lanes');
    const board = await screen.findByRole('region', { name: '事件线' });
    fireEvent.click(screen.getByRole('button', { name: '筛选事件线' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '语音' }));
    expect(screen.queryByRole('group', { name: '语音' })).toBeNull();
    fireEvent.mouseDown(document.body);
    const mark = within(lane('渲染器')).getAllByRole('button')[0]!;
    fireEvent.click(mark);
    fireEvent.keyDown(mark, { key: 'ArrowRight' });
    expect(mark.getAttribute('aria-pressed')).toBe('false');
    expect(board.querySelector('[data-id][aria-pressed="true"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(board.querySelector('[data-id][aria-pressed="true"]')).toBeNull();
  });
});
