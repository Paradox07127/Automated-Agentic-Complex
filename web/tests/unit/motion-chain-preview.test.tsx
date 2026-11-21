// 链详情的两个按钮：「预览这条链」(avatar.preview.sequence) 和「在桌面上播一次」(avatar.playChain)，以及它们置灰时写的原因。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const PONDER_END = 'A_clip_birch_dialog_state_think_end';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;
let stage: HTMLElement;

const click = (el: Element) => act(async () => void fireEvent.click(el));
const row = (key: string) => document.querySelector<HTMLElement>(`[data-chain="${key}"]`)!;
const detail = () => document.querySelector<HTMLElement>('[data-chain-detail]')!;
const previewBtn = () => within(detail()).getByRole('button', { name: '预览这条链' });
const playBtn = () => within(detail()).getByRole('button', { name: '在桌面上播一次' });

async function open(key: string, offline = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={offline} toast={toast} />
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
  stage = document.createElement('div');
  stage.setAttribute('data-preview-stage', '');
  document.body.append(stage);
});
afterEach(() => {
  cleanup();
  stage.remove();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('链详情 预览和桌面播放', () => {
  it('previews the chain with the draft blends over the pack ones, showing the live preview first when it is not drawn', async () => {
    const show = vi.spyOn(bridge.avatar.preview, 'show').mockResolvedValue(true);
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence').mockResolvedValue(true);
    const d = await open(PONDER);
    await act(async () => void fireEvent.change(within(d).getByRole('slider', { name: '进入「dialog_state_think_loop」的混合' }), { target: { value: '0.5' } }));
    await click(previewBtn());
    expect(show).toHaveBeenCalledTimes(1);
    expect(sequence).toHaveBeenLastCalledWith({ clips: [PONDER, PONDER_LOOP, PONDER_END], blend_s: [0.5, 0.25] });
    expect(show.mock.invocationCallOrder[0]!).toBeLessThan(sequence.mock.invocationCallOrder[0]!);
    expect(toast).toHaveBeenLastCalledWith('预览里正在播放「dialog_state_think_start」');
    stage.setAttribute('data-live', 'true');
    await click(previewBtn());
    expect(show).toHaveBeenCalledTimes(1);
    expect(sequence).toHaveBeenCalledTimes(2);
  });

  it('does not play when the live preview could not be shown', async () => {
    vi.spyOn(bridge.avatar.preview, 'show').mockResolvedValue(false);
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    await open(PONDER);
    await click(previewBtn());
    expect(sequence).not.toHaveBeenCalled();
    expect(toast).toHaveBeenLastCalledWith('实时预览没有打开', { severity: 'warning' });
    expect(previewBtn().getAttribute('aria-disabled')).toBeNull();
  });

  it('plays the chain once on the desktop from its start', async () => {
    const play = vi.spyOn(bridge.avatar, 'playChain');
    await open(PONDER);
    await click(playBtn());
    expect(play).toHaveBeenLastCalledWith({ start: PONDER });
    expect(toast).toHaveBeenLastCalledWith('桌面上正在播放「dialog_state_think_start」');
  });

  it('greys out a button the renderer does not support and says why', async () => {
    stage.setAttribute('data-live', 'true');
    vi.spyOn(bridge.avatar.preview, 'sequence').mockRejectedValue({ code: 'not_implemented', detail: 'avatar.preview.sequence' });
    vi.spyOn(bridge.avatar, 'playChain').mockRejectedValue({ code: 'not_implemented', detail: 'avatar.playChain' });
    const d = await open(PONDER);
    await click(previewBtn());
    expect(previewBtn().getAttribute('aria-disabled')).toBe('true');
    expect(d.textContent).toContain('这个版本的渲染器还不支持预览动作链');
    await click(playBtn());
    expect(playBtn().getAttribute('aria-disabled')).toBe('true');
    expect(d.textContent).toContain('这个版本还不支持在桌面上播放');
  });

  it('greys out both while the avatar is not running', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    const play = vi.spyOn(bridge.avatar, 'playChain');
    const d = await open(PONDER, true);
    expect(previewBtn().getAttribute('aria-disabled')).toBe('true');
    expect(playBtn().getAttribute('aria-disabled')).toBe('true');
    expect(d.querySelectorAll('[data-block]').length).toBe(2);
    await click(previewBtn());
    await click(playBtn());
    expect(sequence).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});
