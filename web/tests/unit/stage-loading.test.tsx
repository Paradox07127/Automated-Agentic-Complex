// The character and MMD stages while the live preview loads: the loading bar for a full load, no portrait under the live
// canvas while it loads or draws, the portrait back only where the preview cannot draw.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { MmdStage, type MmdStageProps } from '../../src/pages/mmd/Stage';
import { Stage, type StageProps } from '../../src/pages/character/Stage';

const noop = () => {};
const RECT = { x: 40, y: 120, width: 600, height: 360, top: 120, left: 40, right: 640, bottom: 480, toJSON: () => ({}) } as DOMRect;

const stageProps: StageProps = {
  name: '示例乙', activity: null, scale: 100, offline: false, backoff: null, onRestart: noop, sw: { phase: 'idle' },
  currentName: '示例乙', onRetry: noop, onDismiss: noop, characterId: 'si', portrait: '/portrait.png', head: '/head.png',
};
const mmdProps: MmdStageProps = {
  character: 'si', name: '示例乙', portrait: '/portrait.png', scale: 100, offline: false, backoff: null, onRestart: noop,
  action: undefined, request: undefined, appearance: undefined, loop: false,
};

let show: Mock<(at: PreviewPlacement) => Promise<boolean>>;
let push: (p: { fraction: number } | null) => void;
let draw: (on: boolean) => void;

beforeEach(() => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  show = vi.fn(() => new Promise<boolean>((r) => { draw = r; }));
  push = () => {};
  const onProgress = (cb: typeof push) => ((push = cb), () => {});
  window.agenticComplex = { ...bridge, avatar: { ...bridge.avatar, preview: { ...bridge.avatar.preview, show, hide: async () => {}, onProgress } } };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-preview-stage') ? RECT : ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

const portrait = () => document.querySelector('[data-preview-stage] [data-stub="CharacterArt"]');
const bar = () => screen.queryByRole('progressbar');

for (const [page, view] of [['character', () => <Stage {...stageProps} />], ['MMD', () => <MmdStage {...mmdProps} />]] as const) {
  describe(`${page} stage`, () => {
    it('draws the loading bar over no portrait through a full load, then neither once she is drawn', async () => {
      render(view());
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      expect(portrait()).toBeNull();
      expect(bar()?.getAttribute('aria-valuenow')).toBe('0');
      act(() => push({ fraction: 0.56 }));
      expect(bar()?.getAttribute('aria-valuenow')).toBe('56');
      expect(screen.getByText('56%')).toBeTruthy();
      expect(screen.getByText('示例乙', { selector: '[data-stub="LoadBar"] *' })).toBeTruthy();
      expect(screen.queryByText(/正在载入预览/)).toBeNull();
      act(() => push(null));
      await act(async () => draw(true));
      expect(bar()).toBeNull();
      expect(portrait()).toBeNull();
    });

    it('keeps the old frame for a clip-only reload: no bar, no portrait', async () => {
      const { rerender } = render(view());
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      await act(async () => draw(true));
      rerender(page === 'MMD' ? <MmdStage {...mmdProps} action="wave" /> : <Stage {...stageProps} previewAction="wave" />);
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
      expect(bar()).toBeNull();
      expect(portrait()).toBeNull();
    });

    it('shows the portrait again once the preview fails', async () => {
      render(view());
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      await act(async () => draw(false));
      await waitFor(() => expect(portrait()).toBeTruthy());
      expect(bar()).toBeNull();
    });

    it('keeps the portrait where the shell has no live preview', () => {
      delete window.agenticComplex;
      render(view());
      expect(portrait()).toBeTruthy();
      expect(bar()).toBeNull();
    });
  });
}
