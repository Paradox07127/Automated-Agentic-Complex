// 行为 → 动作 → 池子: event pools and idle tiers edited whole into `pools`; other pools read-only with their reason.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const THINK = 'A_clip_birch_customized_state_think_start';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const PAT = 'A_clip_birch_customized_single_headpat';
const WAVE = 'A_clip_birch_dialog_single_wave';
const FIDGET = 'A_clip_birch_idle_fidget_01';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const click = (el: Element) => act(async () => void fireEvent.click(el));
const save = () => click(screen.getByRole('button', { name: '保存' }));
const pool = (key: string) => screen.getByRole('region', { name: `池子 ${key}` });
const entry = (key: string, clip: string) => pool(key).querySelector<HTMLElement>(`[data-clip="${clip}"]`)!;
const clips = (key: string) => [...pool(key).querySelectorAll<HTMLElement>('[data-clip]')].map((e) => e.dataset.clip);
const weight = (key: string, clip: string) => within(entry(key, clip)).getByRole('spinbutton') as HTMLInputElement;

async function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={toast} />
    </QueryClientProvider>,
  );
  await click(await screen.findByRole('radio', { name: '池子' }));
}

async function setWeight(key: string, clip: string, w: string) {
  const input = weight(key, clip);
  await act(async () => {
    fireEvent.change(input, { target: { value: w } });
    fireEvent.blur(input);
  });
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

describe('池子', () => {
  it('lists event pools and idle tiers to edit, and other pools read-only with their reason', async () => {
    await mount();
    expect(clips('session.thinking')).toEqual([THINK, PONDER]);
    expect([weight('session.thinking', THINK).value, weight('session.thinking', PONDER).value]).toEqual(['1', '2']);
    expect(clips('click.head')).toEqual([PAT]);
    expect(clips('idle.t1')).toEqual([FIDGET]);
    // A pool whose only clip the runtime skips is not drawn from.
    expect(screen.queryByRole('region', { name: '池子 click.single' })).toBeNull();
    const think = pool('think');
    expect(think.textContent).toContain('活动的池子由行为决定，不能在这里改');
    expect(within(think).queryByRole('spinbutton')).toBeNull();
    expect(within(think).queryByRole('button')).toBeNull();
  });

  it('changes a weight and saves the whole pool', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    await setWeight('session.thinking', PONDER, '5');
    expect(pool('session.thinking').textContent).toContain('已改');
    expect(pool('session.thinking').textContent).toContain('83%');
    await setWeight('session.thinking', THINK, '250000');
    expect(weight('session.thinking', THINK).value).toBe('100000');
    await setWeight('session.thinking', THINK, '3');
    await save();
    expect(set).toHaveBeenCalledWith({
      chains: {},
      pools: { 'session.thinking': [{ clip: THINK, weight: 3 }, { clip: PONDER, weight: 5 }] },
      blend_in: {},
    });
  });

  it('adds a chain start of the same posture, removes a clip and keeps at least one', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    await click(within(pool('idle.t1')).getByRole('button', { name: '往 idle.t1 加片段' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('挥手');
    expect(options).not.toContain('idle_fidget_01');
    await click(screen.getByRole('option', { name: '挥手' }));
    expect(clips('idle.t1')).toEqual([FIDGET, WAVE]);
    await click(within(entry('idle.t1', FIDGET)).getByRole('button', { name: '去掉' }));
    expect(clips('idle.t1')).toEqual([WAVE]);
    expect(within(entry('idle.t1', WAVE)).getByRole('button', { name: '去掉' }).getAttribute('aria-disabled')).toBe('true');
    await save();
    expect(set).toHaveBeenCalledWith({ chains: {}, pools: { 'idle.t1': [{ clip: WAVE, weight: 1 }] }, blend_in: {} });
  });

  it('shows every pool the avatar did not take, each with its reason', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [
        { kind: 'pool', key: 'session.thinking', reason: 'stance_mismatch' },
        { kind: 'pool', key: 'idle.t1', reason: 'no_return' },
        { kind: 'pool', key: 'click.head', reason: 'excluded_family' },
      ],
    });
    await mount();
    await setWeight('session.thinking', PONDER, '4');
    await save();
    expect(pool('session.thinking').textContent).toContain('有片段的站姿和池子不一致');
    expect(pool('idle.t1').textContent).toContain('有片段的链最后回不到站姿');
    expect(pool('click.head').textContent).toContain('有片段起始或收尾在排除的姿势族，运行时不会抽到');
    const list = screen.getByRole('list', { name: '上次保存没有生效的池子' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'session.thinking 有片段的站姿和池子不一致',
      'idle.t1 有片段的链最后回不到站姿',
      'click.head 有片段起始或收尾在排除的姿势族，运行时不会抽到',
    ]);
  });

  it('names unknown_pool and unknown_clip in words too', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [
        { kind: 'pool', key: 'session.thinking', reason: 'unknown_pool' },
        { kind: 'pool', key: 'idle.t1', reason: 'unknown_clip' },
      ],
    });
    await mount();
    await setWeight('idle.t1', FIDGET, '2');
    await save();
    expect(pool('session.thinking').textContent).toContain('角色包里没有这个池子，或者它不能改');
    expect(pool('idle.t1').textContent).toContain('有片段不在角色包里');
  });

  it('gives a stored pool back to the pack', async () => {
    await bridge.avatar.motionOverrides.set({ chains: {}, pools: { 'idle.t1': [{ clip: FIDGET, weight: 3 }] }, blend_in: {} });
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    expect(weight('idle.t1', FIDGET).value).toBe('3');
    expect(pool('idle.t1').textContent).toContain('已改');
    await click(within(pool('idle.t1')).getByRole('button', { name: '用包里的' }));
    expect(weight('idle.t1', FIDGET).value).toBe('1');
    await save();
    expect(set).toHaveBeenCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });
});
