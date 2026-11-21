// 行为 → 动作 → 链详情: the chain from the stance it is entered from to the stances it comes back to, its blends and its note.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const IDLE = 'A_clip_birch_idle_loop';
const RELAX = 'A_clip_birch_relax_loop';
const TO_RELAX = 'SourceUI_A_clip_birch_idle_to_relax';
const THINK = 'A_clip_birch_customized_state_think_start';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const PONDER_END = 'A_clip_birch_dialog_state_think_end';
const PAT = 'A_clip_birch_customized_single_headpat';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const click = (el: Element) => act(async () => void fireEvent.click(el));
const save = () => click(screen.getByRole('button', { name: '保存' }));
const row = (key: string) => document.querySelector<HTMLElement>(`[data-chain="${key}"]`)!;
const detail = () => document.querySelector<HTMLElement>('[data-chain-detail]')!;
const joints = (el: Element) => [...el.querySelectorAll<HTMLElement>('[data-joint]')];

async function open(key: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={toast} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radiogroup', { name: '动作视图' });
  await click(screen.getByRole('radio', { name: '清单' }));
  await click(within(row(key)).getByRole('button', { name: '详情' }));
  return detail();
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

describe('链详情', () => {
  it('lays a chain out from its entry stance through its segments to the stances it comes back to', async () => {
    const d = await open(PONDER);
    expect(screen.queryByText('链详情和总览图在下一版')).toBeNull();
    expect(d.getAttribute('aria-label')).toBe('链详情 dialog_state_think_start');
    const entry = d.querySelector('[data-side="entry"]')!;
    expect([...entry.querySelectorAll<HTMLElement>('[data-base]')].map((b) => b.dataset.base)).toEqual([IDLE]);
    expect(entry.textContent).toContain('对话站姿（中心）');
    const segs = [...d.querySelectorAll<HTMLElement>('[data-seg]')];
    expect(segs.map((s) => s.dataset.seg)).toEqual([PONDER, PONDER_LOOP, PONDER_END]);
    expect(segs.map((s) => s.firstElementChild!.textContent)).toEqual(['起', '循环', '收']);
    expect(segs[1]!.textContent).toContain('一圈 2 s');
    expect(segs[1]!.textContent).toContain('持续 2 s');
    const back = d.querySelector('[data-side="back"]')!;
    expect([...back.querySelectorAll<HTMLElement>('[data-base]')].map((b) => b.dataset.base)).toEqual([IDLE, RELAX]);
    expect(back.textContent).toContain('经 idle_to_relax');
    // Entry 12 cm, two inner joints, back to dialog 30 cm and through the bridge 45 cm.
    expect(joints(d).map((j) => [j.dataset.band, j.textContent])).toEqual([
      ['2', '12 cm0.4 s'],
      ['1', '3.1 cm0.25 s'],
      ['1', '0.4 cm0.25 s'],
      ['3', '30 cm0.81 s'],
      ['4', '45 cm0.25 s'],
    ]);
  });

  it('marks a joint without measured poses 未测 and a chain that rests on a base comes back to it', async () => {
    const pat = await open(PAT);
    expect(joints(pat)[0]!.dataset.band).toBe('0');
    expect(joints(pat)[0]!.textContent).toContain('未测');
    await click(within(pat).getByRole('button', { name: '返回' }));
    expect(detail()).toBeNull();
    await click(within(row(THINK)).getByRole('button', { name: '详情' }));
    expect([...detail().querySelectorAll<HTMLElement>('[data-seg]')].map((s) => s.dataset.seg)).toEqual([THINK]);
    expect([...detail().querySelectorAll<HTMLElement>('[data-side="back"] [data-base]')].map((b) => b.dataset.base)).toEqual([IDLE]);
    expect(joints(detail()).map((j) => j.dataset.band)).toEqual(['1', '1']);
  });

  it('saves a segment blend into blend_in and gives it back to the pack', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    const d = await open(PONDER);
    const slider = within(d).getByRole('slider', { name: '进入「dialog_state_think_loop」的混合' });
    expect(slider.getAttribute('aria-valuetext')).toBe('0.25s');
    await act(async () => void fireEvent.change(slider, { target: { value: '0.5' } }));
    expect(joints(d)[1]!.textContent).toBe('3.1 cm0.5 s');
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: { [PONDER_LOOP]: 0.5 } });
    const seg = d.querySelector(`[data-seg="${PONDER_LOOP}"]`)!;
    expect(seg.textContent).toContain('已改');
    await click(within(seg as HTMLElement).getByRole('button', { name: '用包里的' }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });

  it('shows on its segment why the avatar did not take a blend', async () => {
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockResolvedValueOnce({
      applied: { chains: 0, pools: 0, blend_in: 0 },
      adjusted: [{ kind: 'blend_in', key: PONDER_END, reason: 'unknown_clip' }],
    });
    const d = await open(PONDER);
    await act(async () => void fireEvent.change(within(d).getByRole('slider', { name: '进入「dialog_state_think_end」的混合' }), { target: { value: '1' } }));
    await save();
    expect(d.querySelector(`[data-seg="${PONDER_END}"]`)!.textContent).toContain('角色包里没有这个片段');
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('1 项没有生效'), expect.objectContaining({ severity: 'warning' }));
  });

  it('keeps one note per chain in notes, shows it on the row and drops it when cleared', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    const d = await open(THINK);
    const box = within(d).getByRole('textbox', { name: /备注/ });
    expect(box.getAttribute('maxlength')).toBe('500');
    await act(async () => void fireEvent.change(box, { target: { value: '应该放在日常或者思考' } }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {}, notes: { [THINK]: '应该放在日常或者思考' } });
    expect(await bridge.avatar.motionOverrides.get()).toEqual({ chains: {}, pools: {}, blend_in: {}, notes: { [THINK]: '应该放在日常或者思考' } });
    await click(within(d).getByRole('button', { name: '返回' }));
    expect(row(THINK).textContent).toContain('备注：应该放在日常或者思考');
    await click(within(row(THINK)).getByRole('button', { name: '详情' }));
    await act(async () => void fireEvent.change(within(detail()).getByRole('textbox', { name: /备注/ }), { target: { value: '' } }));
    await save();
    expect(set).toHaveBeenLastCalledWith({ chains: {}, pools: {}, blend_in: {} });
  });

  it('locks the blends and the note while the avatar is not running', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MotionSettings offline toast={toast} />
      </QueryClientProvider>,
    );
    await screen.findByRole('radiogroup', { name: '动作视图' });
    await click(screen.getByRole('radio', { name: '清单' }));
    await click(within(row(TO_RELAX)).getByRole('button', { name: '详情' }));
    expect((within(detail()).getByRole('slider') as HTMLInputElement).disabled).toBe(true);
    expect((within(detail()).getByRole('textbox', { name: /备注/ }) as HTMLTextAreaElement).disabled).toBe(true);
  });
});
