// 动作 → 编排 → 链检视: the chain strip from the stance it is entered from to the one it comes back to, the blend of a joint, the
// chain's switch for every pool, and its note.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { click, detail, IDLE, mount, openChain, PAT, PONDER, PONDER_END, PONDER_LOOP, row, save, THINK, TO_RELAX, toEvent } from './chainPage';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const joints = (el: Element) => [...el.querySelectorAll<HTMLElement>('[data-joint]')];
const wedge = (clip: string) => within(detail()).getByRole('button', { name: new RegExp(`^进入「${clip}」的衔接`) });
const slider = (clip: string) => within(detail()).getByRole('slider', { name: `进入「${clip}」的混合` }) as HTMLInputElement;

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

describe('链检视', () => {
  it('lays a chain out from its entry stance through its segments to the stance it comes back to', async () => {
    await mount(toast);
    const d = await openChain(PONDER);
    expect(d.getAttribute('aria-label')).toBe('链详情 dialog_state_think_start');
    expect(playRowPressed(PONDER)).toBe('true');
    const entry = d.querySelector('[data-side="entry"]')!;
    expect(entry.querySelector<HTMLElement>('[data-base]')!.dataset.base).toBe(IDLE);
    expect(entry.textContent).toContain('对话站姿');
    const segs = [...d.querySelectorAll<HTMLElement>('[data-seg]')];
    expect(segs.map((s) => s.dataset.seg)).toEqual([PONDER, PONDER_LOOP, PONDER_END]);
    expect(segs.map((s) => s.firstElementChild!.textContent)).toEqual(['起', '循环', '收']);
    expect(segs[1]!.textContent).toContain('一圈 2 s');
    expect(segs[1]!.textContent).toContain('保持 2 s');
    expect(segs.map((s) => s.querySelector('span:last-child')!.textContent)).toEqual(['0 s', '1.5 s', '3.5 s']);
    const back = d.querySelector('[data-side="back"]')!;
    expect(back.textContent).toContain('对话站姿');
    expect(back.textContent).toContain('回到 │ 4.6 s');
    expect(back.textContent).toContain('或经桥接 放松站姿');
    // Entry 12 cm at 0.4 s, two inner joints, back to dialog 30 cm.
    expect(joints(d).map((j) => [j.dataset.band, j.textContent])).toEqual([
      ['2', '0.40 s12 cm'],
      ['1', '0.25 s3.1 cm'],
      ['1', '0.25 s0.4 cm'],
      ['3', '0.81 s30 cm'],
    ]);
  });

  it('marks a joint without measured poses 未测, and a chain that rests on a base comes back to it', async () => {
    await mount(toast);
    await toEvent('click.head');
    await click(within(row(PAT)).getByRole('button', { name: /^展开/ }));
    expect(joints(detail())[0]!.dataset.band).toBe('0');
    expect(joints(detail())[0]!.textContent).toContain('未测');
    await click(within(row(PAT)).getByRole('button', { name: /^收起/ }));
    expect(detail()).toBeNull();
    await toEvent('session.thinking');
    await click(within(row(THINK)).getByRole('button', { name: /^展开/ }));
    expect([...detail().querySelectorAll<HTMLElement>('[data-seg]')].map((s) => s.dataset.seg)).toEqual([THINK]);
    expect(detail().querySelector<HTMLElement>('[data-side="back"] [data-base]')!.dataset.base).toBe(IDLE);
    expect(joints(detail()).map((j) => j.dataset.band)).toEqual(['1', '1']);
  });

  it('sets the blend into a segment from its joint, by slider and keys, and gives it back to the pack', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await openChain(PONDER);
    expect(within(detail()).queryByRole('slider')).toBeNull();
    await click(wedge('dialog_state_think_loop'));
    expect(slider('dialog_state_think_loop').getAttribute('aria-valuetext')).toBe('0.25 s');
    expect(detail().textContent).toContain('包里 0.25 s');
    await act(async () => void fireEvent.change(slider('dialog_state_think_loop'), { target: { value: '0.5' } }));
    expect(joints(detail())[1]!.textContent).toBe('0.50 s3.1 cm');
    await act(async () => void fireEvent.keyDown(wedge('dialog_state_think_end'), { key: 'ArrowRight' }));
    await act(async () => void fireEvent.keyDown(wedge('dialog_state_think_end'), { key: 'ArrowRight', shiftKey: true }));
    expect(joints(detail())[2]!.textContent).toBe('0.55 s0.4 cm');
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('混合 dialog_state_think_loop、dialog_state_think_end');
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: { [PONDER_LOOP]: 0.5, [PONDER_END]: 0.55 } });
    await act(async () => void fireEvent.keyDown(wedge('dialog_state_think_end'), { key: 'Delete' }));
    await click(wedge('dialog_state_think_loop'));
    await click(within(detail()).getByRole('button', { name: '用包里的' }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });

  it('shows on its segment why the avatar did not take a blend', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'blend_in', key: PONDER_END, reason: 'unknown_clip' }],
    });
    await mount(toast);
    await openChain(PONDER);
    await click(wedge('dialog_state_think_end'));
    await act(async () => void fireEvent.change(slider('dialog_state_think_end'), { target: { value: '1' } }));
    await save();
    expect(detail().querySelector(`[data-seg="${PONDER_END}"]`)!.textContent).toContain('角色包里没有这个片段');
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('1 项没有生效'), expect.objectContaining({ severity: 'warning' }));
  });

  it('skips a chain in every pool through its 开 / 关 switch and keeps base chains on', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await openChain(PONDER);
    const plays = within(detail()).getByRole('switch', { name: /^所有池抽到/ });
    expect(plays.getAttribute('aria-checked')).toBe('true');
    await click(plays);
    expect(row(PONDER).textContent).toContain('已关 │ 抽到跳过');
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: { [PONDER]: false }, pools: {}, blend_in: {} });
    // A base chain added to a pool: its switch is locked.
    await click(screen.getByRole('radio', { name: /^待机/ }));
    await click(screen.getByRole('button', { name: '往 idle.t1 加链' }));
    await click(screen.getByRole('button', { name: /idle_to_relax/ }));
    await click(within(row(TO_RELAX)).getByRole('button', { name: /^展开/ }));
    expect(detail().textContent).toContain('基础动作，不能关');
    expect(within(detail()).queryByRole('switch', { name: /^所有池抽到/ })).toBeNull();
  });

  it('keeps one note per chain in notes and drops it when cleared', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount(toast);
    await openChain(THINK);
    await click(within(detail()).getByRole('button', { name: '备注' }));
    const box = within(detail()).getByRole('textbox', { name: /备注/ });
    expect(box.getAttribute('maxlength')).toBe('500');
    await act(async () => void fireEvent.change(box, { target: { value: '应该放在日常或者思考' } }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {}, notes: { [THINK]: '应该放在日常或者思考' } });
    await click(within(row(THINK)).getByRole('button', { name: /^收起/ }));
    await click(within(row(THINK)).getByRole('button', { name: /^展开/ }));
    // A chain with a note opens with it.
    await act(async () => void fireEvent.change(within(detail()).getByRole('textbox', { name: /备注/ }), { target: { value: '' } }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });

  it('locks the blends, the switch and the note while the avatar is not running', async () => {
    await bridge.avatar.motionOverrides.set({ chains: {}, pools: {}, blend_in: {}, notes: { [PONDER]: '旧备注' } });
    await mount(toast, true);
    await openChain(PONDER);
    await click(wedge('dialog_state_think_loop'));
    expect(slider('dialog_state_think_loop').disabled).toBe(true);
    expect((within(detail()).getByRole('textbox', { name: /备注/ }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(detail()).getByRole('switch', { name: /^所有池抽到/ }).getAttribute('aria-disabled')).toBe('true');
  });
});

function playRowPressed(key: string) {
  return row(key).querySelector('button[aria-pressed]')!.getAttribute('aria-pressed');
}
