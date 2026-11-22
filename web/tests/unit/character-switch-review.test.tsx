// 角色页 after the review of 11-22: a switch reads her actions again and drops the drafts of the one before; a finished MMD sync reads them again here too; leaving for MMD asks about unsaved switches; 设定's tab bar lists only the tabs with rows; 隐藏界面 hides the bottom bar and the roster.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, AvatarAction, MmdSyncState } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { CharacterPage } from '../../src/pages/character/Page';
import { TunePage } from '../../src/pages/tune/Page';
import { HeaderSlotContext } from '../../src/shell/headerSlot';
import { setNavRouter } from '../../src/shell/nav';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));
vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

let bridge: AgenticComplexBridge;
/** The character the fake host has on the desktop. */
let who = 'si';

const NOD = MOTIONS.find((a) => a.id === 'nod')!;
const B_ONLY: AvatarAction = { id: 'b_only', label: '只有示例甲', enabled: true, section: 'talk', durationS: 1, playable: true };
const IDLE: MmdSyncState = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  who = 'si';
  const switchTo = bridge.character.switchTo.bind(bridge.character);
  vi.spyOn(bridge.character, 'switchTo').mockImplementation(async (id) => {
    const r = await switchTo(id);
    if (r.ok) who = id;
    return r;
  });
  const actions = bridge.avatar.actions.bind(bridge.avatar);
  // 示例甲 has nod too, and one action 示例乙 lacks.
  vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => (who === 'voice_a' ? [{ ...NOD }, { ...B_ONLY }] : actions()));
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

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

