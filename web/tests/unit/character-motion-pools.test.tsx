// 角色页「动作 → 编排」 with agentd's motion groups: the picked pool's proposals (收下 joins the draft, 不要 hides one for this
// visit), the clips it refuses, the clips no pool takes, the counts, and the pages without motion-groups.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOTION_GROUPS } from '../../src/bridge/fake/motionGroups';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { click, FIDGET, mount, pool, rows, save, toEvent, weight } from './chainPage';

const P = 'A_clip_birch_';
const RELAX_SP = `${P}ui_relax_sp`;
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

const proposals = () => [...pool().querySelectorAll<HTMLElement>('[data-proposal]')].map((r) => r.dataset.proposal);
const proposal = (clip: string) => pool().querySelector<HTMLElement>(`[data-proposal="${clip}"]`)!;
const fold = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const ready = () => waitFor(() => expect(proposals().length).toBeGreaterThan(0));

describe('编排 › 角色建议', () => {
  it('shows the picked pool\'s proposals open; 收下 makes one a member row with its weight, saved by the one 保存', async () => {
    const x = MOTION_GROUPS.pools['idle.t1']!.proposal.find((p) => p.clip === RELAX_SP)!;
    x.weight = 3;
    try {
      const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
      await mount(toast);
      await ready();
      expect(fold('角色建议').getAttribute('aria-expanded')).toBe('true');
      expect(proposals()).toEqual([RELAX_SP, `${P}uiteam_idle_loop`, `${P}customized_state_stretch_start`]);
      expect(proposal(RELAX_SP).textContent).toContain('ui_relax_sp');
      expect(proposal(RELAX_SP).textContent).toContain('token:ui_relax');
      await click(within(proposal(RELAX_SP)).getByRole('button', { name: '收下' }));
      expect(rows()).toEqual([FIDGET, RELAX_SP]);
      expect(weight(RELAX_SP).value).toBe('3');
      expect(weight(RELAX_SP).disabled).toBe(false);
      expect(proposals()).not.toContain(RELAX_SP);
      expect(set).not.toHaveBeenCalled();
      expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('池 idle.t1');
      await save();
      expect(set).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith({ chains: {}, pools: { 'idle.t1': [{ clip: FIDGET, weight: 1 }, { clip: RELAX_SP, weight: 3 }] }, blend_in: {} });
    } finally {
      x.weight = 1;
    }
  });

  it('不要 hides a proposal without a save', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await ready();
    await click(within(proposal(RELAX_SP)).getByRole('button', { name: '不要' }));
    expect(proposals()).toEqual([`${P}uiteam_idle_loop`, `${P}customized_state_stretch_start`]);
    expect(rows()).toEqual([FIDGET]);
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('已保存');
    expect(set).not.toHaveBeenCalled();
  });

  it('plays a proposal on the character stage through the chain preview', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    await mount(toast);
    await ready();
    await click(proposal(RELAX_SP).querySelector('button[aria-pressed]')!);
    await waitFor(() => expect(sequence).toHaveBeenCalledWith({ clips: [RELAX_SP], blend_s: [] }));
  });

  it('shows the pending proposal count on the loop-map lane and the event cell', async () => {
    await mount(toast);
    await ready();
    const lane = document.querySelector<HTMLElement>('[data-lane="idle.t1"] [data-proposed]')!;
    expect(lane.textContent).toBe('3');
    await click(within(proposal(RELAX_SP)).getByRole('button', { name: '不要' }));
    expect(document.querySelector('[data-lane="idle.t1"] [data-proposed]')!.textContent).toBe('2');
    await click(within(proposal(`${P}uiteam_idle_loop`)).getByRole('button', { name: '收下' }));
    expect(document.querySelector('[data-lane="idle.t1"] [data-proposed]')!.textContent).toBe('1');
    await toEvent('session.thinking');
    expect(document.querySelector('[data-pool-cell="session.thinking"] [data-proposed]')!.textContent).toBe('1');
    expect(document.querySelector('[data-pool-cell="click.head"] [data-proposed]')).toBeNull();
    expect(proposals()).toEqual([`${P}dialog_single_think`]);
  });

  it('greys 收下 and the add on a pool at 64 entries, whose header reads 64/64', async () => {
    const full = [{ clip: FIDGET, weight: 1 }, ...Array.from({ length: 63 }, (_, i) => ({ clip: `${P}extra_${i}`, weight: 1 }))];
    await bridge.avatar.motionOverrides.set({ chains: {}, pools: { 'idle.t1': full }, blend_in: {} });
    await mount(toast);
    await ready();
    expect(pool().querySelector('[data-stub="TitleBar"]')!.textContent).toContain('64/64');
    const take = within(proposal(RELAX_SP)).getByRole('button', { name: '收下' });
    expect(take.getAttribute('aria-disabled')).toBe('true');
    await click(take);
    expect(rows()).toHaveLength(64);
    expect(within(proposal(RELAX_SP)).getByRole('button', { name: '不要' }).hasAttribute('aria-disabled')).toBe(false);
    expect((screen.getByRole('button', { name: '往 idle.t1 加链' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('编排 › 没收的、没进任何池', () => {
  it('folds both by default and lists the reasons in Chinese', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    await mount(toast);
    await ready();
    const refused = fold('没收的');
    expect(refused.getAttribute('aria-expanded')).toBe('false');
    expect(pool().textContent).not.toContain('站姿和池子不一致');
    await click(refused);
    expect(pool().querySelector('[data-refused="A_clip_birch_customized_state_sit_loop"]')!.textContent).toContain('站姿和池子不一致');
    const outside = fold('没进任何池');
    expect(outside.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-outside]')).toBeNull();
    await click(outside);
    const out = (clip: string) => document.querySelector<HTMLElement>(`[data-outside="${P}${clip}"]`)!;
    expect(out('battle_skill_01').closest('[data-reason]')!.textContent).toContain('战斗');
    expect(out('intro_cs_01').closest('[data-reason]')!.textContent).toContain('过场');
    expect(out('receivemoney_hold').closest('[data-reason]')!.textContent).toContain('未分类');
    expect(document.querySelector('[data-reason="battle"]')!.firstElementChild!.textContent).toBe('战斗2');
    await click(out('shared_walk_loop').querySelector('button[aria-pressed]')!);
    await waitFor(() => expect(sequence).toHaveBeenCalledWith({ clips: [`${P}shared_walk_loop`], blend_s: [] }));
    await toEvent('session.thinking');
    await click(fold('没收的'));
    expect(pool().textContent).toContain('回不到站姿');
  });

  it('reads the counts in one line at the top', async () => {
    await mount(toast);
    await ready();
    const c = MOTION_GROUPS.counts;
    expect(document.querySelector('[data-counts]')!.textContent).toBe(
      `片段 ${c.clips}已入池 ${c.pooled}建议 ${c.proposals}没收 ${c.rejected}排除 ${c.excluded}未分类 ${c.unclassified}`,
    );
  });

  it('a failed motion-groups read shows one ErrBar with retry while the member rows still work', async () => {
    const real = bridge.agentd.request.bind(bridge.agentd);
    let fail = true;
    vi.spyOn(bridge.agentd, 'request').mockImplementation((method, path, body) =>
      fail && path.endsWith('/motion-groups') ? Promise.resolve({ status: 409, body: null, error: { code: 'not_current' } }) : real(method, path, body),
    );
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(alert.textContent).toContain('读取动作池失败');
    expect(document.querySelector('[data-counts]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^没进任何池/ })).toBeNull();
    expect(rows()).toEqual([FIDGET]);
    await click(screen.getByRole('button', { name: /^往 idle\.t1 加链/ }));
    await click(screen.getByRole('button', { name: /^挥手/ }));
    await save();
    expect(set).toHaveBeenCalledTimes(1);
    fail = false;
    await click(within(alert).getByRole('button', { name: /重试/ }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
