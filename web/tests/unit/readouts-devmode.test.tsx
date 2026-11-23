// Fixed-width, once-a-second frame readouts, and the 开发者模式 switch that hides developer pages and internal numbers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fpsReadout, msReadout, type Fact, type RenderSample } from '../../src/domain';
import { TextMessage } from '../../src/pages/chat/TextMessage';
import { CharacterPage } from '../../src/pages/character/Page';
import { Resources } from '../../src/pages/diag/Resources';
import { Archive } from '../../src/pages/memory/Archive';
import { SettingsPage } from '../../src/pages/settings/Page';
import { CommandBar } from '../../src/shell/CommandBar';
import { setDevMode, useDevMode } from '../../src/shell/devMode';
import { pageRoutes } from '../../src/shell/registry';
import { stubMatchMedia } from './mediaStub';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = '';
});

const res = (samples: RenderSample[]) => <Resources samples={samples} renderWhy="" details={null} onProc={() => {}} />;
const gpuText = (c: HTMLElement) => [...c.querySelectorAll('[data-stub="ReadTick"]')].find((t) => t.lastElementChild?.textContent === 'GPU')?.querySelector('b')?.textContent ?? '';

describe(' frame readouts', () => {
  it('rounds the fps, P95 and GPU readouts of a raw host sample', () => {
    const { container } = render(res([{ at: 1_000, fps: 59.7, p95_ms: 6.123456789, gpu_ms: 3.04999 }]));
    const fps = container.querySelector('[data-nav-target="diag-render"]')!;
    expect(fps.textContent).toContain('60fps');
    expect(fps.textContent).toContain('6.1ms');
    expect(fps.textContent).toContain('3.0ms');
    expect(fps.textContent).not.toContain('6.123');
  });

  it('refreshes the GPU readout at most once within 1000 ms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const list: RenderSample[] = [];
    const sample = (i: number): RenderSample => ({ at: Date.now(), fps: 60, p95_ms: 8, gpu_ms: 3 + i / 10 });
    list.push(sample(0));
    const { container, rerender } = render(res([...list]));
    const seen = [gpuText(container)];
    expect(seen[0]).toBe('3.0ms');
    for (let i = 1; i < 10; i += 1) {
      act(() => void vi.advanceTimersByTime(100));
      list.push(sample(i));
      rerender(res([...list]));
      seen.push(gpuText(container));
    }
    const changes = seen.filter((t, i) => i > 0 && t !== seen[i - 1]).length;
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('formats ms with one decimal and fps as a whole number, — without a value', () => {
    expect(msReadout(null)).toBe('—');
    expect(msReadout(undefined)).toBe('—');
    expect(msReadout(Number.NaN)).toBe('—');
    expect(msReadout(0)).toBe('0.0 ms');
    expect(msReadout(99.94)).toBe('99.9 ms');
    expect(fpsReadout(null)).toBe('—');
    expect(fpsReadout(Number.NaN)).toBe('—');
    expect(fpsReadout(59.7)).toBe('60');
  });
});

function Probe() {
  return <span data-testid="dev">{useDevMode() ? 'on' : 'off'}</span>;
}

describe(' devMode store', () => {
  it('is on by default outside the app build', () => {
    render(<Probe />);
    expect(screen.getByTestId('dev').textContent).toBe('on');
  });

  it('persists a change and tells subscribed components', () => {
    render(<Probe />);
    act(() => setDevMode(false));
    expect(localStorage.getItem('ef.devMode')).toBe('0');
    expect(screen.getByTestId('dev').textContent).toBe('off');
    act(() => setDevMode(true));
    expect(localStorage.getItem('ef.devMode')).toBe('1');
    expect(screen.getByTestId('dev').textContent).toBe('on');
  });
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function mountAt(component: RouteComponent, search = '') {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The command bar on 每日简报 with its page menu open. */
async function commandBar() {
  stubMatchMedia();
  mountAt(() => <CommandBar routes={pageRoutes} activeId="overview" title="每日简报" tabsRef={noop} rightRef={noop} actionRef={noop} />);
  const nav = await screen.findByRole('navigation', { name: '主导航' });
  fireEvent.click(within(nav).getByRole('button', { name: '每日简报' }));
  return nav;
}

async function character(search: string) {
  window.location.hash = `#/character?still=1${search}`;
  mountAt(CharacterPage, search);
  await screen.findByRole('navigation', { name: '角色分区' });
}

const fact: Fact = {
  id: 'f1',
  version: 1,
  owner: null,
  kind: 'preference',
  text: '喜欢黑咖啡',
  source: 'asserted_by_user',
  recorded_at: 1_000,
  how: '',
  uses_today: 0,
  last_used_at: null,
  uses: [],
  evidence: [],
  episode_refs: [],
};
const noop = () => {};
const ok = async () => true;

describe(' 开发者模式 off', () => {
  beforeEach(() => setDevMode(false));

  it('keeps diagnostics, run records and the other developer pages out of normal navigation', async () => {
    const nav = await commandBar();
    expect(within(nav).queryAllByRole('link')).toEqual([]);
    for (const name of ['每日简报', '对话', '记忆', '角色', '设置', '任务']) expect(screen.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '诊断' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '运行记录' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /管线/ })).toBeNull();
  });

  it('keeps 调参 out of the command bar and opens the character page without a 行为与画面 tab', async () => {
    const nav = await commandBar();
    expect(screen.queryByRole('menuitem', { name: /调参/ })).toBeNull();
    cleanup();
    await character('');
    expect(screen.queryByRole('tab', { name: '行为与画面' })).toBeNull();
  });

  it('opens /character?tab=render with a 画面 tab and no 2× SSAA row', async () => {
    await character('&tab=render');
    const menu = await screen.findByRole('tablist', { name: '角色页签' });
    expect(within(menu).getByRole('tab', { name: '画面' })).toBeTruthy();
    expect((await screen.findAllByText('角色边界')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('2× SSAA')).toHaveLength(0);
  });

  it('drops the turn tag from a reply', () => {
    const { container } = render(<TextMessage mine={false} at={0} text="好。" roleName="她" turn={{ no: 3, res: '成功', ms: 4200 }} />);
    expect(container.textContent).not.toMatch(/第\s*\d+\s*轮/);
  });

  it('drops the reference count from a memory row', () => {
    const { container } = render(
      <QueryClientProvider client={client()}>
        <Archive facts={[fact]} error={null} onRetry={noop} now={2_000} still fresh={new Set()} initial={{ sel: null, q: '' }} write={{ confirm: ok, correct: ok, reject: ok, forget: ok, add: ok }} onJump={noop} onChat={noop} actions={null} />
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain('喜欢黑咖啡');
    expect(container.textContent).not.toContain('引用');
  });
});

describe(' 开发者模式 on', () => {
  beforeEach(() => setDevMode(true));

  it('lists 诊断 in the command bar page menu', async () => {
    const nav = await commandBar();
    expect(screen.getByRole('menuitem', { name: /诊断/ })).toBeTruthy();
  });

  it('lists 调参 in the command bar page menu; the character page still has no 行为与画面 tab', async () => {
    const nav = await commandBar();
    expect(screen.getByRole('menuitem', { name: /调参/ })).toBeTruthy();
    cleanup();
    await character('');
    expect(screen.queryByRole('tab', { name: '行为与画面' })).toBeNull();
  });

  it('opens /character?tab=render without the 2× SSAA row, which 调参 › 画面 draws', async () => {
    await character('&tab=render');
    expect((await screen.findAllByText('角色边界')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('2× SSAA')).toHaveLength(0);
  });
});

describe(' settings 关于', () => {
  it('has a 开发者模式 switch that flips useDevMode()', async () => {
    mountAt(() => (
      <>
        <SettingsPage />
        <Probe />
      </>
    ), '&group=about');
    const sw = await screen.findByRole('switch', { name: '开发者模式' });
    expect(screen.getByText('开发者模式', { selector: '*:not(button)' })).toBeTruthy();
    expect(screen.getByTestId('dev').textContent).toBe('on');
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByTestId('dev').textContent).toBe('off'));
    expect(localStorage.getItem('ef.devMode')).toBe('0');
  });
});
