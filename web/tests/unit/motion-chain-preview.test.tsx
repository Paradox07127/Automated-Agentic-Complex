// 编排's previews: a row's ▶ and the inspector's 「舞台预览」 (avatar.preview.sequence), 「桌面播一次」 (avatar.playChain), and the
// reasons they grey out.
import { act, cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Toast } from '../../src/pages/character/feedback';
import { click, detail, mount, openChain, playRow, PONDER, PONDER_END, PONDER_LOOP, THINK, IDLE, toEvent } from './chainPage';

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;
let stage: HTMLElement;

const previewBtn = () => within(detail()).getByRole('button', { name: /舞台预览|预览中/ }) as HTMLButtonElement;
const playBtn = () => within(detail()).getByRole('button', { name: '桌面播一次' }) as HTMLButtonElement;

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

describe('编排 预览和桌面播放', () => {
  it('previews the chain with the draft blends over the pack ones, showing the live preview first when it is not drawn', async () => {
    const show = vi.spyOn(bridge.avatar.preview, 'show').mockResolvedValue(true);
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence').mockResolvedValue(true);
    await mount(toast);
    await openChain(PONDER);
    await click(within(detail()).getByRole('button', { name: /^进入「dialog_state_think_loop」的衔接/ }));
    await act(async () => void fireEvent.change(within(detail()).getByRole('slider'), { target: { value: '0.5' } }));
    await click(previewBtn());
    expect(show).toHaveBeenCalledTimes(1);
    expect(sequence).toHaveBeenLastCalledWith({ clips: [PONDER, PONDER_LOOP, PONDER_END], blend_s: [0.5, 0.25] });
    expect(show.mock.invocationCallOrder[0]!).toBeLessThan(sequence.mock.invocationCallOrder[0]!);
    expect(toast).toHaveBeenLastCalledWith('预览里正在播放「dialog_state_think_start」');
    stage.setAttribute('data-live', 'true');
    // The row's ▶ plays it too, without opening anything else.
    await click(playRow(PONDER));
    expect(show).toHaveBeenCalledTimes(1);
    expect(sequence).toHaveBeenCalledTimes(2);
    expect(sequence).toHaveBeenLastCalledWith({ clips: [PONDER, PONDER_LOOP, PONDER_END], blend_s: [0.5, 0.25] });
  });

  it('plays a row on the stage from its ▶ without opening it, a chain that rests on a base without the base', async () => {
    stage.setAttribute('data-live', 'true');
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence').mockResolvedValue(true);
    await mount(toast);
    await toEvent('session.thinking');
    await click(playRow(THINK));
    expect(sequence).toHaveBeenLastCalledWith({ clips: [THINK], blend_s: [] });
    expect(detail()).toBeNull();
    expect(sequence.mock.calls.flat().some((c) => (c as { clips: string[] }).clips.includes(IDLE))).toBe(false);
  });

  it('does not play when the live preview could not be shown', async () => {
    vi.spyOn(bridge.avatar.preview, 'show').mockResolvedValue(false);
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    await mount(toast);
    await openChain(PONDER);
    await click(previewBtn());
    expect(sequence).not.toHaveBeenCalled();
    expect(toast).toHaveBeenLastCalledWith('实时预览没有打开', { severity: 'warning' });
    expect(previewBtn().disabled).toBe(false);
  });

  it('plays the chain once on the desktop from its start', async () => {
    const play = vi.spyOn(bridge.avatar, 'playChain');
    await mount(toast);
    await openChain(PONDER);
    await click(playBtn());
    expect(play).toHaveBeenLastCalledWith({ start: PONDER });
    expect(toast).toHaveBeenLastCalledWith('桌面上正在播放「dialog_state_think_start」');
  });

  it('greys out a button the renderer does not support and says why', async () => {
    stage.setAttribute('data-live', 'true');
    vi.spyOn(bridge.avatar.preview, 'sequence').mockRejectedValue({ code: 'not_implemented', detail: 'avatar.preview.sequence' });
    vi.spyOn(bridge.avatar, 'playChain').mockRejectedValue({ code: 'not_implemented', detail: 'avatar.playChain' });
    await mount(toast);
    await openChain(PONDER);
    await click(previewBtn());
    expect(previewBtn().disabled).toBe(true);
    expect(detail().textContent).toContain('这个版本的渲染器还不支持预览动作链');
    await click(playBtn());
    expect(playBtn().disabled).toBe(true);
    expect(detail().textContent).toContain('这个版本还不支持在桌面上播放');
  });

  it('greys out both while the avatar is not running, and a row ▶ only says why', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence');
    const play = vi.spyOn(bridge.avatar, 'playChain');
    await mount(toast, true);
    await openChain(PONDER);
    expect(previewBtn().disabled).toBe(true);
    expect(playBtn().disabled).toBe(true);
    expect(detail().querySelector('[data-block]')!.textContent).toBe('角色未运行');
    await click(playRow(PONDER));
    expect(toast).toHaveBeenLastCalledWith('角色未运行', { severity: 'warning' });
    expect(sequence).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});
