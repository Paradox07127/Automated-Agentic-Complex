// Motion library: the format tag on an imported row and 只看导入 in the MOTIONS table; rename and remove through Dialog on the 导入 pane (VMD dances are on the MMD view).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, type RouteComponent } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, ImportedMotionEntry } from '../../src/bridge/protocol';
import { ImportPane } from '../../src/pages/character/ImportPane';
import { CharacterPage } from '../../src/pages/character/Page';
import { setNavRouter } from '../../src/shell/nav';
import { toast as pushToast } from '../../src/shell/toast';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

let bridge: AgenticComplexBridge;

function install(over: Partial<AgenticComplexBridge> = {}) {
  bridge = { ...createFakeBridge({ surface: 'main', still: true }), ...over };
  window.agenticComplex = bridge;
}

async function mount(search = '', component: RouteComponent = CharacterPage) {
  const root = createRootRoute({ component });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [`/?still=1${search}`] }) });
  setNavRouter(router);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelector('[data-page]')).not.toBeNull());
}

const click = (el: Element) => act(async () => void fireEvent.click(el));
// A BVH import: the fake's own VMD import is an MMD dance, which the 动作 table and the 导入 pane leave out.
const ID = 'bvh_walk';
const BVH: ImportedMotionEntry = { id: ID, clip: `imported_${ID}`, title: '示例舞蹈', format: 'bvh', durationS: 3, hasBgm: false, createdAt: null, warnings: [] };
const rowOf = () => document.querySelector<HTMLElement>(`[data-motion="${ID}"]`);
const itemOf = () => document.querySelector<HTMLElement>(`[data-imported-motion="${ID}"]`);

/** The character's imported motions as the native library keeps them. */
function bvhLibrary() {
  let lib: ImportedMotionEntry[] = [];
  const real = bridge.avatar.actions.bind(bridge.avatar);
  vi.spyOn(bridge.character, 'importMotion').mockImplementation(async () => {
    lib = [{ ...BVH }];
    return { ok: true, action: { id: ID, title: BVH.title, durationS: BVH.durationS, hasBgm: false, format: 'bvh', warnings: [] } };
  });
  vi.spyOn(bridge.character, 'listImportedMotions').mockImplementation(async () => ({ ok: true, motions: lib.map((m) => ({ ...m })) }));
  vi.spyOn(bridge.avatar, 'actions').mockImplementation(async () => [
    ...(await real()),
    ...lib.map((m) => ({ id: m.id, label: m.title, enabled: true, section: 'idle', durationS: m.durationS, playable: true })),
  ]);
  vi.spyOn(bridge.character, 'removeMotion').mockImplementation(async (_c, id) => {
    lib = [];
    return { ok: true, id };
  });
  return vi.spyOn(bridge.character, 'renameMotion').mockImplementation(async (_c, id, title) => {
    lib = lib.map((m) => ({ ...m, title }));
    return { ok: true, id, title };
  });
}

