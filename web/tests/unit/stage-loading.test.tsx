// The character area's stage while the live preview loads, on a motion section and in MMD (a dance, looped): the loading
// bar for a full load, and never the portrait: where the preview cannot draw the stage says why and offers a retry, or stays empty.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { Stage, type StageProps } from '../../src/pages/character/Stage';

const noop = () => {};
const RECT = { x: 40, y: 120, width: 600, height: 360, top: 120, left: 40, right: 640, bottom: 480, toJSON: () => ({}) } as DOMRect;

const stageProps: StageProps = {
  name: '示例乙', activity: null, offline: false, backoff: null, onRestart: noop, sw: { phase: 'idle' },
  currentName: '示例乙', onRetry: noop, onDismiss: noop, characterId: 'si',
};
/** What the MMD section hands the stage for a baked dance. */
const mmdProps: StageProps = { ...stageProps, previewAction: 'mmd_a', previewRequest: 1, loop: true };

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

for (const [page, props] of [['character', stageProps], ['MMD', mmdProps]] as const) {
  const view = () => <Stage {...props} />;
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
      rerender(<Stage {...props} previewAction="wave" previewRequest={2} />);
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
      expect(bar()).toBeNull();
      expect(portrait()).toBeNull();
    });

    it('draws no portrait once the preview fails: the reason and a retry', async () => {
      render(view());
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      await act(async () => draw(false));
      await waitFor(() => expect(screen.getAllByRole('button', { name: '重试预览' }).length).toBeGreaterThan(0));
      expect(screen.getAllByText('实时预览没有加载，仍可查看角色外观').length).toBeGreaterThan(0);
      expect(portrait()).toBeNull();
      expect(bar()).toBeNull();
      act(() => screen.getAllByRole('button', { name: '重试预览' })[0]!.click());
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    });

    it('leaves the stage empty where the shell has no live preview', () => {
      delete window.agenticComplex;
      render(view());
      expect(portrait()).toBeNull();
      expect(document.querySelector('[data-preview-stage] :not([hidden]) > svg, [data-preview-stage] > svg')).toBeNull();
      expect(bar()).toBeNull();
    });
  });
}
