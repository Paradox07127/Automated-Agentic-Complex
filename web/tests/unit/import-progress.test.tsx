// 导入进度条: character.importState/onImport drive the bar under 动作's 导入 buttons, 外观's 导入 progress card and MMD's strip; the fake pushes read … publish → reload.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, ImportState } from '../../src/bridge/protocol';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';
import { Progress } from '../../src/ui';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

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
  await screen.findByRole('navigation', { name: '角色分区' });
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
  it('shows the stage chain while a motion import runs, with its stage and percent, and drops it when idle', async () => {
    const sink = pushes();
    await mount('&pane=motion');
    await act(async () => void fireEvent.click(screen.getByRole('tab', { name: '导入' })));
    const motion = (await screen.findByRole('button', { name: /^导入动作…/ })) as HTMLButtonElement;
    const run = () => screen.queryByRole('status', { name: '导入进度' });
    expect(run()).toBeNull();
    await act(async () => sink.push(RUNNING));
    expect(run()?.textContent).toContain('Dance');
    expect(run()?.textContent).toContain('导入动作 │ 重定向骨骼');
    expect(run()?.textContent).toContain('43%');
    // Read is done, 重定向骨骼 is the current cell, the rest are still to come.
    expect([...run()!.querySelectorAll('li')].map((li) => li.getAttribute('data-s'))).toEqual(['done', 'now', null, null, null, null]);
    expect(motion.disabled).toBe(true);
    await act(async () => sink.push({ ...RUNNING, stage: 'sample', fraction: 0.1 }));
    expect(run()?.querySelectorAll('li')).toHaveLength(7);
    await act(async () => sink.push({ ...RUNNING, stage: null, fraction: 0 }));
    expect(run()?.textContent).toContain('准备中');
    await act(async () => sink.push(IDLE));
    expect(run()).toBeNull();
    expect(motion.disabled).toBe(false);
  });

  it('puts an outfit import on the progress card of the 外观 导入 tab', async () => {
    const sink = pushes();
    await mount('&pane=look');
    fireEvent.click(screen.getByRole('tab', { name: '导入' }));
    await screen.findByRole('heading', { name: '导入外观模组' });
    await act(async () => sink.push({ running: true, kind: 'outfit', title: 'SummerMod', stage: 'compose', fraction: 0.2 }));
    expect(screen.getByRole('progressbar', { name: '合成外观' }).closest('[data-import-progress]')?.textContent).toContain('SummerMod');
  });

  it('reads character.importState on mount, so a remount or reload shows the running import', async () => {
    vi.spyOn(bridge.character, 'importState').mockResolvedValue({ ...RUNNING, kind: 'outfit', stage: 'reload', fraction: 1 });
    await mount('&pane=look');
    fireEvent.click(screen.getByRole('tab', { name: '导入' }));
    const bar = await screen.findByRole('progressbar', { name: '载入角色' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('MMD section', () => {
  it('shows any running import on the library strip and disables 导入 VMD', async () => {
    const sink = pushes();
    await mount('&view=mmd');
    const btn = (await screen.findByRole('button', { name: '导入 VMD' })) as HTMLButtonElement;
    await act(async () => sink.push({ running: true, kind: 'outfit', title: 'SummerMod', stage: 'publish', fraction: 0.9 }));
    const strip = screen.getByRole('status', { name: 'MMD 导入' });
    expect(within(strip).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('90');
    expect(strip.textContent).toContain('正在导入「SummerMod」发布');
    expect(btn.disabled).toBe(true);
    await act(async () => sink.push(IDLE));
    expect(screen.queryByRole('status', { name: 'MMD 导入' })).toBeNull();
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
