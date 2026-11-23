// 主页右列：两列键的竖向滚动列表，滚轮、拖动和键盘焦点滚动它，滚出窗口的键的红点挂到上下装饰线上。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST, listKey, ROW } from '../../src/pages/home/geometry';
import { HomePage } from '../../src/pages/home/Page';
import { setDevMode } from '../../src/shell/devMode';
import { stubMatchMedia } from './mediaStub';
import { pluginsOn, pluginsReset } from './plugins';

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  pluginsOn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pluginsReset();
  localStorage.clear();
  window.location.hash = '';
});

function mount() {
  const root = createRootRoute({ component: HomePage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole('group', { name: '工具' });
}

const slot = (b: HTMLElement) => b.closest<HTMLElement>('[data-stub="WatchKey"]')!;
const top = (b: HTMLElement) => parseFloat(slot(b).style.top);
const key = (list: HTMLElement, name: string) => within(list).getByRole('button', { name });
const line = (list: HTMLElement, which: 'up' | 'down') => list.querySelector(`[data-line="${which}"]`)!;
const query = () => new URLSearchParams(window.location.hash.split('?')[1]);

describe('home right list', () => {
  // Reduced motion: no fling or spring, so each step lands at once.
  beforeEach(() => stubMatchMedia(new Set(['(prefers-reduced-motion: reduce)'])));

  it('opens at the top: five rows in view, the rest out of it', async () => {
    const list = await mount();
    const keys = within(list).getAllByRole('button');
    expect(top(keys[0]!)).toBe(listKey(0, 0).box.top);
    expect(keys.slice(0, 10).every((b) => !slot(b).hasAttribute('data-out'))).toBe(true);
    expect(keys.slice(10).every((b) => slot(b).hasAttribute('data-out'))).toBe(true);
  });

  it('scrolls 22.5 px a wheel notch and stops at either end', async () => {
    const list = await mount();
    const first = within(list).getAllByRole('button')[0]!;
    const rest = top(first);
    fireEvent.wheel(first, { deltaY: -100 });
    expect(top(first)).toBe(rest);
    fireEvent.wheel(first, { deltaY: 100 });
    expect(top(first)).toBeCloseTo(rest - 22.5, 1);
    fireEvent.wheel(first, { deltaY: 3, deltaMode: 1 });
    expect(top(first)).toBeCloseTo(rest - 22.5 * 4, 1);
    for (let i = 0; i < 40; i++) fireEvent.wheel(first, { deltaY: 100 });
    const last = within(list).getAllByRole('button').at(-1)!;
    expect(slot(last).hasAttribute('data-out')).toBe(false);
    expect(top(last) + 64).toBeLessThanOrEqual(LIST.bottom - LIST.fade + 270 + 0.1);
  });

  it('moves each row along the arc as it scrolls', async () => {
    const list = await mount();
    const second = within(list).getAllByRole('button')[2]!;
    const x0 = parseFloat(slot(second).style.left);
    fireEvent.wheel(second, { deltaY: 100 * (ROW.pitch / 22.5) });
    // The second row takes about the first row's place, nearer the centre.
    expect(parseFloat(slot(second).style.left)).toBeLessThan(x0);
  });

  it('scrolls by a drag and lets the click it ends in through to nothing', async () => {
    const list = await mount();
    const first = key(list, '定时');
    const rest = top(first);
    fireEvent.pointerDown(first, { button: 0, clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 290 });
    fireEvent.pointerMove(window, { clientY: 240 });
    fireEvent.pointerUp(window, { clientY: 240 });
    expect(top(first)).toBeLessThan(rest);
    fireEvent.click(first);
    expect(window.location.hash).toBe('');
    fireEvent.click(first);
    expect(query().get('tab')).toBe('sched');
  });

  it('brings a key that takes focus out of view into the window, with a little of the next row', async () => {
    const list = await mount();
    const far = key(list, '感知');
    expect(slot(far).hasAttribute('data-out')).toBe(true);
    act(() => far.focus());
    expect(slot(far).hasAttribute('data-out')).toBe(false);
    expect(top(far) + 64).toBeLessThan(LIST.bottom - LIST.fade + 270);
    act(() => key(list, '派发任务').focus());
    expect(top(key(list, '派发任务'))).toBe(listKey(0, 0).box.top);
  });

  it('moves focus a row with the arrow keys and across with left and right', async () => {
    pluginsOn();
    const list = await mount();
    const keys = within(list).getAllByRole('button');
    act(() => keys[0]!.focus());
    fireEvent.keyDown(keys[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(keys[2]);
    fireEvent.keyDown(keys[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(keys[3]);
    fireEvent.keyDown(keys[3]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(keys[3]);
    for (let i = 0; i < 7; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(slot(document.activeElement as HTMLElement).hasAttribute('data-out')).toBe(false);
  });

  it('starts at the top again each time the page opens', async () => {
    const list = await mount();
    for (let i = 0; i < 6; i++) fireEvent.wheel(within(list).getAllByRole('button')[0]!, { deltaY: 100 });
    cleanup();
    const again = await mount();
    expect(top(within(again).getAllByRole('button')[0]!)).toBe(listKey(0, 0).box.top);
  });

  it('puts 档案\'s 待确认 dot on the line over the list once the key scrolls out above', async () => {
    const list = await mount();
    const facts = await within(list).findByRole('img', { name: /^\d+ 条待确认$/ }, { timeout: 3000 });
    expect(key(list, '档案').contains(facts)).toBe(true);
    expect(line(list, 'up').querySelector('i')).toBeNull();
    expect(line(list, 'down').querySelector('i')).toBeNull();
    for (let i = 0; i < 40; i++) fireEvent.wheel(key(list, '搜索'), { deltaY: 100 });
    expect(slot(key(list, '档案')).hasAttribute('data-out')).toBe(true);
    expect(line(list, 'up').querySelector('i')).not.toBeNull();
    expect(line(list, 'down').querySelector('i')).toBeNull();
  });
});

describe('home right list in motion', () => {
  it('pulls past the top with rubber and springs back', async () => {
    const list = await mount();
    const first = within(list).getAllByRole('button')[0]!;
    const rest = top(first);
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      fireEvent.wheel(first, { deltaY: -100 });
      expect(top(first)).toBeGreaterThan(rest);
      expect(top(first)).toBeLessThan(rest + 22.5);
      // Check the final position, including the frames after the spring first snaps to the edge.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(top(first)).toBe(rest);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coasts on after a fling and slows to a stop', async () => {
    const list = await mount();
    const first = within(list).getAllByRole('button')[0]!;
    fireEvent.pointerDown(first, { button: 0, clientY: 400 });
    for (const [y, t] of [[390, 0], [370, 16], [350, 32], [330, 48]] as const) fireEvent.pointerMove(window, { clientY: y, timeStamp: t });
    fireEvent.pointerUp(window, { clientY: 330 });
    const released = top(first);
    await vi.waitFor(() => expect(top(first)).toBeLessThan(released - 5), { timeout: 1500 });
  });
});

describe('home right list keys', () => {
  it('lands each sub-view key on its page and tab', async () => {
    setDevMode(true);
    const list = await mount();
    const cases: Array<[string, string, Record<string, string>]> = [
      ['定时', 'tasks', { tab: 'sched' }],
      ['档案', 'memory', { view: 'about' }],
      ['回顾', 'memory', { view: 'activity' }],
      ['外观', 'character', { pane: 'look' }],
      ['动作表', 'character', { pane: 'motion' }],
      ['拍照', 'character', { view: 'photo' }],
      ['MMD', 'character', { view: 'mmd' }],
      ['角色这一天', 'overview', { tab: 'char' }],
      ['时间', 'overview', { tab: 'tm' }],
      ['能力', 'settings', { group: 'perm' }],
      ['感知', 'settings', { group: 'privacy' }],
      ['诊断', 'diag', { tab: 'overview' }],
      ['对话轮次', 'diag', { tab: 'turns' }],
      ['日志', 'diag', { tab: 'logs' }],
      ['管线', 'memory', { view: 'pipeline' }],
    ];
    for (const [name, page, params] of cases) {
      window.location.hash = '';
      fireEvent.click(key(list, name));
      expect(window.location.hash, name).toMatch(new RegExp(`^#/${page}\\?`));
      for (const [k, v] of Object.entries(params)) expect(query().get(k), name).toBe(v);
    }
  });

  it('marks a page key 已关闭 while its plug-in is off and still opens it; leaves 时间 out without 屏幕感知', async () => {
    pluginsReset();
    setDevMode(false);
    const list = await mount();
    for (const name of ['定时', '回顾', '角色这一天']) {
      const b = key(list, name);
      expect(b.hasAttribute('disabled'), name).toBe(false);
      expect(b.querySelector('[data-stub="PowerMark"]')?.getAttribute('aria-label'), name).toBe('已关闭');
    }
    for (const name of ['档案', '外观', '能力']) expect(key(list, name).querySelector('[data-stub="PowerMark"]'), name).toBeNull();
    expect(within(list).queryByRole('button', { name: '时间' })).toBeNull();
    fireEvent.click(key(list, '回顾'));
    expect(query().get('view')).toBe('activity');
  });
});
