// 导入进度条: character.importState/onImport drive one bar under the import buttons of 导入 and MMD; the fake pushes read … publish → reload.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, ImportState } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { MmdPage } from '../../src/pages/mmd/Page';
import { setNavRouter } from '../../src/shell/nav';
import { Progress } from '../../src/ui';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;
const IDLE: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };
const RUNNING: ImportState = { running: true, kind: 'motion', title: 'Dance', stage: 'retarget', fraction: 0.426 };

async function mount(search: string) {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: /^切换角色/ });
}

/** Captures every `character.onImport` callback; `push` reaches them all. */
function pushes() {
  const cbs = new Set<(s: ImportState) => void>();
  vi.spyOn(bridge.character, 'onImport').mockImplementation((cb) => {
    cbs.add(cb);
    return () => cbs.delete(cb);
  });
  return { push: (s: ImportState) => cbs.forEach((cb) => cb(s)) };
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

describe('Progress', () => {
  it('is a progressbar named by its stage with a whole percent', () => {
    render(<Progress label="校验" value={0.5049} />);
    const bar = screen.getByRole('progressbar', { name: '校验' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.textContent).toBe('校验50%');
  });
});

describe('导入 pane', () => {
  it('shows the bar while an import runs, with its stage and percent, and drops it when idle', async () => {
    const sink = pushes();
    await mount('&pane=import');
    const motion = await screen.findByRole('button', { name: '导入动作' });
    expect(screen.queryByRole('progressbar', { name: '重定向骨骼' })).toBeNull();
    await act(async () => sink.push(RUNNING));
    const bar = screen.getByRole('progressbar', { name: '重定向骨骼' });
    expect(bar.getAttribute('aria-valuenow')).toBe('43');
    expect(bar.textContent).toBe('重定向骨骼43%');
    expect(bar.closest('section')?.getAttribute('aria-label')).toBe('动作');
    expect(motion.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: '导入外观…' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => sink.push({ ...RUNNING, stage: null, fraction: 0 }));
    expect(screen.getByRole('progressbar', { name: '准备中' }).getAttribute('aria-valuenow')).toBe('0');
    await act(async () => sink.push(IDLE));
    expect(screen.queryByRole('progressbar', { name: '准备中' })).toBeNull();
    expect(motion.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('puts an outfit import under the outfit button', async () => {
    const sink = pushes();
    await mount('&pane=import');
    await screen.findByRole('button', { name: '导入动作' });
    await act(async () => sink.push({ running: true, kind: 'outfit', title: 'SummerMod', stage: 'compose', fraction: 0.2 }));
    expect(screen.getByRole('progressbar', { name: '合成外观' }).closest('section')?.getAttribute('aria-label')).toBe('外观与 mod');
  });

  it('reads character.importState on mount, so a remount or reload shows the running import', async () => {
    vi.spyOn(bridge.character, 'importState').mockResolvedValue({ ...RUNNING, stage: 'reload', fraction: 1 });
    await mount('&pane=import');
    const bar = await screen.findByRole('progressbar', { name: '载入角色' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('MMD page', () => {
  it('shows any running import on the library strip and disables 导入 VMD', async () => {
    const sink = pushes();
    const router = createRouter({ routeTree: createRootRoute({ component: MmdPage }), history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const btn = (await screen.findByRole('button', { name: '导入 VMD' })) as HTMLButtonElement;
    await act(async () => sink.push({ running: true, kind: 'outfit', title: 'SummerMod', stage: 'publish', fraction: 0.9 }));
    expect(screen.getByRole('progressbar', { name: '发布' }).getAttribute('aria-valuenow')).toBe('90');
    expect(screen.getByRole('status', { name: 'MMD 导入' }).textContent).toContain('正在导入「SummerMod」');
    expect(btn.disabled).toBe(true);
    await act(async () => sink.push(IDLE));
    expect(screen.queryByRole('progressbar', { name: '发布' })).toBeNull();
  });
});

describe('fake bridge', () => {
  it('pushes read … publish, then reload, then idle during importMotion, and importState follows', async () => {
    const seen: Array<string | null> = [];
    const off = bridge.character.onImport((s) => seen.push(s.running ? s.stage : null));
    const running = bridge.character.importMotion();
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect((await bridge.character.importState()).kind).toBe('motion');
    expect((await running).ok).toBe(true);
    off();
    expect(seen).toEqual(['read', 'sample', 'retarget', 'write', 'validate', 'publish', 'reload', null]);
    expect(await bridge.character.importState()).toEqual(IDLE);
  });

  it('pushes the outfit stages during importOutfit', async () => {
    const seen: Array<string | null> = [];
    const off = bridge.character.onImport((s) => seen.push(s.running ? s.stage : null));
    await bridge.character.importOutfit();
    off();
    expect(seen).toEqual(['read', 'compose', 'write', 'validate', 'publish', 'reload', null]);
  });
});
