// 角色页 after the Gemini review of 11-22 (fix card 3): an old motion preview stays off after MMD, a switch from the tray locks the page,
// a pending switch confirm drops on a new run, the room follows the stage's deck and compact layout, a loop ends with her, and the layer calls queue.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, CharacterEntry } from '../../src/bridge/protocol';
import type { RuntimeSnapshot } from '../../src/bridge/runtimeSnapshot';
import type { CharacterProfile } from '../../src/domain';
import { CHARACTER_LAYERS, CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { CharacterPage } from '../../src/pages/character/Page';
import { useMotions } from '../../src/pages/character/useMotions';
import { useSwitch } from '../../src/pages/character/useSwitch';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
// The stage as what it is asked to play.
vi.mock('../../src/pages/character/Stage', async (actual) => ({
  ...(await actual<typeof import('../../src/pages/character/Stage')>()),
  Stage: (p: { previewAction?: string; deck?: boolean }) => <div data-testid="stage" data-action={p.previewAction ?? ''} data-deck={p.deck || undefined} />,
}));

let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

const noop = () => {};
const click = (el: Element) => act(async () => void fireEvent.click(el));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-motion="${id}"]`);
/** Clicks a 开 / 关 switch only when it is not at `on` yet. */
const turn = async (sw: HTMLElement, on: boolean) => {
  if ((sw.getAttribute('aria-checked') === 'true') !== on) await click(sw);
};
const rail = (name: string) => within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name });
const page = () => document.querySelector<HTMLElement>('[data-page="character"]')!;
const deferred = <T,>() => {
  let ok!: (v: T) => void;
  const p = new Promise<T>((r) => (ok = r));
  return { p, ok };
};

async function mount(search = '') {
  const root = createRootRoute({ component: CharacterPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: '角色分区' });
  return router;
}

const si = (layers?: CharacterEntry['layers']): CharacterEntry => ({
  id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [], ...(layers ? { layers } : {}),
});

const props: OperatorProps = {
  roster: [si(CHARACTER_LAYERS.map((l) => ({ ...l, visible: true })))],
  current: 'si',
  sw: { state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop },
  offline: false,
  backoff: null,
  onRestart: noop,
  actions: MOTIONS,
  motionsError: null,
  onRetryMotions: noop,
  charState: STATE_WITH_CAUSES,
  toast: noop,
  pane: 'motion',
};

describe('949c#3 a motion preview after MMD', () => {
  it('does not play again on 总览 once MMD showed its own stage', async () => {
    const ui = render(<Operator {...props} />);
    await click(row('nod')!.querySelector('button')!);
    expect(screen.getByTestId('stage').dataset.action).toBe('nod');
    ui.rerender(<Operator {...props} side={{ of: 'mmd', node: <div />, band: false, preview: { action: undefined, request: undefined, loop: false } }} />);
    expect(screen.getByTestId('stage').dataset.action).toBe('');
    ui.rerender(<Operator {...props} pane="overview" />);
    expect(screen.getByTestId('stage').dataset.action).toBe('');
  });
});

describe('949c#5 a switch the page did not start', () => {
  it('locks the motion switches while the host switches from the tray', async () => {
    let push: (s: RuntimeSnapshot) => void = noop;
    vi.spyOn(bridge.app, 'onRuntime').mockImplementation((cb) => {
      push = cb;
      return noop;
    });
    await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    const off = () => within(row('nod')!).getByRole('switch').getAttribute('aria-disabled') === 'true';
    expect(off()).toBe(false);
    const s = await bridge.app.runtime();
    await act(async () => push({ ...s, character: { ...s.character, switching: true } }));
    expect(off()).toBe(true);
  });

  it('locks MMD while the page’s own switch runs', async () => {
    const run = deferred<{ ok: true }>();
    vi.spyOn(bridge.character, 'switchTo').mockImplementation(() => run.p);
    await mount();
    const heads = await screen.findByRole('group', { name: '角色头像' });
    await click(within(heads).getByRole('button', { name: '示例甲' }));
    await click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换' }));
    await click(rail('MMD'));
    const vmd = await screen.findByRole('button', { name: /导入 VMD/ });
    expect((vmd as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('949c#6 useSwitch', () => {
  it('drops a head’s pending confirm once 重试 starts another run', async () => {
    const tasks = deferred<ReadonlyArray<{ title: string }>>();
    const ask = vi.fn();
    vi.spyOn(bridge.character, 'switchTo').mockImplementation(() => new Promise(noop));
    const b = { id: 'voice_a', name: '示例甲' } as CharacterProfile;
    const c = { id: 'third', name: '示例丙' } as CharacterProfile;
    const { result } = renderHook(() => useSwitch({ initial: { phase: 'failed', target: c, stage: null, reason: '' }, runningTasks: () => tasks.p, ask, onDone: noop }));
    act(() => result.current.request(b, 'si', '示例乙'));
    act(() => void result.current.retry());
    expect(result.current.state.phase).toBe('running');
    await act(async () => tasks.ok([]));
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('949c#11 / #12 the room under the stage', () => {
  it('lifts the room floor with the stage when 外观 shows the action bar for unsaved switches', async () => {
    await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    await turn(within(row('nod')!).getByRole('switch'), false);
    await click(rail('外观'));
    await waitFor(() => expect(screen.getByTestId('stage').dataset.deck).toBe('true'));
    expect(page().dataset.stageSpan).toBe('deck');
  });

  it('marks the page compact when the scene is wide but short, as the scene’s own rules do', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [width, height] = this.dataset.view === 'operator' ? [1280, 520] : [0, 0];
      return { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
    });
    await mount('&pane=look');
    await waitFor(() => expect(page().hasAttribute('data-compact')).toBe(true));
  });
});

describe('c434#6 useMotions', () => {
  it('drops the loop of the character before', async () => {
    const { result, rerender } = renderHook((p: { character: string }) => useMotions({ character: p.character, actions: MOTIONS, toast: noop }), { initialProps: { character: 'si' } });
    const nod = MOTIONS.find((a) => a.id === 'nod')!;
    await act(async () => result.current.preview(nod, 1, true));
    expect(result.current.play?.loop).toBe(true);
    rerender({ character: 'voice_a' });
    expect(result.current.play).toBeNull();
  });
});

describe('cc03#1 / #13 useLayers', () => {
  const layer = (name: string) => within(screen.getByRole('group', { name: '服装分层' })).getByRole('switch', { name });

  it('sends a second switch only once the first one answers, with every click in it', async () => {
    const pending: Array<() => void> = [];
    const set = vi.spyOn(bridge.avatar, 'setLayers').mockImplementation(() => new Promise<void>((ok) => void pending.push(ok)));
    render(<Operator {...props} pane="look" />);
    await click(screen.getByRole('tab', { name: '显示' }));
    await turn(layer('外套'), false);
    await turn(layer('披风'), false);
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => pending[0]!());
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(['coat', 'cape']);
    await act(async () => pending[1]!());
    expect(layer('披风').getAttribute('aria-checked')).toBe('false');
    expect(layer('外套').getAttribute('aria-checked')).toBe('false');
  });

  it('shows a layer the menu bar showed again once the roster is read again', async () => {
    await mount('&pane=look');
    await click(await screen.findByRole('tab', { name: '显示' }));
    await turn(layer('外套'), false);
    await waitFor(() => expect(layer('外套').getAttribute('aria-checked')).toBe('false'));
    // The menu bar shows it on the host.
    await act(async () => bridge.avatar.setLayers([]));
    await click(screen.getByRole('button', { name: '更多' }));
    await click(screen.getByRole('menuitem', { name: '重新读取角色目录' }));
    await waitFor(() => expect(layer('外套').getAttribute('aria-checked')).toBe('true'));
  });
});
