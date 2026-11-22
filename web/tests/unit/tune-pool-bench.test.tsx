// 调参「动作池」: every pool of the current character with the pack's clips and agentd's proposals; accepting one sends the whole
// pool through avatar.motionOverrides.set, and a pool the avatar does not take shows why on the clip just accepted.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOTION_GROUPS } from '../../src/bridge/fake/motionGroups';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { PoolBench } from '../../src/pages/tune/PoolBench';

const P = 'A_clip_birch_';
let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  toast = vi.fn<Toast>();
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PoolBench offline={false} toast={toast} />
    </QueryClientProvider>,
  );
}

const pool = () => screen.getByRole('region', { name: /^池子 / });
const group = (name: string) => within(pool()).getByRole('list', { name });

describe('动作池', () => {
  it('lists every pool with its pack and proposal counts and opens on the first', async () => {
    mount();
    const keys = await screen.findByRole('list', { name: '池子' });
    const buttons = within(keys).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['idle.t1，角色包 1 条，建议 3 条', 'session.thinking，角色包 2 条，建议 1 条']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(pool().getAttribute('aria-label')).toBe('池子 idle.t1');
    expect(within(group('角色包')).getAllByRole('listitem').map((r) => r.getAttribute('data-clip'))).toEqual([`${P}idle_fidget_01`]);
    expect(within(group('建议')).getAllByRole('listitem')).toHaveLength(3);
    expect(group('不收').textContent).toContain('站姿和池子不一致');
    const cover = screen.getByRole('region', { name: '池外' });
    expect(within(cover).getByRole('list', { name: '排除 battle' }).children).toHaveLength(2);
    expect(within(cover).getByRole('list', { name: '未分类' }).children).toHaveLength(MOTION_GROUPS.unclassified.length);
  });

  it('accept sends the pack with the accepted clip as the whole pool', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '收下 ui_relax_sp' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]![0]).toEqual({
      chains: {},
      pools: { 'idle.t1': [{ clip: `${P}idle_fidget_01`, weight: 1 }, { clip: `${P}ui_relax_sp`, weight: 1 }] },
      blend_in: {},
    });
    await waitFor(() => expect(within(group('建议')).getByRole('button', { name: '撤回 ui_relax_sp' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '收下 uiteam_idle_loop' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1]![0].pools['idle.t1']!.map((e) => e.clip)).toEqual([`${P}idle_fidget_01`, `${P}ui_relax_sp`, `${P}uiteam_idle_loop`]);
  });

  it('a pool the avatar does not take shows the reason on the clip just accepted', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValue({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'pool', key: 'session.thinking', reason: 'no_return' }],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^session\.thinking，/ }));
    fireEvent.click(within(pool()).getByRole('button', { name: '收下 dialog_single_think' }));
    await waitFor(() => expect(within(group('建议')).getByRole('listitem').textContent).toContain('回不到站姿'));
    expect(toast).toHaveBeenCalledWith('已保存 │ 1 项没有生效', { severity: 'warning' });
  });

  it('drop takes a proposal off the list without sending anything', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '不要 ui_relax_sp' }));
    expect(within(group('建议')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'idle.t1，角色包 1 条，建议 2 条' })).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it('plays a clip outside every pool in the live preview', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '播放 shared_walk_loop' }));
    await waitFor(() => expect(sequence).toHaveBeenCalledWith({ clips: [`${P}shared_walk_loop`], blend_s: [] }));
  });
});