beforeEach(() => {
  vi.mocked(pushToast).mockClear();
  install();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('motion library', () => {
  it('tags an imported row and filters to it; renames and removes it on the 导入 pane', async () => {
    const rename = bvhLibrary();
    await mount('&pane=motion');
    await click(await screen.findByRole('tab', { name: '导入' }));
    await click(await screen.findByRole('button', { name: /^导入动作…/ }));
    await waitFor(() => expect(itemOf()).not.toBeNull());
    expect(within(itemOf()!).getByText('BVH')).toBeTruthy();

    await click(screen.getByRole('tab', { name: '动作表' }));
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(within(rowOf()!).getByText('BVH')).toBeTruthy();
    const only = screen.getByRole('button', { name: /仅显示导入动作/ });
    expect(only.getAttribute('aria-pressed')).toBe('false');
    await click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(Array.from(document.querySelectorAll('[data-motion]')).map((r) => r.getAttribute('data-motion'))).toEqual([ID]);
    await click(within(rowOf()!).getByRole('button', { pressed: false }));
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull();

    await click(screen.getByRole('tab', { name: '导入' }));
    await click(within(itemOf()!).getByRole('button', { name: '改名' }));
    let dialog = screen.getByRole('dialog', { name: '重命名' });
    let input = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('示例舞蹈');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('si', ID, '慢舞');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(itemOf()?.textContent).toContain('慢舞'));

    await click(within(itemOf()!).getByRole('button', { name: '改名' }));
    dialog = screen.getByRole('dialog', { name: '重命名' });
    input = within(dialog).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '不要' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(itemOf()?.textContent).toContain('慢舞');

    await click(within(itemOf()!).getByRole('button', { name: '删除' }));
    dialog = screen.getByRole('dialog', { name: '删除动作' });
    expect(dialog.textContent).toContain('删除后角色会重新载入一次');
    await click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(itemOf()).toBeNull());
  });

  it('shows no 只看导入 and no imported list without an imported motion', async () => {
    const list = vi.spyOn(bridge.character, 'listImportedMotions');
    await mount('&pane=motion');
    await screen.findAllByText('点头附和');
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /仅显示导入动作/ })).toBeNull();
    await click(screen.getByRole('tab', { name: '导入' }));
    expect(screen.queryByRole('list', { name: '导入的动作' })).toBeNull();
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull();
  });

  it('greys out 改名 and 删除 while the avatar is not running', () => {
    const entry = BVH;
    render(
      <ImportPane
        motionImport={{ running: false, note: null, run: () => {} }}
        library={{ character: 'si', byId: { [ID]: entry }, rename: () => {}, remove: () => {}, busy: false, error: null, refetch: () => {} }}
        offline
        lock={false}
      />,
    );
    expect((screen.getByRole('button', { name: '改名' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '改名' }).title).toBe('角色未运行');
    expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes an open delete dialog when the character changes, so it cannot delete on the new one', async () => {
    const remove = vi.fn();
    const pane = (character: string) => (
      <ImportPane
        motionImport={{ running: false, note: null, run: () => {} }}
        library={{ character, byId: { [ID]: BVH }, rename: () => {}, remove, busy: false, error: null, refetch: () => {} }}
        offline={false}
        lock={false}
      />
    );
    const { rerender } = render(pane('si'));
    await click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('dialog', { name: '删除动作' })).toBeTruthy();
    rerender(pane('cedar'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('sends the character the pane shows with a rename and a remove', async () => {
    const rename = bvhLibrary();
    await mount('&pane=motion');
    await click(await screen.findByRole('tab', { name: '导入' }));
    await click(await screen.findByRole('button', { name: /^导入动作…/ }));
    await waitFor(() => expect(itemOf()).not.toBeNull());
    await click(within(itemOf()!).getByRole('button', { name: '改名' }));
    const input = within(screen.getByRole('dialog', { name: '重命名' })).getByRole('textbox');
    fireEvent.change(input, { target: { value: '慢舞' } });
    await act(async () => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(rename).toHaveBeenCalledWith('si', ID, '慢舞');
    await click(within(itemOf()!).getByRole('button', { name: '删除' }));
    await click(within(screen.getByRole('dialog', { name: '删除动作' })).getByRole('button', { name: '删除' }));
    expect(bridge.character.removeMotion).toHaveBeenCalledWith('si', ID);
    expect(bridge.character.listImportedMotions).toHaveBeenCalledWith('si');
  });

  it('keeps the listed motions and offers a retry when a later list read answers busy', async () => {
    bvhLibrary();
    await mount('&pane=motion');
    await click(await screen.findByRole('tab', { name: '导入' }));
    await click(await screen.findByRole('button', { name: /^导入动作…/ }));
    await waitFor(() => expect(itemOf()).not.toBeNull());
    vi.mocked(bridge.character.listImportedMotions).mockResolvedValue({ ok: false, reason: 'busy', detail: '角色正在切换，或另一个导入还没完成' });
    await click(screen.getByRole('button', { name: /^导入动作…/ }));
    await waitFor(() => expect(screen.getByText(/读取导入的动作失败/)).toBeTruthy());
    expect(itemOf()).not.toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
