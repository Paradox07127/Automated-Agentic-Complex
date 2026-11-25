// A character's own memory: `owner` on the domain fact, `GET /memory?owner=` in the fake bridge, and the page reading it from its address.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { fromFact } from '../../src/domain/adapt';
import { NOW, WIRE_FACTS } from '../../src/mock/fixtures';
import { v31Id } from '../../src/mock/memory-v31';
import { MemoryPage } from '../../src/pages/memory/Page';
import { HeaderSlotContext } from '../../src/shell/headerSlot';
import { ToastHost } from '../../src/shell/toast';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  pluginsOn();
  Element.prototype.scrollIntoView = vi.fn();
  delete window.agenticComplex;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pluginsReset();
  window.location.hash = '';
});

interface Read {
  facts: Array<{ fact_id: string; owner: string | null; source: string }>;
  counts: Record<string, number>;
}
const read = async (query: string) => {
  window.location.hash = '#/memory?view=about';
  return (await getBridge().agentd.request('GET', `/memory${query}`)).body as Read;
};

describe('memory owner › domain', () => {
  it('keeps the owner of a fact, null for a shared one', () => {
    const shared = WIRE_FACTS[0]!;
    expect(fromFact(shared, NOW).owner).toBeNull();
    expect(fromFact({ ...shared, owner: 'si' }, NOW).owner).toBe('si');
  });
});

describe('memory owner › fake bridge', () => {
  it('answers ?owner= with only her private facts and counts them', async () => {
    const all = await read('');
    const mine = await read('?owner=si');
    expect(mine.facts.length).toBeGreaterThan(0);
    expect(mine.facts.every((f) => f.owner === 'si')).toBe(true);
    expect(all.facts.length).toBeGreaterThan(mine.facts.length);
    for (const source of Object.keys(mine.counts)) expect(mine.counts[source]).toBe(mine.facts.filter((f) => f.source === source).length);
  });

  it('answers another character with nothing and ?owner=shared with the shared facts', async () => {
    const other = await read('?owner=voice_a');
    expect([other.facts, Object.values(other.counts).reduce((a, b) => a + b, 0)]).toEqual([[], 0]);
    const shared = await read('?owner=shared');
    expect(shared.facts.length).toBeGreaterThan(0);
    expect(shared.facts.every((f) => f.owner === null)).toBe(true);
  });
});

describe('memory owner › page', () => {
  function mount(at: string, setSub = vi.fn()) {
    window.location.hash = `#/memory${at}`;
    const root = createRootRoute({ component: () => <MemoryPage /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/${at}`] }) });
    render(
      <HeaderSlotContext.Provider value={{ setSub, right: null, action: null }}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </HeaderSlotContext.Provider>,
    );
    return setSub;
  }
  const reads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([m, p]) => m === 'GET' && /^\/memory(\?|$)/.test(String(p))).map(([, p]) => p);

  it('reads only her memory and names her in the header when the address carries an owner', async () => {
    const bridge = getBridge();
    const spy = vi.spyOn(bridge.agentd, 'request');
    const setSub = mount('?still=1&view=about&owner=si');
    await waitFor(() => expect(document.querySelectorAll('[data-fact]').length).toBeGreaterThan(0));
    expect([...document.querySelectorAll('[data-fact]')].map((r) => r.getAttribute('data-fact')).sort()).toEqual([v31Id('o1'), v31Id('o2')]);
    expect(reads(spy)).toEqual(['/memory?owner=si']);
    await waitFor(() => expect(setSub).toHaveBeenLastCalledWith('示例乙'));
  });

  it('reads the whole memory without an owner', async () => {
    const spy = vi.spyOn(getBridge().agentd, 'request');
    const setSub = mount('?still=1&view=about');
    await screen.findByText('小林');
    expect(reads(spy)).toEqual(['/memory']);
    expect(setSub).not.toHaveBeenCalledWith(expect.stringContaining('示例'));
  });

  it('导出 in her archive exports only her facts, and without an owner the whole memory', async () => {
    const spy = vi.spyOn(getBridge().files, 'saveAgentdExport').mockResolvedValue(true);
    for (const [at, path, label] of [['?still=1&view=about&owner=si', '/memory/export?owner=si', '导出 示例乙 的记忆'],
      ['?still=1&view=about', '/memory/export', '导出全部记忆']] as const) {
      window.location.hash = `#/memory${at}`;
      const root = createRootRoute({ component: () => <MemoryPage /> });
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/${at}`] }) })} />
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: /^管理/ }));
      fireEvent.click(await screen.findByRole('menuitem', { name: label })); // the name carries a reason while it is off
      await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ path, suggestedName: '记忆.json' }));
      cleanup();
    }
  });

  it('清空记忆 in her archive counts and deletes only her facts, and the toast claims nothing about the rest', async () => {
    const spy = vi.spyOn(getBridge().agentd, 'request');
    window.location.hash = '#/memory?still=1&view=about&owner=si';
    const root = createRootRoute({
      component: () => (
        <>
          <MemoryPage />
          <ToastHost />
        </>
      ),
    });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1&view=about&owner=si'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-fact]').length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: /^管理/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /清空记忆/ }));
    const ask = await screen.findByRole('alertdialog', { name: '清空「示例乙」的专属记忆？' });
    expect(ask.querySelector('b.num')?.textContent).toBe('2');
    fireEvent.change(within(ask).getByRole('textbox', { name: '输入删除确认' }), { target: { value: '删除' } });
    fireEvent.click(within(ask).getByRole('button', { name: '清空' }));
    await waitFor(() => expect(spy.mock.calls.filter(([m]) => m === 'DELETE').map(([, p]) => p)).toEqual(['/memory?scope=facts&owner=si']));
    await expect(spy.mock.results.find((_, i) => spy.mock.calls[i]?.[0] === 'DELETE')?.value).resolves.toMatchObject({ body: { facts_deleted: 2 } });
    expect(await screen.findByText('已清空 示例乙 的 2 条记忆')).toBeTruthy();
    expect(screen.queryByText(/称呼和生日保留/)).toBeNull();
    expect((await read('?owner=si')).facts).toEqual([]);
    expect((await read('?owner=shared')).facts.length).toBeGreaterThan(0);
  });
});
