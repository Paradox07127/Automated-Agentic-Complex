import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGate } from '../../src/pages/chat/Gate';
import { setPlugins } from '../../src/shell/plugins';
import { pluginsOn, pluginsReset } from './plugins';

// 和她对话 off: the page stays on screen, greyed and inert, under a 已关闭 board that leads to its switch.
// No model account: the input area says 未接入 and leads to the account row.

afterEach(() => {
  cleanup();
  pluginsReset();
  window.location.hash = '';
});

async function mountChat(search: string) {
  const root = createRootRoute({ component: ChatGate });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: '消息' });
}

const hashQuery = () => new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1));

describe('chat: 和她对话 off', () => {
  it('greys the whole page under a 已关闭 board whose button opens the switch', async () => {
    pluginsOn();
    setPlugins({ 'plugins.light_ai': false });
    const thread = await mountChat('');
    expect(thread.closest('[inert]')).not.toBeNull();
    const board = screen.getByRole('status', { name: /和她对话/ });
    expect(board.textContent).toContain('已关闭');
    fireEvent.click(within(board).getByRole('button', { name: /前往设置打开/ }));
    expect(window.location.hash.startsWith('#/settings?')).toBe(true);
    expect(hashQuery().get('group')).toBe('model');
    expect(hashQuery().get('item')).toBe('plugins.light_ai');
  });

  it('leaves the page alone while the switch is on', async () => {
    pluginsOn();
    const thread = await mountChat('');
    expect(thread.closest('[inert]')).toBeNull();
    expect(screen.queryByText('已关闭')).toBeNull();
  });

  it('shows the board on the ai-off demo', async () => {
    pluginsOn();
    await mountChat('&demo=ai-off');
    expect((await screen.findByRole('status', { name: /和她对话/ })).textContent).toContain('已关闭');
  });
});

describe('chat: no model account', () => {
  it('shows 未接入 over the input on the nomodel demo, leading to the account row', async () => {
    pluginsOn();
    const thread = await mountChat('&demo=nomodel');
    const strip = (await within(thread).findByText('没有可用的模型')).closest<HTMLElement>('[role="status"]')!;
    expect(strip.textContent).toContain('未接入');
    expect(thread.closest('[inert]')).toBeNull();
    fireEvent.click(within(strip).getByRole('button', { name: /前往设置连接/ }));
    expect(hashQuery().get('group')).toBe('model');
    expect(hashQuery().get('item')).toBe('svc');
  });
});
