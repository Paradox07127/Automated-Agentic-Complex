// 播放方式 in the character page's bottom bar: 循环 plays the motion on the desktop until 停止, and loops the stage's live preview.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator } from '../../src/pages/character/Operator';

const noop = () => {};
const RECT = { x: 40, y: 120, width: 300, height: 360, top: 120, left: 40, right: 340, bottom: 480, toJSON: () => ({}) } as DOMRect;
const EMPTY = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;

function install(over: Partial<Parameters<typeof createFakeBridge>[0]> = {}) {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: 'main', still: true, ...over });
  window.agenticComplex = bridge;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return 'previewStage' in this.dataset || 'previewLayer' in this.dataset ? RECT : EMPTY;
  });
  return {
    play: vi.spyOn(bridge.avatar, 'playAction').mockResolvedValue(),
    stop: vi.spyOn(bridge.avatar, 'stopAction').mockResolvedValue(),
    show: vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true),
  };
}

function Op() {
  return (
    <Operator
      roster={[{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [] }]}
      current="si"
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={noop}
    />
  );
}

const mode = (name: string) => within(screen.getByRole('radiogroup', { name: '播放方式' })).getByRole('radio', { name }) as HTMLButtonElement;
const pickNod = () => act(async () => void fireEvent.click(screen.getByRole('grid', { name: '全部动作' }).querySelector('[data-motion="nod"] button')!));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

describe('播放方式', () => {
  it('plays once by default, on the desktop and on the stage', async () => {
    const { play, show } = install();
    render(<Op />);
    expect(mode('一次').getAttribute('aria-checked')).toBe('true');
    await pickNod();
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'nod' })));
    expect(show.mock.calls.every(([at]) => !('loop' in at))).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /桌面预览/ })));
    expect(play).toHaveBeenCalledWith('nod', 1);
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
    expect(document.body.textContent).not.toContain('桌面角色将播放一次');
  });

  it('loops on the desktop until 停止, and loops the stage preview', async () => {
    const { play, stop, show } = install();
    render(<Op />);
    await pickNod();
    await act(async () => void fireEvent.click(mode('循环')));
    await waitFor(() => expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'nod', loop: true })));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /桌面预览/ })));
    expect(play).toHaveBeenCalledWith('nod', 1, { loop: true });
    const stage = document.querySelector('[data-stage]') as HTMLElement;
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 1500))));
    expect(within(stage).getByRole('status').textContent).toContain('循环中 │ 点头附和');
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: '停止' })));
    expect(stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /桌面预览/ })).toBeTruthy());
    expect(within(stage).queryByRole('status')).toBeNull();
  });

  it('turns 循环 off, with its reason, where the character cannot loop', async () => {
    install({ capabilities: { actionLoop: false } });
    render(<Op />);
    const loop = mode('循环');
    expect(loop.disabled).toBe(true);
    expect(loop.closest('[title]')?.getAttribute('title')).toBe('当前版本角色暂不支持循环播放');
    expect(mode('一次').disabled).toBe(false);
  });
});
