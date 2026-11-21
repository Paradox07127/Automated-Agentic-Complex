// interaction-15: the four touch switches on the 调参 page's 行为 capabilities, only 捏脸 off by default, saved by their beh.* id.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { TunePage } from '../../src/pages/tune/Page';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

async function tune() {
  const root = createRootRoute({ component: TunePage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
}

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('touch switches (beh.touch / beh.pat / beh.pinch / beh.greet)', () => {
  it('shows all four, only 捏脸 off by default, and saves beh.pat by its id', async () => {
    const save = vi.spyOn(bridge.settings, 'save').mockResolvedValue({ restart: 'none', notApplied: [] });
    await tune();
    for (const [name, on] of [['点不同部位有不同反应', 'true'], ['摸头', 'true'], ['捏脸（按住脸颊拖动）', 'false'], ['锁屏或睡眠回来时迎接', 'true']]) {
      expect((await screen.findByRole('switch', { name })).getAttribute('aria-checked'), name).toBe(on);
    }
    await act(async () => void fireEvent.click(screen.getByRole('switch', { name: '摸头' })));
    expect(save).toHaveBeenLastCalledWith({ 'beh.pat': false });
  });
});