const click = (el: Element) => act(async () => void fireEvent.click(el));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-motion="${id}"]`);
const rail = (name: string) => within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name });

/** Switches on 总览 (the only page with the head strip), then goes back to 动作. */
async function switchTo(name: string) {
  await click(rail('总览'));
  const heads = await screen.findByRole('group', { name: '角色头像' });
  await click(within(heads).getByRole('button', { name }));
  await click(within(await screen.findByRole('dialog')).getByRole('button', { name: '切换' }));
  await waitFor(() => expect(within(screen.getByRole('group', { name: '角色头像' })).getByRole('button', { name }).getAttribute('aria-current')).toBe('true'));
  await click(rail('动作'));
}

describe('a switch on the character page', () => {
  it('reads her actions again: 示例甲 does not keep 示例乙’s table', async () => {
    await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    expect(row('b_only')).toBeNull();
    await switchTo('示例甲');
    await waitFor(() => expect(row('b_only')).not.toBeNull());
    expect(row('think')).toBeNull();
  });

  it('drops the unsaved switches of the character before', async () => {
    await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    await click(within(row('nod')!).getByRole('switch'));
    expect(within(row('nod')!).queryByLabelText('未保存')).not.toBeNull();
    await switchTo('示例甲');
    await waitFor(() => expect(row('b_only')).not.toBeNull());
    expect(within(row('nod')!).queryByLabelText('未保存')).toBeNull();
    expect(screen.queryByText(/已修改/)).toBeNull();
  });

  it('reads her actions again when the MMD sync after a switch ends, without the MMD page', async () => {
    let push: (s: MmdSyncState) => void = () => {};
    vi.spyOn(bridge.mmd, 'onSync').mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    const reads = vi.mocked(bridge.avatar.actions).mock.calls.length;
    await act(async () => push({ ...IDLE, running: true, character: 'si', total: 1 }));
    await act(async () => push(IDLE));
    await waitFor(() => expect(vi.mocked(bridge.avatar.actions).mock.calls.length).toBeGreaterThan(reads));
  });
});

describe('the rail’s MMD item with unsaved switches', () => {
  it('asks before it leaves them; 留下 keeps the page and the drafts, 放弃 opens MMD', async () => {
    const router = await mount('&pane=motion');
    await waitFor(() => expect(row('nod')).not.toBeNull());
    await click(within(row('nod')!).getByRole('switch'));
    const mmd = within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name: 'MMD' });
    await click(mmd);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 项');
    expect(router.state.location.pathname).toBe('/');
    await click(within(dialog).getByRole('button', { name: '留下' }));
    expect(within(row('nod')!).queryByLabelText('未保存')).not.toBeNull();
    await click(mmd);
    await click(within(await screen.findByRole('dialog')).getByRole('button', { name: '放弃并打开 MMD' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/mmd'));
  });

  it('opens MMD at once without unsaved switches', async () => {
    const router = await mount('&pane=motion');
    await click(within(screen.getByRole('navigation', { name: '角色分区' })).getByRole('button', { name: 'MMD' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/mmd'));
  });
});

describe('设定 tab bar', () => {
  it('lists only the tabs the settings schema has rows for, and lights the one the body shows', async () => {
    const schema = bridge.settings.schema.bind(bridge.settings);
    vi.spyOn(bridge.settings, 'schema').mockImplementation(async () => (await schema()).filter((r) => !(r as { id: string }).id.startsWith('scn.')));
    await mount('&tab=scene');
    const bar = screen.getByRole('tablist', { name: '角色页签' });
    await waitFor(() => expect(within(bar).getAllByRole('tab').map((t) => t.textContent)).toEqual(['行为', '画面']));
    expect(within(bar).getByRole('tab', { selected: true }).textContent).toBe('行为');
    expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toBe('行为');
  });
});

describe('隐藏界面', () => {
  const props: OperatorProps = {
    roster: [
      { id: 'si', name: '示例乙', en: 'SI', active: true, appearances: [] },
      { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, appearances: [] },
    ],
    current: 'si',
    sw: { state: { phase: 'idle' }, request: () => {}, retry: () => {}, dismiss: () => {} },
    offline: false,
    backoff: null,
    onRestart: () => {},
    actions: MOTIONS,
    motionsError: null,
    onRetryMotions: () => {},
    charState: null,
    toast: () => {},
    // 隐藏界面 is on 总览 only; an unsaved switch keeps the bottom bar there.
    pane: 'overview',
    seed: { stretch: false },
  };

  function inShell(p: OperatorProps) {
    const bottom = document.createElement('div');
    document.body.append(bottom);
    const node = (q: OperatorProps) => (
      <HeaderSlotContext.Provider value={{ setSub: () => {}, right: null, action: null, bottom }}>
        <Operator {...q} />
      </HeaderSlotContext.Provider>
    );
    const ui = render(node(p));
    return { bottom, ui, rerender: (q: OperatorProps) => ui.rerender(node(q)) };
  }

  it('takes the bottom bar away and brings it back', async () => {
    const { bottom } = inShell(props);
    expect(within(bottom).getByRole('button', { name: /桌面预览/ })).toBeTruthy();
    await click(screen.getByRole('button', { name: '隐藏界面' }));
    expect(bottom.childElementCount).toBe(0);
    await click(screen.getByRole('button', { name: '隐藏界面', pressed: true }));
    expect(within(bottom).getByRole('button', { name: /桌面预览/ })).toBeTruthy();
    bottom.remove();
  });

  it('closes the open roster', async () => {
    const { bottom } = inShell(props);
    await click(screen.getByRole('button', { name: /^切换角色/ }));
    expect(screen.getByRole('dialog', { name: '全部角色' })).toBeTruthy();
    await click(screen.getByRole('button', { name: '隐藏界面' }));
    expect(screen.queryByRole('dialog', { name: '全部角色' })).toBeNull();
    bottom.remove();
  });

  it('does not carry into 拍照, which has no key to bring the UI back', async () => {
    const { bottom, ui, rerender } = inShell(props);
    await click(screen.getByRole('button', { name: '隐藏界面' }));
    const op = ui.container.querySelector('[data-view="operator"]')!;
    expect(op.hasAttribute('data-bare')).toBe(true);
    rerender({ ...props, side: { of: 'photo', node: <div /> } });
    expect(op.hasAttribute('data-bare')).toBe(false);
    bottom.remove();
  });
});

describe('调参 motion table', () => {
  it('draws its dark rows under the dark theme, so the switches in them take the dark tokens', async () => {
    window.location.hash = '#/tune?still=1';
    const root = createRootRoute({ component: TunePage });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(row('nod')).not.toBeNull());
    const sw = within(row('nod')!).getByRole('switch');
    expect(sw.closest('[data-theme]')?.getAttribute('data-theme')).toBe('dark');
    window.location.hash = '';
  });
});
