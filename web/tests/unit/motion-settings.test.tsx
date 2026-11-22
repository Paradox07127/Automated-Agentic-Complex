// 角色页「动作 → 编排」: idle tiers on the loop map, event pools in a grid, the picked pool's chains with their weights, all saved
// through avatar.motionOverrides.set from the one commit bar.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { demoNative } from '../../src/mock/settings';
import type { Toast } from '../../src/pages/character/feedback';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { laneText } from '../../src/pages/character/motions/LoopMap';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';
import { poolsOf } from '../../src/pages/character/motions/pools';
import { CHAR_SECTIONS } from '../../src/pages/character/sections';
import { SettingRows } from '../../src/pages/character/SettingRows';
import { click, FIDGET, IDLE, mount, PAT, PONDER, pool, row, rows, save, setWeight, THINK, tierUse, toEvent, WAVE, weight } from './chainPage';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

beforeEach(() => {
  Object.assign(tierUse(), { after_s: [20, 40], interval_s: [25, 60], no_repeat: 4 });
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  toast = vi.fn<Toast>();
});
afterEach(() => {
  cleanup();
  const u = tierUse();
  delete u.after_s;
  delete u.interval_s;
  delete u.no_repeat;
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('编排', () => {
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

  it('reads the tier draw times off the graph and opens on the first idle tier with its chains', async () => {
    const tier = poolsOf(MOTION_GRAPH as unknown as MotionGraph).find((p) => p.key === 'idle.t1')!;
    expect(tier).toMatchObject({ after_s: [20, 40], interval_s: [25, 60], no_repeat: 4 });
    expect(laneText(tier)).toBe('20–40 s 后 │ 每 25–60 s');
    expect(laneText({ ...tier, posture: 'sit', after_s: [120, 240], interval_s: [90, 180] })).toBe('坐着时 │ 2–4 m 后 │ 每 1.5–3 m');
    await mount(toast);
    expect(screen.getByRole('radio', { name: '待机 1 档' }).getAttribute('aria-checked')).toBe('true');
    const lane = screen.getByRole('radio', { name: /^T1 站/ });
    expect(lane.getAttribute('aria-checked')).toBe('true');
    expect(lane.textContent).toContain('20–40 s 后 │ 每 25–60 s');
    expect(lane.textContent).toContain('1 条');
    // The hub stance in the ring, the other stance under it with its bridge.
    expect(document.querySelector('[data-hub]')!.textContent).toContain('对话站姿');
    expect(screen.getByRole('list', { name: '其他站姿' }).textContent).toContain('放松站姿经桥接 │ 0.25 s');
    expect(pool().getAttribute('aria-label')).toBe('池子 idle.t1');
    expect(within(pool()).getByRole('heading').textContent).toBe('T1 站姿待机');
    expect(pool().textContent).toContain('idle.t1 │ 最近 4 条不重复 │ 权重和 1');
    expect(rows()).toEqual([FIDGET]);
  });

  it('lists event pools by group and shows the picked one; pools the runtime does not let one change are not there', async () => {
    await mount(toast);
    await toEvent('session.thinking');
    const grid = screen.getByRole('radiogroup', { name: '事件池' });
    expect([...grid.querySelectorAll<HTMLElement>('[data-pool-cell]')].map((c) => c.dataset.poolCell)).toEqual(['session.thinking', 'click.head']);
    expect(grid.textContent).toContain('思考');
    expect(grid.textContent).toContain('点击与进场');
    expect(rows()).toEqual([THINK, PONDER]);
    expect([weight(THINK).value, weight(PONDER).value]).toEqual(['1', '2']);
    expect(row(PONDER).textContent).toContain('67%');
    expect(pool().textContent).toContain('思考 │ 权重和 3');
    // An activity pool and a pool whose only clip the runtime skips have no cell.
    expect(document.querySelector('[data-pool-cell="think"]')).toBeNull();
    expect(document.querySelector('[data-pool-cell="click.single"]')).toBeNull();
  });

  it('flags a chain that cuts hard or comes in far on its row, and counts the hard ones on its lane', async () => {
    const e = MOTION_GRAPH.edges.find((x) => x.from === IDLE && x.to === FIDGET)!;
    const was = e.gap;
    e.gap = 50;
    try {
      await mount(toast);
      expect(row(FIDGET).textContent).toContain('会硬切 50 cm');
      expect(screen.getByRole('radio', { name: /^T1/ }).textContent).toContain('1 硬切');
      await toEvent('session.thinking');
      expect(row(PONDER).textContent).toContain('回站姿 30 cm');
      expect(document.querySelector('[data-pool-cell="session.thinking"] [aria-label="有会硬切的链"]')).toBeNull();
    } finally {
      e.gap = was;
    }
  });

  it('changes a weight with the field and the arrows, clamps it, and saves the whole pool', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await toEvent('session.thinking');
    await setWeight(PONDER, '5');
    expect(pool().textContent).toContain('已改');
    expect(row(PONDER).textContent).toContain('83%');
    await setWeight(THINK, '250000');
    expect(weight(THINK).value).toBe('100000');
    await setWeight(THINK, '2');
    await click(within(row(THINK)).getByRole('button', { name: '「customized_state_think_start」的权重：增加' }));
    expect(weight(THINK).value).toBe('3');
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('未保存 1 项│ 池 session.thinking');
    await save();
    expect(set).toHaveBeenCalledWith({
      chains: {},
      pools: { 'session.thinking': [{ clip: THINK, weight: 3 }, { clip: PONDER, weight: 5 }] },
      blend_in: {},
    });
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('已保存');
  });

  it('adds a chain start of the same posture, takes one out from its inspector and keeps at least one', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await click(screen.getByRole('button', { name: '往 idle.t1 加链' }));
    const offered = within(screen.getByRole('list', { name: '能加的链起头' })).getAllByRole('button').map((b) => b.textContent);
    expect(offered.some((t) => t!.startsWith('挥手'))).toBe(true);
    expect(offered.some((t) => t!.includes('idle_fidget_01'))).toBe(false);
    await click(screen.getByRole('button', { name: /^挥手/ }));
    expect(rows()).toEqual([FIDGET, WAVE]);
    await click(within(row(FIDGET)).getByRole('button', { name: /^展开/ }));
    await click(screen.getByRole('button', { name: '从这个池去掉' }));
    expect(rows()).toEqual([WAVE]);
    await click(within(row(WAVE)).getByRole('button', { name: /^展开/ }));
    expect((screen.getByRole('button', { name: '从这个池去掉' }) as HTMLButtonElement).disabled).toBe(true);
    await save();
    expect(set).toHaveBeenCalledWith({ chains: {}, pools: { 'idle.t1': [{ clip: WAVE, weight: 1 }] }, blend_in: {} });
  });

  it('marks each pool and chain the avatar did not take, with its reason', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [
        { kind: 'pool', key: 'session.thinking', reason: 'stance_mismatch' },
        { kind: 'pool', key: 'idle.t1', reason: 'unknown_clip' },
        { kind: 'chain', key: PONDER, reason: 'unknown_chain' },
      ],
    });
    await mount(toast);
    await setWeight(FIDGET, '2');
    await save();
    expect(toast).toHaveBeenLastCalledWith('已保存 │ 3 项没有生效', { severity: 'warning' });
    expect(pool().textContent).toContain('上次保存没有生效：有片段不在角色包里');
    expect(screen.getByRole('radio', { name: /^T1/ }).hasAttribute('data-bad')).toBe(true);
    await toEvent('session.thinking');
    expect(document.querySelector('[data-pool-cell="session.thinking"]')!.hasAttribute('data-bad')).toBe(true);
    expect(pool().textContent).toContain('有片段的站姿和池子不一致');
    expect(row(PONDER).textContent).toContain('角色包里没有这条链');
    expect(row(THINK).textContent).not.toContain('角色包里没有这条链');
  });

  it('gives a stored pool back to the pack and undoes everything unsaved at once', async () => {
    await bridge.avatar.motionOverrides.set({ chains: {}, pools: { 'idle.t1': [{ clip: FIDGET, weight: 3 }] }, blend_in: {} });
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    expect(weight(FIDGET).value).toBe('3');
    expect(screen.getByRole('radio', { name: /^T1/ }).querySelector('[data-stub="Diamond"]')).toBeTruthy();
    await click(within(pool()).getByRole('button', { name: '用包里的' }));
    expect(weight(FIDGET).value).toBe('1');
    await click(screen.getByRole('button', { name: '全部撤销' }));
    expect(weight(FIDGET).value).toBe('3');
    await click(within(pool()).getByRole('button', { name: '用包里的' }));
    await save();
    expect(set).toHaveBeenCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });

  it('toasts a failed save and keeps the changes', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'failed' }));
    await mount(toast);
    await setWeight(FIDGET, '4');
    await save();
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('没有保存'), expect.objectContaining({ severity: 'danger' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('locks every write and says so while the avatar is not running, and can still be browsed', async () => {
    await mount(toast, true);
    expect(weight(FIDGET).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '往 idle.t1 加链' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('角色未运行 │ 只读');
    await toEvent('click.head');
    expect(rows()).toEqual([PAT]);
  });
});

describe('设定 → 行为', () => {
  it('has no 动作 section: the chains live on the character page\'s 动作 pane', async () => {
    expect(CHAR_SECTIONS.some((s) => s.title === '动作')).toBe(false);
    render(<SettingRows n={await demoNative(null)} tab="behavior" set={vi.fn()} setMany={vi.fn()} pending={new Set()} failed={{}} offline={false} />);
    expect(screen.queryByRole('region', { name: '动作' })).toBeNull();
  });
});
