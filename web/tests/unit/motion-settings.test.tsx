// 角色页「动作 → 衔接」: the chain list read from agentd's motion graph and saved through avatar.motionOverrides.set.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { demoNative } from '../../src/mock/settings';
import type { Toast } from '../../src/pages/character/feedback';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';
import { CHAR_SECTIONS } from '../../src/pages/character/sections';
import { SettingRows } from '../../src/pages/character/SettingRows';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const THINK = 'A_clip_birch_customized_state_think_start';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
const PAT = 'A_clip_birch_customized_single_headpat';
const WAVE = 'A_clip_birch_dialog_single_wave';
const FIDGET = 'A_clip_birch_idle_fidget_01';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const fail = (code: string) => Object.assign(new Error(code), { code });
const row = (key: string) => {
  const el = document.querySelector<HTMLElement>(`[data-chain="${key}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
};
const sw = (key: string) => within(row(key)).getByRole('switch');
const click = (el: Element) => act(async () => void fireEvent.click(el));
const save = () => click(screen.getByRole('button', { name: '保存' }));

async function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={toast} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radiogroup', { name: '动作视图' });
  await click(screen.getByRole('radio', { name: '清单' }));
}

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

describe('MotionSettings', () => {
  it('says the pack needs a rebuild when it has no motion graph, without an error', async () => {
    await bridge.character.switchTo('voice_a');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MotionSettings offline={false} toast={toast} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('这个角色包还没有动作图，需要重建角色包')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-chain]')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('has one section per group with chains and one row per chain, as the graph has them', async () => {
    await mount();
    const groupOf = (key: string) => MOTION_GRAPH.clips.find((c) => c.name === key)!.group;
    const keys = Object.keys(MOTION_GRAPH.chains);
    const groups = MOTION_GRAPH.groups.filter((g) => keys.some((k) => groupOf(k) === g.id));
    expect(groups.length).toBe(4);
    for (const g of groups) {
      const region = screen.getByRole('region', { name: g.title });
      const rows = [...region.querySelectorAll<HTMLElement>('[data-chain]')].map((r) => r.dataset.chain).sort();
      expect(rows, g.id).toEqual(keys.filter((k) => groupOf(k) === g.id).sort());
    }
    expect(document.querySelectorAll('[data-chain]').length).toBe(keys.length);
    // Defaults: on where a clip of the chain has a live use.
    expect(sw(THINK).getAttribute('aria-checked')).toBe('true');
    expect(sw(WAVE).getAttribute('aria-checked')).toBe('false');
    expect(within(row(WAVE)).getByText('挥手')).toBeTruthy();
    expect(within(row(WAVE)).getByText('默认关')).toBeTruthy();
    expect(within(row(PAT)).getByText('新')).toBeTruthy();
  });

  it('keeps base and bridge chains on with a disabled switch', async () => {
    await mount();
    expect(sw(TO_RELAX).getAttribute('aria-disabled')).toBe('true');
    expect(sw(TO_RELAX).getAttribute('aria-checked')).toBe('true');
    expect(within(row(TO_RELAX)).getAllByText('基础动作，不能关').length).toBeGreaterThan(0);
    await click(sw(TO_RELAX));
    expect(sw(TO_RELAX).getAttribute('aria-checked')).toBe('true');
    const base = screen.getByRole('region', { name: '基础站姿与桥接' });
    await click(within(base).getByRole('button', { name: '整组关' }));
    expect(sw(TO_RELAX).getAttribute('aria-checked')).toBe('true');
  });

  it('turns a whole group off and saves only those chains', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    const thinking = screen.getByRole('region', { name: '思考' });
    await click(within(thinking).getByRole('button', { name: '整组关' }));
    expect(sw(THINK).getAttribute('aria-checked')).toBe('false');
    expect(sw(PONDER).getAttribute('aria-checked')).toBe('false');
    expect(sw(PAT).getAttribute('aria-checked')).toBe('true');
    expect(set).not.toHaveBeenCalled();
    await save();
    expect(set).toHaveBeenCalledWith({ chains: { [THINK]: false, [PONDER]: false }, pools: {}, blend_in: {} });
    await click(within(thinking).getByRole('button', { name: '整组开' }));
    expect(sw(THINK).getAttribute('aria-checked')).toBe('true');
  });

  it('filters 已改 and searches by name', async () => {
    await mount();
    await click(sw(WAVE));
    await click(screen.getByRole('button', { name: /^已改/ }));
    expect([...document.querySelectorAll<HTMLElement>('[data-chain]')].map((r) => r.dataset.chain)).toEqual([WAVE]);
    expect(screen.queryByRole('region', { name: '思考' })).toBeNull();
    await click(screen.getByRole('button', { name: /^全部/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索动作' }), { target: { value: 'fidget' } });
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[data-chain]')].map((r) => r.dataset.chain)).toEqual([FIDGET]));
  });

  it('sends only the chains that differ from their default, with the stored pools', async () => {
    const pools = { 'idle.t1': [{ clip: FIDGET, weight: 3 }] };
    await bridge.avatar.motionOverrides.set({ chains: { [FIDGET]: false, [THINK]: true }, pools, blend_in: {} });
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    expect(sw(FIDGET).getAttribute('aria-checked')).toBe('false');
    expect(within(row(FIDGET)).getByText('已改')).toBeTruthy();
    await click(sw(WAVE));
    await click(sw(PAT));
    await click(sw(PAT));
    await save();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ chains: { [FIDGET]: false, [WAVE]: true }, pools, blend_in: {} });
    expect(await bridge.avatar.motionOverrides.get()).toEqual({ chains: { [FIDGET]: false, [WAVE]: true }, pools, blend_in: {} });
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('marks each adjusted chain on its row and toasts a failed save', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 1, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'chain', key: WAVE, reason: 'unknown_chain' }, { kind: 'chain', key: PAT, reason: 'required' }],
    });
    await mount();
    await click(sw(WAVE));
    await click(sw(PAT));
    await click(sw(FIDGET));
    await save();
    expect(within(row(WAVE)).getByText('角色包里没有这条链')).toBeTruthy();
    expect(within(row(PAT)).getByText('基础动作，不能关')).toBeTruthy();
    expect(row(FIDGET).textContent).not.toContain('角色包里没有这条链');
    set.mockRejectedValueOnce(fail('failed'));
    await click(sw(THINK));
    await save();
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('没有保存'), expect.objectContaining({ severity: 'danger' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('plays a chain once on the desktop and greys the buttons when the shell cannot', async () => {
    const play = vi.spyOn(bridge.avatar, 'playChain');
    await mount();
    await click(within(row(PAT)).getByRole('button', { name: '在桌面上播一次' }));
    expect(play).toHaveBeenCalledWith({ start: PAT });
    play.mockRejectedValueOnce(fail('not_implemented'));
    await click(within(row(WAVE)).getByRole('button', { name: '在桌面上播一次' }));
    await waitFor(() => expect(within(row(THINK)).getByRole('button', { name: '在桌面上播一次' }).getAttribute('aria-disabled')).toBe('true'));
    expect(within(row(THINK)).getByRole('button', { name: '在桌面上播一次' }).getAttribute('title')).toBe('这个版本还不支持在桌面上播放');
  });
});

describe('设定 → 行为', () => {
  it('has no 动作 section: the chains live on the character page\'s 动作 pane', async () => {
    expect(CHAR_SECTIONS.some((s) => s.title === '动作')).toBe(false);
    render(<SettingRows n={await demoNative(null)} tab="behavior" dev set={vi.fn()} setMany={vi.fn()} pending={new Set()} failed={{}} offline={false} />);
    expect(screen.queryByRole('region', { name: '动作' })).toBeNull();
  });
});
